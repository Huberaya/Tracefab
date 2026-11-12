-- P11 Neon compatibility: switch to tracefab_worker for ACL changes on worker-owned functions.
-- The function remains SECURITY INVOKER; the caller must hold temporary SET membership.
--
-- DEFAUT MESURE LE 2026-11-12 — `RESET ROLE` ne revient pas au role de l'appelant
--
-- Le corps ci-dessous revient de `tracefab_worker` par `RESET ROLE`. Or `RESET
-- ROLE` ne defait que le dernier `SET ROLE` de la SESSION : il retablit
-- l'utilisateur de session, pas celui que le runner avait etabli par
-- `SET LOCAL ROLE tracefab_migrator` avant d'appeler cette fonction.
--
-- Mesure, chaine du depot rejouee sur PostgreSQL 17.6 jetable, topologie CI
-- (session `tracefab_ci_admin` -> `SET LOCAL ROLE tracefab_migrator`, registre a
-- 84 noms) :
--
--     runner                        current_user = tracefab_migrator, registre = 84
--     SET ROLE tracefab_worker      current_user = tracefab_worker
--     RESET ROLE                    current_user = tracefab_ci_admin, registre = 0
--
-- Le registre etant en FORCE RLS avec une politique `current_user = proprietaire`,
-- cette identite ne voit AUCUNE ligne : `noms_enregistres` devient vide, les 84
-- GRANT sont REVOQUES, puis le controle 3.g refuse 84 fonctions d'un coup —
-- « Registre runtime : EXECUTE accorde hors registre : tracefab_accept_...
-- tracefab_waive_quality_issue ». C'est le rouge du job « Base — isolation RLS
-- executee ».
--
-- Le retour se fait desormais par `SET LOCAL ROLE <role d'entree>`, dont la
-- restauration est exacte (mesuree dans les deux sens). `SET LOCAL` est employe
-- partout, y compris au premier basculement : un role perime ne doit pas
-- survivre a la transaction.
CREATE OR REPLACE FUNCTION public.tracefab_apply_runtime_function_grants()
RETURNS TABLE (fonctions_autorisees INTEGER, fonctions_revoquees INTEGER)
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  -- Role d'ENTREE, capture avant tout changement d'identite : c'est lui qu'il
  -- faut retablir, et non l'utilisateur de session (voir le defaut mesure
  -- ci-dessus).
  role_entree TEXT := current_user;
  owner_oid OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  owner_name TEXT := current_user;
  app_oid OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app');
  -- Deux proprietaires de confiance, et deux seulement :
  --   * le proprietaire des migrations, pour les fonctions ordinaires ;
  --   * `tracefab_worker`, pour les fonctions qui doivent voir les tables
  --     protegees par FORCE RLS (voir 20261028120100).
  -- Une fonction enregistree appartenant a un AUTRE role est refusee plus bas.
  worker_oid OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker');
  proprietaires OID[];
  noms_enregistres TEXT[];
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
    IF NOT pg_catalog.pg_has_role(current_user, worker_oid, 'SET') THEN
      RAISE EXCEPTION 'Registre runtime : le role executant ne peut pas SET ROLE tracefab_worker.' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(r.name ORDER BY r.name), ARRAY[]::TEXT[])
    INTO noms_enregistres
    FROM public.tracefab_runtime_function_registry r;

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
    SELECT p.oid::pg_catalog.regprocedure AS signature, p.proowner AS proprietaire
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosecdef
       AND p.proowner = ANY (proprietaires)
  LOOP
    IF worker_oid IS NOT NULL AND f.proprietaire = worker_oid THEN EXECUTE 'SET LOCAL ROLE tracefab_worker'; END IF;
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature);
    IF worker_oid IS NOT NULL AND f.proprietaire = worker_oid THEN EXECUTE format('SET LOCAL ROLE %I', role_entree); END IF;
  END LOOP;

  -- 3.d — On repart de zero : tout EXECUTE accorde au role applicatif est
  --       retire. Les droits sont ensuite reconstruits a partir du registre,
  --       ce qui garantit qu'aucun droit residuel ne survit.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature, p.proowner AS proprietaire
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proowner = ANY (proprietaires)
       AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
  LOOP
    IF worker_oid IS NOT NULL AND f.proprietaire = worker_oid THEN EXECUTE 'SET LOCAL ROLE tracefab_worker'; END IF;
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM tracefab_app', f.signature);
    IF worker_oid IS NOT NULL AND f.proprietaire = worker_oid THEN EXECUTE format('SET LOCAL ROLE %I', role_entree); END IF;
    nb_revoquees := nb_revoquees + 1;
  END LOOP;

  -- 3.e — Les fonctions FUTURES ne doivent pas devenir executables en silence.
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM tracefab_app',
    owner_name
  );
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    owner_name
  );
  IF worker_oid IS NOT NULL AND worker_oid <> owner_oid THEN
    EXECUTE 'SET LOCAL ROLE tracefab_worker';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE tracefab_worker IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM tracefab_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE tracefab_worker IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
    EXECUTE format('SET LOCAL ROLE %I', role_entree);
  END IF;

  -- 3.f — Reconstruction : uniquement les noms du registre.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature, p.proowner AS proprietaire
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proowner = ANY (proprietaires)
       AND p.proname = ANY (noms_enregistres)
  LOOP
    IF worker_oid IS NOT NULL AND f.proprietaire = worker_oid THEN EXECUTE 'SET LOCAL ROLE tracefab_worker'; END IF;
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO tracefab_app', f.signature);
    IF worker_oid IS NOT NULL AND f.proprietaire = worker_oid THEN EXECUTE format('SET LOCAL ROLE %I', role_entree); END IF;
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

  -- 3.j — L identite d entree est retablie. Sans ce controle, une fonction qui
  --       rend le role changerait silencieusement l identite de tout ce que
  --       l appelant execute ensuite dans la meme transaction.
  IF current_user <> role_entree THEN
    RAISE EXCEPTION 'Registre runtime : identite non retablie (entree %, sortie %)',
      role_entree, current_user USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT nb_autorisees, nb_revoquees;
END
$$;

REVOKE ALL ON FUNCTION public.tracefab_apply_runtime_function_grants() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.tracefab_apply_runtime_function_grants() FROM tracefab_app';
  END IF;
END
$$;

COMMENT ON FUNCTION public.tracefab_apply_runtime_function_grants() IS 'Rebuilds runtime function grants, switching to tracefab_worker for worker-owned functions; SECURITY INVOKER.';
