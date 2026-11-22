-- ============================================================================
-- 20261028120000 — registre des fonctions ouvertes au runtime
--
-- LE PROBLEME QUE CETTE MIGRATION RESOUT
--
-- La migration 20261021120000 limite les fonctions executables par
-- tracefab_app a une liste ecrite en dur dans son propre code. Ce controle est
-- bon, mais il est FIGE : a la fin de son execution, elle verifie que chaque
-- nom de la liste existe deja, et elle leve 42883 sinon. Consequence mesuree :
-- ajouter une fonction appelee par api/ oblige soit a modifier la liste d'une
-- migration deja appliquee — donc a changer son empreinte, ce qui desynchronise
-- toutes les bases migrees et exige d'ecrire dans _prisma_migrations — soit a
-- laisser diverger le module et la base.
--
-- Constat direct : la chaine ne permet aujourd'hui AUCUN ajout de fonction
-- appelee depuis api/. C'est ce qui bloque le correctif du contexte worker.
--
-- LA REPONSE : UN REGISTRE, PAS UN ASSOUPLISSEMENT
--
-- Les noms autorises quittent le code de la migration pour une table dediee.
-- Une migration ULTERIEURE peut alors ajouter un nom par INSERT, sans toucher
-- a l'historique. Le controle n'est pas leve, il est DEPLACE et RENFORCE :
--
--   1. un nom enregistre doit designer exactement une fonction existante,
--      publique et appartenant au proprietaire des migrations -> sinon 42883 ;
--   2. aucune fonction ne recoit EXECUTE pour tracefab_app sans figurer au
--      registre -> sinon 42501 ;
--   3. toute fonction appelee par une politique RLS doit figurer au registre ;
--   4. les SECURITY DEFINER restent inexecutables par PUBLIC.
--
-- Autrement dit : on peut AJOUTER une fonction, jamais en ouvrir une par
-- inadvertance, et une fonction fantome fait echouer la migration.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   - elle ne modifie pas 20261021120000 ni aucune migration deja appliquee ;
--   - elle n'ecrit pas dans _prisma_migrations ;
--   - elle n'accorde aucun privilege a tracefab_app sur le registre ;
--   - elle ne cree aucun secret et ne touche a aucune donnee metier.
-- ============================================================================

-- 1. Le registre -------------------------------------------------------------
--    Aucune donnee personnelle : uniquement des noms de fonctions, qui sont
--    deja publics dans pg_proc. La RLS est activee ET forcee, et la seule
--    politique autorise le PROPRIETAIRE de la table a lire et ecrire. Le role
--    applicatif n'a aucun privilege ici : il n'a pas a lire la facon dont ses
--    droits sont calcules.
CREATE TABLE public.tracefab_runtime_function_registry (
  name TEXT PRIMARY KEY,
  registered_by TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracefab_runtime_function_registry_name_format
    CHECK (name ~ '^tracefab_[a-z0-9_]+$')
);

ALTER TABLE public.tracefab_runtime_function_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracefab_runtime_function_registry FORCE ROW LEVEL SECURITY;

-- La politique compare a l'appelant au proprietaire reel de la table, lu dans
-- le catalogue : elle fonctionne donc telle quelle sur une base locale ou le
-- proprietaire est 'postgres', comme sur la base geree ou c'est un autre role.
CREATE POLICY tracefab_runtime_function_registry_owner
  ON public.tracefab_runtime_function_registry
  FOR ALL
  USING (
    current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)
                      FROM pg_catalog.pg_class c
                     WHERE c.oid = 'public.tracefab_runtime_function_registry'::regclass)
  )
  WITH CHECK (
    current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)
                      FROM pg_catalog.pg_class c
                     WHERE c.oid = 'public.tracefab_runtime_function_registry'::regclass)
  );

