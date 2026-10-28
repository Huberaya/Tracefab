-- ============================================================================
-- 20261027200000 — l'identité worker cesse d'être falsifiable
--
-- LE DEFAUT CORRIGE
--   Onze politiques RLS étaient gardées par un GUC de session :
--       current_setting('tracefab.worker_context', true) = 'true'
--   Or un GUC est positionnable par n'importe quel rôle. Mesuré le 27/10/2026
--   sur base jetable (PostgreSQL 18.4, rôle `tracefab_app`, BYPASSRLS=false) :
--       sans contexte : organizations 0 · users 0 · organization_memberships 0
--       après SET     : organizations 2 · users 2 · organization_memberships 2
--   L'isolation ne reposait donc pas sur la base mais sur la bonne volonté de
--   l'appelant.
--
-- LA CORRECTION
--   1. une identité `tracefab_worker` NOLOGIN : elle ne peut pas ouvrir de
--      session, donc aucun mot de passe à gérer ni à faire fuiter ;
--   2. les politiques worker ne lisent plus un GUC mais `current_user` — une
--      valeur que l'appelant ne peut pas fabriquer : elle est fixée par la
--      connexion, ou par une fonction SECURITY DEFINER qui appartient au rôle ;
--   3. `tracefab_app` ne peut pas devenir ce rôle (aucune appartenance, et on
--      s'en assure explicitement) ;
--   4. `tracefab_worker` reçoit exactement les privilèges de `tracefab_app`,
--      ni plus ni moins : il n'ajoute aucun droit, il change seulement
--      l'identité sous laquelle les politiques worker s'ouvrent.
--
-- POURQUOI PAS UN GUC « PROTÉGÉ »
--   `GRANT SET ON PARAMETER` n'aiderait pas : le rôle qui doit légitimement
--   armer le contexte est celui-là même qui ne doit pas pouvoir le faire. Un
--   appelant unique ne peut pas être à la fois approuvé et suspect.
--
-- CE QUE LA MIGRATION NE FAIT PAS
--   - elle ne crée aucun mot de passe, aucune connexion, aucun secret ;
--   - elle n'élargit aucun privilège à `tracefab_app` ;
--   - elle ne touche à aucune donnée (aucun INSERT/UPDATE/DELETE de ligne).
--
-- RETOUR ARRIÈRE
--   La migration est réversible par un script SQL qui remet les politiques sur
--   le GUC (voir docs/security/2026-10-27-correction-contexte-worker.md).
--   Mais revenir au GUC, c'est rouvrir la faille : le retour arrière n'est
--   légitime que pour rétablir un service pendant une fenêtre de quelques
--   minutes, jamais comme état durable.
-- ============================================================================

-- 1. L'identité worker : non connectable, sans privilège d'administration -----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_worker') THEN
    CREATE ROLE tracefab_worker
      NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  ELSE
    -- Le role existe deja : on ne touche PAS a `LOGIN`. Les environnements
    -- jetables le creent connectable pour exercer reellement les chemins
    -- worker ; la production le cree ici, donc NOLOGIN. Forcer NOLOGIN sur un
    -- role preexistant casserait la base de test sans rien apporter.
    ALTER ROLE tracefab_worker
      NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  END IF;
END
$$;

-- 2. Les politiques worker ne lisent plus un GUC falsifiable ------------------
--    Le remplacement est fait depuis le catalogue : aucune liste écrite à la
--    main ne peut se désynchroniser d'une politique ajoutée plus tard.
DO $$
DECLARE
  p record;
  ancienne text := 'current_setting(''tracefab.worker_context''::text, true) = ''true''::text';
  nouvelle text := '(current_user = ''tracefab_worker''::name)';
  nq text;
  nc text;
  clauses text;
  restantes int := 0;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (qual LIKE '%tracefab.worker_context%' OR with_check LIKE '%tracefab.worker_context%')
     ORDER BY tablename, policyname
  LOOP
    nq := replace(p.qual, ancienne, nouvelle);
    nc := replace(p.with_check, ancienne, nouvelle);
    clauses := NULL;

    IF p.qual IS NOT NULL THEN
      IF nq IS NULL OR nq = p.qual THEN
        RAISE EXCEPTION 'politique % sur % : expression USING non reconnue (%), migration interrompue',
          p.policyname, p.tablename, p.qual;
      END IF;
      clauses := format('USING (%s)', nq);
    END IF;

    IF p.with_check IS NOT NULL THEN
      IF nc IS NULL OR nc = p.with_check THEN
        RAISE EXCEPTION 'politique % sur % : expression WITH CHECK non reconnue (%), migration interrompue',
          p.policyname, p.tablename, p.with_check;
      END IF;
      clauses := concat_ws(' ', clauses, format('WITH CHECK (%s)', nc));
    END IF;

    IF clauses IS NULL THEN
      RAISE EXCEPTION 'politique % sur % : aucune clause à réécrire', p.policyname, p.tablename;
    END IF;

    EXECUTE format('ALTER POLICY %I ON %I.%I %s',
      p.policyname, p.schemaname, p.tablename, clauses);
    restantes := restantes + 1;
  END LOOP;

  -- Une politique oubliée serait une porte laissée ouverte : on échoue plutôt
  -- que de migrer à moitié.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND (qual LIKE '%tracefab.worker_context%' OR with_check LIKE '%tracefab.worker_context%')
  ) THEN
    RAISE EXCEPTION 'il reste des politiques gardées par le GUC worker après réécriture';
  END IF;

  IF restantes = 0 THEN
    RAISE NOTICE 'aucune politique gardée par le GUC worker : rien à réécrire';
  ELSE
    RAISE NOTICE '% politique(s) worker indexée(s) désormais sur current_user', restantes;
  END IF;
