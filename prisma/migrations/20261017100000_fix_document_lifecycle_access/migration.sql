-- TRACEFAB — TF-02 : fiabiliser le cycle de vie documentaire.
--
-- CONSTATS CONFIRMES SUR CHAINE APPLIQUEE (base jetable PG17, 2026-10-17)
--
-- 1. La migration 20261006100000 a remplace `documents_select_authorized`
--    par `status <> 'deleted' AND tracefab_can_access_document(id)`. Or
--    `tracefab_can_access_document` exige `d.status = 'available'` dans son
--    EXISTS. Consequence mesureee : un document en statut `uploaded`,
--    `scanning` ou `rejected` est invisible pour TOUT LE MONDE, y compris
--    son proprietaire — la route de scan (findFirst sur status in
--    uploaded/scanning) ne trouve jamais le document, le scan est
--    impossible, et les documents restent bloques dans `scanning`.
--
-- 2. `tracefab_finalize_document_upload` ne controle pas qui l'appelle :
--    toute session qui peut executer la fonction peut basculer n'importe
--    quel document en `available` avec un sha256 de son choix.
--
-- CORRECTIONS
--
-- A. Le proprietaire (membre de owner_organization_id) revoit ses documents
--    dans tous les etats non supprimes : c'est necessaire au parcours de
--    depot, de scan, de reprise et de supervision des quotas. L'acces croise
--    (partages, preuves de reponses, certifications) reste borne par
--    tracefab_can_access_document, qui n'ouvre que les documents `available`.
--
-- B. tracefab_finalize_document_upload refuse une finalisation par un
--    utilisateur qui n'a pas un role ecrivain sur l'organisation
--    proprietaire. Les chemins sans utilisateur (DBA, tests via le
--    proprietaire de fonction) restent possibles : ils supposent deja un
--    controle total de la base.

-- ---------------------------------------------------------------------------
-- A. Politique de lecture des documents
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS documents_select_authorized ON documents;
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO PUBLIC USING (
    status <> 'deleted'
    AND (
      -- Proprietaire : metadonnees de SON document, tout etat non supprime.
      tracefab_can_access_org(owner_organization_id)
      -- Acces croise : uniquement via la fonction, qui exige status='available'.
      OR tracefab_can_access_document(id)
    )
  );

COMMENT ON POLICY documents_select_authorized ON documents IS
  'TF-02 : le proprietaire lit les metadonnees de ses documents dans tous les '
  'etats non supprimes (depot, scan, reprise, quotas) ; les autres acteurs '
  'passent par tracefab_can_access_document, borne au statut available.';

-- ---------------------------------------------------------------------------
-- B. Finalisation du scan : role ecrivain requis
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_finalize_document_upload(
  p_document_id UUID,
  p_sha256 TEXT,
  p_scan_passed BOOLEAN,
  p_actual_byte_size BIGINT
)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
BEGIN
  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  -- Defense en profondeur (TF-02) : un utilisateur authentifie ne peut
  -- finaliser qu'un document de SON organisation, avec un role ecrivain.
  -- Sans contexte utilisateur, seul le proprietaire de la fonction (chemin
  -- DBA / exploitation) peut finaliser : un role applicatif anonyme ne peut
  -- jamais basculer un document en `available`.
  IF tracefab_current_user_id() IS NOT NULL THEN
    IF NOT tracefab_has_org_role(
      v_document.owner_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    ) THEN
      RAISE EXCEPTION 'document_scan_role_required';
    END IF;
  ELSIF session_user <> current_user THEN
    RAISE EXCEPTION 'document_scan_actor_required';
  END IF;

  IF v_document.status NOT IN ('uploaded', 'scanning') THEN
    RAISE EXCEPTION 'document_not_in_scannable_state';
  END IF;

  IF p_actual_byte_size < 0 OR p_actual_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF p_scan_passed AND length(trim(COALESCE(p_sha256, ''))) <> 64 THEN
    RAISE EXCEPTION 'sha256_required_for_available_document';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET sha256 = NULLIF(trim(p_sha256), ''),
      byte_size = p_actual_byte_size,
      status = CASE WHEN p_scan_passed THEN 'available'::document_status ELSE 'rejected'::document_status END,
      available_at = CASE WHEN p_scan_passed THEN now() ELSE NULL END,
      metadata = metadata || jsonb_build_object('scan_passed', p_scan_passed)
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);
  RETURN v_document;
END;
$$;

COMMENT ON FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) IS
  'TF-02 : finalisation du cycle depot/scan. Un utilisateur authentifie doit '
  'porter un role ecrivain sur l''organisation proprietaire du document.';
