-- Migration: 20261014110000_revoke_public_execute_public_context_functions
--
-- REVOKE PUBLIC EXECUTE sur les 5 fonctions de contexte public créées par
-- la migration 20261009180000_public_read_context (migration 35), GRANT
-- conditionnel à tracefab_app.
--
-- `tracefab_public_context`, `tracefab_product_is_public`,
-- `tracefab_material_is_public`, `tracefab_supplier_site_is_public` et
-- `tracefab_public_brand` sont les prédicats des politiques de lecture
-- publique et la seule porte d'exposition de la marque. Quatre d'entre eux
-- sont SECURITY DEFINER : ils contournent la RLS par construction. Les
-- laisser en EXECUTE PUBLIC (le défaut PostgreSQL, proacl NULL) permet à
-- n'importe quel rôle de la base de les invoquer directement — en
-- particulier `tracefab_public_brand`, qui lirait l'identité de marque
-- hors de tout contexte public.
--
-- Ces fonctions doivent rester exécutables par le rôle applicatif
-- `tracefab_app` : les politiques qui les appellent sont évaluées au nom
-- de l'appelant. On retire donc seulement le droit PUBLIC, et on réaccorde
-- explicitement le rôle applicatif.
--
-- Le GRANT est conditionnel, pour la même raison que dans la migration
-- 20261009180000 : le rôle existe déjà en production mais pas sur une base
-- vierge, où il est créé APRES les migrations (scripts/seed_rls_fixture.mjs,
-- qui pose ensuite GRANT EXECUTE ON ALL FUNCTIONS). Un GRANT inconditionnel
-- ferait échouer toute la chaîne de migrations sur une base neuve.

REVOKE EXECUTE ON FUNCTION tracefab_public_context() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_product_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_material_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_public_brand(uuid) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_public_context() TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_product_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_material_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_public_brand(uuid) TO tracefab_app;
  END IF;
END
$grants$;

-- Les fonctions d'autorisation des politiques RLS et les gardes de triggers
-- ont également pu conserver PUBLIC EXECUTE depuis leur création antérieure
-- à la révocation des privilèges par défaut. PUBLIC n'est pas requis :
-- tracefab_app reçoit un GRANT direct sur les prédicats appelés par ses
-- politiques; PostgreSQL n'exige pas EXECUTE PUBLIC à chaque déclenchement.
DO $hardening$
DECLARE
  function_row record;
  found_count integer;
  expected_names text[] := ARRAY[
    'tracefab_can_access_org',
    'tracefab_is_org_member',
    'tracefab_has_org_role',
    'tracefab_can_access_shared_subject',
    'tracefab_can_access_document',
    'tracefab_validate_subject_ownership',
    'tracefab_validate_membership_mutation',
    'tracefab_validate_relationship_organizations',
    'tracefab_validate_document_location',
    'tracefab_validate_share_relationship'
  ];
  app_predicates text[] := ARRAY[
    'tracefab_can_access_org',
    'tracefab_is_org_member',
    'tracefab_has_org_role',
    'tracefab_can_access_shared_subject',
    'tracefab_can_access_document'
  ];
BEGIN
  SELECT count(DISTINCT p.proname)::integer
    INTO found_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.prosecdef
     AND p.proname = ANY(expected_names);

  IF found_count <> cardinality(expected_names) THEN
    RAISE EXCEPTION
      'Hardening SECURITY DEFINER incomplet : % fonctions sur % attendues sont présentes',
      found_count, cardinality(expected_names);
  END IF;

  FOR function_row IN
    SELECT p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosecdef
       AND p.proname = ANY(expected_names)
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC',
      'public',
      function_row.function_name,
      function_row.identity_arguments
    );

    IF function_row.function_name = ANY(app_predicates)
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.%I(%s) TO %I',
        'public',
        function_row.function_name,
        function_row.identity_arguments,
        'tracefab_app'
      );
    END IF;
  END LOOP;
END
$hardening$;