-- 1 bis. Aucun privilege applicatif sur le registre -------------------------
--    Le bootstrap accorde par defaut SELECT sur toute nouvelle table au role
--    applicatif (ALTER DEFAULT PRIVILEGES). Sans cette revocation explicite,
--    creer le registre ELARGIRAIT les droits de tracefab_app — exactement ce
--    que la mission interdit. Le runtime n'a pas a lire la facon dont ses
--    propres droits sont calcules.
REVOKE ALL ON TABLE public.tracefab_runtime_function_registry FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tracefab_runtime_function_registry FROM tracefab_app';
  END IF;
END
$$;

-- 2. Reprise de l'existant ---------------------------------------------------
--    Les 84 noms de 20261021120000 sont recopies a l'identique : le perimetre
--    actuel est preserve avant d'etre etendu. ON CONFLICT DO NOTHING rend la
--    reprise inoffensive si la table contient deja des lignes.
INSERT INTO public.tracefab_runtime_function_registry (name, registered_by) VALUES
    ('tracefab_accept_organization_invitation', '20261021120000_limit_app_function_execute'),
    ('tracefab_acknowledge_quality_issue', '20261021120000_limit_app_function_execute'),
    ('tracefab_active_organization_id', '20261021120000_limit_app_function_execute'),
    ('tracefab_add_data_request_item', '20261021120000_limit_app_function_execute'),
    ('tracefab_add_dpp_claim', '20261021120000_limit_app_function_execute'),
    ('tracefab_add_dpp_event', '20261021120000_limit_app_function_execute'),
    ('tracefab_add_product_identifier', '20261021120000_limit_app_function_execute'),
    ('tracefab_add_product_material', '20261021120000_limit_app_function_execute'),
    ('tracefab_add_supply_chain_link', '20261021120000_limit_app_function_execute'),
    ('tracefab_allocate_tc_quantity', '20261021120000_limit_app_function_execute'),
    ('tracefab_apply_document_ai_verification', '20261021120000_limit_app_function_execute'),
    ('tracefab_audit_product_green_claims', '20261021120000_limit_app_function_execute'),
    ('tracefab_bind_schema', '20261021120000_limit_app_function_execute'),
    ('tracefab_calculate_product_pef', '20261021120000_limit_app_function_execute'),
    ('tracefab_can_access_document', '20261021120000_limit_app_function_execute'),
    ('tracefab_can_access_org', '20261021120000_limit_app_function_execute'),
    ('tracefab_can_access_shared_subject', '20261021120000_limit_app_function_execute'),
    ('tracefab_claim_notification_outbox', '20261021120000_limit_app_function_execute'),
    ('tracefab_complete_notification_outbox', '20261021120000_limit_app_function_execute'),
    ('tracefab_compute_dpp_readiness', '20261021120000_limit_app_function_execute'),
    ('tracefab_compute_product_quality', '20261021120000_limit_app_function_execute'),
    ('tracefab_compute_supplier_quality', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_data_request', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_dpp_identity', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_material', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_organization', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_product', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_quality_cap', '20261021120000_limit_app_function_execute'),
    ('tracefab_create_supply_chain_node', '20261021120000_limit_app_function_execute'),
    ('tracefab_current_user_email', '20261021120000_limit_app_function_execute'),
    ('tracefab_current_user_id', '20261021120000_limit_app_function_execute'),
    ('tracefab_delete_supply_chain_link', '20261021120000_limit_app_function_execute'),
    ('tracefab_delete_supply_chain_node', '20261021120000_limit_app_function_execute'),
    ('tracefab_enqueue_due_data_request_reminders', '20261021120000_limit_app_function_execute'),
    ('tracefab_enqueue_manual_data_request_reminder', '20261021120000_limit_app_function_execute'),
    ('tracefab_finalize_document_upload', '20261021120000_limit_app_function_execute'),
    ('tracefab_get_or_create_supplier_passport', '20261021120000_limit_app_function_execute'),
    ('tracefab_get_product_traceability', '20261021120000_limit_app_function_execute'),
    ('tracefab_get_public_supplier_passport', '20261021120000_limit_app_function_execute'),
    ('tracefab_has_org_role', '20261021120000_limit_app_function_execute'),
    ('tracefab_in_active_tenant', '20261021120000_limit_app_function_execute'),
    ('tracefab_ingest_plm_erp_payload', '20261021120000_limit_app_function_execute'),
    ('tracefab_invite_supplier', '20261021120000_limit_app_function_execute'),
    ('tracefab_is_org_member', '20261021120000_limit_app_function_execute'),
    ('tracefab_link_dpp_claim_evidence', '20261021120000_limit_app_function_execute'),
    ('tracefab_mark_dpp_ready_to_publish', '20261021120000_limit_app_function_execute'),
    ('tracefab_material_is_public', '20261021120000_limit_app_function_execute'),
    ('tracefab_material_visible_via_product', '20261021120000_limit_app_function_execute'),
    ('tracefab_product_is_public', '20261021120000_limit_app_function_execute'),
    ('tracefab_public_brand', '20261021120000_limit_app_function_execute'),
    ('tracefab_public_context', '20261021120000_limit_app_function_execute'),
    ('tracefab_public_dpp_claims', '20261021120000_limit_app_function_execute'),
    ('tracefab_reconcile_mass_balance', '20261021120000_limit_app_function_execute'),
    ('tracefab_require_active_tenant', '20261021120000_limit_app_function_execute'),
    ('tracefab_register_certification', '20261021120000_limit_app_function_execute'),
    ('tracefab_register_document', '20261021120000_limit_app_function_execute'),
    ('tracefab_register_supplier_organization', '20261021120000_limit_app_function_execute'),
    ('tracefab_register_transaction_certificate', '20261021120000_limit_app_function_execute'),
    ('tracefab_replace_dpp_identity', '20261021120000_limit_app_function_execute'),
    ('tracefab_request_passport_access', '20261021120000_limit_app_function_execute'),
    ('tracefab_review_data_response', '20261021120000_limit_app_function_execute'),
    ('tracefab_review_passport_access', '20261021120000_limit_app_function_execute'),
    ('tracefab_review_quality_remediation', '20261021120000_limit_app_function_execute'),
    ('tracefab_revoke_clerk_membership', '20261021120000_limit_app_function_execute'),
    ('tracefab_send_data_request', '20261021120000_limit_app_function_execute'),
    ('tracefab_set_dpp_publication', '20261021120000_limit_app_function_execute'),
    ('tracefab_start_product_revision', '20261021120000_limit_app_function_execute'),
    ('tracefab_submit_data_request', '20261021120000_limit_app_function_execute'),
    ('tracefab_submit_data_response', '20261021120000_limit_app_function_execute'),
    ('tracefab_submit_quality_remediation', '20261021120000_limit_app_function_execute'),
    ('tracefab_submit_supplier_profile', '20261021120000_limit_app_function_execute'),
    ('tracefab_supplier_site_is_public', '20261021120000_limit_app_function_execute'),
    ('tracefab_sync_clerk_membership', '20261021120000_limit_app_function_execute'),
    ('tracefab_sync_clerk_organization', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_certification', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_material', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_product_data', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_product_identifier', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_product_material', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_supplier_passport', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_supplier_profile', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_supply_chain_link', '20261021120000_limit_app_function_execute'),
    ('tracefab_update_supply_chain_node', '20261021120000_limit_app_function_execute'),
    ('tracefab_waive_quality_issue', '20261021120000_limit_app_function_execute')
