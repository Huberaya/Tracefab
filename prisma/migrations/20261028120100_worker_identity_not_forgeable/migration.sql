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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    CREATE ROLE tracefab_worker
      NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  ELSE
    -- On ne touche pas a LOGIN : les environnements jetables rendent ce role
    -- connectable pour eprouver les chemins worker, la production le cree ici,
    -- donc NOLOGIN. Forcer NOLOGIN casserait la base de test sans rien apporter.
    ALTER ROLE tracefab_worker
      NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  END IF;
END
$$;

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

-- 4. Le worker garde l'usage du schema, et rien de plus ----------------------
GRANT USAGE ON SCHEMA public TO tracefab_worker;
REVOKE CREATE ON SCHEMA public FROM tracefab_worker;

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
--    C'est ce transfert qui rend les politiques worker efficaces. Attribuer la
--    propriete d'un objet exige d'etre membre du role cible (ou superutilisateur).
--    L'octroi ci-dessous est donc technique et borne au role qui execute les
--    migrations ; il n'ouvre rien a `tracefab_app`.
DO $$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'MEMBER') THEN
    EXECUTE pg_catalog.format('GRANT tracefab_worker TO %I', current_user);
  END IF;

  EXECUTE 'ALTER FUNCTION public.tracefab_upsert_clerk_user(TEXT, TEXT, TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_ensure_clerk_user(TEXT, TEXT, TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_soft_delete_clerk_user(TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_clerk_organization_uuid(TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_archive_clerk_organization(TEXT) OWNER TO tracefab_worker';
  EXECUTE 'ALTER FUNCTION public.tracefab_notification_outbox_health() OWNER TO tracefab_worker';
END
$$;

-- 6 bis. L appartenance technique est retiree ---------------------------------
--    Attribuer la propriete d un objet exige d etre membre du role cible. Une
--    fois le transfert fait, cette appartenance ne sert plus : la laisser en
--    place donnerait au proprietaire des migrations un `SET ROLE tracefab_worker`
--    permanent, donc une identite de plus a defendre. On la retire.
--    Consequence a connaitre : une migration ULTERIEURE qui voudrait changer le
--    proprietaire d une de ces fonctions devra re-accorder l appartenance le
--    temps du transfert, puis la retirer de la meme facon.
DO $$
BEGIN
  -- `pg_has_role` rend vrai pour un superutilisateur meme sans octroi explicite
  -- (il est membre implicite de tout role). On interroge donc pg_auth_members :
  -- seule une appartenance REELLEMENT accordee a quelque chose a retirer.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
      JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
     WHERE r.rolname = current_user
       AND c.rolname = 'tracefab_worker'
  ) THEN
    EXECUTE pg_catalog.format('REVOKE tracefab_worker FROM %I', current_user);
  END IF;
END
$$;

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
