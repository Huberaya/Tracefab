-- ============================================================================
-- 20261028120100 — l'identite worker cesse d'etre falsifiable
--
-- LE DEFAUT CORRIGE
--
-- Onze politiques RLS etaient gardees par un GUC de session :
--     current_setting('tracefab.worker_context', true) = 'true'
-- Or un GUC est positionnable par n'importe quel role. Mesure du 27/10/2026 sur
-- base jetable, role `tracefab_app` sans BYPASSRLS :
--     sans contexte : organizations 0 · users 0 · organization_memberships 0
--     apres SET     : organizations 2 · users 2 · organization_memberships 2
-- L'isolation ne reposait donc pas sur la base mais sur la bonne volonte de
-- l'appelant. Un correctif « GRANT SET ON PARAMETER » ne marche pas non plus :
-- mesure du 28/10/2026, `set_config()` et `SET` passent encore apres revocation.
--
-- LA CORRECTION
--
--   1. les onze politiques ne lisent plus le GUC mais `current_user` ;
--   2. `tracefab_worker` est une identite NOLOGIN : aucun mot de passe, aucune
--      session possible, donc aucun secret a creer ni a faire fuiter ;
--   3. `tracefab_app` ne peut pas endosser cette identite (aucune appartenance) ;
--   4. les operations systeme deviennent SIX FONCTIONS NOMMEES, POSSEDEES PAR
--      `tracefab_worker`, a portee etroite, declarees au registre runtime.
--
-- POURQUOI LES FONCTIONS APPARTIENNENT AU WORKER, ET NON AU PROPRIETAIRE DES
-- MIGRATIONS — c'est le point que la premiere version avait faux
--
-- Toutes les tables sensibles sont en FORCE ROW LEVEL SECURITY : meme le
-- proprietaire de la table est soumis aux politiques. Or `current_user` vaut le
-- PROPRIETAIRE a l'interieur d'une fonction SECURITY DEFINER. Une fonction
-- possedee par le proprietaire des migrations ne peut donc jamais satisfaire une
-- politique qui teste `current_user = 'tracefab_worker'`.
--
-- Mesure : fonction SECURITY DEFINER possedee par un proprietaire NON
-- superutilisateur, sous FORCE RLS -> **0 ligne**. Le meme essai en tant que
-- `postgres` (superutilisateur) rend 1 ligne : le superutilisateur contourne la
-- RLS, ce qui masque le defaut en test local et le revelation en production.
-- Le candidat precedent avait ete valide sous `postgres` ; il aurait donc ete
-- muet sur la base geree.
--
-- En possedant les fonctions, `tracefab_worker` rend `current_user` egal a
-- lui-meme a l'interieur de leur execution, et les politiques s'ouvrent pour
-- elles seules. Mesure : 1 ligne, alors que l'acces direct par `tracefab_app`
-- reste refuse.
--
-- CE QUE LA MIGRATION NE FAIT PAS
--   - aucun mot de passe, aucune connexion, aucun secret ;
--   - aucun privilege nouveau pour `tracefab_app` : elle n'executera que des
--     fonctions declarees au registre ;
--   - aucune donnee metier touchee ;
--   - aucune migration anterieure modifiee.
--
-- RETOUR ARRIERE
--   Voir docs/security/2026-10-28-correction-contexte-worker.md §7.
-- ============================================================================

-- 1. L'identite worker -------------------------------------------------------
-- Aucun SUPERUSER n'est requis : l'executant doit posseder CREATEROLE et les
-- fonctions existantes. Le role worker est cree directement avec ses attributs
-- minimaux. Un role preexistant non conforme est REFUSE, jamais « repare » par
-- ALTER ROLE (qui exigerait un superutilisateur sur PostgreSQL 16+).
DO $worker_role$
DECLARE
  v_role record;
  v_executor record;
BEGIN
  IF current_user = 'tracefab_app' THEN
    RAISE EXCEPTION 'worker_migration_requires_admin_role';
  END IF;

  SELECT rolsuper, rolcreaterole
    INTO v_executor
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;

  IF NOT FOUND OR NOT (v_executor.rolsuper OR v_executor.rolcreaterole) THEN
    RAISE EXCEPTION 'worker_role_creation_requires_createrole';
  END IF;

  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
    INTO v_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'tracefab_worker';

  IF NOT FOUND THEN
    CREATE ROLE tracefab_worker
      NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  ELSIF v_role.rolcanlogin
     OR v_role.rolsuper
     OR v_role.rolbypassrls
     OR v_role.rolcreaterole
     OR v_role.rolcreatedb
     OR v_role.rolinherit THEN
    RAISE EXCEPTION 'tracefab_worker_role_not_least_privilege';
  END IF;