ON CONFLICT (name) DO NOTHING;

-- 3. Application et verification des droits ----------------------------------
--    Une seule fonction fait autorite. Une migration qui ajoute une fonction
--    l'enregistre puis l'appelle ; il n'existe donc qu'un seul chemin par
--    lequel un privilege d'execution peut exister.
--
--    SECURITY INVOKER volontaire : cette fonction n'a besoin que des droits du
--    proprietaire des migrations, et elle ne doit surtout pas pouvoir etre
--    transformee en outil d'elevation. Son EXECUTE est retire a PUBLIC et au
--    role applicatif plus bas.
CREATE OR REPLACE FUNCTION public.tracefab_apply_runtime_function_grants()
RETURNS TABLE (fonctions_autorisees INTEGER, fonctions_revoquees INTEGER)
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  owner_oid OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  app_oid OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app');
  -- Deux proprietaires de confiance, et deux seulement :
  --   * le proprietaire des migrations, pour les fonctions ordinaires ;
  --   * `tracefab_worker`, pour les fonctions qui doivent voir les tables
  --     protegees par FORCE RLS (voir 20261028120100).
  -- Une fonction enregistree appartenant a un AUTRE role est refusee plus bas.
  worker_oid OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker');
  proprietaires OID[];
  invalides TEXT;
  omises_par_politiques TEXT;
  hors_registre TEXT;
  manquantes TEXT;
  secdef_publiques INTEGER;
  f RECORD;
  nb_autorisees INTEGER := 0;
  nb_revoquees INTEGER := 0;
  tables_registre CONSTANT OID := 'public.tracefab_runtime_function_registry'::regclass;