END
$$;

-- 3. `tracefab_app` ne doit pas pouvoir endosser l'identité worker -----------
--    Aucune appartenance ne doit exister : `SET ROLE tracefab_worker` devient
--    alors impossible pour le rôle applicatif.
DO $$
BEGIN
  IF pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    REVOKE tracefab_worker FROM tracefab_app;
    RAISE NOTICE 'appartenance tracefab_worker -> tracefab_app révoquée : elle permettait l''usurpation';
  END IF;
END
$$;

-- 4. Le worker reçoit les privilèges du rôle applicatif, à l'identique --------
--    Ni plus (aucune escalade), ni moins (les mêmes requêtes doivent aboutir
--    sous la nouvelle identité). On copie les droits effectifs de la cible.
DO $$
DECLARE
  t record;
  priv text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('tracefab_app', format('public.%I', t.relname), priv) THEN
        EXECUTE format('GRANT %s ON TABLE public.%I TO tracefab_worker', priv, t.relname);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tracefab_worker', f.signature);
  END LOOP;
END
$$;

-- 5. Le worker garde l'usage du schéma, et rien de plus ---------------------
--    Retirer USAGE rendrait le rôle inutilisable ; le laisser tel quel
--    n'ajoute aucun droit. On retire en revanche CREATE, que ce rôle n'a
--    aucune raison de détenir.
GRANT USAGE ON SCHEMA public TO tracefab_worker;
REVOKE CREATE ON SCHEMA public FROM tracefab_worker;

DO $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication
    INTO r FROM pg_roles WHERE rolname = 'tracefab_worker';
  -- `rolcanlogin` n'est volontairement pas teste ici : la migration cree le
  -- role NOLOGIN (aucun mot de passe ne doit figurer dans un fichier versionne),
  -- et l'approvisionnement le rend connectable hors migration. Ce qui est
  -- interdit, en revanche, ce sont les attributs qui contournent la RLS ou
  -- elargissent les droits.
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
     OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'tracefab_worker porte un attribut interdit : super=% bypassrls=% createrole=% createdb=% replication=%',
      r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication;
  END IF;
END
$$;

-- ============================================================================
-- 6. Les operations systeme passent par des fonctions nommees
--
-- POURQUOI PAS UNE SECONDE CONNEXION
--
-- L'option « un role worker connectable, et un second client Prisma » a ete
-- ecartee pour deux raisons mesurees : elle exige un mot de passe de plus
-- (donc un nouveau secret et une modification de role sur la base geree), et
-- elle contredit l'invariant du depot « une seule variable de connexion, un
-- seul client Prisma », verifie par `test:inventaire:consommateurs`. Un
-- correctif qui casse un garde-fou existant n'en est pas un.
--
-- Le modele retenu est celui qui existe deja ici : 117 fonctions SECURITY
-- DEFINER, `search_path` fige, EXECUTE restreint. Ces six fonctions le
-- completent sans rien elargir :
--   - operation unique et parametree : aucune requete arbitraire ne passe ;
--   - aucune lecture en masse : l'upsert ne rend que la ligne qu'il ecrit ;
--   - EXECUTE retire a PUBLIC, accorde au seul role applicatif.
-- ============================================================================

-- Les colonnes de sortie sont prefixees `out_` : sans cela, elles portent les
-- memes noms que les colonnes de `users`, et `ON CONFLICT (clerk_user_id)`
-- devient ambigu (« column reference clerk_user_id is ambiguous »).
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

-- 7. Aucune fonction ouverte a PUBLIC ----------------------------------------
REVOKE ALL ON FUNCTION tracefab_upsert_clerk_user(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_ensure_clerk_user(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_soft_delete_clerk_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_clerk_organization_uuid(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_archive_clerk_organization(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_notification_outbox_health() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_upsert_clerk_user(TEXT, TEXT, TEXT) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_ensure_clerk_user(TEXT, TEXT, TEXT) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_soft_delete_clerk_user(TEXT) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_clerk_organization_uuid(TEXT) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_archive_clerk_organization(TEXT) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_notification_outbox_health() TO tracefab_app;
  END IF;
END
$$;