END
$worker_role$;

-- 2. Les onze politiques ne lisent plus un GUC falsifiable -------------------
--    Remplacement fait depuis le catalogue : aucune liste ecrite a la main ne
--    peut se desynchroniser d'une politique ajoutee plus tard.
DO $$
DECLARE
  p RECORD;
  ancienne TEXT := 'current_setting(''tracefab.worker_context''::text, true) = ''true''::text';
  nouvelle TEXT := '(current_user = ''tracefab_worker''::name)';
  nq TEXT;
  nc TEXT;
  clauses TEXT;
  restantes INTEGER := 0;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND (qual LIKE '%tracefab.worker_context%' OR with_check LIKE '%tracefab.worker_context%')
     ORDER BY tablename, policyname
  LOOP
    nq := replace(p.qual, ancienne, nouvelle);
    nc := replace(p.with_check, ancienne, nouvelle);
    clauses := NULL;

    IF p.qual IS NOT NULL THEN
      IF nq IS NULL OR nq = p.qual THEN
        RAISE EXCEPTION 'politique % sur % : expression USING non reconnue, migration interrompue',
          p.policyname, p.tablename;
      END IF;
      clauses := format('USING (%s)', nq);
    END IF;

    IF p.with_check IS NOT NULL THEN
      IF nc IS NULL OR nc = p.with_check THEN
        RAISE EXCEPTION 'politique % sur % : expression WITH CHECK non reconnue, migration interrompue',
          p.policyname, p.tablename;
      END IF;
      clauses := concat_ws(' ', clauses, format('WITH CHECK (%s)', nc));
    END IF;

    IF clauses IS NULL THEN
      RAISE EXCEPTION 'politique % sur % : aucune clause a reecrire', p.policyname, p.tablename;
    END IF;

    EXECUTE format('ALTER POLICY %I ON %I.%I %s', p.policyname, p.schemaname, p.tablename, clauses);
    restantes := restantes + 1;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND (qual LIKE '%tracefab.worker_context%' OR with_check LIKE '%tracefab.worker_context%')
  ) THEN
    RAISE EXCEPTION 'il reste des politiques gardees par le GUC worker apres reecriture';
  END IF;

  RAISE NOTICE '% politique(s) worker indexee(s) desormais sur current_user', restantes;
END
$$;

-- 3. `tracefab_app` ne doit pas pouvoir endosser l'identite worker -----------
DO $$
BEGIN
  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    REVOKE tracefab_worker FROM tracefab_app;
    RAISE NOTICE 'appartenance tracefab_worker -> tracefab_app revoquee : elle permettait l''usurpation';
  END IF;
END
$$;

-- 4. Le worker reçoit temporairement CREATE pour devenir proprietaire
--    des six fonctions. CREATE sera retire immediatement apres le transfert.
GRANT USAGE, CREATE ON SCHEMA public TO tracefab_worker;

-- 5. Les six operations systeme ----------------------------------------------
--    Chacune : operation unique, parametree, `search_path` fige, aucune lecture
--    en masse. Elles seront possedees par `tracefab_worker` juste apres leur
--    creation (section 6), ce qui est la condition pour que les politiques
--    worker s'ouvrent a elles.

