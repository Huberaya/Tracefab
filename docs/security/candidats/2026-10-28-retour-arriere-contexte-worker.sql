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

BEGIN;

-- 1. Les onze politiques reviennent au GUC ----------------------------------
--    ATTENTION : PostgreSQL reecrit le mot-cle en MAJUSCULES dans pg_policies
--    (CURRENT_USER). Un replace() qui ne vise qu'une seule casse ne remplacerait
--    RIEN, tout en laissant le script continuer : le role worker et le registre
--    seraient supprimes plus bas alors que les politiques seraient toujours
--    accrochees au role, et la base serait cassee en silence.
--    On traite donc les deux graphies, et le garde-fou qui suit refuse de
--    poursuivre si une politique n'a pas ete remise.
--    Piege voisin : dans un LIKE, '_' est un joker — '%tracefab_worker%'
--    matcherait aussi 'tracefab.worker_context'. On compare donc litteralement
--    avec strpos().
DO $$
DECLARE
  p RECORD;
  maj TEXT := '(CURRENT_USER = ''tracefab_worker''::name)';
  min TEXT := '(current_user = ''tracefab_worker''::name)';
  ancienne TEXT := '(current_setting(''tracefab.worker_context''::text, true) = ''true''::text)';
  nq TEXT;
  nc TEXT;
  clauses TEXT;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND (strpos(qual, 'tracefab_worker') > 0 OR strpos(with_check, 'tracefab_worker') > 0)
     ORDER BY tablename, policyname
  LOOP
    nq := replace(replace(p.qual, maj, ancienne), min, ancienne);
    nc := replace(replace(p.with_check, maj, ancienne), min, ancienne);
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

-- 1 bis. Garde-fou : aucune politique ne doit rester accrochee au role worker.
--        Bloc separe, donc etat relu apres les ALTER.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND (strpos(qual, 'tracefab_worker') > 0 OR strpos(with_check, 'tracefab_worker') > 0)
  ) THEN
    RAISE EXCEPTION 'retour_arriere_incomplet : politiques encore liees a tracefab_worker';
  END IF;
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

-- 5. Defaire 20261028120200 --------------------------------------------------
--    Les champs reserves de documents redeviennent ecrits par le role
--    applicatif, qui peut de nouveau poser le drapeau interne. C'est un
--    retour a l'etat FAUILLE : un adherent peut auto-approuver un document.
--    Le GRANT doit revenir AVANT que le code applicatif ne repasse au chemin
--    direct, sinon le parcours de scan echoue en 42501 entre les deux.
--    (l'etape 4 a deja detruit le registre : la ligne n'existe plus que si
--    l'etape 4 a ete sautee volontairement)
DO $$
BEGIN
  IF to_regclass('public.tracefab_runtime_function_registry') IS NOT NULL THEN
    DELETE FROM public.tracefab_runtime_function_registry
     WHERE name = 'tracefab_mark_document_scanning';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS public.tracefab_mark_document_scanning(UUID);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'GRANT INSERT, UPDATE, DELETE ON TABLE public.documents TO tracefab_app';
  END IF;
END
$$;

-- 5 bis. Garde-fou : documents doit avoir retrouve son ecriture pour l'app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app')
     AND NOT pg_catalog.has_table_privilege('tracefab_app', 'public.documents', 'UPDATE') THEN
    RAISE EXCEPTION 'retour_arriere_incomplet : tracefab_app ne peut pas ecrire dans documents';
  END IF;
END
$$;

COMMIT;

-- Apres execution, verifier que l'echelle est bien revenue a l'etat d'origine :
--   SELECT count(*) FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (strpos(coalesce(qual,''),'worker_context') > 0
--        OR strpos(coalesce(with_check,''),'worker_context') > 0);
-- Attendu : 11. (strpos et non LIKE : '_' est un joker dans LIKE, et
-- '%tracefab_worker%' matcherait aussi 'tracefab.worker_context'.)
-- Et se souvenir que ces 11 politiques sont EXACTEMENT la faille.
