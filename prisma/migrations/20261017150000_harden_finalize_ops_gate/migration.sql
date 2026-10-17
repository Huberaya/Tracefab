-- TRACEFAB — TF-02 revue adversariale (2C.38) : durcir la finalisation.
--
-- DEFAUTS REPRODUITS SUR CHAINE APPLIQUEE (PG17 jetable, 2026-10-17)
--
-- 1. CONTROLE ACTEUR PAR COMPARAISON session_user <> current_user.
--    Dans une fonction SECURITY DEFINER, current_user vaut TOUJOURS le
--    proprietaire de la fonction : la comparaison ne prouve aucun privilege,
--    elle ne fait que « session_user == proprietaire de la fonction ».
--    Reproduction mesuree : avec ALTER FUNCTION ... OWNER TO tracefab_app,
--    un appel tracefab_app SANS contexte franchit le controle acteur
--    (aucune erreur document_scan_actor_required ; l'appel n'est arrete que
--    plus bas par le SELECT filtre par RLS — document_not_found). Le controle
--    d'autorisation ne distingue donc pas le role d'exploitation du role
--    applicatif : il depend du proprietaire de la fonction, ce qui est une
--    configuration, pas un privilege.
--
-- 2. sha256 NON VALIDE AU FORMAT. La verification se limitait a
--    length(trim(...)) = 64 : une chaine de 64 caracteres quelconques
--    ('zzz...z') bascule le document en `available` avec un empreinte
--    inutilisable comme releve d'integrite.
--
-- CORRECTIONS
--
-- A. Chemin exploitation = privilege REEL. Il exige que le role de la session
--    detienne TRUNCATE sur la table documents (classe proprietaire/DBA — le
--    role applicatif n'a que SELECT/INSERT/UPDATE/DELETE par le bootstrap).
--    Le role applicatif `tracefab_app` est en plus explicitement exclu, meme
--    s'il devenait proprietaire de la fonction (ALTER OWNER) ou de la table :
--    aucune configuration ne peut lui ouvrir le chemin d'exploitation.
--    Ce n'est plus une comparaison de noms entre session_user et current_user.
--
-- B. sha256 : format hexadecimal strict (64 caracteres) requis pour toute
--    mise en `available`, stocke en minuscules canoniques.
--
-- Le parcours applicatif de scan (contexte utilisateur + role ecrivain) est
-- inchange. Les privileges EXECUTE existants (proprietaire + tracefab_app via
-- le bootstrap) sont inchanges : aucune ouverture ajoutee.

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
  -- Garde d'exploitation AVANT toute lecture : sans contexte utilisateur,
  -- seul un role d'exploitation reel (TRUNCATE sur documents) passe, le role
  -- applicatif etant explicitement exclu. Placee avant le SELECT, la garde
  -- s'applique meme si le proprietaire de la fonction (DEFINER) est le role
  -- applicatif, et ne revele pas l'existence d'un document par un message
  -- different.
  IF tracefab_current_user_id() IS NULL
     AND (session_user = 'tracefab_app'
          OR NOT has_table_privilege(session_user, 'documents', 'TRUNCATE')) THEN
    RAISE EXCEPTION 'document_scan_actor_required';
  END IF;

  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  -- Defense en profondeur (TF-02) : un utilisateur authentifie ne peut
  -- finaliser qu'un document de SON organisation, avec un role ecrivain.
  IF tracefab_current_user_id() IS NOT NULL THEN
    IF NOT tracefab_has_org_role(
      v_document.owner_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    ) THEN
      RAISE EXCEPTION 'document_scan_role_required';
    END IF;
  END IF;

  IF v_document.status NOT IN ('uploaded', 'scanning') THEN
    RAISE EXCEPTION 'document_not_in_scannable_state';
  END IF;

  IF p_actual_byte_size < 0 OR p_actual_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  -- Empreinte d'integrite : pour une mise en available, sha256 hexadecimal
  -- strict (64 caracteres). Un verdict non fiable ou une empreinte invalide
  -- ne produit JAMAIS un document disponible.
  IF p_scan_passed AND COALESCE(p_sha256, '') !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'sha256_required_for_available_document';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET sha256 = lower(NULLIF(trim(p_sha256), '')),
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
  'TF-02 : finalisation du cycle depot/scan. Utilisateur authentifie : role '
  'ecrivain sur l''organisation proprietaire. Sans contexte : chemin '
  'exploitation exigeant un privilege reel (TRUNCATE sur documents), le role '
  'applicatif tracefab_app etant explicitement exclu. sha256 hexadecimal '
  'strict requis pour toute mise en available.';