CREATE OR REPLACE FUNCTION tracefab_upsert_clerk_user(
  p_clerk_user_id TEXT,
  p_email TEXT,
  p_full_name TEXT
)
RETURNS TABLE (id UUID, email TEXT, full_name TEXT, out_clerk_user_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.users;
BEGIN
  IF p_clerk_user_id IS NULL OR btrim(p_clerk_user_id) = '' THEN
    RAISE EXCEPTION 'clerk_user_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_email IS NULL OR btrim(p_email) = '' OR position('@' IN p_email) = 0 THEN
    RAISE EXCEPTION 'clerk_email_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (clerk_user_id, email, full_name)
  VALUES (p_clerk_user_id, lower(btrim(p_email)), coalesce(nullif(btrim(p_full_name), ''), lower(btrim(p_email))))
  ON CONFLICT (clerk_user_id) DO UPDATE
    SET email = excluded.email,
        full_name = excluded.full_name,
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.id, v_row.email, v_row.full_name, v_row.clerk_user_id;
END
$$;

-- « Creer si absent » : ne reecrit jamais un compte existant. Le webhook Clerk
-- s'en sert avant de synchroniser une adhesion ; un upsert ecraserait l'e-mail
-- reel avec la valeur portee par l'evenement — une perte de donnee silencieuse.
CREATE OR REPLACE FUNCTION tracefab_ensure_clerk_user(
  p_clerk_user_id TEXT,
  p_email TEXT,
  p_full_name TEXT
)
RETURNS TABLE (id UUID, email TEXT, full_name TEXT, out_clerk_user_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.users;
BEGIN
  IF p_clerk_user_id IS NULL OR btrim(p_clerk_user_id) = '' THEN
    RAISE EXCEPTION 'clerk_user_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_email IS NULL OR btrim(p_email) = '' OR position('@' IN p_email) = 0 THEN
    RAISE EXCEPTION 'clerk_email_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (clerk_user_id, email, full_name)
  VALUES (p_clerk_user_id, lower(btrim(p_email)), coalesce(nullif(btrim(p_full_name), ''), lower(btrim(p_email))))
  ON CONFLICT (clerk_user_id) DO NOTHING;

  -- Alias obligatoire : les colonnes de sortie portent les memes noms que les
  -- colonnes de la table, et sans alias PostgreSQL refuse la reference.
  SELECT u.* INTO v_row FROM public.users u WHERE u.clerk_user_id = p_clerk_user_id;
  RETURN QUERY SELECT v_row.id, v_row.email, v_row.full_name, v_row.clerk_user_id;
END
$$;

CREATE OR REPLACE FUNCTION tracefab_soft_delete_clerk_user(p_clerk_user_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_clerk_user_id IS NULL OR btrim(p_clerk_user_id) = '' THEN
    RAISE EXCEPTION 'clerk_user_id_required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.users u
     SET email = 'deleted+' || p_clerk_user_id || '@invalid.tracefab.local',
         full_name = 'Deleted Clerk user',
         updated_at = now()
   WHERE u.clerk_user_id = p_clerk_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

CREATE OR REPLACE FUNCTION tracefab_clerk_organization_uuid(p_clerk_organization_id TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id FROM public.organizations o
   WHERE o.clerk_organization_id = p_clerk_organization_id
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION tracefab_archive_clerk_organization(p_clerk_organization_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_clerk_organization_id IS NULL OR btrim(p_clerk_organization_id) = '' THEN
    RAISE EXCEPTION 'clerk_organization_id_required' USING ERRCODE = '22023';
  END IF;

  SELECT o.id INTO v_id FROM public.organizations o
   WHERE o.clerk_organization_id = p_clerk_organization_id;
  IF v_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations SET status = 'archived', updated_at = now() WHERE id = v_id;
  UPDATE public.organization_memberships
     SET status = 'revoked'
   WHERE organization_id = v_id AND status <> 'revoked';
  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION tracefab_notification_outbox_health()
RETURNS TABLE (
  pending INTEGER,
  processing INTEGER,
  sent INTEGER,
  failed INTEGER,
  ready INTEGER,
  "staleProcessing" INTEGER,
  exhausted INTEGER,
  "oldestReadyAt" TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*) FILTER (WHERE o.status = 'pending')::integer,
    COUNT(*) FILTER (WHERE o.status = 'processing')::integer,
    COUNT(*) FILTER (WHERE o.status = 'sent')::integer,
    COUNT(*) FILTER (WHERE o.status = 'failed')::integer,
    COUNT(*) FILTER (WHERE o.status IN ('pending', 'failed') AND o.available_at <= now() AND o.attempts < 5)::integer,
    COUNT(*) FILTER (WHERE o.status = 'processing' AND o.locked_at < now() - interval '15 minutes')::integer,
    COUNT(*) FILTER (WHERE o.status = 'failed' AND o.attempts >= 5)::integer,
    MIN(o.available_at) FILTER (WHERE o.status IN ('pending', 'failed') AND o.available_at <= now() AND o.attempts < 5)
  FROM public.tracefab_notification_outbox o
$$;

-- 6. Propriete des fonctions : `tracefab_worker` -----------------------------
--    Le role executant est membre avec INHERIT + SET, sans ADMIN OPTION. Cela
--    permet le transfert de propriete et les migrations futures, sans lui
--    permettre de deleguer l'identite worker a un autre role.
--    CREATE est temporairement accorde au worker car PostgreSQL l'exige pour
--    ALTER FUNCTION ... OWNER TO ; il est retire juste apres.
DO $worker_ownership$
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT tracefab_worker TO %I WITH INHERIT TRUE, SET TRUE',
    current_user
  );

  EXECUTE 'ALTER FUNCTION public.tracefab_upsert_clerk_user(TEXT, TEXT, TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_ensure_clerk_user(TEXT, TEXT, TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_soft_delete_clerk_user(TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_clerk_organization_uuid(TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_archive_clerk_organization(TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_notification_outbox_health() OWNER TO tracefab_worker';
END
$worker_ownership$;

REVOKE CREATE ON SCHEMA public FROM tracefab_worker;

-- Verification ferme : le role executant peut endosser worker ; l'application
-- ne le peut jamais ; worker ne peut plus creer d'objets dans public.
--
-- PostgreSQL/Neon peut exposer DEUX lignes pour le meme couple membre/role :
-- CREATE ROLE cree une appartenance bootstrap avec ADMIN OPTION (sur Neon,
-- grantor = cloud_admin, INHERIT/SET = false), puis le GRANT ci-dessus ajoute
-- l'appartenance explicite minimale (grantor = current_user, INHERIT/SET =
-- true, ADMIN = false). La ligne bootstrap est geree par la plateforme et ne
-- peut pas etre revoquee par neondb_owner. Le controle distingue donc les deux
-- lignes au lieu de prendre arbitrairement la premiere avec SELECT INTO.
DO $worker_verify$
DECLARE
  v_member_oid OID;
  v_explicit_rows INTEGER := 0;
  v_bootstrap_rows INTEGER := 0;
  v_unexpected_rows INTEGER := 0;
BEGIN
  SELECT oid INTO v_member_oid
    FROM pg_catalog.pg_roles
   WHERE rolname = current_user;

  SELECT
    count(*) FILTER (
      WHERE m.grantor = v_member_oid
        AND m.inherit_option IS TRUE
        AND m.set_option IS TRUE
        AND m.admin_option IS FALSE
    ),
    count(*) FILTER (
      WHERE m.admin_option IS TRUE
        AND m.inherit_option IS FALSE
        AND m.set_option IS FALSE
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.pg_roles grantor
           WHERE grantor.oid = m.grantor
             AND (grantor.rolsuper OR grantor.rolcreaterole OR grantor.rolbypassrls)
        )
    ),
    count(*) FILTER (
      WHERE NOT (
        (m.grantor = v_member_oid
          AND m.inherit_option IS TRUE
          AND m.set_option IS TRUE
          AND m.admin_option IS FALSE)
        OR
        (m.admin_option IS TRUE
          AND m.inherit_option IS FALSE
          AND m.set_option IS FALSE
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_roles grantor
             WHERE grantor.oid = m.grantor
               AND (grantor.rolsuper OR grantor.rolcreaterole OR grantor.rolbypassrls)
          ))
      )
    )
    INTO v_explicit_rows, v_bootstrap_rows, v_unexpected_rows
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
   WHERE granted.rolname = 'tracefab_worker'
     AND member.rolname = current_user;

  IF v_explicit_rows <> 1
     OR v_bootstrap_rows > 1
     OR v_unexpected_rows <> 0 THEN
    RAISE EXCEPTION 'worker_migration_membership_not_minimal'
      USING DETAIL = pg_catalog.format(
        'explicit=%s bootstrap=%s unexpected=%s',
        v_explicit_rows, v_bootstrap_rows, v_unexpected_rows
      );
  END IF;

  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_must_not_be_worker_member';
  END IF;

  IF pg_catalog.has_schema_privilege('tracefab_worker', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'tracefab_worker_must_not_retain_schema_create';
  END IF;
END
$worker_verify$;

-- 7. Privileges du worker : le strict necessaire a ces six fonctions ---------
--    Rien n'est copie du role applicatif : chaque table listee ici est lue ou
--    ecrite par une des fonctions ci-dessus, et par aucune autre. Le worker
--    n'etant pas connectable, ces droits ne sont atteignables qu'a travers
--    elles.
GRANT SELECT, INSERT, UPDATE ON TABLE public.users TO tracefab_worker;
GRANT SELECT, UPDATE ON TABLE public.organizations TO tracefab_worker;
-- SELECT est indispensable en plus de UPDATE : une politique UPDATE lit les
-- lignes pour evaluer son USING. Mesure : sans lui, « permission denied for
-- table organization_memberships ».
GRANT SELECT, UPDATE ON TABLE public.organization_memberships TO tracefab_worker;
GRANT SELECT ON TABLE public.tracefab_notification_outbox TO tracefab_worker;
-- Deux tables referencees par les politiques permissives evaluees sur les
-- tables ci-dessus. Toutes les politiques permissives etant combinees par OR,
-- chacune doit pouvoir etre evaluee : un droit manquant fait echouer la requete
-- au lieu de la restreindre. Ensemble determine depuis pg_policies, pas devine.
GRANT SELECT ON TABLE public.brand_supplier_relationships TO tracefab_worker;
GRANT SELECT ON TABLE public.organization_invitations TO tracefab_worker;

-- Le worker doit aussi pouvoir EXECUTER les fonctions d'aide que les politiques
-- de ces quatre tables appellent : une politique est evaluee avec les droits de
-- l'appelant, qui est ici `tracefab_worker`. Mesure : sans ces octrois,
-- l'upsert echoue sur « permission denied for function tracefab_current_user_id ».
-- La liste est volontairement limitee aux helpers effectivement references par
-- les politiques des tables que ces fonctions touchent — pas les 84 fonctions
-- du registre. Le worker n'etant pas connectable, ces droits ne sont
-- atteignables qu a l interieur des six fonctions ci-dessus.
GRANT EXECUTE ON FUNCTION public.tracefab_current_user_email() TO tracefab_worker;
GRANT EXECUTE ON FUNCTION public.tracefab_current_user_id() TO tracefab_worker;
GRANT EXECUTE ON FUNCTION public.tracefab_has_org_role(UUID, public.membership_role[]) TO tracefab_worker;
GRANT EXECUTE ON FUNCTION public.tracefab_is_org_member(UUID) TO tracefab_worker;

-- 7 bis. Retrait d un privilege devenu inutile -------------------------------
--    Les ecritures sur `users` ne passent plus par le role applicatif : elles
--    passent par les deux fonctions ci-dessus, possedees par `tracefab_worker`.
--    Le privilege d ecriture directe devient donc sans usage, et un privilege
--    sans usage est une surface d attaque gratuite. On le RETIRE — c est une
--    reduction, jamais un elargissement.
--    Verifie avant : plus aucune ecriture sur `users` dans api/, ni par
--    methode de modele Prisma, ni en SQL (test:tables-ecriture-directe).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.users FROM tracefab_app';
  END IF;
END
$$;

-- 8. Enregistrement au registre runtime --------------------------------------
--    C'est ici que se joue le deblocage du chantier : ces six noms sont
--    DECLARES dans le registre cree par 20261028120000, puis les droits sont
--    reconstruits par la fonction d'application. Aucune liste figee dans une
--    migration anterieure n'est modifiee : l'historique reste intact.
--
--    Si l'une de ces fonctions n'existait pas, l'application echouerait en 42883
--    au lieu d'accorder silencieusement un droit sur du vide.
INSERT INTO public.tracefab_runtime_function_registry (name, registered_by) VALUES
  ('tracefab_archive_clerk_organization', '20261028120100_worker_identity_not_forgeable'),
  ('tracefab_clerk_organization_uuid',    '20261028120100_worker_identity_not_forgeable'),
  ('tracefab_ensure_clerk_user',          '20261028120100_worker_identity_not_forgeable'),
  ('tracefab_notification_outbox_health', '20261028120100_worker_identity_not_forgeable'),
  ('tracefab_soft_delete_clerk_user',     '20261028120100_worker_identity_not_forgeable'),
  ('tracefab_upsert_clerk_user',          '20261028120100_worker_identity_not_forgeable')
ON CONFLICT (name) DO NOTHING;

REVOKE ALL ON FUNCTION tracefab_upsert_clerk_user(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_ensure_clerk_user(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_soft_delete_clerk_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_clerk_organization_uuid(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_archive_clerk_organization(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_notification_outbox_health() FROM PUBLIC;

-- Application : les droits de `tracefab_app` sont reconstruits a partir du
-- registre. Les 84 fonctions heritees restent ouvertes, les 6 nouvelles
-- s'ajoutent, et toute fonction hors registre fait echouer la migration.
SELECT * FROM public.tracefab_apply_runtime_function_grants();
