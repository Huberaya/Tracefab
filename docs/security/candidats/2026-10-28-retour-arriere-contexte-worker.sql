-- ============================================================================
-- RETOUR ARRIERE du correctif de contexte worker — A N'EXECUTER QUE SUR
-- DECISION EXPLICITE, PENDANT UNE FENETRE DE RETABLISSEMENT COURTE.
--
-- Ce script remet la base dans l'etat d'AVANT 20261028120100, c'est-a-dire
-- AVEC LA FAILLE OUVERTE : onze politiques RLS s'ouvriront de nouveau sur un
-- GUC que n'importe quel role peut poser. Il existe pour retablir un service
-- casse, jamais pour rester en place.
--
-- Il ne touche ni a l'historique ni a _prisma_migrations : les migrations
-- restent enregistrees, donc un redeploiement ne les rejouera pas. Un retour
-- arriere est un incident a documenter, pas une operation banale.
--
-- A executer sur une base dont on a la propriete, en une seule transaction.
-- ============================================================================
BEGIN;

-- 1. Les onze politiques reviennent au GUC ----------------------------------
DO $$
DECLARE
  p RECORD;
  actuelle TEXT := '(current_user = ''tracefab_worker''::name)';
  ancienne TEXT := 'current_setting(''tracefab.worker_context''::text, true) = ''true''::text';
  nq TEXT;
  nc TEXT;
  clauses TEXT;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND (qual LIKE '%tracefab_worker%' OR with_check LIKE '%tracefab_worker%')
     ORDER BY tablename, policyname
  LOOP
    nq := replace(p.qual, actuelle, ancienne);
    nc := replace(p.with_check, actuelle, ancienne);
    clauses := NULL;
    IF p.qual IS NOT NULL THEN
      clauses := format('USING (%s)', nq);
    END IF;
    IF p.with_check IS NOT NULL THEN
      clauses := concat_ws(' ', clauses, format('WITH CHECK (%s)', nc));
    END IF;
    IF clauses IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I %s', p.policyname, p.schemaname, p.tablename, clauses);
    END IF;
  END LOOP;
END
$$;

-- 2. Les fonctions repassent au proprietaire des migrations -----------------
--    (necessite d'etre membre de tracefab_worker le temps du transfert)
DO $$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'MEMBER') THEN
    EXECUTE pg_catalog.format('GRANT tracefab_worker TO %I', current_user);
  END IF;
  ALTER FUNCTION public.tracefab_upsert_clerk_user(TEXT, TEXT, TEXT) OWNER TO CURRENT_USER;
  ALTER FUNCTION public.tracefab_ensure_clerk_user(TEXT, TEXT, TEXT) OWNER TO CURRENT_USER;
  ALTER FUNCTION public.tracefab_soft_delete_clerk_user(TEXT) OWNER TO CURRENT_USER;
  ALTER FUNCTION public.tracefab_clerk_organization_uuid(TEXT) OWNER TO CURRENT_USER;
  ALTER FUNCTION public.tracefab_archive_clerk_organization(TEXT) OWNER TO CURRENT_USER;
  ALTER FUNCTION public.tracefab_notification_outbox_health() OWNER TO CURRENT_USER;
END
$$;

-- 3. Le role applicatif retrouve l'ecriture directe sur users ---------------
--    L'ancien chemin faisait un upsert Prisma sous le role de connexion.
--    Le code applicatif doit etre revenu a cette version dans le meme temps,
--    sinon il appelle des fonctions qui ne sont plus possedees par le worker
--    et qui ne verront donc plus rien.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'GRANT INSERT, UPDATE, DELETE ON TABLE public.users TO tracefab_app';
  END IF;
END
$$;

-- 4. Le registre et l'identite worker disparaissent -------------------------
DROP FUNCTION IF EXISTS public.tracefab_apply_runtime_function_grants();
DROP TABLE IF EXISTS public.tracefab_runtime_function_registry;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    DROP OWNED BY tracefab_worker;
    DROP ROLE tracefab_worker;
  END IF;
END
$$;

COMMIT;

-- Apres execution, verifier que l'echelle est bien revenue a l'etat d'origine :
--   SELECT count(*) FROM pg_policies
--    WHERE schemaname = 'public' AND coalesce(qual,'') LIKE '%worker_context%';
-- Attendu : 11.
-- Et se souvenir que ces 11 politiques sont EXACTEMENT la faille.
