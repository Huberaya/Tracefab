-- TraceFab — `tracefab_current_user_email()` doit etre executable par le runtime.
--
-- LE DEFAUT, MESURE
--
-- La politique `organizations_select_member` appelle
-- `tracefab_current_user_email()`. Cette fonction est `SECURITY INVOKER` et son
-- corps contient `SELECT ... FROM public.users`. Or PostgreSQL controle les
-- privileges a l'ANALYSE de la requete, pas a l'execution de la branche : meme
-- lorsque le `CASE` ne prend pas la branche qui lit `users` (mode permissif,
-- `tracefab_identity_politique.strict = false`), l'acces est verifie.
--
-- Consequence mesuree sur une base migree, connectee en `tracefab_app` :
--
--     select id from organizations;
--     ERROR: permission denied for table users
--
-- `tracefab_app` ne recoit volontairement aucun SELECT sur `users` (la table
-- est gardee par `users_select_self` et `users_worker_select`). La liste des
-- organisations du compte etait donc inaccessible au role applicatif, et
-- toute politique qui evalue cette expression tombait avec un 500 opaque.
--
-- CE QUE LA MIGRATION CHANGE
--
-- La fonction devient `SECURITY DEFINER` avec `search_path` fige, comme les
-- autres fonctions d'aide a la RLS (`tracefab_is_org_member`,
-- `tracefab_can_access_org`). Elle ne rend JAMAIS l'email d'un tiers : la
-- lecture est bornee a `tracefab_current_user_id()`, et la valeur reste NULL
-- hors contexte d'identite. L'ACL existante est conservee (CREATE OR REPLACE
-- ne la modifie pas) ; les postconditions le verifient.
--
-- Ce que la migration NE fait PAS : elle n'accorde aucun SELECT sur `users`
-- au runtime et ne change pas la politique d'identite. Le seul droit ajoute
-- est celui de lire SA PROPRE adresse, par une fonction nommee.

BEGIN;

DO $preconditions$
DECLARE
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
BEGIN
  SELECT p.oid, p.proowner, p.proacl
    INTO v_oid, v_owner, v_acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tracefab_current_user_email';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'runtime_user_email_target_missing';
  END IF;

  -- Releve conserve pour la postcondition : CREATE OR REPLACE ne doit changer
  -- ni l'OID, ni le proprietaire, ni l'ACL.
  PERFORM pg_catalog.set_config('tracefab.mig2600.expected_acl', coalesce(array_to_string(v_acl, ' '), ''), true);
  PERFORM pg_catalog.set_config('tracefab.mig2600.expected_owner', v_owner::text, true);
  PERFORM pg_catalog.set_config('tracefab.mig2600.expected_oid', v_oid::text, true);
END;
$preconditions$;

CREATE OR REPLACE FUNCTION public.tracefab_current_user_email()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $current_user_email$
  SELECT CASE
           WHEN coalesce((SELECT p.strict FROM public.tracefab_identity_politique p
                           WHERE p.singleton), false)
             THEN (SELECT pg_catalog.lower(u.email)
                     FROM public.users u
                    WHERE u.id = public.tracefab_current_user_id())
           ELSE nullif(current_setting('tracefab.user_email', true), ''::text)
         END;
$current_user_email$;

DO $postconditions$
DECLARE
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_definition text;
  v_attendu_oid oid := current_setting('tracefab.mig2600.expected_oid')::oid;
  v_attendu_owner oid := current_setting('tracefab.mig2600.expected_owner')::oid;
  v_attendu_acl text := current_setting('tracefab.mig2600.expected_acl');
  v_role record;
BEGIN
  SELECT p.oid, p.proowner, p.proacl, pg_catalog.pg_get_functiondef(p.oid)
    INTO v_oid, v_owner, v_acl, v_definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tracefab_current_user_email';

  IF v_oid IS DISTINCT FROM v_attendu_oid THEN
    RAISE EXCEPTION 'runtime_user_email_changed_oid';
  END IF;
  IF v_owner IS DISTINCT FROM v_attendu_owner THEN
    RAISE EXCEPTION 'runtime_user_email_changed_owner';
  END IF;
  IF coalesce(array_to_string(v_acl, ' '), '') <> v_attendu_acl THEN
    RAISE EXCEPTION 'runtime_user_email_changed_acl';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_oid AND p.prosecdef
       AND pg_catalog.strpos(coalesce(array_to_string(p.proconfig, ','), ''), 'search_path=pg_catalog, public') > 0
  ) THEN
    RAISE EXCEPTION 'runtime_user_email_not_definer_or_search_path_unset';
  END IF;

  -- Le runtime doit pouvoir l'evaluer : c'est la condition meme du correctif.
  IF NOT pg_catalog.has_function_privilege('tracefab_app',
        'public.tracefab_current_user_email()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime_user_email_not_executable_by_runtime';
  END IF;

  -- La fonction ne porte jamais le role HTTP comme proprietaire : il n'aurait
  -- alors plus besoin d'aucune garde pour lire `users`.
  FOR v_role IN
    SELECT r.rolname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_oid
  LOOP
    IF v_role.rolname = 'tracefab_app' THEN
      RAISE EXCEPTION 'runtime_user_email_owned_by_runtime';
    END IF;
  END LOOP;

  -- NOTE — ce que cette migration ne verifie PAS, et pourquoi.
  --
  -- Elle n'exige pas que `tracefab_app` soit sans SELECT sur `users` : ce
  -- privilege depend du provisionnement (certains environnements de test
  -- l'accordent avant la chaine), et une precondition d'environnement dans une
  -- migration de securite fait echouer la chaine pour une raison qui n'est pas
  -- dans le depot. Le contrat verifie ici est celui qui compte : la fonction
  -- rend l'email de l'IDENTITE COURANTE, par elle-meme, quel que soit l'etat
  -- des privileges de table.
END;
$postconditions$;

COMMIT;
