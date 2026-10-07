-- P0 security hardening: SECURITY DEFINER functions must not be callable by PUBLIC.
-- The application owner retains implicit ownership privileges. Runtime roles must
-- receive explicit EXECUTE grants in a separate, reviewed role migration.
DO $$
DECLARE
  function_row record;
BEGIN
  FOR function_row IN
    SELECT n.nspname AS schema_name,
           p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prokind = 'f'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC',
      function_row.schema_name,
      function_row.function_name,
      function_row.identity_arguments
    );
  END LOOP;
END
$$;

-- Prevent future functions created by this migration owner from inheriting
-- PUBLIC EXECUTE by default. Explicit grants remain mandatory for app/worker
-- roles after the runtime role is separated from the migration owner.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END
$$;
