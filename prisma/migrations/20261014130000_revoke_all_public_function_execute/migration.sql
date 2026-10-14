-- TRACEFAB — fermer EXECUTE PUBLIC sur toutes les fonctions existantes du schéma public.
--
-- Les migrations historiques ont révoqué les droits sur les fonctions présentes
-- à leur date, mais des migrations ultérieures ont explicitement réaccordé
-- EXECUTE à PUBLIC. Une liste blanche de noms ne suffit donc pas : chaque
-- nouvelle fonction sensible pourrait rouvrir la même faille.
--
-- Le runtime Neon est le rôle serveur tracefab_app. Les politiques RLS et les
-- routes appellent les fonctions sous ce rôle ; les appels anonymes passent par
-- l'API, jamais par un rôle SQL PUBLIC. Les déclencheurs n'exigent pas EXECUTE
-- PUBLIC à chaque exécution.
--
-- Base vierge : tracefab_app peut ne pas exister pendant db:deploy. Le GRANT
-- est alors différé au seed, qui configure aussi les privilèges par défaut.
-- Production : si le rôle existe, le GRANT explicite préserve les appels du
-- runtime après le REVOKE. Toute l'opération est transactionnelle.

BEGIN;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $grant_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tracefab_app;
  END IF;
END
$grant_runtime$;

DO $verify_acl$
DECLARE
  exposed_functions text;
  runtime_missing text;
BEGIN
  SELECT string_agg(
           format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)),
           ', ' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
         )
    INTO exposed_functions
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND EXISTS (
       SELECT 1
         FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     );

  IF exposed_functions IS NOT NULL THEN
    RAISE EXCEPTION
      'Durcissement incomplet : EXECUTE PUBLIC subsiste sur : %',
      exposed_functions;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    SELECT string_agg(
             format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)),
             ', ' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
           )
      INTO runtime_missing
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND NOT has_function_privilege('tracefab_app', p.oid, 'EXECUTE');

    IF runtime_missing IS NOT NULL THEN
      RAISE EXCEPTION
        'Durcissement refusé : tracefab_app perd EXECUTE sur : %',
        runtime_missing;
    END IF;
  END IF;
END
$verify_acl$;

COMMIT;