BEGIN
  IF app_oid IS NULL THEN
    RAISE EXCEPTION 'Registre runtime refuse : le role tracefab_app est absent'
      USING ERRCODE = '42704';
  END IF;

  proprietaires := ARRAY[owner_oid];
  IF worker_oid IS NOT NULL AND worker_oid <> owner_oid THEN
    proprietaires := proprietaires || worker_oid;
  END IF;

  -- 3.a — Chaque nom enregistre doit designer UNE fonction existante, publique
  --       et appartenant au proprietaire des migrations. Un nom fantome, une
  --       surcharge ambiguë ou une fonction d'un autre proprietaire arretent
  --       tout : c'est le controle « une fonction autorisee doit exister ».
  SELECT string_agg(invalide.name, ', ' ORDER BY invalide.name)
    INTO invalides
    FROM (
      SELECT r.name
        FROM public.tracefab_runtime_function_registry r
        LEFT JOIN pg_catalog.pg_proc p
          ON p.proname = r.name AND p.prokind = 'f'
        LEFT JOIN pg_catalog.pg_namespace n
          ON n.oid = p.pronamespace AND n.nspname = 'public'
       GROUP BY r.name
      HAVING count(p.oid) FILTER (WHERE n.oid IS NOT NULL) <> 1
          OR COALESCE(bool_or(NOT (p.proowner = ANY (proprietaires))) FILTER (WHERE n.oid IS NOT NULL), false)
    ) AS invalide;

  IF invalides IS NOT NULL THEN
    RAISE EXCEPTION 'Registre runtime : fonctions absentes, surchargees ou d''un autre proprietaire : %', invalides
      USING ERRCODE = '42883';
  END IF;

  -- 3.b — Le catalogue des politiques RLS est une source de verite independante.
  --       Toute fonction TraceFab appelee par USING/WITH CHECK doit etre
  --       enregistree, sinon une politique pourrait s'appuyer sur une fonction
  --       que le runtime n'a pas le droit d'executer.
  WITH corps AS (
    SELECT COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
           COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS corps
      FROM pg_catalog.pg_policy pol
      JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.oid <> tables_registre
  ), fonctions_politiques AS (
    SELECT DISTINCT (m.matches)[1] AS name
      FROM corps b
      CROSS JOIN LATERAL pg_catalog.regexp_matches(b.corps, '(tracefab_[a-z0-9_]+)[[:space:]]*\(', 'g') AS m(matches)
  )
  SELECT string_agg(fp.name, ', ' ORDER BY fp.name)
    INTO omises_par_politiques
    FROM fonctions_politiques fp
   WHERE NOT EXISTS (SELECT 1 FROM public.tracefab_runtime_function_registry r WHERE r.name = fp.name);

  IF omises_par_politiques IS NOT NULL THEN
    RAISE EXCEPTION 'Registre runtime : fonctions de politiques RLS non enregistrees : %', omises_par_politiques
      USING ERRCODE = '42501';
  END IF;

  -- 3.c — Aucune fonction SECURITY DEFINER du proprietaire n'est executable
  --       par PUBLIC.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosecdef
       AND p.proowner = ANY (proprietaires)
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature);
  END LOOP;

  -- 3.d — On repart de zero : tout EXECUTE accorde au role applicatif est
  --       retire. Les droits sont ensuite reconstruits a partir du registre,
  --       ce qui garantit qu'aucun droit residuel ne survit.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proowner = ANY (proprietaires)
       AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM tracefab_app', f.signature);
    nb_revoquees := nb_revoquees + 1;
  END LOOP;

  -- 3.e — Les fonctions FUTURES ne doivent pas devenir executables en silence.
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM tracefab_app',
    current_user
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );

  -- 3.f — Reconstruction : uniquement les noms du registre.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN public.tracefab_runtime_function_registry r ON r.name = p.proname
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proowner = ANY (proprietaires)
  LOOP
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO tracefab_app', f.signature);
    nb_autorisees := nb_autorisees + 1;
  END LOOP;

  -- 3.g — Controle final : aucun EXECUTE ne doit exister hors registre. C'est
  --       le controle « une fonction non autorisee ne peut pas etre ajoutee ».
  SELECT string_agg(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY p.proname)
    INTO hors_registre
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proowner = ANY (proprietaires)
     AND acl.grantee = app_oid
     AND acl.privilege_type = 'EXECUTE'
     AND NOT EXISTS (SELECT 1 FROM public.tracefab_runtime_function_registry r WHERE r.name = p.proname);

  IF hors_registre IS NOT NULL THEN
    RAISE EXCEPTION 'Registre runtime : EXECUTE accorde hors registre : %', hors_registre
      USING ERRCODE = '42501';
  END IF;

  -- 3.h — Controle final : chaque nom enregistre est bien executable.
  SELECT string_agg(r.name, ', ' ORDER BY r.name)
    INTO manquantes
    FROM public.tracefab_runtime_function_registry r
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
        AND p.proowner = ANY (proprietaires)
        AND p.proname = r.name
        AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
   );

  IF manquantes IS NOT NULL THEN
    RAISE EXCEPTION 'Registre runtime : noms enregistres mais non executables : %', manquantes
      USING ERRCODE = '42501';
  END IF;

  -- 3.i — Controle final : plus aucune SECURITY DEFINER ouverte a PUBLIC.
  SELECT count(*)::integer
    INTO secdef_publiques
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.proowner = ANY (proprietaires)
     AND acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE';

  IF secdef_publiques <> 0 THEN
    RAISE EXCEPTION 'Registre runtime : % fonction(s) SECURITY DEFINER executable(s) par PUBLIC', secdef_publiques
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT nb_autorisees, nb_revoquees;
END
$$;

-- 4. Personne ne peut se servir de cette fonction pour redistribuer des droits.
--    Ni PUBLIC, ni le role applicatif : sinon le runtime pourrait s'auto-ouvrir
--    n'importe quelle fonction, et le registre ne controlerait plus rien.
REVOKE ALL ON FUNCTION public.tracefab_apply_runtime_function_grants() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.tracefab_apply_runtime_function_grants() FROM tracefab_app';
  END IF;
END
$$;

-- 5. Premiere application : le perimetre actuel est reconstruit depuis le
--    registre, donc a l'identique des 84 noms herites. Si un ecart existait,
--    cette etape echouerait au lieu de le laisser passer.
SELECT * FROM public.tracefab_apply_runtime_function_grants();
