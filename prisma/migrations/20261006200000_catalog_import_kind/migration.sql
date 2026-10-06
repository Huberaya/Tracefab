-- Backfill guard for environments where the P1 jobs table was created before
-- the typed products/suppliers distinction was added to the migration source.
ALTER TABLE IF EXISTS tracefab_catalog_import_jobs
  ADD COLUMN IF NOT EXISTS import_kind TEXT NOT NULL DEFAULT 'products';

DO $$
BEGIN
  ALTER TABLE tracefab_catalog_import_jobs
    ADD CONSTRAINT catalog_import_jobs_import_kind_check
    CHECK (import_kind IN ('products', 'suppliers'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN tracefab_catalog_import_jobs.import_kind IS 'Import domain: products or suppliers.';
