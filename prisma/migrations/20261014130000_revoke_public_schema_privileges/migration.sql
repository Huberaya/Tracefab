-- TRACEFAB — fermer les privilèges PUBLIC trop larges dans le schéma public.
--
-- Plusieurs migrations historiques accordent explicitement EXECUTE PUBLIC et
-- des privilèges de table/séquence à PUBLIC. Le durcissement du 7 octobre ne
-- couvrait que les fonctions SECURITY DEFINER présentes à cette date ; des
-- migrations postérieures ont réintroduit des droits publics.
--
-- Le runtime est un serveur de confiance connecté sous tracefab_app. Il doit
-- conserver ses GRANTs directs existants ; les routes publiques passent par
-- l'API et non par un rôle SQL PUBLIC. RLS reste la barrière ligne par ligne.
--
-- On ne réaccorde PAS les droits de table à tracefab_app ici : la migration ne
-- doit pas élargir ses privilèges directs, notamment sur _prisma_migrations.
-- Les droits runtime déjà existants sont préservés car REVOKE FROM PUBLIC ne
-- retire pas les GRANTs directs accordés au rôle applicatif.
--
-- Base vierge : le seed attribue ensuite les droits applicatifs requis. Les
-- vérifications de cette migration portent sur l'absence de privilèges PUBLIC
-- et sur la conservation d'EXECUTE pour tracefab_app.

BEGIN;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

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
  exposed_relations text;
  public_schema_create boolean;
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

  SELECT string_agg(
           format('%I [%s]', c.relname, c.relkind),
           ', ' ORDER BY c.relname
         )
    INTO exposed_relations
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND c.relacl IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM aclexplode(c.relacl) acl
        WHERE acl.grantee = 0
     );

  IF exposed_relations IS NOT NULL THEN
    RAISE EXCEPTION
      'Durcissement incomplet : privilèges PUBLIC subsistent sur les relations/séquences : %',
      exposed_relations;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
     WHERE n.nspname = 'public'
       AND acl.grantee = 0
       AND acl.privilege_type = 'CREATE'
  )
    INTO public_schema_create;

  IF public_schema_create THEN
    RAISE EXCEPTION
      'Durcissement incomplet : PUBLIC conserve CREATE sur le schéma public';
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
