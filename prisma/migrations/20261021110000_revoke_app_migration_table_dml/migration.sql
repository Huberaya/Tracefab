-- Remove migration-management writes from the application runtime role.
--
-- SECURITY: public._prisma_migrations is a technical ledger, not an application
-- table. It is the only relation in the production privilege inventory that
-- has no RLS and still grants INSERT/UPDATE/DELETE to tracefab_app.
--
-- Prisma deployment is performed by the controlled migration pipeline with its
-- migration-capable connection. The HTTP runtime must not be able to rewrite,
-- delete, or forge migration history.
--
-- Idempotent and deliberately leaves SELECT unchanged. No application data is
-- read, inserted, updated, or deleted by this migration.

DO $revoke_runtime_migration_dml$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public._prisma_migrations FROM tracefab_app';
  END IF;
END
$revoke_runtime_migration_dml$;
