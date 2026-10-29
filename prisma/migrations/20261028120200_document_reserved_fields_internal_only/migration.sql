-- ============================================================================
-- 20261028120200 — champs reserves des documents : ecriture interne seulement
--
-- LE PROBLEME MESURE
--
-- 20261028120100 a rendu le contexte worker non falsifiable : les politiques
-- qui parlent au nom du worker comparent desormais current_user a un role
-- dedie, et non un GUC que le client peut poser. Ce travail a laisse intact un
-- second drapeau, interne celui-la :
--
--   tracefab.internal_document_update
--
-- Le trigger tracefab_validate_document_location l'utilise pour autoriser
-- l'ecriture des champs geres par le pipeline (status, byte_size, sha256,
-- uploaded_by, available_at, deleted_at, deleted_by). Tracefab_app possedait
-- UPDATE sur documents et pouvait poser le drapeau lui-meme :
--
--   SET tracefab.internal_document_update = 'true';
--   UPDATE documents SET status = 'available', sha256 = <forge>;
--
-- Mesure du 28/10/2026 sur une base jetable reconstruite depuis zero, sous
-- tracefab_app, avec le contexte d'un proprietaire de l'organisation
-- proprietaire du document :
--
--   UPDATE status sans drapeau        -> P0001 managed_document_fields_are_not_client_writable
--   SET drapeau puis UPDATE status    -> SUCCES (1 ligne)
--   SET drapeau puis UPDATE sha256    -> SUCCES (1 ligne)
--
-- Autrement dit, un adherent de l'organisation pouvait auto-approuver un
-- document — donc publier un fichier jamais scanne — en posant un GUC que rien
-- ne protegeait. C'est exactement la classe de defaut que la PR corrige
-- ailleurs.
--
-- LA REPONSE : LE ROLE APPLICATIF N'ECRIT PLUS DANS documents
--
-- L'inventaire de api/ est sans ambiguite : le runtime ne fait que LIRE
-- documents par Prisma (findFirst/findMany). Les trois ecritures existantes
-- passaient deja par des fonctions SECURITY DEFINER — register, finalize,
-- soft_delete — sauf la bascule `uploaded -> scanning`, ecrite en SQL brut
-- depuis api/_lib/documents.ts. Cette migration :
--
--   1. cree la fonction manquante tracefab_mark_document_scanning(uuid), sur
--      le modele des trois autres, qui pose elle-meme le drapeau interne ;
--   2. la declare au registre runtime pour que le role applicatif puisse
--      l'appeler et pour qu'elle recoive EXECUTE par le mecanisme existant ;
--   3. retire a tracefab_app INSERT, UPDATE, DELETE et TRUNCATE sur documents.
--
-- Consequence : le drapeau internal_document_update devient inatteignable pour
-- le client, faute de privilege d'ecriture — comme internal_data_collection_update
-- l'est deja sur data_requests (tracefab_app n'y a que SELECT). Mesure
-- reproductible : SET du drapeau puis UPDATE -> 42501 permission denied.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   - elle ne modifie aucune migration deja appliquee, ni son empreinte ;
--   - elle n'ecrit pas dans _prisma_migrations ;
--   - elle n'accorde aucun privilege nouveau hors du registre ;
--   - elle ne touche a aucune donnee metier et ne cree aucun secret.
-- ============================================================================

-- 1. La transition `scanning`, cote interne -----------------------------------
--    Memes garde-fous que l'ancien chemin : le document doit exister, etre dans
--    un etat scannable, et l'appelant doit avoir un role d'ecriture dans
--    l'organisation proprietaire (regle identique a l'ancienne politique
--    documents_update_metadata_owner, pour ne pas changer le parcours).
--    Rejouer l'appel sur un document deja `scanning` reste permis : le flux de
--    scan documente un retry explicite.
CREATE OR REPLACE FUNCTION public.tracefab_mark_document_scanning(p_document_id UUID)
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

  IF v_document.status NOT IN ('uploaded', 'scanning') THEN
    RAISE EXCEPTION 'document_not_in_scannable_state';
  END IF;

  IF NOT tracefab_has_org_role(
    v_document.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_scan_role_required';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET status = 'scanning'::document_status
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);

  RETURN v_document;
END;
$$;

-- 2. Personne d'autre que le runtime ne doit l'appeler ------------------------
REVOKE ALL ON FUNCTION public.tracefab_mark_document_scanning(UUID) FROM PUBLIC;

-- 3. Declarer la fonction au registre ----------------------------------------
--    Sans cette ligne, l'appel depuis api/ echouerait en 42501 : le runtime
--    n'execute que les fonctions declarees. Declarer ne suffit pas a ouvrir :
--    c'est tracefab_apply_runtime_function_grants() qui delivre EXECUTE, et
--    elle le fait pour le seul role applicatif.
INSERT INTO public.tracefab_runtime_function_registry (name, registered_by)
VALUES ('tracefab_mark_document_scanning', '20261028120200_document_reserved_fields_internal_only')
ON CONFLICT (name) DO NOTHING;

-- 4. Le role applicatif perd l'ecriture directe sur documents -----------------
--    Il conserve SELECT : tous les parcours lisent les metadonnees. Les
--    ecritures restantes passent par les quatre fonctions SECURITY DEFINER.
--    Le trigger garde son drapeau interne : il n'est simplement plus
--    atteignable par un client.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.documents FROM tracefab_app';
  END IF;
END
$$;

-- 5. Appliquer le perimetre depuis le registre -------------------------------
--    Reconstruit EXECUTE a partir des seules lignes declarees, et leve si un
--    octroi existe hors registre. Deux valeurs retournees : (autorisees,
--    revoquees). L'appel est idempotent.
SELECT * FROM public.tracefab_apply_runtime_function_grants();
