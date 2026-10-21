-- Least-privilege DML for tracefab_app.
--
-- The runtime writes directly to a subset of tables, but the historical
-- grants gave INSERT, UPDATE and DELETE on every such table. Keep only the
-- verbs observed in the application code. Mutations on other tables must use
-- reviewed SECURITY DEFINER entry points.
--
-- Idempotent and data-preserving: this changes ACLs only; it does not alter
-- rows, table definitions, RLS policies, or application data.

DO $least_privilege_dml$
DECLARE
  item record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    RAISE NOTICE 'tracefab_app absent; bootstrap will apply the reviewed DML matrix';
    RETURN;
  END IF;

  -- Clear historical table-level write/structural grants before rebuilding
  -- the explicit allowlist. SELECT grants and sequence privileges are kept.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON ALL TABLES IN SCHEMA public FROM tracefab_app;

  FOR item IN
    SELECT * FROM (VALUES
      ('audit_logs', ARRAY['INSERT']::text[]),
      ('data_points', ARRAY['INSERT']::text[]),
      ('data_shares', ARRAY['INSERT']::text[]),
      ('documents', ARRAY['UPDATE']::text[]),
      ('materials', ARRAY['INSERT']::text[]),
      ('organization_invitations', ARRAY['INSERT','UPDATE']::text[]),
      ('organization_memberships', ARRAY['UPDATE']::text[]),
      ('organizations', ARRAY['UPDATE']::text[]),
      ('plm_erp_integrations', ARRAY['INSERT','UPDATE']::text[]),
      ('plm_erp_sync_jobs', ARRAY['INSERT']::text[]),
      ('product_green_claims', ARRAY['INSERT']::text[]),
      ('product_identifiers', ARRAY['INSERT','UPDATE']::text[]),
      ('product_materials', ARRAY['INSERT','UPDATE']::text[]),
      ('quality_cap_messages', ARRAY['INSERT']::text[]),
      ('rate_limit_counters', ARRAY['INSERT','UPDATE','DELETE']::text[]),
      ('supplier_sites', ARRAY['INSERT','UPDATE']::text[]),
      ('tracefab_catalog_import_jobs', ARRAY['INSERT','UPDATE']::text[]),
      ('tracefab_products', ARRAY['INSERT','UPDATE']::text[]),
      ('users', ARRAY['INSERT','UPDATE']::text[])
    ) AS allowlist(table_name, privileges)
  LOOP
    IF to_regclass(format('public.%I', item.table_name)) IS NULL THEN
      RAISE NOTICE 'table public.% absent; DML grant skipped', item.table_name;
      CONTINUE;
    END IF;

    EXECUTE format(
      'GRANT %s ON TABLE %I.%I TO tracefab_app',
      array_to_string(item.privileges, ', '),
      'public',
      item.table_name
    );
  END LOOP;
END
$least_privilege_dml$;
