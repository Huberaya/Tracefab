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
-- Avant le REVOKE, les seuls privilèges relationnels PUBLIC déjà effectifs
-- pour tracefab_app sont transférés individuellement au rôle runtime. Aucun
-- privilège supplémentaire n'est accordé aux tables/séquences qui n'étaient
-- pas accessibles auparavant ; les GRANTs directs existants restent intacts.
-- La migration vérifie que les accès effectifs antérieurs sont conservés.
--
-- Base vierge : le seed peut compléter ensuite les droits de fixture, mais la
-- migration doit préserver à elle seule les accès que les ACL PUBLIC donnaient
-- déjà au runtime avant leur retrait.

BEGIN;

-- Photographier les droits effectifs du runtime AVANT de retirer PUBLIC.
-- Si l'application ne dispose que des droits hérités de PUBLIC, ces droits
-- sont transférés explicitement à tracefab_app avant la révocation. Cela évite
-- une panne silencieuse des requêtes en production, sans accorder au runtime
-- plus de droits qu'il n'en avait déjà.
CREATE TEMP TABLE tracefab_runtime_function_acl_before (
  routine_oid oid PRIMARY KEY
) ON COMMIT DROP;

CREATE TEMP TABLE tracefab_public_relation_acl_before (
  relation_oid oid NOT NULL,
  relkind "char" NOT NULL,
  privilege_type text NOT NULL,
  PRIMARY KEY (relation_oid, privilege_type)
) ON COMMIT DROP;

DO $preserve_runtime_acl$
DECLARE
  f record;
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    INSERT INTO tracefab_runtime_function_acl_before (routine_oid)
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE');

    -- Transférer uniquement EXECUTE PUBLIC qui est actuellement effectif.
    FOR f IN
      SELECT p.oid::regprocedure AS signature, p.prokind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind IN ('f', 'p')
         AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         AND EXISTS (
           SELECT 1
             FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )
    LOOP
      EXECUTE format(
        'GRANT EXECUTE ON %s %s TO tracefab_app',
        CASE WHEN f.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
        f.signature
      );
    END LOOP;

    -- Photographier puis transférer chaque privilège PUBLIC exact sur les
    -- relations applicatives possédées par le rôle de migration.
    INSERT INTO tracefab_public_relation_acl_before (relation_oid, relkind, privilege_type)
    SELECT c.oid, c.relkind, acl.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND acl.grantee = 0;

    FOR r IN
      SELECT c.oid::regclass AS relation_name, c.relkind, acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) acl
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         AND acl.grantee = 0
    LOOP
      IF r.relkind = 'S' THEN
        EXECUTE format('GRANT %s ON SEQUENCE %s TO tracefab_app', r.privilege_type, r.relation_name);
      ELSE
        EXECUTE format('GRANT %s ON TABLE %s TO tracefab_app', r.privilege_type, r.relation_name);
      END IF;
    END LOOP;
  END IF;
END
$preserve_runtime_acl$;

-- Ne pas modifier les fonctions d'extensions détenues par un rôle fournisseur
-- (ex. cloud_admin sur Neon/pgcrypto). Le rôle de migration ne possède pas
-- nécessairement ces fonctions et leur EXECUTE PUBLIC n'est pas un droit
-- applicatif TraceFab. Ne durcir que les fonctions dont current_user est propriétaire.
DO $revoke_owned_functions$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature, p.prokind
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON %s %s FROM PUBLIC', CASE WHEN f.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, f.signature);
  END LOOP;
END
$revoke_owned_functions$;
-- Même règle pour les relations : ne pas tenter de modifier les objets détenus
-- par un rôle fournisseur. L'inventaire Neon fourni montre que les relations
-- applicatives exposées sont détenues par neondb_owner.
DO $revoke_owned_relations$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS relation_name, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC', r.relation_name);
    ELSE
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC', r.relation_name);
    END IF;
  END LOOP;
END
$revoke_owned_relations$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Les droits PUBLIC nécessaires ont été transférés à tracefab_app avant les REVOKE.



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
     AND p.prokind IN ('f', 'p')
     AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
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
     AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
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
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
      INTO runtime_missing
      FROM tracefab_runtime_function_acl_before b
      JOIN pg_proc p ON p.oid = b.routine_oid
     WHERE NOT has_function_privilege('tracefab_app', b.routine_oid, 'EXECUTE');

    IF runtime_missing IS NOT NULL THEN
      RAISE EXCEPTION
        'Durcissement refusé : tracefab_app perd des droits EXECUTE auparavant effectifs sur : %',
        runtime_missing;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM tracefab_public_relation_acl_before b
       WHERE CASE WHEN b.relkind = 'S'
                  THEN NOT has_sequence_privilege('tracefab_app', b.relation_oid, b.privilege_type)
                  ELSE NOT has_table_privilege('tracefab_app', b.relation_oid, b.privilege_type)
             END
    ) THEN
      RAISE EXCEPTION
        'Durcissement refusé : tracefab_app perd un privilège relationnel précédemment accordé à PUBLIC';
    END IF;
  END IF;
END
$verify_acl$;

COMMIT;
