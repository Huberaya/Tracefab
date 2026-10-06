-- P1 catalogue import/export: durable import jobs with tenant-scoped audit metadata.
-- Completion events are written to the existing append-only audit_logs table.

CREATE TABLE IF NOT EXISTS tracefab_catalog_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  import_kind TEXT NOT NULL DEFAULT 'products' CHECK (import_kind IN ('products', 'suppliers')),
  source_filename TEXT NOT NULL CHECK (length(trim(source_filename)) BETWEEN 1 AND 240),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'completed_with_errors', 'rejected')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  rejected_rows INTEGER NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  error_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT catalog_import_counts_consistent CHECK (accepted_rows + rejected_rows <= total_rows)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_import_jobs_idempotency
  ON tracefab_catalog_import_jobs(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_import_jobs_org_created
  ON tracefab_catalog_import_jobs(organization_id, created_at DESC);

ALTER TABLE tracefab_catalog_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracefab_catalog_import_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY catalog_import_jobs_select_brand ON tracefab_catalog_import_jobs
  FOR SELECT TO PUBLIC USING (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'auditor']::membership_role[])
  );

CREATE POLICY catalog_import_jobs_insert_brand ON tracefab_catalog_import_jobs
  FOR INSERT TO PUBLIC WITH CHECK (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    AND actor_user_id = tracefab_current_user_id()
  );

CREATE POLICY catalog_import_jobs_update_brand ON tracefab_catalog_import_jobs
  FOR UPDATE TO PUBLIC USING (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) WITH CHECK (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

GRANT SELECT, INSERT, UPDATE ON tracefab_catalog_import_jobs TO PUBLIC;

COMMENT ON TABLE tracefab_catalog_import_jobs IS 'Tenant-scoped CSV catalogue imports. Stores hashes and row-level validation metadata, never raw source files.';
COMMENT ON COLUMN tracefab_catalog_import_jobs.source_sha256 IS 'SHA-256 of the submitted source content; raw catalogue files are not persisted.';
COMMENT ON COLUMN tracefab_catalog_import_jobs.error_rows IS 'Row-level validation codes and messages without raw source secrets.';
