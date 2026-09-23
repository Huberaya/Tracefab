-- Tracefab Neon initial migration
--
-- Canonical runtime database: PostgreSQL on Neon.
-- Authentication: Clerk. The API resolves Clerk's subject to users.clerk_user_id
-- and sets tracefab.user_id for each transaction before protected queries.
-- This migration deliberately does not create a public DPP projection.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION tracefab_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('tracefab.user_id', true), '')::UUID;
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_self ON users
  FOR SELECT TO PUBLIC USING (id = tracefab_current_user_id());
CREATE POLICY users_update_self ON users
  FOR UPDATE TO PUBLIC
  USING (id = tracefab_current_user_id())
  WITH CHECK (id = tracefab_current_user_id());


-- SOURCE: 20260922000000_tracefab_core.sql
-- Tracefab core domain
-- Chantier 1 — Architecture / Data Model
--
-- This migration is intentionally isolated from the historical Ethimarket schema.
-- It creates the first multi-tenant Tracefab bounded context with private-by-default
-- access policies. It does not create public Storage buckets.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Enumerations
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE organization_type AS ENUM ('brand', 'supplier', 'verifier', 'platform');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE organization_status AS ENUM ('invited', 'active', 'suspended', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'manager', 'contributor', 'viewer', 'auditor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_status AS ENUM ('invited', 'active', 'suspended', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE relationship_status AS ENUM ('invited', 'active', 'suspended', 'ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE supplier_onboarding_status AS ENUM ('not_started', 'invited', 'in_progress', 'submitted', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE node_type AS ENUM ('product', 'material', 'organization', 'site', 'process');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE supply_chain_link_type AS ENUM ('sourced_from', 'transformed_at', 'manufactured_at', 'supplied_by', 'contains', 'next_step');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE data_request_status AS ENUM ('draft', 'sent', 'in_progress', 'submitted', 'changes_requested', 'approved', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE data_request_item_status AS ENUM ('pending', 'answered', 'needs_review', 'accepted', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE data_type AS ENUM ('text', 'number', 'boolean', 'date', 'country', 'percentage', 'json', 'document');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE data_value_status AS ENUM ('declared', 'documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party', 'expired', 'needs_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_kind AS ENUM ('certificate', 'technical_spec', 'origin_proof', 'audit_report', 'invoice', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('uploaded', 'scanning', 'available', 'rejected', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_visibility AS ENUM ('private', 'shared', 'public_projection');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('pending', 'passed', 'failed', 'needs_review', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE dpp_readiness_status AS ENUM ('not_started', 'in_progress', 'data_ready', 'review_required', 'ready_to_publish', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE share_status AS ENUM ('active', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 2. Tenancy and organizations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type organization_type NOT NULL,
  legal_name TEXT NOT NULL CHECK (length(trim(legal_name)) > 0),
  display_name TEXT,
  country_code VARCHAR(2),
  registration_number TEXT,
  website TEXT,
  status organization_status NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL DEFAULT 'viewer',
  status membership_status NOT NULL DEFAULT 'active',
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  target_role membership_role NOT NULL DEFAULT 'viewer',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brand_supplier_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status relationship_status NOT NULL DEFAULT 'invited',
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  sharing_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (brand_organization_id <> supplier_organization_id),
  UNIQUE (brand_organization_id, supplier_organization_id)
);

-- -----------------------------------------------------------------------------
-- 3. Supplier and product domain
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  onboarding_status supplier_onboarding_status NOT NULL DEFAULT 'not_started',
  activity_types TEXT[] NOT NULL DEFAULT '{}',
  profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  last_submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  country_code VARCHAR(2) NOT NULL,
  address TEXT,
  city TEXT,
  postal_code TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  activity_types TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

CREATE TABLE IF NOT EXISTS tracefab_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reference TEXT NOT NULL CHECK (length(trim(reference)) > 0),
  sku TEXT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category TEXT,
  status product_status NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  public_slug TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_organization_id, reference),
  UNIQUE (brand_organization_id, public_slug)
);

CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  material_type TEXT NOT NULL CHECK (length(trim(material_type)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT,
  composition JSONB NOT NULL DEFAULT '{}'::jsonb,
  origin_country_code VARCHAR(2),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_materials (
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
  material_role TEXT NOT NULL DEFAULT 'main',
  percentage NUMERIC(7,4) CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  unit TEXT NOT NULL DEFAULT '%',
  product_version INTEGER NOT NULL DEFAULT 1 CHECK (product_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, material_id, material_role, product_version)
);

-- -----------------------------------------------------------------------------
-- 4. Traceability graph
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS supply_chain_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type node_type NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_site_id UUID REFERENCES supplier_sites(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  material_id UUID REFERENCES materials(id) ON DELETE CASCADE,
  process_code TEXT,
  label TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (organization_id IS NOT NULL OR supplier_site_id IS NOT NULL OR product_id IS NOT NULL OR material_id IS NOT NULL OR process_code IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS supply_chain_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES supply_chain_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES supply_chain_nodes(id) ON DELETE CASCADE,
  link_type supply_chain_link_type NOT NULL,
  sequence_number INTEGER,
  valid_from DATE,
  valid_until DATE,
  evidence_document_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_node_id <> target_node_id),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

-- -----------------------------------------------------------------------------
-- 5. Data collection
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  questionnaire_key TEXT NOT NULL,
  questionnaire_version TEXT NOT NULL,
  status data_request_status NOT NULL DEFAULT 'draft',
  due_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (brand_organization_id <> supplier_organization_id)
);

CREATE TABLE IF NOT EXISTS data_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_request_id UUID NOT NULL REFERENCES data_requests(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  data_type data_type NOT NULL,
  required BOOLEAN NOT NULL DEFAULT false,
  evidence_required BOOLEAN NOT NULL DEFAULT false,
  visibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  status data_request_item_status NOT NULL DEFAULT 'pending',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (data_request_id, field_key)
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT,
  kind document_kind NOT NULL DEFAULT 'other',
  status document_status NOT NULL DEFAULT 'uploaded',
  visibility document_visibility NOT NULL DEFAULT 'private',
  expires_at DATE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (storage_bucket, storage_path)
);

CREATE TABLE IF NOT EXISTS data_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_request_item_id UUID NOT NULL REFERENCES data_request_items(id) ON DELETE CASCADE,
  value JSONB NOT NULL,
  data_type data_type NOT NULL,
  status data_value_status NOT NULL DEFAULT 'declared',
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  responded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  supersedes_id UUID REFERENCES data_responses(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS data_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_site_id UUID REFERENCES supplier_sites(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  material_id UUID REFERENCES materials(id) ON DELETE CASCADE,
  data_key TEXT NOT NULL,
  value JSONB NOT NULL,
  data_type data_type NOT NULL,
  status data_value_status NOT NULL DEFAULT 'declared',
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  declared_by UUID REFERENCES users(id) ON DELETE SET NULL,
  valid_from DATE,
  valid_until DATE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_id UUID REFERENCES data_points(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(supplier_id, supplier_site_id, product_id, material_id) = 1),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE TABLE IF NOT EXISTS data_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES brand_supplier_relationships(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grantee_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  status share_status NOT NULL DEFAULT 'active',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (supplier_organization_id <> grantee_organization_id),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

-- -----------------------------------------------------------------------------
-- 6. Certifications, verification, quality and DPP
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_site_id UUID REFERENCES supplier_sites(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  standard_name TEXT NOT NULL,
  standard_code TEXT,
  issuer_name TEXT,
  certificate_number TEXT,
  issued_at DATE,
  expires_at DATE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  status data_value_status NOT NULL DEFAULT 'declared',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(supplier_id, supplier_site_id, product_id) >= 1),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at)
);

CREATE TABLE IF NOT EXISTS verification_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_point_id UUID REFERENCES data_points(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  certification_id UUID REFERENCES certifications(id) ON DELETE CASCADE,
  verifier_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  status verification_status NOT NULL DEFAULT 'pending',
  notes TEXT,
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(data_point_id, document_id, certification_id) >= 1)
);

CREATE TABLE IF NOT EXISTS data_quality_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  completeness NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (completeness BETWEEN 0 AND 100),
  freshness NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (freshness BETWEEN 0 AND 100),
  documentation_coverage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (documentation_coverage BETWEEN 0 AND 100),
  consistency NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (consistency BETWEEN 0 AND 100),
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocking_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculation_version TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(supplier_id, product_id) = 1)
);

CREATE TABLE IF NOT EXISTS dpp_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  product_version INTEGER NOT NULL CHECK (product_version > 0),
  requirement_profile_key TEXT NOT NULL,
  requirement_profile_version TEXT NOT NULL,
  readiness_status dpp_readiness_status NOT NULL DEFAULT 'not_started',
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocking_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  public_projection JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  computed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (product_id, product_version, requirement_profile_key, requirement_profile_version)
);

-- -----------------------------------------------------------------------------
-- 7. Audit
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deferred evidence FK: links are created after both tables exist.
ALTER TABLE supply_chain_links
  ADD CONSTRAINT supply_chain_links_evidence_document_fk
  FOREIGN KEY (evidence_document_id) REFERENCES documents(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 8. Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_memberships_user ON organization_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON organization_memberships(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON organization_invitations(lower(email));
CREATE INDEX IF NOT EXISTS idx_relationship_brand ON brand_supplier_relationships(brand_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_relationship_supplier ON brand_supplier_relationships(supplier_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_supplier_sites_supplier ON supplier_sites(supplier_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_brand ON tracefab_products(brand_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_product_materials_material ON product_materials(material_id);
CREATE INDEX IF NOT EXISTS idx_graph_product ON supply_chain_links(product_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_requests_supplier ON data_requests(supplier_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_brand ON data_requests(brand_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_request_items_request ON data_request_items(data_request_id, status);
CREATE INDEX IF NOT EXISTS idx_responses_item ON data_responses(data_request_item_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON documents(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_points_owner ON data_points(owner_organization_id, data_key, status);
CREATE INDEX IF NOT EXISTS idx_data_points_product ON data_points(product_id, data_key, version);
CREATE INDEX IF NOT EXISTS idx_data_points_supplier ON data_points(supplier_id, data_key, version);
CREATE INDEX IF NOT EXISTS idx_shares_relationship ON data_shares(relationship_id, status);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON data_shares(grantee_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_certifications_owner ON certifications(owner_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_certifications_expiry ON certifications(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verifications_owner ON verification_records(owner_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_quality_supplier ON data_quality_scores(supplier_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_product ON data_quality_scores(product_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dpp_product ON dpp_records(product_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(organization_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 9. Updated-at helper
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER organizations_set_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER relationships_set_updated_at
    BEFORE UPDATE ON brand_supplier_relationships
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER suppliers_set_updated_at
    BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER supplier_sites_set_updated_at
    BEFORE UPDATE ON supplier_sites
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER products_set_updated_at
    BEFORE UPDATE ON tracefab_products
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER materials_set_updated_at
    BEFORE UPDATE ON materials
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER requests_set_updated_at
    BEFORE UPDATE ON data_requests
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER data_points_set_updated_at
    BEFORE UPDATE ON data_points
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER certifications_set_updated_at
    BEFORE UPDATE ON certifications
    FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Subject ownership prevents a tenant from attaching another tenant's product,
-- material or site to an apparently local fact or certification.
CREATE OR REPLACE FUNCTION tracefab_validate_subject_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'data_points' THEN
    IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = NEW.supplier_id AND s.organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'supplier_owner_mismatch';
    END IF;

    IF NEW.supplier_site_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM supplier_sites ss
      JOIN suppliers s ON s.id = ss.supplier_id
      WHERE ss.id = NEW.supplier_site_id AND s.organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'supplier_site_owner_mismatch';
    END IF;

    IF NEW.product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = NEW.product_id AND p.brand_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'product_owner_mismatch';
    END IF;

    IF NEW.material_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM materials m
      WHERE m.id = NEW.material_id AND m.owner_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'material_owner_mismatch';
    END IF;

    IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = NEW.source_document_id AND d.owner_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'source_document_owner_mismatch';
    END IF;
  ELSE
    IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = NEW.supplier_id AND s.organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'supplier_owner_mismatch';
    END IF;

    IF NEW.supplier_site_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM supplier_sites ss
      JOIN suppliers s ON s.id = ss.supplier_id
      WHERE ss.id = NEW.supplier_site_id AND s.organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'supplier_site_owner_mismatch';
    END IF;

    IF NEW.product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = NEW.product_id AND p.brand_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'product_owner_mismatch';
    END IF;

    IF NEW.document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = NEW.document_id AND d.owner_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'document_owner_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_points_validate_subject_ownership
    BEFORE INSERT OR UPDATE ON data_points
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_subject_ownership();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER certifications_validate_subject_ownership
    BEFORE INSERT OR UPDATE ON certifications
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_subject_ownership();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 10. Tenant access helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_is_org_member(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = tracefab_current_user_id()
      AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION tracefab_has_org_role(p_organization_id UUID, p_roles membership_role[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = tracefab_current_user_id()
      AND m.status = 'active'
      AND m.role = ANY(p_roles)
  );
$$;

CREATE OR REPLACE FUNCTION tracefab_can_access_org(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tracefab_is_org_member(p_organization_id);
$$;

-- Cross-organization access is object-scoped. The share scope may contain:
-- {"all": true} or arrays such as {"document_ids": ["..."], "product_ids": ["..."]}.
CREATE OR REPLACE FUNCTION tracefab_can_access_shared_subject(
  p_supplier_organization_id UUID,
  p_subject_type TEXT,
  p_subject_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM data_shares s
    JOIN organization_memberships m
      ON m.organization_id = s.grantee_organization_id
     AND m.user_id = tracefab_current_user_id()
     AND m.status = 'active'
    WHERE s.supplier_organization_id = p_supplier_organization_id
      AND s.status = 'active'
      AND s.starts_at <= now()
      AND (s.ends_at IS NULL OR s.ends_at >= now())
      AND (
        COALESCE((s.scope ->> 'all')::boolean, false)
        OR CASE p_subject_type
          WHEN 'supplier' THEN COALESCE(s.scope -> 'supplier_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'supplier_site' THEN COALESCE(s.scope -> 'supplier_site_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'product' THEN COALESCE(s.scope -> 'product_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'material' THEN COALESCE(s.scope -> 'material_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'document' THEN COALESCE(s.scope -> 'document_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'data_point' THEN COALESCE(s.scope -> 'data_point_ids', '[]'::jsonb) ? p_subject_id::text
          WHEN 'certification' THEN COALESCE(s.scope -> 'certification_ids', '[]'::jsonb) ? p_subject_id::text
          ELSE false
        END
      )
  );
$$;

-- Bootstrap function: the first owner membership cannot be inserted through the
-- normal owner/admin RLS policy because no membership exists yet.
CREATE OR REPLACE FUNCTION tracefab_create_organization(
  p_type organization_type,
  p_legal_name TEXT,
  p_display_name TEXT DEFAULT NULL,
  p_country_code VARCHAR(2) DEFAULT NULL
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_organization organizations;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF p_type = 'platform' THEN
    RAISE EXCEPTION 'platform_organization_not_user_creatable';
  END IF;

  INSERT INTO organizations (type, legal_name, display_name, country_code, status, created_by)
  VALUES (p_type, p_legal_name, p_display_name, p_country_code, 'active', tracefab_current_user_id())
  RETURNING * INTO v_organization;

  INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at)
  VALUES (v_organization.id, tracefab_current_user_id(), 'owner', 'active', now());

  RETURN v_organization;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_create_organization(organization_type, TEXT, TEXT, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_create_organization(organization_type, TEXT, TEXT, VARCHAR) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_is_org_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_is_org_member(UUID) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_has_org_role(UUID, membership_role[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_has_org_role(UUID, membership_role[]) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_can_access_org(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_can_access_org(UUID) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_can_access_shared_subject(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_can_access_shared_subject(UUID, TEXT, UUID) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_set_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_set_updated_at() TO PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_subject_ownership() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_validate_subject_ownership() TO PUBLIC;

-- -----------------------------------------------------------------------------
-- 11. Row Level Security
-- -----------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_supplier_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracefab_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_chain_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_chain_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpp_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Organizations
CREATE POLICY organizations_select_member ON organizations
  FOR SELECT TO PUBLIC USING (tracefab_is_org_member(id));
CREATE POLICY organizations_insert_creator ON organizations
  FOR INSERT TO PUBLIC WITH CHECK (created_by = tracefab_current_user_id());
CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(id, ARRAY['owner', 'admin']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(id, ARRAY['owner', 'admin']::membership_role[]));

-- Memberships
CREATE POLICY memberships_select_member ON organization_memberships
  FOR SELECT TO PUBLIC USING (tracefab_is_org_member(organization_id));
CREATE POLICY memberships_insert_admin ON organization_memberships
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));
CREATE POLICY memberships_update_admin ON organization_memberships
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));

-- Invitations
CREATE POLICY invitations_select_admin ON organization_invitations
  FOR SELECT TO PUBLIC USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));
CREATE POLICY invitations_insert_admin ON organization_invitations
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]) AND invited_by = tracefab_current_user_id());
CREATE POLICY invitations_update_admin ON organization_invitations
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));

-- Relationships
CREATE POLICY relationships_select_participant ON brand_supplier_relationships
  FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));
CREATE POLICY relationships_insert_participant ON brand_supplier_relationships
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));
CREATE POLICY relationships_update_participant ON brand_supplier_relationships
  FOR UPDATE TO PUBLIC USING (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id))
  WITH CHECK (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));

-- Supplier profile and sites
CREATE POLICY suppliers_select_authorized ON suppliers
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(organization_id)
    OR tracefab_can_access_shared_subject(organization_id, 'supplier', id)
  );
CREATE POLICY suppliers_insert_admin ON suppliers
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));
CREATE POLICY suppliers_update_admin ON suppliers
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));

CREATE POLICY supplier_sites_select_authorized ON supplier_sites
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = supplier_sites.supplier_id
        AND (
          tracefab_can_access_org(s.organization_id)
          OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', supplier_sites.id)
        )
    )
  );
CREATE POLICY supplier_sites_insert_member ON supplier_sites
  FOR INSERT TO PUBLIC WITH CHECK (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_sites.supplier_id AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );
CREATE POLICY supplier_sites_update_member ON supplier_sites
  FOR UPDATE TO PUBLIC USING (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_sites.supplier_id AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_sites.supplier_id AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );

-- Products and materials
CREATE POLICY products_select_brand ON tracefab_products
  FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id));
CREATE POLICY products_insert_brand ON tracefab_products
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY products_update_brand ON tracefab_products
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY materials_select_authorized ON materials
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'material', id)
  );
CREATE POLICY materials_insert_owner ON materials
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY materials_update_owner ON materials
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY product_materials_select_authorized ON product_materials
  FOR SELECT TO PUBLIC USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_is_org_member(p.brand_organization_id))
    OR EXISTS (
      SELECT 1 FROM materials m
      WHERE m.id = product_materials.material_id
        AND (
          tracefab_can_access_org(m.owner_organization_id)
          OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id)
        )
    )
  );
CREATE POLICY product_materials_insert_brand ON product_materials
  FOR INSERT TO PUBLIC WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );
CREATE POLICY product_materials_update_brand ON product_materials
  FOR UPDATE TO PUBLIC USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );

-- Traceability
CREATE POLICY nodes_select_authorized ON supply_chain_nodes
  FOR SELECT TO PUBLIC USING (
    (organization_id IS NOT NULL AND tracefab_can_access_org(organization_id))
    OR (supplier_site_id IS NOT NULL AND EXISTS (SELECT 1 FROM supplier_sites ss JOIN suppliers s ON s.id = ss.supplier_id WHERE ss.id = supply_chain_nodes.supplier_site_id AND (tracefab_can_access_org(s.organization_id) OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', ss.id))))
    OR (product_id IS NOT NULL AND EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_nodes.product_id AND tracefab_is_org_member(p.brand_organization_id)))
    OR (material_id IS NOT NULL AND EXISTS (SELECT 1 FROM materials m WHERE m.id = supply_chain_nodes.material_id AND (tracefab_can_access_org(m.owner_organization_id) OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id))))
  );
CREATE POLICY nodes_insert_authorized ON supply_chain_nodes
  FOR INSERT TO PUBLIC WITH CHECK (
    (organization_id IS NOT NULL AND tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
    OR (product_id IS NOT NULL AND EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_nodes.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])))
  );
CREATE POLICY links_select_brand ON supply_chain_links
  FOR SELECT TO PUBLIC USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_links.product_id AND tracefab_is_org_member(p.brand_organization_id))
  );
CREATE POLICY links_insert_brand ON supply_chain_links
  FOR INSERT TO PUBLIC WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_links.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );

-- Requests and responses
CREATE POLICY requests_select_participant ON data_requests
  FOR SELECT TO PUBLIC USING (tracefab_can_access_org(brand_organization_id) OR tracefab_can_access_org(supplier_organization_id));
CREATE POLICY requests_insert_brand ON data_requests
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY requests_update_participant ON data_requests
  FOR UPDATE TO PUBLIC USING (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id))
  WITH CHECK (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));

CREATE POLICY request_items_select_participant ON data_request_items
  FOR SELECT TO PUBLIC USING (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND (tracefab_can_access_org(r.brand_organization_id) OR tracefab_can_access_org(r.supplier_organization_id)))
  );
CREATE POLICY request_items_insert_brand ON data_request_items
  FOR INSERT TO PUBLIC WITH CHECK (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );
CREATE POLICY request_items_update_participant ON data_request_items
  FOR UPDATE TO PUBLIC USING (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND (tracefab_is_org_member(r.brand_organization_id) OR tracefab_is_org_member(r.supplier_organization_id)))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND (tracefab_is_org_member(r.brand_organization_id) OR tracefab_is_org_member(r.supplier_organization_id)))
  );

CREATE POLICY responses_select_participant ON data_responses
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM data_request_items i JOIN data_requests r ON r.id = i.data_request_id
      WHERE i.id = data_responses.data_request_item_id
        AND (tracefab_can_access_org(r.brand_organization_id) OR tracefab_can_access_org(r.supplier_organization_id))
    )
  );
CREATE POLICY responses_insert_supplier ON data_responses
  FOR INSERT TO PUBLIC WITH CHECK (
    responded_by = tracefab_current_user_id()
    AND EXISTS (
      SELECT 1 FROM data_request_items i JOIN data_requests r ON r.id = i.data_request_id
      WHERE i.id = data_responses.data_request_item_id
        AND tracefab_has_org_role(r.supplier_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );
CREATE POLICY responses_update_supplier ON data_responses
  FOR UPDATE TO PUBLIC USING (responded_by = tracefab_current_user_id())
  WITH CHECK (responded_by = tracefab_current_user_id());

-- Documents and data points
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'document', id)
  );
CREATE POLICY documents_insert_owner ON documents
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_is_org_member(owner_organization_id) AND uploaded_by = tracefab_current_user_id());
CREATE POLICY documents_update_owner ON documents
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY data_points_select_authorized ON data_points
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'data_point', id)
  );
CREATE POLICY data_points_insert_owner ON data_points
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_is_org_member(owner_organization_id) AND declared_by = tracefab_current_user_id());
CREATE POLICY data_points_update_owner ON data_points
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY shares_select_participant ON data_shares
  FOR SELECT TO PUBLIC USING (tracefab_is_org_member(supplier_organization_id) OR tracefab_is_org_member(grantee_organization_id));
CREATE POLICY shares_insert_supplier ON data_shares
  FOR INSERT TO PUBLIC WITH CHECK (
    tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    AND EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = data_shares.relationship_id
        AND r.supplier_organization_id = data_shares.supplier_organization_id
        AND r.brand_organization_id = data_shares.grantee_organization_id
        AND r.status = 'active'
    )
  );
CREATE POLICY shares_update_supplier ON data_shares
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));

-- Certifications and verification
CREATE POLICY certifications_select_authorized ON certifications
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'certification', id)
  );
CREATE POLICY certifications_insert_owner ON certifications
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY certifications_update_owner ON certifications
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY verifications_select_authorized ON verification_records
  FOR SELECT TO PUBLIC USING (tracefab_can_access_org(owner_organization_id));
CREATE POLICY verifications_insert_authorized ON verification_records
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]));
CREATE POLICY verifications_update_authorized ON verification_records
  FOR UPDATE TO PUBLIC USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]));

CREATE POLICY quality_select_authorized ON data_quality_scores
  FOR SELECT TO PUBLIC USING (tracefab_can_access_org(owner_organization_id));
CREATE POLICY quality_insert_owner ON data_quality_scores
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));

CREATE POLICY dpp_select_brand ON dpp_records
  FOR SELECT TO PUBLIC USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = dpp_records.product_id AND tracefab_is_org_member(p.brand_organization_id))
  );
CREATE POLICY dpp_insert_brand ON dpp_records
  FOR INSERT TO PUBLIC WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = dpp_records.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
  );

-- Append-only audit log
CREATE POLICY audit_select_admin ON audit_logs
  FOR SELECT TO PUBLIC USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'auditor']::membership_role[]));
CREATE POLICY audit_insert_member ON audit_logs
  FOR INSERT TO PUBLIC WITH CHECK (tracefab_is_org_member(organization_id) AND actor_user_id = tracefab_current_user_id());

-- -----------------------------------------------------------------------------
-- 12. Explicit grants: anonymous users receive no Tracefab access through RLS.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT SELECT, INSERT, UPDATE ON
  organizations,
  organization_memberships,
  organization_invitations,
  brand_supplier_relationships,
  suppliers,
  supplier_sites,
  tracefab_products,
  materials,
  product_materials,
  supply_chain_nodes,
  supply_chain_links,
  data_requests,
  data_request_items,
  documents,
  data_responses,
  data_points,
  data_shares,
  certifications,
  verification_records,
  data_quality_scores,
  dpp_records,
  audit_logs
TO PUBLIC;
COMMENT ON SCHEMA public IS 'Tracefab core tables are protected by organization-scoped RLS. Anonymous access is intentionally not provided by this migration.';
COMMENT ON TABLE data_points IS 'Canonical supplier/product/material facts with explicit provenance and non-binary quality status.';
COMMENT ON TABLE dpp_records IS 'Versioned readiness computations; not a claim of final regulatory compliance.';
COMMENT ON TABLE audit_logs IS 'Append-only application audit events. Critical writes should later move behind trusted database functions.';

-- SOURCE: 20260922010000_tracefab_supplier_profile.sql
-- Tracefab Chantier 2 — Supplier Profile and invitation onboarding
--
-- This migration adds the first supplier-facing onboarding flow to the core
-- model. Invitation tokens are expected to be generated and hashed by a trusted
-- backend before calling tracefab_invite_supplier. Raw tokens never enter SQL.

-- -----------------------------------------------------------------------------
-- 1. Supplier profile fields and invitation relationship
-- -----------------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS profile_summary TEXT,
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS employee_count_range TEXT
    CHECK (employee_count_range IS NULL OR employee_count_range IN ('1_10', '11_50', '51_250', '251_1000', '1001_plus')),
  ADD COLUMN IF NOT EXISTS year_established INTEGER
    CHECK (year_established IS NULL OR year_established BETWEEN 1800 AND 2100),
  ADD COLUMN IF NOT EXISTS profile_completion NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (profile_completion BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS last_profile_updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS relationship_id UUID REFERENCES brand_supplier_relationships(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_invitations_relationship
  ON organization_invitations(relationship_id, accepted_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_suppliers_onboarding
  ON suppliers(onboarding_status, profile_completion);

-- -----------------------------------------------------------------------------
-- 2. Relationship integrity
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_relationship_organizations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_type organization_type;
  v_supplier_type organization_type;
BEGIN
  SELECT type INTO v_brand_type
  FROM organizations
  WHERE id = NEW.brand_organization_id;

  SELECT type INTO v_supplier_type
  FROM organizations
  WHERE id = NEW.supplier_organization_id;

  IF v_brand_type IS DISTINCT FROM 'brand'::organization_type
     OR v_supplier_type IS DISTINCT FROM 'supplier'::organization_type THEN
    RAISE EXCEPTION 'relationship_requires_brand_and_supplier_organizations';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_validate_share_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM brand_supplier_relationships r
    WHERE r.id = NEW.relationship_id
      AND r.supplier_organization_id = NEW.supplier_organization_id
      AND r.brand_organization_id = NEW.grantee_organization_id
  ) THEN
    RAISE EXCEPTION 'share_relationship_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_validate_invitation_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.relationship_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM brand_supplier_relationships r
    WHERE r.id = NEW.relationship_id
      AND r.supplier_organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'invitation_relationship_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER relationships_validate_organizations
    BEFORE INSERT OR UPDATE ON brand_supplier_relationships
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_relationship_organizations();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER shares_validate_relationship
    BEFORE INSERT OR UPDATE ON data_shares
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_share_relationship();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER invitations_validate_relationship
    BEFORE INSERT OR UPDATE ON organization_invitations
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_invitation_relationship();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Profile completeness
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_calculate_supplier_profile_completion(p_supplier_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_organization_id UUID;
  v_legal_name TEXT;
  v_country_code VARCHAR(2);
  v_profile_summary TEXT;
  v_contact_name TEXT;
  v_contact_email TEXT;
  v_activity_types TEXT[];
  v_has_active_site BOOLEAN;
  v_completed INTEGER := 0;
BEGIN
  SELECT
    s.organization_id,
    s.profile_summary,
    s.contact_name,
    s.contact_email,
    s.activity_types,
    EXISTS (
      SELECT 1 FROM supplier_sites ss
      WHERE ss.supplier_id = s.id AND ss.is_active = true
    )
  INTO
    v_organization_id,
    v_profile_summary,
    v_contact_name,
    v_contact_email,
    v_activity_types,
    v_has_active_site
  FROM suppliers s
  WHERE s.id = p_supplier_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT o.legal_name, o.country_code
  INTO v_legal_name, v_country_code
  FROM organizations o
  WHERE o.id = v_organization_id;

  IF length(trim(COALESCE(v_legal_name, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF v_country_code IS NOT NULL AND length(trim(v_country_code)) = 2 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_profile_summary, ''))) >= 30 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_contact_name, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF position('@' IN COALESCE(v_contact_email, '')) > 1 THEN
    v_completed := v_completed + 1;
  END IF;
  IF COALESCE(cardinality(v_activity_types), 0) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF v_has_active_site THEN
    v_completed := v_completed + 1;
  END IF;

  RETURN round((v_completed::NUMERIC / 7) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_completeness(p_supplier_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completion NUMERIC(5,2);
BEGIN
  v_completion := tracefab_calculate_supplier_profile_completion(p_supplier_id);

  UPDATE suppliers
  SET profile_completion = v_completion
  WHERE id = p_supplier_id;

  RETURN v_completion;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_from_supplier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM tracefab_refresh_supplier_profile_completeness(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_from_site()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_supplier_profile_completeness(OLD.supplier_id);
    RETURN OLD;
  END IF;

  PERFORM tracefab_refresh_supplier_profile_completeness(NEW.supplier_id);
  IF TG_OP = 'UPDATE' AND OLD.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
    PERFORM tracefab_refresh_supplier_profile_completeness(OLD.supplier_id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_from_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID;
BEGIN
  SELECT s.id INTO v_supplier_id
  FROM suppliers s
  WHERE s.organization_id = NEW.id;

  IF v_supplier_id IS NOT NULL THEN
    PERFORM tracefab_refresh_supplier_profile_completeness(v_supplier_id);
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER suppliers_profile_completeness_after_change
    AFTER INSERT OR UPDATE OF profile_summary, contact_name, contact_email, activity_types
    ON suppliers
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_supplier_profile_from_supplier();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER supplier_sites_refresh_profile
    AFTER INSERT OR UPDATE OR DELETE ON supplier_sites
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_supplier_profile_from_site();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER organizations_refresh_supplier_profile
    AFTER UPDATE OF legal_name, display_name, country_code ON organizations
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_supplier_profile_from_organization();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Trusted invitation creation and acceptance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_invite_supplier(
  p_brand_organization_id UUID,
  p_email TEXT,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_country_code VARCHAR(2),
  p_token_hash TEXT
)
RETURNS TABLE (
  relationship_id UUID,
  supplier_organization_id UUID,
  supplier_id UUID,
  invitation_id UUID,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_organization_id UUID;
  v_supplier_id UUID;
  v_relationship_id UUID;
  v_invitation_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_brand_type organization_type;
  v_email TEXT;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_admin_role_required';
  END IF;

  SELECT type INTO v_brand_type
  FROM organizations
  WHERE id = p_brand_organization_id;

  IF v_brand_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'brand_organization_required';
  END IF;

  v_email := lower(trim(COALESCE(p_email, '')));
  IF position('@' IN v_email) <= 1 OR length(v_email) < 5 THEN
    RAISE EXCEPTION 'valid_supplier_email_required';
  END IF;

  IF length(trim(COALESCE(p_legal_name, ''))) = 0 THEN
    RAISE EXCEPTION 'supplier_legal_name_required';
  END IF;

  IF length(trim(COALESCE(p_token_hash, ''))) < 32 THEN
    RAISE EXCEPTION 'hashed_invitation_token_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM organization_invitations i
    JOIN brand_supplier_relationships r ON r.id = i.relationship_id
    WHERE r.brand_organization_id = p_brand_organization_id
      AND lower(i.email) = v_email
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'active_supplier_invitation_exists';
  END IF;

  INSERT INTO organizations (
    type,
    legal_name,
    display_name,
    country_code,
    status,
    created_by
  )
  VALUES (
    'supplier',
    trim(p_legal_name),
    NULLIF(trim(p_display_name), ''),
    upper(NULLIF(trim(p_country_code), '')),
    'invited',
    tracefab_current_user_id()
  )
  RETURNING id INTO v_supplier_organization_id;

  INSERT INTO suppliers (
    organization_id,
    onboarding_status,
    last_profile_updated_by
  )
  VALUES (
    v_supplier_organization_id,
    'invited',
    tracefab_current_user_id()
  )
  RETURNING id INTO v_supplier_id;

  INSERT INTO brand_supplier_relationships (
    brand_organization_id,
    supplier_organization_id,
    status,
    requested_by
  )
  VALUES (
    p_brand_organization_id,
    v_supplier_organization_id,
    'invited',
    tracefab_current_user_id()
  )
  RETURNING id INTO v_relationship_id;

  v_expires_at := now() + interval '7 days';

  INSERT INTO organization_invitations (
    organization_id,
    relationship_id,
    email,
    target_role,
    token_hash,
    invited_by,
    expires_at
  )
  VALUES (
    v_supplier_organization_id,
    v_relationship_id,
    v_email,
    'owner',
    p_token_hash,
    tracefab_current_user_id(),
    v_expires_at
  )
  RETURNING id INTO v_invitation_id;

  RETURN QUERY SELECT
    v_relationship_id,
    v_supplier_organization_id,
    v_supplier_id,
    v_invitation_id,
    v_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_accept_organization_invitation(p_token_hash TEXT)
RETURNS TABLE (
  organization_id UUID,
  membership_id UUID,
  relationship_id UUID,
  supplier_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation organization_invitations;
  v_membership_id UUID;
  v_supplier_id UUID;
  v_auth_email TEXT;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  SELECT * INTO v_invitation
  FROM organization_invitations i
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL
    AND i.expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_or_expired_invitation';
  END IF;

  v_auth_email := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_auth_email = '' OR v_auth_email <> lower(v_invitation.email) THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM organization_memberships m
    WHERE m.organization_id = v_invitation.organization_id
      AND m.user_id = tracefab_current_user_id()
  ) THEN
    RAISE EXCEPTION 'user_already_member';
  END IF;

  INSERT INTO organization_memberships (
    organization_id,
    user_id,
    role,
    status,
    invited_by,
    joined_at
  )
  VALUES (
    v_invitation.organization_id,
    tracefab_current_user_id(),
    v_invitation.target_role,
    'active',
    v_invitation.invited_by,
    now()
  )
  RETURNING id INTO v_membership_id;

  UPDATE organization_invitations
  SET accepted_at = now()
  WHERE id = v_invitation.id;

  UPDATE organizations
  SET status = 'active'
  WHERE id = v_invitation.organization_id
    AND status = 'invited';

  IF v_invitation.relationship_id IS NOT NULL THEN
    UPDATE brand_supplier_relationships
    SET status = 'active',
        accepted_at = COALESCE(accepted_at, now())
    WHERE id = v_invitation.relationship_id;

    UPDATE suppliers
    SET onboarding_status = 'in_progress',
        last_profile_updated_by = tracefab_current_user_id()
    WHERE organization_id = v_invitation.organization_id
    RETURNING id INTO v_supplier_id;
  END IF;

  RETURN QUERY SELECT
    v_invitation.organization_id,
    v_membership_id,
    v_invitation.relationship_id,
    v_supplier_id;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_supplier_profile(
  p_supplier_id UUID,
  p_profile_summary TEXT,
  p_contact_name TEXT,
  p_contact_email TEXT,
  p_contact_phone TEXT,
  p_employee_count_range TEXT,
  p_year_established INTEGER,
  p_activity_types TEXT[]
)
RETURNS suppliers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier suppliers;
BEGIN
  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_supplier.organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_profile_role_required';
  END IF;

  UPDATE suppliers
  SET profile_summary = NULLIF(trim(p_profile_summary), ''),
      contact_name = NULLIF(trim(p_contact_name), ''),
      contact_email = lower(NULLIF(trim(p_contact_email), '')),
      contact_phone = NULLIF(trim(p_contact_phone), ''),
      employee_count_range = NULLIF(trim(p_employee_count_range), ''),
      year_established = p_year_established,
      activity_types = COALESCE(p_activity_types, '{}'::TEXT[]),
      onboarding_status = CASE
        WHEN onboarding_status IN ('invited', 'submitted', 'approved', 'rejected') THEN 'in_progress'
        ELSE onboarding_status
      END,
      last_profile_updated_by = tracefab_current_user_id()
  WHERE id = p_supplier_id;

  PERFORM tracefab_refresh_supplier_profile_completeness(p_supplier_id);

  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id;

  RETURN v_supplier;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_submit_supplier_profile(p_supplier_id UUID)
RETURNS suppliers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier suppliers;
  v_completion NUMERIC(5,2);
BEGIN
  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_supplier.organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_profile_role_required';
  END IF;

  v_completion := tracefab_refresh_supplier_profile_completeness(p_supplier_id);

  IF v_completion < 100 THEN
    RAISE EXCEPTION 'supplier_profile_incomplete: %', v_completion;
  END IF;

  IF v_supplier.onboarding_status NOT IN ('invited', 'in_progress', 'rejected') THEN
    RAISE EXCEPTION 'supplier_profile_status_does_not_allow_submission';
  END IF;

  UPDATE suppliers
  SET onboarding_status = 'submitted',
      last_submitted_at = now(),
      last_profile_updated_by = tracefab_current_user_id(),
      profile_completion = v_completion
  WHERE id = p_supplier_id
  RETURNING * INTO v_supplier;

  RETURN v_supplier;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Participant visibility for invitation tracking
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS invitations_select_admin ON organization_invitations;
CREATE POLICY invitations_select_participant ON organization_invitations
  FOR SELECT TO PUBLIC USING (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[])
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = organization_invitations.relationship_id
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  );

DROP POLICY IF EXISTS invitations_update_admin ON organization_invitations;
CREATE POLICY invitations_update_participant ON organization_invitations
  FOR UPDATE TO PUBLIC USING (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[])
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = organization_invitations.relationship_id
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  ) WITH CHECK (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[])
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = organization_invitations.relationship_id
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Function privileges
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_relationship_organizations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_share_relationship() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_invitation_relationship() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_calculate_supplier_profile_completion(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_completeness(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_from_supplier() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_from_site() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_from_organization() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_invite_supplier(UUID, TEXT, TEXT, TEXT, VARCHAR, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_accept_organization_invitation(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_supplier_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_submit_supplier_profile(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_invite_supplier(UUID, TEXT, TEXT, TEXT, VARCHAR, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_accept_organization_invitation(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_supplier_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_submit_supplier_profile(UUID) TO PUBLIC;

COMMENT ON COLUMN suppliers.profile_completion IS 'Computed completeness percentage for the current supplier profile; not a verification score.';
COMMENT ON COLUMN organization_invitations.relationship_id IS 'Optional brand-supplier context for participant visibility and onboarding.';
COMMENT ON FUNCTION tracefab_invite_supplier(UUID, TEXT, TEXT, TEXT, VARCHAR, TEXT) IS 'Creates an invited supplier organization, relationship and hashed-token invitation. Raw tokens are handled outside SQL.';
COMMENT ON FUNCTION tracefab_accept_organization_invitation(TEXT) IS 'Accepts a hashed invitation token only when the authenticated email matches the invitation email.';
COMMENT ON FUNCTION tracefab_update_supplier_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[]) IS 'Updates editable supplier profile fields through a tenant-checked function and recalculates completeness.';
COMMENT ON FUNCTION tracefab_submit_supplier_profile(UUID) IS 'Moves a complete supplier profile to submitted. Completeness is not verification or certification.';

-- SOURCE: 20260922020000_tracefab_product_data.sql
-- Tracefab Chantier 3 — Product Data
--
-- Adds structured product information, identifiers, material composition and a
-- transparent data-readiness computation. Data ready is not equivalent to
-- verified, certified or compliant with a final regulatory act.

-- -----------------------------------------------------------------------------
-- 1. Product data fields
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE product_data_readiness AS ENUM ('not_started', 'in_progress', 'data_ready', 'needs_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tracefab_products
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS product_family TEXT,
  ADD COLUMN IF NOT EXISTS color_name TEXT,
  ADD COLUMN IF NOT EXISTS size_range TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS country_of_design VARCHAR(2),
  ADD COLUMN IF NOT EXISTS country_of_manufacture VARCHAR(2),
  ADD COLUMN IF NOT EXISTS weight_grams NUMERIC(10,2)
    CHECK (weight_grams IS NULL OR weight_grams >= 0),
  ADD COLUMN IF NOT EXISTS care_instructions JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS data_readiness product_data_readiness NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS data_completion NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (data_completion BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS data_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_data_updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS product_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('gtin', 'ean', 'upc', 'internal')),
  identifier_value TEXT NOT NULL CHECK (length(trim(identifier_value)) > 0),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, identifier_type, identifier_value)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_primary
  ON product_identifiers(product_id, identifier_type)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_product_identifiers_product
  ON product_identifiers(product_id, identifier_type);

CREATE INDEX IF NOT EXISTS idx_products_data_readiness
  ON tracefab_products(brand_organization_id, data_readiness, data_completion);

-- -----------------------------------------------------------------------------
-- 2. Product ownership and composition integrity
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_product_brand_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_type organization_type;
BEGIN
  SELECT type INTO v_org_type
  FROM organizations
  WHERE id = NEW.brand_organization_id;

  IF v_org_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'product_requires_brand_organization';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.brand_organization_id IS DISTINCT FROM NEW.brand_organization_id THEN
    RAISE EXCEPTION 'product_brand_organization_is_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.version IS DISTINCT FROM NEW.version
       OR OLD.data_completion IS DISTINCT FROM NEW.data_completion
       OR OLD.data_readiness IS DISTINCT FROM NEW.data_readiness
       OR OLD.data_ready_at IS DISTINCT FROM NEW.data_ready_at
     )
     AND COALESCE(current_setting('tracefab.internal_product_revision', true), 'false') <> 'true'
     AND COALESCE(current_setting('tracefab.internal_product_readiness_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'computed_product_fields_are_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER products_validate_brand_ownership
    BEFORE INSERT OR UPDATE ON tracefab_products
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_product_brand_ownership();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_product_material_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_organization_id UUID;
  v_material_organization_id UUID;
BEGIN
  SELECT p.brand_organization_id
  INTO v_brand_organization_id
  FROM tracefab_products p
  WHERE p.id = NEW.product_id;

  IF v_brand_organization_id IS NULL THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  SELECT m.owner_organization_id
  INTO v_material_organization_id
  FROM materials m
  WHERE m.id = NEW.material_id;

  IF v_material_organization_id IS NULL THEN
    RAISE EXCEPTION 'material_not_found';
  END IF;

  IF v_material_organization_id <> v_brand_organization_id
     AND NOT tracefab_can_access_shared_subject(
       v_material_organization_id,
       'material',
       NEW.material_id
     ) THEN
    RAISE EXCEPTION 'material_not_shared_with_product_brand';
  END IF;

  IF NEW.product_version <> (SELECT p.version FROM tracefab_products p WHERE p.id = NEW.product_id) THEN
    RAISE EXCEPTION 'product_material_version_must_match_current_product_version';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER product_materials_validate_ownership
    BEFORE INSERT OR UPDATE ON product_materials
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_product_material_ownership();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Product data readiness computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_calculate_product_data_completion(p_product_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_count INTEGER;
  v_materials_with_percentage INTEGER;
  v_percentage_total NUMERIC;
  v_has_identifier BOOLEAN;
  v_has_product_data_point BOOLEAN;
  v_needs_review BOOLEAN;
  v_completed INTEGER := 0;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Seven deliberately explicit MVP requirements. Presence is not verification.
  IF length(trim(COALESCE(v_product.reference, ''))) > 0
     AND length(trim(COALESCE(v_product.name, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_product.category, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_product.description, ''))) >= 30 THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM product_identifiers i
    WHERE i.product_id = p_product_id
      AND (i.identifier_type = 'internal' OR i.is_primary = true)
  ) OR length(trim(COALESCE(v_product.sku, ''))) > 0
  INTO v_has_identifier;

  IF v_has_identifier THEN
    v_completed := v_completed + 1;
  END IF;

  IF v_product.country_of_manufacture IS NOT NULL
     AND length(trim(v_product.country_of_manufacture)) = 2 THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE pm.percentage IS NOT NULL),
    COALESCE(SUM(pm.percentage), 0)
  INTO v_material_count, v_materials_with_percentage, v_percentage_total
  FROM product_materials pm
  WHERE pm.product_id = p_product_id
    AND pm.product_version = v_product.version;

  IF v_material_count > 0
     AND v_materials_with_percentage = v_material_count
     AND abs(v_percentage_total - 100) < 0.01 THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM data_points dp
    WHERE dp.product_id = p_product_id
      AND dp.status NOT IN ('expired', 'needs_review')
  ) INTO v_has_product_data_point;

  IF v_has_product_data_point THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM data_points dp
    WHERE dp.product_id = p_product_id
      AND dp.status IN ('expired', 'needs_review')
  ) INTO v_needs_review;

  RETURN round((v_completed::NUMERIC / 7) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_readiness(p_product_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completion NUMERIC(5,2);
  v_needs_review BOOLEAN;
  v_readiness product_data_readiness;
BEGIN
  v_completion := tracefab_calculate_product_data_completion(p_product_id);

  SELECT EXISTS (
    SELECT 1 FROM data_points dp
    WHERE dp.product_id = p_product_id
      AND dp.status IN ('expired', 'needs_review')
  ) INTO v_needs_review;

  v_readiness := CASE
    WHEN v_needs_review THEN 'needs_review'::product_data_readiness
    WHEN v_completion = 100 THEN 'data_ready'::product_data_readiness
    WHEN v_completion = 0 THEN 'not_started'::product_data_readiness
    ELSE 'in_progress'::product_data_readiness
  END;

  PERFORM set_config('tracefab.internal_product_readiness_update', 'true', true);

  UPDATE tracefab_products
  SET data_completion = v_completion,
      data_readiness = v_readiness,
      data_ready_at = CASE
        WHEN v_readiness = 'data_ready' AND data_ready_at IS NULL THEN now()
        WHEN v_readiness <> 'data_ready' THEN NULL
        ELSE data_ready_at
      END
  WHERE id = p_product_id;

  PERFORM set_config('tracefab.internal_product_readiness_update', 'false', true);
  RETURN v_completion;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_material()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
    RETURN OLD;
  END IF;

  PERFORM tracefab_refresh_product_data_readiness(NEW.product_id);
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_identifier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
    RETURN OLD;
  END IF;
  PERFORM tracefab_refresh_product_data_readiness(NEW.product_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_data_point()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.product_id IS NOT NULL THEN
      PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    PERFORM tracefab_refresh_product_data_readiness(NEW.product_id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id
     AND OLD.product_id IS NOT NULL THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_product()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM tracefab_refresh_product_data_readiness(NEW.id);
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER products_data_readiness_after_change
    AFTER INSERT OR UPDATE OF reference, sku, name, category, description,
      country_of_manufacture, version
    ON tracefab_products
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_product();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER product_materials_refresh_data_readiness
    AFTER INSERT OR UPDATE OR DELETE ON product_materials
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_material();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER product_identifiers_refresh_data_readiness
    AFTER INSERT OR UPDATE OR DELETE ON product_identifiers
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_identifier();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER data_points_refresh_product_readiness
    AFTER INSERT OR UPDATE OR DELETE ON data_points
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_data_point();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 4. Product mutation functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_product(
  p_brand_organization_id UUID,
  p_reference TEXT,
  p_name TEXT,
  p_category TEXT DEFAULT NULL,
  p_sku TEXT DEFAULT NULL
)
RETURNS tracefab_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_org_type organization_type;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  SELECT type INTO v_org_type
  FROM organizations
  WHERE id = p_brand_organization_id;

  IF v_org_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'brand_organization_required';
  END IF;

  INSERT INTO tracefab_products (
    brand_organization_id,
    reference,
    sku,
    name,
    category,
    created_by,
    last_data_updated_by
  )
  VALUES (
    p_brand_organization_id,
    trim(p_reference),
    NULLIF(trim(p_sku), ''),
    trim(p_name),
    NULLIF(trim(p_category), ''),
    tracefab_current_user_id(),
    tracefab_current_user_id()
  )
  RETURNING * INTO v_product;

  PERFORM tracefab_refresh_product_data_readiness(v_product.id);
  SELECT p.* INTO v_product
  FROM tracefab_products p
  WHERE p.id = v_product.id;

  RETURN v_product;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_product_data(
  p_product_id UUID,
  p_reference TEXT,
  p_sku TEXT,
  p_name TEXT,
  p_category TEXT,
  p_description TEXT,
  p_product_family TEXT,
  p_color_name TEXT,
  p_size_range TEXT[],
  p_country_of_design VARCHAR(2),
  p_country_of_manufacture VARCHAR(2),
  p_weight_grams NUMERIC,
  p_care_instructions JSONB
)
RETURNS tracefab_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  UPDATE tracefab_products
  SET reference = trim(p_reference),
      sku = NULLIF(trim(p_sku), ''),
      name = trim(p_name),
      category = NULLIF(trim(p_category), ''),
      description = NULLIF(trim(p_description), ''),
      product_family = NULLIF(trim(p_product_family), ''),
      color_name = NULLIF(trim(p_color_name), ''),
      size_range = COALESCE(p_size_range, '{}'::TEXT[]),
      country_of_design = upper(NULLIF(trim(p_country_of_design), '')),
      country_of_manufacture = upper(NULLIF(trim(p_country_of_manufacture), '')),
      weight_grams = p_weight_grams,
      care_instructions = COALESCE(p_care_instructions, '{}'::jsonb),
      last_data_updated_by = tracefab_current_user_id()
  WHERE id = p_product_id;

  PERFORM tracefab_refresh_product_data_readiness(p_product_id);

  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  RETURN v_product;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_start_product_revision(p_product_id UUID)
RETURNS tracefab_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_manager_role_required';
  END IF;

  PERFORM set_config('tracefab.internal_product_revision', 'true', true);

  UPDATE tracefab_products
  SET version = version + 1,
      data_completion = 0,
      data_readiness = 'in_progress',
      data_ready_at = NULL,
      last_data_updated_by = tracefab_current_user_id()
  WHERE id = p_product_id
  RETURNING * INTO v_product;

  PERFORM tracefab_refresh_product_data_readiness(p_product_id);
  SELECT p.* INTO v_product
  FROM tracefab_products p
  WHERE p.id = p_product_id;

  PERFORM set_config('tracefab.internal_product_revision', 'false', true);
  RETURN v_product;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS for product identifiers
-- -----------------------------------------------------------------------------

ALTER TABLE product_identifiers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON product_identifiers TO PUBLIC;

CREATE POLICY product_identifiers_select_brand ON product_identifiers
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

CREATE POLICY product_identifiers_insert_brand ON product_identifiers
  FOR INSERT TO PUBLIC WITH CHECK (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

CREATE POLICY product_identifiers_update_brand ON product_identifiers
  FOR UPDATE TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

-- -----------------------------------------------------------------------------
-- 6. Function privileges and documentation
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_product_brand_ownership() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_product_material_ownership() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_calculate_product_data_completion(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_readiness(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_material() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_identifier() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_data_point() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_product() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_create_product(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_product_data(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], VARCHAR, VARCHAR, NUMERIC, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_start_product_revision(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_create_product(UUID, TEXT, TEXT, TEXT, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_product_data(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], VARCHAR, VARCHAR, NUMERIC, JSONB) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_start_product_revision(UUID) TO PUBLIC;

COMMENT ON COLUMN tracefab_products.data_completion IS 'Computed product data completeness; it is not a verification or certification score.';
COMMENT ON COLUMN tracefab_products.data_readiness IS 'Operational readiness state for product data, distinct from product lifecycle status.';
COMMENT ON TABLE product_identifiers IS 'Product identifiers scoped to a product. External identifier uniqueness rules remain integration-specific.';
COMMENT ON FUNCTION tracefab_calculate_product_data_completion(UUID) IS 'Computes seven explicit MVP product-data requirements; data ready is not regulatory compliance.';
COMMENT ON FUNCTION tracefab_start_product_revision(UUID) IS 'Starts a new product composition/data revision; historical snapshots remain a later concern.';

-- SOURCE: 20260922030000_tracefab_data_collection.sql
-- Tracefab Chantier 4 — Data Collection
--
-- Implements the first request / response workflow on top of the core model.
-- A response may be declared or documented before it is reviewed. Review status
-- is deliberately separate from the existence of a value or document.

-- -----------------------------------------------------------------------------
-- 1. Request, item and response metadata
-- -----------------------------------------------------------------------------

ALTER TABLE data_requests
  ADD COLUMN IF NOT EXISTS relationship_id UUID REFERENCES brand_supplier_relationships(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS completion_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (completion_percentage BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE data_request_items
  ADD COLUMN IF NOT EXISTS help_text TEXT,
  ADD COLUMN IF NOT EXISTS validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_kinds TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE data_responses
  ADD COLUMN IF NOT EXISTS response_version INTEGER NOT NULL DEFAULT 1
    CHECK (response_version > 0),
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS review_comment TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_brand_idempotency
  ON data_requests(brand_organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requests_relationship_status
  ON data_requests(relationship_id, status, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_items_required_status
  ON data_request_items(data_request_id, required, status);

-- Normalize legacy response rows before adding the current-response invariant.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY data_request_item_id
      ORDER BY submitted_at ASC, id ASC
    ) AS response_version,
    row_number() OVER (
      PARTITION BY data_request_item_id
      ORDER BY submitted_at DESC, id DESC
    ) AS reverse_rank
  FROM data_responses
)
UPDATE data_responses r
SET response_version = ranked.response_version,
    is_current = (ranked.reverse_rank = 1)
FROM ranked
WHERE r.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_current_item
  ON data_responses(data_request_item_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_responses_item_version
  ON data_responses(data_request_item_id, response_version DESC);

-- -----------------------------------------------------------------------------
-- 2. Request integrity and progress computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_data_request_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_type organization_type;
  v_supplier_type organization_type;
  v_product_brand UUID;
BEGIN
  SELECT type INTO v_brand_type
  FROM organizations
  WHERE id = NEW.brand_organization_id;

  SELECT type INTO v_supplier_type
  FROM organizations
  WHERE id = NEW.supplier_organization_id;

  IF v_brand_type IS DISTINCT FROM 'brand'::organization_type
     OR v_supplier_type IS DISTINCT FROM 'supplier'::organization_type THEN
    RAISE EXCEPTION 'data_request_requires_brand_and_supplier';
  END IF;

  IF NEW.relationship_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM brand_supplier_relationships r
    WHERE r.id = NEW.relationship_id
      AND r.brand_organization_id = NEW.brand_organization_id
      AND r.supplier_organization_id = NEW.supplier_organization_id
  ) THEN
    RAISE EXCEPTION 'data_request_relationship_mismatch';
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    SELECT p.brand_organization_id INTO v_product_brand
    FROM tracefab_products p
    WHERE p.id = NEW.product_id;

    IF v_product_brand IS NULL OR v_product_brand <> NEW.brand_organization_id THEN
      RAISE EXCEPTION 'data_request_product_brand_mismatch';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.brand_organization_id IS DISTINCT FROM NEW.brand_organization_id
    OR OLD.supplier_organization_id IS DISTINCT FROM NEW.supplier_organization_id
    OR OLD.relationship_id IS DISTINCT FROM NEW.relationship_id
  ) THEN
    RAISE EXCEPTION 'data_request_participants_are_immutable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_requests_validate_integrity
    BEFORE INSERT OR UPDATE ON data_requests
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_request_integrity();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_data_request_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.completion_percentage IS DISTINCT FROM NEW.completion_percentage
       OR OLD.submitted_at IS DISTINCT FROM NEW.submitted_at
       OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
       OR OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at
       OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
       OR OLD.last_activity_at IS DISTINCT FROM NEW.last_activity_at
     )
     AND COALESCE(current_setting('tracefab.internal_data_collection_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'workflow_request_fields_are_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_requests_validate_mutation
    BEFORE UPDATE ON data_requests
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_request_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_data_response_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item data_request_items;
  v_supplier_organization_id UUID;
  v_document_owner UUID;
BEGIN
  SELECT i.*
  INTO v_item
  FROM data_request_items i
  WHERE i.id = NEW.data_request_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_item_not_found';
  END IF;

  SELECT r.supplier_organization_id
  INTO v_supplier_organization_id
  FROM data_requests r
  WHERE r.id = v_item.data_request_id;

  IF v_supplier_organization_id IS NULL THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NEW.data_type <> v_item.data_type THEN
    RAISE EXCEPTION 'response_data_type_mismatch';
  END IF;

  IF NEW.source_document_id IS NOT NULL THEN
    SELECT d.owner_organization_id INTO v_document_owner
    FROM documents d
    WHERE d.id = NEW.source_document_id;

    IF v_document_owner IS NULL OR v_document_owner <> v_supplier_organization_id THEN
      RAISE EXCEPTION 'response_document_supplier_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_responses_validate_integrity
    BEFORE INSERT OR UPDATE ON data_responses
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_response_integrity();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_data_request_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.data_request_id IS DISTINCT FROM NEW.data_request_id THEN
    RAISE EXCEPTION 'request_item_request_is_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND COALESCE(current_setting('tracefab.internal_data_collection_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'request_item_workflow_status_is_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER request_items_validate_mutation
    BEFORE UPDATE ON data_request_items
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_request_item_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_refresh_data_request_progress(p_request_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_required_count INTEGER;
  v_answered_count INTEGER;
  v_completion NUMERIC(5,2);
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE i.required),
    COUNT(*) FILTER (
      WHERE i.required AND EXISTS (
        SELECT 1 FROM data_responses dr
        WHERE dr.data_request_item_id = i.id
          AND dr.is_current = true
      )
    )
  INTO v_required_count, v_answered_count
  FROM data_request_items i
  WHERE i.data_request_id = p_request_id;

  IF v_required_count = 0 THEN
    v_completion := 0;
  ELSE
    v_completion := round((v_answered_count::NUMERIC / v_required_count) * 100, 2);
  END IF;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_requests
  SET completion_percentage = v_completion,
      last_activity_at = now()
  WHERE id = p_request_id;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  RETURN v_completion;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_request_progress_from_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_data_request_progress(OLD.data_request_id);
    RETURN OLD;
  END IF;

  PERFORM tracefab_refresh_data_request_progress(NEW.data_request_id);
  IF TG_OP = 'UPDATE' AND OLD.data_request_id IS DISTINCT FROM NEW.data_request_id THEN
    PERFORM tracefab_refresh_data_request_progress(OLD.data_request_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_request_progress_from_response()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT i.data_request_id INTO v_request_id
    FROM data_request_items i
    WHERE i.id = OLD.data_request_item_id;
  ELSE
    SELECT i.data_request_id INTO v_request_id
    FROM data_request_items i
    WHERE i.id = NEW.data_request_item_id;
  END IF;

  IF v_request_id IS NOT NULL THEN
    PERFORM tracefab_refresh_data_request_progress(v_request_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER request_items_refresh_progress
    AFTER INSERT OR UPDATE OR DELETE ON data_request_items
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_request_progress_from_item();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER data_responses_refresh_progress
    AFTER INSERT OR UPDATE OR DELETE ON data_responses
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_request_progress_from_response();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Request and response workflow functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_data_request(
  p_brand_organization_id UUID,
  p_supplier_organization_id UUID,
  p_product_id UUID,
  p_title TEXT,
  p_questionnaire_key TEXT,
  p_questionnaire_version TEXT,
  p_due_at TIMESTAMPTZ DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS data_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_relationship_id UUID;
  v_idempotency_key TEXT;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_data_request_role_required';
  END IF;

  v_idempotency_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');

  IF v_idempotency_key IS NOT NULL THEN
    SELECT r.* INTO v_request
    FROM data_requests r
    WHERE r.brand_organization_id = p_brand_organization_id
      AND r.idempotency_key = v_idempotency_key;
    IF FOUND THEN
      RETURN v_request;
    END IF;
  END IF;

  SELECT r.id INTO v_relationship_id
  FROM brand_supplier_relationships r
  WHERE r.brand_organization_id = p_brand_organization_id
    AND r.supplier_organization_id = p_supplier_organization_id
    AND r.status = 'active';

  IF v_relationship_id IS NULL THEN
    RAISE EXCEPTION 'active_brand_supplier_relationship_required';
  END IF;

  IF p_product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tracefab_products p
    WHERE p.id = p_product_id
      AND p.brand_organization_id = p_brand_organization_id
  ) THEN
    RAISE EXCEPTION 'request_product_brand_mismatch';
  END IF;

  INSERT INTO data_requests (
    brand_organization_id,
    supplier_organization_id,
    relationship_id,
    product_id,
    title,
    questionnaire_key,
    questionnaire_version,
    status,
    due_at,
    idempotency_key,
    created_by,
    last_activity_at
  )
  VALUES (
    p_brand_organization_id,
    p_supplier_organization_id,
    v_relationship_id,
    p_product_id,
    trim(p_title),
    trim(p_questionnaire_key),
    trim(p_questionnaire_version),
    'draft',
    p_due_at,
    v_idempotency_key,
    tracefab_current_user_id(),
    now()
  )
  RETURNING * INTO v_request;

  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_add_data_request_item(
  p_data_request_id UUID,
  p_field_key TEXT,
  p_label TEXT,
  p_data_type data_type,
  p_required BOOLEAN DEFAULT false,
  p_evidence_required BOOLEAN DEFAULT false,
  p_help_text TEXT DEFAULT NULL,
  p_validation_rules JSONB DEFAULT '{}'::jsonb,
  p_evidence_kinds TEXT[] DEFAULT '{}'
)
RETURNS data_request_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_item data_request_items;
BEGIN
  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_data_request_role_required';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'data_request_items_locked_after_send';
  END IF;

  INSERT INTO data_request_items (
    data_request_id,
    field_key,
    label,
    data_type,
    required,
    evidence_required,
    help_text,
    validation_rules,
    evidence_kinds,
    sort_order
  )
  VALUES (
    p_data_request_id,
    trim(p_field_key),
    trim(p_label),
    p_data_type,
    p_required,
    p_evidence_required,
    NULLIF(trim(p_help_text), ''),
    COALESCE(p_validation_rules, '{}'::jsonb),
    COALESCE(p_evidence_kinds, '{}'::TEXT[]),
    (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM data_request_items WHERE data_request_id = p_data_request_id)
  )
  RETURNING * INTO v_item;

  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_send_data_request(p_data_request_id UUID)
RETURNS data_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
BEGIN
  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_data_request_role_required';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'data_request_not_draft';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM data_request_items i WHERE i.data_request_id = p_data_request_id) THEN
    RAISE EXCEPTION 'data_request_requires_items';
  END IF;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_requests
  SET status = 'sent',
      last_activity_at = now()
  WHERE id = p_data_request_id
  RETURNING * INTO v_request;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);

  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_submit_data_response(
  p_data_request_item_id UUID,
  p_value JSONB,
  p_source_document_id UUID DEFAULT NULL
)
RETURNS data_responses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item data_request_items;
  v_request data_requests;
  v_previous_response data_responses;
  v_response data_responses;
  v_next_version INTEGER;
  v_status data_value_status;
BEGIN
  SELECT i.* INTO v_item
  FROM data_request_items i
  WHERE i.id = p_data_request_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_item_not_found';
  END IF;

  SELECT r.* INTO v_request
  FROM data_requests r
  WHERE r.id = v_item.data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.supplier_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_response_role_required';
  END IF;

  IF v_request.status NOT IN ('sent', 'in_progress', 'changes_requested') THEN
    RAISE EXCEPTION 'data_request_not_accepting_responses';
  END IF;

  IF p_value IS NULL THEN
    RAISE EXCEPTION 'response_value_required';
  END IF;

  SELECT * INTO v_previous_response
  FROM data_responses
  WHERE data_request_item_id = p_data_request_item_id
    AND is_current = true
  FOR UPDATE;

  v_next_version := COALESCE(v_previous_response.response_version, 0) + 1;
  v_status := CASE
    WHEN p_source_document_id IS NULL THEN 'declared'::data_value_status
    ELSE 'documented'::data_value_status
  END;

  IF v_previous_response.id IS NOT NULL THEN
    UPDATE data_responses
    SET is_current = false
    WHERE id = v_previous_response.id;
  END IF;

  INSERT INTO data_responses (
    data_request_item_id,
    value,
    data_type,
    status,
    source_document_id,
    responded_by,
    supersedes_id,
    response_version,
    is_current,
    submitted_at
  )
  VALUES (
    p_data_request_item_id,
    p_value,
    v_item.data_type,
    v_status,
    p_source_document_id,
    tracefab_current_user_id(),
    v_previous_response.id,
    v_next_version,
    true,
    now()
  )
  RETURNING * INTO v_response;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_request_items
  SET status = 'answered'
  WHERE id = p_data_request_item_id;

  UPDATE data_requests
  SET status = 'in_progress',
      last_activity_at = now()
  WHERE id = v_request.id
    AND status IN ('sent', 'changes_requested');

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_submit_data_request(p_data_request_id UUID)
RETURNS data_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_required_count INTEGER;
  v_answered_count INTEGER;
BEGIN
  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.supplier_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_response_role_required';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE i.required),
    COUNT(*) FILTER (
      WHERE i.required AND EXISTS (
        SELECT 1 FROM data_responses dr
        WHERE dr.data_request_item_id = i.id
          AND dr.is_current = true
          AND dr.status NOT IN ('needs_review', 'expired')
      )
    )
  INTO v_required_count, v_answered_count
  FROM data_request_items i
  WHERE i.data_request_id = p_data_request_id;

  IF v_required_count = 0 OR v_answered_count <> v_required_count THEN
    RAISE EXCEPTION 'required_data_request_items_incomplete';
  END IF;

  IF v_request.status NOT IN ('sent', 'in_progress', 'changes_requested') THEN
    RAISE EXCEPTION 'data_request_not_submittable';
  END IF;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_requests
  SET status = 'submitted',
      submitted_at = now(),
      last_activity_at = now()
  WHERE id = p_data_request_id
  RETURNING * INTO v_request;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_review_data_response(
  p_data_response_id UUID,
  p_status data_value_status,
  p_review_comment TEXT DEFAULT NULL
)
RETURNS data_responses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_response data_responses;
  v_item data_request_items;
  v_request data_requests;
  v_required_count INTEGER;
  v_accepted_count INTEGER;
BEGIN
  IF p_status NOT IN ('verified_by_reviewer', 'needs_review') THEN
    RAISE EXCEPTION 'unsupported_review_status';
  END IF;

  SELECT dr.* INTO v_response
  FROM data_responses dr
  WHERE dr.id = p_data_response_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_response_not_found';
  END IF;

  SELECT i.* INTO v_item
  FROM data_request_items i
  WHERE i.id = v_response.data_request_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_item_not_found';
  END IF;

  SELECT r.* INTO v_request
  FROM data_requests r
  WHERE r.id = v_item.data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT v_response.is_current THEN
    RAISE EXCEPTION 'only_current_response_can_be_reviewed';
  END IF;

  IF v_request.status NOT IN ('in_progress', 'submitted', 'changes_requested') THEN
    RAISE EXCEPTION 'data_request_not_reviewable';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'reviewer_role_required';
  END IF;

  UPDATE data_responses
  SET status = p_status,
      review_comment = NULLIF(trim(p_review_comment), ''),
      reviewed_at = now(),
      reviewed_by = tracefab_current_user_id()
  WHERE id = p_data_response_id
  RETURNING * INTO v_response;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_request_items
  SET status = CASE
    WHEN p_status = 'verified_by_reviewer' THEN 'accepted'::data_request_item_status
    ELSE 'needs_review'::data_request_item_status
  END
  WHERE id = v_item.id;

  IF p_status = 'needs_review' THEN
    PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

    UPDATE data_requests
    SET status = 'changes_requested',
        reviewed_at = now(),
        reviewed_by = tracefab_current_user_id(),
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  ELSE
    SELECT
      COUNT(*) FILTER (WHERE i.required),
      COUNT(*) FILTER (WHERE i.required AND i.status = 'accepted')
    INTO v_required_count, v_accepted_count
    FROM data_request_items i
    WHERE i.data_request_id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

    UPDATE data_requests
    SET status = CASE
          WHEN v_required_count > 0 AND v_required_count = v_accepted_count THEN 'approved'::data_request_status
          ELSE status
        END,
        reviewed_at = now(),
        reviewed_by = tracefab_current_user_id(),
        closed_at = CASE
          WHEN v_required_count > 0 AND v_required_count = v_accepted_count THEN now()
          ELSE closed_at
        END,
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  END IF;

  RETURN v_response;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RLS hardening for the workflow
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS requests_select_participant ON data_requests;
CREATE POLICY requests_select_participant ON data_requests
  FOR SELECT TO PUBLIC USING (
    tracefab_is_org_member(brand_organization_id)
    OR (tracefab_is_org_member(supplier_organization_id) AND status <> 'draft')
  );

DROP POLICY IF EXISTS requests_insert_brand ON data_requests;
CREATE POLICY requests_insert_brand ON data_requests
  FOR INSERT TO PUBLIC WITH CHECK (
    status = 'draft'
    AND created_by = tracefab_current_user_id()
    AND tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    AND EXISTS (
      SELECT 1 FROM brand_supplier_relationships r
      WHERE r.id = data_requests.relationship_id
        AND r.brand_organization_id = data_requests.brand_organization_id
        AND r.supplier_organization_id = data_requests.supplier_organization_id
        AND r.status = 'active'
    )
    AND (product_id IS NULL OR EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = data_requests.product_id
        AND p.brand_organization_id = data_requests.brand_organization_id
    ))
  );

DROP POLICY IF EXISTS requests_update_participant ON data_requests;
CREATE POLICY requests_update_brand ON data_requests
  FOR UPDATE TO PUBLIC USING (
    status = 'draft'
    AND tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) WITH CHECK (
    status = 'draft'
    AND tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

DROP POLICY IF EXISTS request_items_select_participant ON data_request_items;
CREATE POLICY request_items_select_participant ON data_request_items
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND (
          tracefab_is_org_member(r.brand_organization_id)
          OR (tracefab_is_org_member(r.supplier_organization_id) AND r.status <> 'draft')
        )
    )
  );

DROP POLICY IF EXISTS request_items_insert_brand ON data_request_items;
CREATE POLICY request_items_insert_brand ON data_request_items
  FOR INSERT TO PUBLIC WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND r.status = 'draft'
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

DROP POLICY IF EXISTS request_items_update_participant ON data_request_items;
CREATE POLICY request_items_update_brand ON data_request_items
  FOR UPDATE TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND r.status = 'draft'
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND r.status = 'draft'
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

DROP POLICY IF EXISTS responses_insert_supplier ON data_responses;
DROP POLICY IF EXISTS responses_update_supplier ON data_responses;

-- Responses are inserted and reviewed only through the workflow functions.
-- There is intentionally no authenticated INSERT or UPDATE policy here.

-- -----------------------------------------------------------------------------
-- 5. Function privileges and documentation
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_data_request_integrity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_data_response_integrity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_data_request_item_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_data_request_progress(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_request_progress_from_item() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_request_progress_from_response() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_create_data_request(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_add_data_request_item(UUID, TEXT, TEXT, data_type, BOOLEAN, BOOLEAN, TEXT, JSONB, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_send_data_request(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_submit_data_response(UUID, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_submit_data_request(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_create_data_request(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_add_data_request_item(UUID, TEXT, TEXT, data_type, BOOLEAN, BOOLEAN, TEXT, JSONB, TEXT[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_send_data_request(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_submit_data_response(UUID, JSONB, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_submit_data_request(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) TO PUBLIC;

COMMENT ON COLUMN data_requests.completion_percentage IS 'Required-item response completion. It measures collection progress, not data quality.';
COMMENT ON COLUMN data_responses.is_current IS 'Only one response revision per item may be current.';
COMMENT ON FUNCTION tracefab_submit_data_response(UUID, JSONB, UUID) IS 'Creates a new supplier response revision and supersedes the previous current response.';
COMMENT ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) IS 'Brand-side review transition. Verified means reviewer-verified, not third-party certification.';

-- SOURCE: 20260922040000_tracefab_documents_certifications.sql
-- Tracefab Chantier 5 — Documents and Certifications
--
-- Adds private Storage registration, controlled document lifecycle and a
-- certification / verification workflow. A document is evidence metadata; its
-- presence never proves that the underlying claim is true.

-- -----------------------------------------------------------------------------
-- 1. Private document storage and metadata
-- -----------------------------------------------------------------------------

-- Object storage bucket provisioning is handled outside PostgreSQL on Neon.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_documents_storage_lookup
  ON documents(storage_bucket, storage_path, status);

CREATE INDEX IF NOT EXISTS idx_documents_owner_kind
  ON documents(owner_organization_id, kind, status);

CREATE OR REPLACE FUNCTION tracefab_validate_document_location()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.storage_bucket <> 'tracefab-private' THEN
    RAISE EXCEPTION 'tracefab_private_bucket_required';
  END IF;

  IF NEW.storage_path !~ ('^' || NEW.owner_organization_id::TEXT || '/[^/].*$')
     OR NEW.storage_path ~ '(^|/)\.\.(/|$)' THEN
    RAISE EXCEPTION 'document_path_must_be_tenant_scoped';
  END IF;

  IF NEW.visibility <> 'private' THEN
    RAISE EXCEPTION 'documents_are_private_in_chantier_5';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status <> 'uploaded' THEN
    RAISE EXCEPTION 'new_documents_must_start_uploaded';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.owner_organization_id IS DISTINCT FROM NEW.owner_organization_id
       OR OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
       OR OLD.storage_path IS DISTINCT FROM NEW.storage_path THEN
      RAISE EXCEPTION 'document_storage_identity_is_immutable';
    END IF;

    IF (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.byte_size IS DISTINCT FROM NEW.byte_size
      OR OLD.sha256 IS DISTINCT FROM NEW.sha256
      OR OLD.uploaded_by IS DISTINCT FROM NEW.uploaded_by
      OR OLD.available_at IS DISTINCT FROM NEW.available_at
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.deleted_by IS DISTINCT FROM NEW.deleted_by
    )
    AND COALESCE(current_setting('tracefab.internal_document_update', true), 'false') <> 'true' THEN
      RAISE EXCEPTION 'managed_document_fields_are_not_client_writable';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER documents_validate_location
    BEFORE INSERT OR UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_document_location();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_documents_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION tracefab_documents_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_register_document(
  p_owner_organization_id UUID,
  p_storage_path TEXT,
  p_original_filename TEXT,
  p_content_type TEXT,
  p_byte_size BIGINT,
  p_sha256 TEXT,
  p_kind document_kind,
  p_expires_at DATE DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
  v_path TEXT;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_upload_role_required';
  END IF;

  v_path := trim(p_storage_path);
  IF v_path = '' OR v_path !~ ('^' || p_owner_organization_id::TEXT || '/[^/].*$')
     OR v_path ~ '(^|/)\.\.(/|$)' THEN
    RAISE EXCEPTION 'document_path_must_be_tenant_scoped';
  END IF;

  IF p_byte_size < 0 OR p_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF length(trim(COALESCE(p_original_filename, ''))) = 0
     OR length(trim(COALESCE(p_content_type, ''))) = 0 THEN
    RAISE EXCEPTION 'document_metadata_required';
  END IF;

  SELECT * INTO v_document
  FROM documents d
  WHERE d.storage_bucket = 'tracefab-private'
    AND d.storage_path = v_path;

  IF FOUND THEN
    IF v_document.owner_organization_id <> p_owner_organization_id
       OR v_document.uploaded_by <> tracefab_current_user_id()
       OR v_document.status = 'deleted' THEN
      RAISE EXCEPTION 'document_path_already_registered';
    END IF;
    RETURN v_document;
  END IF;

  INSERT INTO documents (
    owner_organization_id,
    storage_bucket,
    storage_path,
    original_filename,
    content_type,
    byte_size,
    sha256,
    kind,
    status,
    visibility,
    expires_at,
    uploaded_by,
    metadata
  )
  VALUES (
    p_owner_organization_id,
    'tracefab-private',
    v_path,
    trim(p_original_filename),
    trim(p_content_type),
    p_byte_size,
    NULLIF(trim(p_sha256), ''),
    p_kind,
    'uploaded',
    'private',
    p_expires_at,
    tracefab_current_user_id(),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_document;

  RETURN v_document;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_finalize_document_upload(
  p_document_id UUID,
  p_sha256 TEXT,
  p_scan_passed BOOLEAN,
  p_actual_byte_size BIGINT
)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
BEGIN
  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  IF v_document.status NOT IN ('uploaded', 'scanning') THEN
    RAISE EXCEPTION 'document_not_in_scannable_state';
  END IF;

  IF p_actual_byte_size < 0 OR p_actual_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF p_scan_passed AND length(trim(COALESCE(p_sha256, ''))) <> 64 THEN
    RAISE EXCEPTION 'sha256_required_for_available_document';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET sha256 = NULLIF(trim(p_sha256), ''),
      byte_size = p_actual_byte_size,
      status = CASE WHEN p_scan_passed THEN 'available'::document_status ELSE 'rejected'::document_status END,
      available_at = CASE WHEN p_scan_passed THEN now() ELSE NULL END,
      metadata = metadata || jsonb_build_object('scan_passed', p_scan_passed)
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);
  RETURN v_document;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_soft_delete_document(p_document_id UUID)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
BEGIN
  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_document.owner_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_delete_role_required';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET status = 'deleted',
      deleted_at = now(),
      deleted_by = tracefab_current_user_id()
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);
  RETURN v_document;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Certification and verification lifecycle
-- -----------------------------------------------------------------------------

ALTER TABLE certifications
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verified_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION tracefab_validate_certification_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND COALESCE(current_setting('tracefab.internal_certification_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'certification_status_is_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER certifications_validate_mutation
    BEFORE UPDATE ON certifications
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_certification_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_register_certification(
  p_owner_organization_id UUID,
  p_supplier_id UUID,
  p_supplier_site_id UUID,
  p_product_id UUID,
  p_standard_name TEXT,
  p_standard_code TEXT,
  p_issuer_name TEXT,
  p_certificate_number TEXT,
  p_issued_at DATE,
  p_expires_at DATE,
  p_document_id UUID
)
RETURNS certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_certification certifications;
  v_status data_value_status;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'certification_role_required';
  END IF;

  IF length(trim(COALESCE(p_standard_name, ''))) = 0 THEN
    RAISE EXCEPTION 'certification_standard_required';
  END IF;

  IF p_document_id IS NULL THEN
    v_status := 'declared';
  ELSE
    v_status := 'documented';
  END IF;

  INSERT INTO certifications (
    owner_organization_id,
    supplier_id,
    supplier_site_id,
    product_id,
    standard_name,
    standard_code,
    issuer_name,
    certificate_number,
    issued_at,
    expires_at,
    document_id,
    status,
    created_by
  )
  VALUES (
    p_owner_organization_id,
    p_supplier_id,
    p_supplier_site_id,
    p_product_id,
    trim(p_standard_name),
    NULLIF(trim(p_standard_code), ''),
    NULLIF(trim(p_issuer_name), ''),
    NULLIF(trim(p_certificate_number), ''),
    p_issued_at,
    p_expires_at,
    p_document_id,
    v_status,
    tracefab_current_user_id()
  )
  RETURNING * INTO v_certification;

  RETURN v_certification;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_certification(
  p_certification_id UUID,
  p_standard_name TEXT,
  p_standard_code TEXT,
  p_issuer_name TEXT,
  p_certificate_number TEXT,
  p_issued_at DATE,
  p_expires_at DATE,
  p_document_id UUID
)
RETURNS certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_certification certifications;
BEGIN
  SELECT * INTO v_certification
  FROM certifications
  WHERE id = p_certification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'certification_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_certification.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'certification_role_required';
  END IF;

  IF length(trim(COALESCE(p_standard_name, ''))) = 0 THEN
    RAISE EXCEPTION 'certification_standard_required';
  END IF;

  PERFORM set_config('tracefab.internal_certification_update', 'true', true);

  UPDATE certifications
  SET standard_name = trim(p_standard_name),
      standard_code = NULLIF(trim(p_standard_code), ''),
      issuer_name = NULLIF(trim(p_issuer_name), ''),
      certificate_number = NULLIF(trim(p_certificate_number), ''),
      issued_at = p_issued_at,
      expires_at = p_expires_at,
      document_id = p_document_id,
      status = CASE
        WHEN p_document_id IS NULL THEN 'declared'::data_value_status
        ELSE 'documented'::data_value_status
      END,
      last_verified_at = NULL,
      last_verified_by = NULL
  WHERE id = p_certification_id
  RETURNING * INTO v_certification;

  PERFORM set_config('tracefab.internal_certification_update', 'false', true);
  RETURN v_certification;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_review_certification(
  p_certification_id UUID,
  p_verification_status verification_status,
  p_method TEXT,
  p_notes TEXT,
  p_verifier_organization_id UUID DEFAULT NULL
)
RETURNS certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_certification certifications;
  v_verifier_type organization_type;
  v_certification_status data_value_status;
BEGIN
  IF p_verification_status NOT IN ('passed', 'failed', 'needs_review', 'expired') THEN
    RAISE EXCEPTION 'unsupported_certification_verification_status';
  END IF;

  IF length(trim(COALESCE(p_method, ''))) = 0 THEN
    RAISE EXCEPTION 'verification_method_required';
  END IF;

  SELECT * INTO v_certification
  FROM certifications
  WHERE id = p_certification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'certification_not_found';
  END IF;

  IF p_verifier_organization_id IS NULL THEN
    IF NOT tracefab_has_org_role(
      v_certification.owner_organization_id,
      ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
    ) THEN
      RAISE EXCEPTION 'certification_reviewer_role_required';
    END IF;
  ELSE
    SELECT type INTO v_verifier_type
    FROM organizations
    WHERE id = p_verifier_organization_id;

    IF v_verifier_type IS DISTINCT FROM 'verifier'::organization_type
       OR NOT tracefab_has_org_role(
         p_verifier_organization_id,
         ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
       ) THEN
      RAISE EXCEPTION 'third_party_verifier_role_required';
    END IF;
  END IF;

  v_certification_status := CASE
    WHEN p_verification_status = 'passed' AND v_verifier_type = 'verifier'::organization_type
      THEN 'certified_by_third_party'::data_value_status
    WHEN p_verification_status = 'passed'
      THEN 'verified_by_reviewer'::data_value_status
    WHEN p_verification_status = 'expired'
      THEN 'expired'::data_value_status
    ELSE 'needs_review'::data_value_status
  END;

  INSERT INTO verification_records (
    owner_organization_id,
    certification_id,
    verifier_organization_id,
    method,
    status,
    notes,
    verified_by,
    verified_at
  )
  VALUES (
    v_certification.owner_organization_id,
    p_certification_id,
    p_verifier_organization_id,
    trim(p_method),
    p_verification_status,
    p_notes,
    tracefab_current_user_id(),
    now()
  );

  PERFORM set_config('tracefab.internal_certification_update', 'true', true);

  UPDATE certifications
  SET status = v_certification_status,
      last_verified_at = now(),
      last_verified_by = tracefab_current_user_id()
  WHERE id = p_certification_id
  RETURNING * INTO v_certification;

  PERFORM set_config('tracefab.internal_certification_update', 'false', true);
  RETURN v_certification;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS and Storage policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS documents_select_authorized ON documents;
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO PUBLIC USING (
    status <> 'deleted'
    AND (
      tracefab_can_access_org(owner_organization_id)
      OR (
        status = 'available'
        AND tracefab_can_access_shared_subject(owner_organization_id, 'document', id)
      )
    )
  );

DROP POLICY IF EXISTS documents_insert_owner ON documents;
-- Document rows are registered through tracefab_register_document(...), which
-- enforces the private bucket and tenant-scoped path before object upload.

DROP POLICY IF EXISTS documents_update_owner ON documents;
CREATE POLICY documents_update_metadata_owner ON documents
  FOR UPDATE TO PUBLIC USING (
    tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) WITH CHECK (
    tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

DROP POLICY IF EXISTS certifications_insert_owner ON certifications;
DROP POLICY IF EXISTS certifications_update_owner ON certifications;
-- Certification creation, edits and review are workflow functions so that
-- status cannot be forged as verified or certified by a client write.

DROP POLICY IF EXISTS verifications_select_authorized ON verification_records;
CREATE POLICY verifications_select_authorized ON verification_records
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR (verifier_organization_id IS NOT NULL AND tracefab_is_org_member(verifier_organization_id))
    OR (
      certification_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM certifications c
        WHERE c.id = verification_records.certification_id
          AND tracefab_can_access_shared_subject(c.owner_organization_id, 'certification', c.id)
      )
    )
  );

DROP POLICY IF EXISTS verifications_insert_authorized ON verification_records;
DROP POLICY IF EXISTS verifications_update_authorized ON verification_records;
-- Verification records are inserted by tracefab_review_certification(...).

-- Object storage policies are implemented by the trusted API/object-storage adapter.

-- -----------------------------------------------------------------------------
-- 4. Function privileges and documentation
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_document_location() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_documents_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_register_document(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, document_kind, DATE, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_soft_delete_document(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_certification_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_register_certification(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_certification(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_review_certification(UUID, verification_status, TEXT, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_register_document(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, document_kind, DATE, JSONB) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_soft_delete_document(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_register_certification(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_certification(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_review_certification(UUID, verification_status, TEXT, TEXT, UUID) TO PUBLIC;

COMMENT ON TABLE documents IS 'Private evidence metadata. Storage objects are tenant-scoped and never public by this migration.';
COMMENT ON COLUMN documents.status IS 'Upload and scan lifecycle; available means the trusted scan flow accepted the object, not that its claims are true.';
COMMENT ON TABLE certifications IS 'Supplier/product certification claims with explicit evidence and separate verification records.';
COMMENT ON FUNCTION tracefab_review_certification(UUID, verification_status, TEXT, TEXT, UUID) IS 'Records a verification event and derives verified/certified status without treating document presence as proof.';

-- SOURCE: 20260922050000_tracefab_data_quality.sql
-- Tracefab Chantier 6 — Data Quality
--
-- Adds explainable quality issues, versioned score snapshots and controlled
-- acknowledgement/waiver actions. A quality score is not a verification or
-- certification claim.

-- -----------------------------------------------------------------------------
-- 1. Quality issue model
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE quality_issue_severity AS ENUM ('info', 'warning', 'blocking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE quality_issue_status AS ENUM ('open', 'acknowledged', 'resolved', 'waived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  subject_id UUID GENERATED ALWAYS AS (COALESCE(supplier_id, product_id)) STORED,
  rule_key TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  severity quality_issue_severity NOT NULL,
  status quality_issue_status NOT NULL DEFAULT 'open',
  field_key TEXT,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(supplier_id, product_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_issues_identity
  ON data_quality_issues(owner_organization_id, subject_id, rule_key, rule_version);

CREATE INDEX IF NOT EXISTS idx_quality_issues_supplier_status
  ON data_quality_issues(supplier_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_quality_issues_product_status
  ON data_quality_issues(product_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_quality_issues_owner_detected
  ON data_quality_issues(owner_organization_id, detected_at DESC);

CREATE OR REPLACE FUNCTION tracefab_validate_quality_issue_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_owner UUID;
  v_product_owner UUID;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT organization_id INTO v_supplier_owner
    FROM suppliers
    WHERE id = NEW.supplier_id;
    IF v_supplier_owner IS NULL OR v_supplier_owner <> NEW.owner_organization_id THEN
      RAISE EXCEPTION 'quality_issue_supplier_owner_mismatch';
    END IF;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    SELECT brand_organization_id INTO v_product_owner
    FROM tracefab_products
    WHERE id = NEW.product_id;
    IF v_product_owner IS NULL OR v_product_owner <> NEW.owner_organization_id THEN
      RAISE EXCEPTION 'quality_issue_product_owner_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER quality_issues_validate_subject
    BEFORE INSERT OR UPDATE ON data_quality_issues
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_quality_issue_subject();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_quality_issues_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER quality_issues_set_updated_at
    BEFORE UPDATE ON data_quality_issues
    FOR EACH ROW EXECUTE FUNCTION tracefab_quality_issues_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_upsert_quality_issue(
  p_owner_organization_id UUID,
  p_supplier_id UUID,
  p_product_id UUID,
  p_rule_key TEXT,
  p_rule_version TEXT,
  p_severity quality_issue_severity,
  p_field_key TEXT,
  p_message TEXT,
  p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS data_quality_issues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
BEGIN
  INSERT INTO data_quality_issues (
    owner_organization_id,
    supplier_id,
    product_id,
    rule_key,
    rule_version,
    severity,
    status,
    field_key,
    message,
    details,
    detected_at,
    acknowledged_at,
    acknowledged_by,
    resolved_at,
    resolved_by
  )
  VALUES (
    p_owner_organization_id,
    p_supplier_id,
    p_product_id,
    p_rule_key,
    p_rule_version,
    p_severity,
    'open',
    p_field_key,
    p_message,
    COALESCE(p_details, '{}'::jsonb),
    now(),
    NULL,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (owner_organization_id, subject_id, rule_key, rule_version)
  DO UPDATE SET
    severity = EXCLUDED.severity,
    status = CASE
      WHEN data_quality_issues.status = 'waived' THEN 'waived'::quality_issue_status
      ELSE 'open'::quality_issue_status
    END,
    field_key = EXCLUDED.field_key,
    message = EXCLUDED.message,
    details = EXCLUDED.details,
    detected_at = EXCLUDED.detected_at,
    acknowledged_at = CASE
      WHEN data_quality_issues.status = 'waived' THEN data_quality_issues.acknowledged_at
      ELSE NULL
    END,
    acknowledged_by = CASE
      WHEN data_quality_issues.status = 'waived' THEN data_quality_issues.acknowledged_by
      ELSE NULL
    END,
    resolved_at = NULL,
    resolved_by = NULL,
    updated_at = now()
  RETURNING * INTO v_issue;

  RETURN v_issue;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Supplier quality computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_compute_supplier_quality(
  p_supplier_id UUID,
  p_calculation_version TEXT DEFAULT 'supplier_quality_v1'
)
RETURNS data_quality_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier suppliers;
  v_owner_organization_id UUID;
  v_profile_completion NUMERIC(5,2);
  v_data_point_count INTEGER;
  v_fresh_data_point_count INTEGER;
  v_documented_data_point_count INTEGER;
  v_certification_count INTEGER;
  v_documented_certification_count INTEGER;
  v_expired_certification_count INTEGER;
  v_active_site_count INTEGER;
  v_blocking_count INTEGER;
  v_warning_count INTEGER;
  v_freshness NUMERIC(5,2);
  v_documentation NUMERIC(5,2);
  v_consistency NUMERIC(5,2);
  v_missing_fields JSONB := '[]'::jsonb;
  v_score data_quality_scores;
BEGIN
  IF length(trim(COALESCE(p_calculation_version, ''))) = 0 THEN
    RAISE EXCEPTION 'quality_calculation_version_required';
  END IF;

  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found';
  END IF;

  v_owner_organization_id := v_supplier.organization_id;

  IF NOT (
    tracefab_has_org_role(
      v_owner_organization_id,
      ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
    )
    OR tracefab_can_access_shared_subject(v_owner_organization_id, 'supplier', p_supplier_id)
  ) THEN
    RAISE EXCEPTION 'supplier_quality_access_denied';
  END IF;

  UPDATE data_quality_issues
  SET status = 'resolved',
      resolved_at = now(),
      resolved_by = tracefab_current_user_id()
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_supplier_id
    AND rule_version = p_calculation_version
    AND status IN ('open', 'acknowledged');

  v_profile_completion := COALESCE(v_supplier.profile_completion, 0);

  IF v_profile_completion < 100 THEN
    v_missing_fields := v_missing_fields || to_jsonb('supplier_profile'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_profile_incomplete',
      p_calculation_version,
      'blocking',
      'profile_completion',
      'Supplier profile is not complete.',
      jsonb_build_object('completion', v_profile_completion)
    );
  END IF;

  SELECT COUNT(*) INTO v_active_site_count
  FROM supplier_sites
  WHERE supplier_id = p_supplier_id AND is_active = true;

  IF v_active_site_count = 0 THEN
    v_missing_fields := v_missing_fields || to_jsonb('active_site'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_no_active_site',
      p_calculation_version,
      'blocking',
      'supplier_sites',
      'Supplier has no active site.',
      '{}'::jsonb
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE valid_until IS NULL OR valid_until >= CURRENT_DATE),
    COUNT(*) FILTER (
      WHERE source_document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = data_points.source_document_id
            AND d.status = 'available'
        )
    )
  INTO v_data_point_count, v_fresh_data_point_count, v_documented_data_point_count
  FROM data_points
  WHERE supplier_id = p_supplier_id;

  IF v_data_point_count = 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_no_data_points',
      p_calculation_version,
      'warning',
      'data_points',
      'Supplier has no structured data points.',
      '{}'::jsonb
    );
  END IF;

  IF v_data_point_count > 0 THEN
    v_freshness := round((v_fresh_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
    v_documentation := round((v_documented_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
  ELSE
    v_freshness := 0;
    v_documentation := 0;
  END IF;

  IF v_data_point_count > v_fresh_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_expired_data_points',
      p_calculation_version,
      'warning',
      'data_points',
      'Supplier has expired data points.',
      jsonb_build_object('expired_count', v_data_point_count - v_fresh_data_point_count)
    );
  END IF;

  IF v_data_point_count > v_documented_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_missing_evidence',
      p_calculation_version,
      'warning',
      'source_document_id',
      'Some supplier data points have no source document.',
      jsonb_build_object('missing_document_count', v_data_point_count - v_documented_data_point_count)
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = certifications.document_id
            AND d.status = 'available'
        )
    ),
    COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < CURRENT_DATE)
  INTO v_certification_count, v_documented_certification_count, v_expired_certification_count
  FROM certifications
  WHERE supplier_id = p_supplier_id OR supplier_site_id IN (
    SELECT id FROM supplier_sites WHERE supplier_id = p_supplier_id
  );

  IF v_certification_count > 0 AND v_expired_certification_count > 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_expired_certification',
      p_calculation_version,
      'blocking',
      'certifications.expires_at',
      'Supplier has one or more expired certifications.',
      jsonb_build_object('expired_count', v_expired_certification_count)
    );
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE severity = 'blocking'),
    COUNT(*) FILTER (WHERE severity = 'warning')
  INTO v_blocking_count, v_warning_count
  FROM data_quality_issues
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_supplier_id
    AND status IN ('open', 'acknowledged');

  v_consistency := GREATEST(0, 100 - (v_blocking_count * 30) - (v_warning_count * 10));

  INSERT INTO data_quality_scores (
    owner_organization_id,
    supplier_id,
    completeness,
    freshness,
    documentation_coverage,
    consistency,
    missing_fields,
    blocking_issues,
    calculation_version,
    computed_at
  )
  SELECT
    v_owner_organization_id,
    p_supplier_id,
    v_profile_completion,
    v_freshness,
    CASE
      WHEN v_certification_count + v_data_point_count = 0 THEN 0
      ELSE round(((v_documented_data_point_count + v_documented_certification_count)::NUMERIC / (v_certification_count + v_data_point_count)) * 100, 2)
    END,
    v_consistency,
    v_missing_fields,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('rule_key', rule_key, 'severity', severity, 'message', message))
      FROM data_quality_issues
      WHERE owner_organization_id = v_owner_organization_id
        AND subject_id = p_supplier_id
        AND severity = 'blocking'
        AND status IN ('open', 'acknowledged')
    ), '[]'::jsonb),
    p_calculation_version,
    now()
  RETURNING * INTO v_score;

  RETURN v_score;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Product quality computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_compute_product_quality(
  p_product_id UUID,
  p_calculation_version TEXT DEFAULT 'product_quality_v1'
)
RETURNS data_quality_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_owner_organization_id UUID;
  v_data_point_count INTEGER;
  v_fresh_data_point_count INTEGER;
  v_documented_data_point_count INTEGER;
  v_certification_count INTEGER;
  v_documented_certification_count INTEGER;
  v_expired_certification_count INTEGER;
  v_material_count INTEGER;
  v_material_percentage_count INTEGER;
  v_material_percentage_total NUMERIC;
  v_blocking_count INTEGER;
  v_warning_count INTEGER;
  v_freshness NUMERIC(5,2);
  v_documentation NUMERIC(5,2);
  v_consistency NUMERIC(5,2);
  v_missing_fields JSONB := '[]'::jsonb;
  v_score data_quality_scores;
BEGIN
  IF length(trim(COALESCE(p_calculation_version, ''))) = 0 THEN
    RAISE EXCEPTION 'quality_calculation_version_required';
  END IF;

  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  v_owner_organization_id := v_product.brand_organization_id;

  IF NOT tracefab_has_org_role(
    v_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'product_quality_access_denied';
  END IF;

  UPDATE data_quality_issues
  SET status = 'resolved',
      resolved_at = now(),
      resolved_by = tracefab_current_user_id()
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_product_id
    AND rule_version = p_calculation_version
    AND status IN ('open', 'acknowledged');

  IF COALESCE(v_product.data_completion, 0) < 100 THEN
    v_missing_fields := v_missing_fields || to_jsonb('product_data'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_data_incomplete',
      p_calculation_version,
      'blocking',
      'data_completion',
      'Product data is not complete.',
      jsonb_build_object('completion', COALESCE(v_product.data_completion, 0))
    );
  END IF;

  IF v_product.data_readiness = 'needs_review' THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_data_needs_review',
      p_calculation_version,
      'blocking',
      'data_readiness',
      'Product data contains an item requiring review.',
      '{}'::jsonb
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE valid_until IS NULL OR valid_until >= CURRENT_DATE),
    COUNT(*) FILTER (
      WHERE source_document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = data_points.source_document_id
            AND d.status = 'available'
        )
    )
  INTO v_data_point_count, v_fresh_data_point_count, v_documented_data_point_count
  FROM data_points
  WHERE product_id = p_product_id;

  IF v_data_point_count = 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_no_data_points',
      p_calculation_version,
      'blocking',
      'data_points',
      'Product has no structured data points.',
      '{}'::jsonb
    );
  END IF;

  IF v_data_point_count > 0 THEN
    v_freshness := round((v_fresh_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
    v_documentation := round((v_documented_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
  ELSE
    v_freshness := 0;
    v_documentation := 0;
  END IF;

  IF v_data_point_count > v_fresh_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_expired_data_points',
      p_calculation_version,
      'warning',
      'data_points',
      'Product has expired data points.',
      jsonb_build_object('expired_count', v_data_point_count - v_fresh_data_point_count)
    );
  END IF;

  IF v_data_point_count > v_documented_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_missing_evidence',
      p_calculation_version,
      'warning',
      'source_document_id',
      'Some product data points have no source document.',
      jsonb_build_object('missing_document_count', v_data_point_count - v_documented_data_point_count)
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE percentage IS NOT NULL),
    COALESCE(SUM(percentage), 0)
  INTO v_material_count, v_material_percentage_count, v_material_percentage_total
  FROM product_materials
  WHERE product_id = p_product_id
    AND product_version = v_product.version;

  IF v_material_count = 0
     OR v_material_percentage_count <> v_material_count
     OR abs(v_material_percentage_total - 100) >= 0.01 THEN
    v_missing_fields := v_missing_fields || to_jsonb('product_material_composition'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_composition_incomplete',
      p_calculation_version,
      'blocking',
      'product_materials',
      'Current product composition is missing or does not total 100 percent.',
      jsonb_build_object('material_count', v_material_count, 'percentage_total', v_material_percentage_total)
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = certifications.document_id
            AND d.status = 'available'
        )
    ),
    COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < CURRENT_DATE)
  INTO v_certification_count, v_documented_certification_count, v_expired_certification_count
  FROM certifications
  WHERE product_id = p_product_id;

  IF v_expired_certification_count > 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_expired_certification',
      p_calculation_version,
      'warning',
      'certifications.expires_at',
      'Product has an expired certification.',
      jsonb_build_object('expired_count', v_expired_certification_count)
    );
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE severity = 'blocking'),
    COUNT(*) FILTER (WHERE severity = 'warning')
  INTO v_blocking_count, v_warning_count
  FROM data_quality_issues
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_product_id
    AND status IN ('open', 'acknowledged');

  v_consistency := GREATEST(0, 100 - (v_blocking_count * 30) - (v_warning_count * 10));

  INSERT INTO data_quality_scores (
    owner_organization_id,
    product_id,
    completeness,
    freshness,
    documentation_coverage,
    consistency,
    missing_fields,
    blocking_issues,
    calculation_version,
    computed_at
  )
  SELECT
    v_owner_organization_id,
    p_product_id,
    COALESCE(v_product.data_completion, 0),
    v_freshness,
    CASE
      WHEN v_certification_count + v_data_point_count = 0 THEN 0
      ELSE round(((v_documented_data_point_count + v_documented_certification_count)::NUMERIC / (v_certification_count + v_data_point_count)) * 100, 2)
    END,
    v_consistency,
    v_missing_fields,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('rule_key', rule_key, 'severity', severity, 'message', message))
      FROM data_quality_issues
      WHERE owner_organization_id = v_owner_organization_id
        AND subject_id = p_product_id
        AND severity = 'blocking'
        AND status IN ('open', 'acknowledged')
    ), '[]'::jsonb),
    p_calculation_version,
    now()
  RETURNING * INTO v_score;

  RETURN v_score;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Issue acknowledgement and waiver
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_acknowledge_quality_issue(p_issue_id UUID)
RETURNS data_quality_issues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
BEGIN
  SELECT * INTO v_issue
  FROM data_quality_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality_issue_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_issue.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'quality_issue_review_role_required';
  END IF;

  UPDATE data_quality_issues
  SET status = 'acknowledged',
      acknowledged_at = now(),
      acknowledged_by = tracefab_current_user_id()
  WHERE id = p_issue_id
  RETURNING * INTO v_issue;

  RETURN v_issue;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_waive_quality_issue(
  p_issue_id UUID,
  p_reason TEXT
)
RETURNS data_quality_issues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
BEGIN
  IF length(trim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'quality_issue_waiver_reason_required';
  END IF;

  SELECT * INTO v_issue
  FROM data_quality_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality_issue_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_issue.owner_organization_id,
    ARRAY['owner', 'admin']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'quality_issue_waive_role_required';
  END IF;

  UPDATE data_quality_issues
  SET status = 'waived',
      details = details || jsonb_build_object('waiver_reason', trim(p_reason), 'waived_by', tracefab_current_user_id(), 'waived_at', now()),
      resolved_at = NULL,
      resolved_by = NULL
  WHERE id = p_issue_id
  RETURNING * INTO v_issue;

  RETURN v_issue;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS and privileges
-- -----------------------------------------------------------------------------

ALTER TABLE data_quality_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quality_insert_owner ON data_quality_scores;
DROP POLICY IF EXISTS quality_select_authorized ON data_quality_scores;
CREATE POLICY quality_select_authorized ON data_quality_scores
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR (
      supplier_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM suppliers s
        WHERE s.id = data_quality_scores.supplier_id
          AND tracefab_can_access_shared_subject(s.organization_id, 'supplier', s.id)
      )
    )
  );

CREATE POLICY quality_issues_select_owner ON data_quality_issues
  FOR SELECT TO PUBLIC USING (tracefab_can_access_org(owner_organization_id));

-- No direct INSERT/UPDATE policy: issue creation is computed and issue actions
-- go through acknowledgement/waiver functions.

REVOKE EXECUTE ON FUNCTION tracefab_validate_quality_issue_subject() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_quality_issues_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_upsert_quality_issue(UUID, UUID, UUID, TEXT, TEXT, quality_issue_severity, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_compute_supplier_quality(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_compute_product_quality(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_acknowledge_quality_issue(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_waive_quality_issue(UUID, TEXT) FROM PUBLIC;

GRANT SELECT ON data_quality_issues TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_compute_supplier_quality(UUID, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_compute_product_quality(UUID, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_acknowledge_quality_issue(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_waive_quality_issue(UUID, TEXT) TO PUBLIC;

COMMENT ON TABLE data_quality_issues IS 'Explainable, versioned quality findings. An issue is not a certification result.';
COMMENT ON TABLE data_quality_scores IS 'Append-only quality score snapshots. Scores describe data readiness and quality dimensions, not truth or compliance.';
COMMENT ON COLUMN data_quality_scores.consistency IS 'Rule-based consistency score; it does not mean an external verifier confirmed the data.';
COMMENT ON FUNCTION tracefab_compute_supplier_quality(UUID, TEXT) IS 'Computes an explainable supplier score and current quality issues.';
COMMENT ON FUNCTION tracefab_compute_product_quality(UUID, TEXT) IS 'Computes an explainable product score and current quality issues.';

-- SOURCE: 20260922060000_tracefab_traceability.sql
-- Tracefab Chantier 7 — Traceability
--
-- Hardens the PostgreSQL adjacency graph for product traceability. Every node
-- and link keeps an explicit data status; a graph is not proof that a physical
-- supply-chain event was independently verified.

-- -----------------------------------------------------------------------------
-- 1. Traceability record metadata
-- -----------------------------------------------------------------------------

ALTER TABLE supply_chain_nodes
  ADD COLUMN IF NOT EXISTS status data_value_status NOT NULL DEFAULT 'declared',
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS declared_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS observed_at DATE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE supply_chain_links
  ADD COLUMN IF NOT EXISTS status data_value_status NOT NULL DEFAULT 'declared',
  ADD COLUMN IF NOT EXISTS declared_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_traceability_nodes_status
  ON supply_chain_nodes(product_id, node_type, status);

CREATE INDEX IF NOT EXISTS idx_traceability_links_status
  ON supply_chain_links(product_id, status, sequence_number);

CREATE INDEX IF NOT EXISTS idx_traceability_links_nodes
  ON supply_chain_links(source_node_id, target_node_id);

CREATE OR REPLACE FUNCTION tracefab_traceability_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER traceability_nodes_set_updated_at
    BEFORE UPDATE ON supply_chain_nodes
    FOR EACH ROW EXECUTE FUNCTION tracefab_traceability_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER traceability_links_set_updated_at
    BEFORE UPDATE ON supply_chain_links
    FOR EACH ROW EXECUTE FUNCTION tracefab_traceability_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 2. Graph integrity
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_supply_chain_node()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reference_count INTEGER;
  v_material_owner UUID;
  v_site_owner UUID;
  v_product_owner UUID;
BEGIN
  v_reference_count := num_nonnulls(
    NEW.organization_id,
    NEW.supplier_site_id,
    NEW.product_id,
    NEW.material_id,
    NEW.process_code
  );

  IF v_reference_count <> 1 THEN
    RAISE EXCEPTION 'traceability_node_requires_exactly_one_reference';
  END IF;

  IF NEW.node_type = 'organization' AND NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_node_reference_required';
  ELSIF NEW.node_type = 'site' AND NEW.supplier_site_id IS NULL THEN
    RAISE EXCEPTION 'site_node_reference_required';
  ELSIF NEW.node_type = 'product' AND NEW.product_id IS NULL THEN
    RAISE EXCEPTION 'product_node_reference_required';
  ELSIF NEW.node_type = 'material' AND NEW.material_id IS NULL THEN
    RAISE EXCEPTION 'material_node_reference_required';
  ELSIF NEW.node_type = 'process' AND NEW.process_code IS NULL THEN
    RAISE EXCEPTION 'process_node_reference_required';
  END IF;

  IF NEW.node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner
    FROM materials
    WHERE id = NEW.material_id;
    IF v_material_owner IS NULL THEN
      RAISE EXCEPTION 'material_node_target_not_found';
    END IF;
  ELSIF NEW.node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner
    FROM supplier_sites ss
    JOIN suppliers s ON s.id = ss.supplier_id
    WHERE ss.id = NEW.supplier_site_id;
    IF v_site_owner IS NULL THEN
      RAISE EXCEPTION 'site_node_target_not_found';
    END IF;
  ELSIF NEW.node_type = 'product' THEN
    SELECT brand_organization_id INTO v_product_owner
    FROM tracefab_products
    WHERE id = NEW.product_id;
    IF v_product_owner IS NULL THEN
      RAISE EXCEPTION 'product_node_target_not_found';
    END IF;
  END IF;

  IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = NEW.source_document_id
      AND (
        tracefab_can_access_org(d.owner_organization_id)
        OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
      )
  ) THEN
    RAISE EXCEPTION 'traceability_source_document_not_accessible';
  END IF;

  IF NEW.declared_by IS NULL THEN
    NEW.declared_by := tracefab_current_user_id();
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER traceability_nodes_validate
    BEFORE INSERT OR UPDATE ON supply_chain_nodes
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_supply_chain_node();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_supply_chain_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_owner UUID;
  v_source_exists BOOLEAN;
  v_target_exists BOOLEAN;
BEGIN
  SELECT brand_organization_id INTO v_product_owner
  FROM tracefab_products
  WHERE id = NEW.product_id;

  IF v_product_owner IS NULL THEN
    RAISE EXCEPTION 'traceability_product_not_found';
  END IF;

  SELECT EXISTS (SELECT 1 FROM supply_chain_nodes WHERE id = NEW.source_node_id),
         EXISTS (SELECT 1 FROM supply_chain_nodes WHERE id = NEW.target_node_id)
  INTO v_source_exists, v_target_exists;

  IF NOT v_source_exists OR NOT v_target_exists THEN
    RAISE EXCEPTION 'traceability_link_node_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM supply_chain_nodes n
    WHERE n.id IN (NEW.source_node_id, NEW.target_node_id)
      AND n.node_type = 'product'
      AND n.product_id <> NEW.product_id
  ) THEN
    RAISE EXCEPTION 'traceability_product_node_mismatch';
  END IF;

  IF NEW.source_node_id = NEW.target_node_id THEN
    RAISE EXCEPTION 'traceability_link_cannot_self_reference';
  END IF;

  IF NEW.evidence_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = NEW.evidence_document_id
      AND (
        tracefab_can_access_org(d.owner_organization_id)
        OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
      )
  ) THEN
    RAISE EXCEPTION 'traceability_evidence_document_not_accessible';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'traceability_link_product_is_immutable';
  END IF;

  IF NEW.declared_by IS NULL THEN
    NEW.declared_by := tracefab_current_user_id();
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER traceability_links_validate
    BEFORE INSERT OR UPDATE ON supply_chain_links
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_supply_chain_link();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Controlled graph mutations
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_supply_chain_node(
  p_graph_product_id UUID,
  p_node_type node_type,
  p_label TEXT,
  p_organization_id UUID DEFAULT NULL,
  p_supplier_site_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL,
  p_material_id UUID DEFAULT NULL,
  p_process_code TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_source_document_id UUID DEFAULT NULL,
  p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_node supply_chain_nodes;
  v_site_owner UUID;
  v_material_owner UUID;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_graph_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'traceability_product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF length(trim(COALESCE(p_label, ''))) = 0 THEN
    RAISE EXCEPTION 'traceability_node_label_required';
  END IF;

  IF p_node_type = 'product' AND p_product_id IS DISTINCT FROM p_graph_product_id THEN
    RAISE EXCEPTION 'traceability_product_node_must_match_graph_product';
  END IF;

  IF p_node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner
    FROM materials
    WHERE id = p_material_id;
    IF v_material_owner IS NULL OR NOT (
      tracefab_can_access_org(v_material_owner)
      OR tracefab_can_access_shared_subject(v_material_owner, 'material', p_material_id)
    ) THEN
      RAISE EXCEPTION 'traceability_material_access_denied';
    END IF;
  END IF;

  IF p_node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner
    FROM supplier_sites ss
    JOIN suppliers s ON s.id = ss.supplier_id
    WHERE ss.id = p_supplier_site_id;
    IF v_site_owner IS NULL OR NOT (
      tracefab_can_access_org(v_site_owner)
      OR tracefab_can_access_shared_subject(v_site_owner, 'supplier_site', p_supplier_site_id)
    ) THEN
      RAISE EXCEPTION 'traceability_site_access_denied';
    END IF;
  END IF;

  IF p_node_type = 'organization'
     AND p_organization_id IS DISTINCT FROM v_product.brand_organization_id
     AND NOT EXISTS (
       SELECT 1 FROM brand_supplier_relationships r
       WHERE r.brand_organization_id = v_product.brand_organization_id
         AND r.supplier_organization_id = p_organization_id
         AND r.status = 'active'
     ) THEN
    RAISE EXCEPTION 'traceability_organization_not_in_active_relationship';
  END IF;

  INSERT INTO supply_chain_nodes (
    node_type,
    organization_id,
    supplier_site_id,
    product_id,
    material_id,
    process_code,
    label,
    metadata,
    status,
    source_document_id,
    declared_by,
    observed_at
  )
  VALUES (
    p_node_type,
    p_organization_id,
    p_supplier_site_id,
    p_product_id,
    p_material_id,
    NULLIF(trim(p_process_code), ''),
    trim(p_label),
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_source_document_id IS NULL THEN 'declared' ELSE 'documented' END,
    p_source_document_id,
    tracefab_current_user_id(),
    p_observed_at
  )
  RETURNING * INTO v_node;

  RETURN v_node;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_node(
  p_graph_product_id UUID,
  p_node_id UUID,
  p_label TEXT,
  p_metadata JSONB,
  p_source_document_id UUID DEFAULT NULL,
  p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_node supply_chain_nodes;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_graph_product_id;

  IF NOT FOUND OR NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supply_chain_links l
    WHERE l.product_id = p_graph_product_id
      AND (l.source_node_id = p_node_id OR l.target_node_id = p_node_id)
  ) THEN
    RAISE EXCEPTION 'traceability_node_not_in_product_graph';
  END IF;

  IF length(trim(COALESCE(p_label, ''))) = 0 THEN
    RAISE EXCEPTION 'traceability_node_label_required';
  END IF;

  UPDATE supply_chain_nodes
  SET label = trim(p_label),
      metadata = COALESCE(p_metadata, '{}'::jsonb),
      source_document_id = p_source_document_id,
      status = CASE WHEN p_source_document_id IS NULL THEN 'declared' ELSE 'documented' END,
      declared_by = tracefab_current_user_id(),
      observed_at = p_observed_at
  WHERE id = p_node_id
  RETURNING * INTO v_node;

  RETURN v_node;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_add_supply_chain_link(
  p_product_id UUID,
  p_source_node_id UUID,
  p_target_node_id UUID,
  p_link_type supply_chain_link_type,
  p_sequence_number INTEGER DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,
  p_valid_until DATE DEFAULT NULL,
  p_evidence_document_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS supply_chain_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_link supply_chain_links;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND OR NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF p_sequence_number IS NOT NULL AND p_sequence_number < 0 THEN
    RAISE EXCEPTION 'traceability_sequence_must_be_positive';
  END IF;

  INSERT INTO supply_chain_links (
    product_id,
    source_node_id,
    target_node_id,
    link_type,
    sequence_number,
    valid_from,
    valid_until,
    evidence_document_id,
    metadata,
    status,
    declared_by
  )
  VALUES (
    p_product_id,
    p_source_node_id,
    p_target_node_id,
    p_link_type,
    p_sequence_number,
    p_valid_from,
    p_valid_until,
    p_evidence_document_id,
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_evidence_document_id IS NULL THEN 'declared' ELSE 'documented' END,
    tracefab_current_user_id()
  )
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_link(
  p_link_id UUID,
  p_sequence_number INTEGER,
  p_valid_from DATE,
  p_valid_until DATE,
  p_evidence_document_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS supply_chain_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link supply_chain_links;
  v_brand_organization_id UUID;
BEGIN
  SELECT l.* INTO v_link
  FROM supply_chain_links l
  WHERE l.id = p_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'traceability_link_not_found';
  END IF;

  SELECT p.brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products p
  WHERE p.id = v_link.product_id;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF p_sequence_number IS NOT NULL AND p_sequence_number < 0 THEN
    RAISE EXCEPTION 'traceability_sequence_must_be_positive';
  END IF;

  UPDATE supply_chain_links
  SET sequence_number = p_sequence_number,
      valid_from = p_valid_from,
      valid_until = p_valid_until,
      evidence_document_id = p_evidence_document_id,
      metadata = COALESCE(p_metadata, '{}'::jsonb),
      status = CASE WHEN p_evidence_document_id IS NULL THEN 'declared' ELSE 'documented' END,
      declared_by = tracefab_current_user_id()
  WHERE id = p_link_id
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_get_product_traceability(p_product_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_organization_id UUID;
  v_result JSONB;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF v_brand_organization_id IS NULL OR NOT tracefab_is_org_member(v_brand_organization_id) THEN
    RAISE EXCEPTION 'traceability_read_access_denied';
  END IF;

  SELECT jsonb_build_object(
    'product_id', p_product_id,
    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', n.id,
        'node_type', n.node_type,
        'label', n.label,
        'metadata', n.metadata,
        'status', n.status,
        'observed_at', n.observed_at,
        'source_document_id', CASE
          WHEN n.source_document_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = n.source_document_id
              AND (
                tracefab_can_access_org(d.owner_organization_id)
                OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
              )
          ) THEN n.source_document_id
          ELSE NULL
        END
      ) ORDER BY n.node_type, n.label)
      FROM supply_chain_nodes n
      WHERE EXISTS (
        SELECT 1 FROM supply_chain_links l
        WHERE l.product_id = p_product_id
          AND (l.source_node_id = n.id OR l.target_node_id = n.id)
      )
    ), '[]'::jsonb),
    'links', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id,
        'source_node_id', l.source_node_id,
        'target_node_id', l.target_node_id,
        'link_type', l.link_type,
        'sequence_number', l.sequence_number,
        'valid_from', l.valid_from,
        'valid_until', l.valid_until,
        'status', l.status,
        'metadata', l.metadata,
        'evidence_document_id', CASE
          WHEN l.evidence_document_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = l.evidence_document_id
              AND (
                tracefab_can_access_org(d.owner_organization_id)
                OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
              )
          ) THEN l.evidence_document_id
          ELSE NULL
        END
      ) ORDER BY l.sequence_number NULLS LAST, l.created_at)
      FROM supply_chain_links l
      WHERE l.product_id = p_product_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RLS and function privileges
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS nodes_select_authorized ON supply_chain_nodes;
CREATE POLICY nodes_select_traceability_graph ON supply_chain_nodes
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(organization_id)
    OR (
      supplier_site_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM supplier_sites ss
        JOIN suppliers s ON s.id = ss.supplier_id
        WHERE ss.id = supply_chain_nodes.supplier_site_id
          AND (
            tracefab_can_access_org(s.organization_id)
            OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', ss.id)
          )
      )
    )
    OR (
      material_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM materials m
        WHERE m.id = supply_chain_nodes.material_id
          AND (
            tracefab_can_access_org(m.owner_organization_id)
            OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id)
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM supply_chain_links l
      JOIN tracefab_products p ON p.id = l.product_id
      WHERE (l.source_node_id = supply_chain_nodes.id OR l.target_node_id = supply_chain_nodes.id)
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

DROP POLICY IF EXISTS nodes_insert_authorized ON supply_chain_nodes;
-- Node creation and updates go through the graph functions.

DROP POLICY IF EXISTS links_select_brand ON supply_chain_links;
CREATE POLICY links_select_traceability_graph ON supply_chain_links
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = supply_chain_links.product_id
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

DROP POLICY IF EXISTS links_insert_brand ON supply_chain_links;
-- Link creation and updates go through the graph functions.

REVOKE EXECUTE ON FUNCTION tracefab_traceability_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_supply_chain_node() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_supply_chain_link() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_create_supply_chain_node(UUID, node_type, TEXT, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_supply_chain_node(UUID, UUID, TEXT, JSONB, UUID, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_add_supply_chain_link(UUID, UUID, UUID, supply_chain_link_type, INTEGER, DATE, DATE, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_supply_chain_link(UUID, INTEGER, DATE, DATE, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_get_product_traceability(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_create_supply_chain_node(UUID, node_type, TEXT, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, DATE) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_supply_chain_node(UUID, UUID, TEXT, JSONB, UUID, DATE) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_add_supply_chain_link(UUID, UUID, UUID, supply_chain_link_type, INTEGER, DATE, DATE, UUID, JSONB) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_supply_chain_link(UUID, INTEGER, DATE, DATE, UUID, JSONB) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_get_product_traceability(UUID) TO PUBLIC;

COMMENT ON TABLE supply_chain_nodes IS 'Product traceability graph nodes with provenance status; graph presence is not independent verification.';
COMMENT ON TABLE supply_chain_links IS 'Product traceability graph edges with explicit declared/documented status and optional evidence.';
COMMENT ON FUNCTION tracefab_get_product_traceability(UUID) IS 'Returns a tenant-authorized graph projection with evidence identifiers redacted when access is absent.';

-- SOURCE: 20260922070000_tracefab_dpp_readiness.sql
-- Tracefab Chantier 8 — DPP Readiness
--
-- Implements versioned readiness profiles and product-level readiness
-- computations. This is a readiness projection, not a final regulatory
-- compliance declaration and not a public DPP publication flow.

-- -----------------------------------------------------------------------------
-- 1. Requirement profiles and DPP record metadata
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE dpp_profile_status AS ENUM ('draft', 'active', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS dpp_requirement_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  name TEXT NOT NULL,
  status dpp_profile_status NOT NULL DEFAULT 'draft',
  definition JSONB NOT NULL CHECK (
    COALESCE(jsonb_typeof(definition -> 'requirements') = 'array', false)
    AND COALESCE(jsonb_array_length(definition -> 'requirements'), 0) > 0
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_key, profile_version)
);

CREATE INDEX IF NOT EXISTS idx_dpp_profiles_active
  ON dpp_requirement_profiles(profile_key, profile_version, status);

ALTER TABLE dpp_records
  ADD COLUMN IF NOT EXISTS requirement_profile_id UUID REFERENCES dpp_requirement_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS input_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dpp_records_profile
  ON dpp_records(requirement_profile_id, product_id, product_version, computed_at DESC);

CREATE OR REPLACE FUNCTION tracefab_dpp_profiles_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER dpp_profiles_set_updated_at
    BEFORE UPDATE ON dpp_requirement_profiles
    FOR EACH ROW EXECUTE FUNCTION tracefab_dpp_profiles_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Initial profile is a Tracefab readiness profile, deliberately not labelled as
-- a legal or final regulatory profile.
INSERT INTO dpp_requirement_profiles (
  profile_key,
  profile_version,
  name,
  status,
  definition
)
VALUES (
  'textile_readiness_mvp',
  '1.0',
  'Tracefab textile readiness MVP',
  'active',
  '{
    "scope": "product_readiness",
    "notice": "Operational readiness profile, not a final regulatory compliance declaration.",
    "requirements": [
      {"key": "product.reference", "label": "Product reference", "blocking": true},
      {"key": "product.name", "label": "Product name", "blocking": true},
      {"key": "product.description", "label": "Product description", "blocking": true},
      {"key": "product.category", "label": "Product category", "blocking": true},
      {"key": "product.country_of_manufacture", "label": "Country of manufacture", "blocking": true},
      {"key": "product.data_ready", "label": "Core product data ready", "blocking": true},
      {"key": "composition.complete", "label": "Complete material composition", "blocking": true},
      {"key": "traceability.graph", "label": "Traceability graph present", "blocking": true},
      {"key": "quality.no_blocking_issues", "label": "No open blocking quality issue", "blocking": true}
    ]
  }'::jsonb
)
ON CONFLICT (profile_key, profile_version) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status,
    definition = EXCLUDED.definition;

-- -----------------------------------------------------------------------------
-- 2. Requirement evaluation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_dpp_requirement_met(
  p_requirement_key TEXT,
  p_product_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_count INTEGER;
  v_material_percentage_count INTEGER;
  v_percentage_total NUMERIC;
  v_met BOOLEAN := false;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  CASE p_requirement_key
    WHEN 'product.reference' THEN
      v_met := length(trim(COALESCE(v_product.reference, ''))) > 0;
    WHEN 'product.name' THEN
      v_met := length(trim(COALESCE(v_product.name, ''))) > 0;
    WHEN 'product.description' THEN
      v_met := length(trim(COALESCE(v_product.description, ''))) >= 30;
    WHEN 'product.category' THEN
      v_met := length(trim(COALESCE(v_product.category, ''))) > 0;
    WHEN 'product.country_of_manufacture' THEN
      v_met := v_product.country_of_manufacture IS NOT NULL
        AND length(trim(v_product.country_of_manufacture)) = 2;
    WHEN 'product.data_ready' THEN
      v_met := v_product.data_readiness = 'data_ready';
    WHEN 'composition.complete' THEN
      SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE percentage IS NOT NULL),
        COALESCE(SUM(percentage), 0)
      INTO v_material_count, v_material_percentage_count, v_percentage_total
      FROM product_materials
      WHERE product_id = p_product_id
        AND product_version = v_product.version;
      v_met := v_material_count > 0
        AND v_material_percentage_count = v_material_count
        AND abs(v_percentage_total - 100) < 0.01;
    WHEN 'traceability.graph' THEN
      v_met := EXISTS (
        SELECT 1 FROM supply_chain_links
        WHERE product_id = p_product_id
      );
    WHEN 'quality.no_blocking_issues' THEN
      SELECT s.blocking_issues = '[]'::jsonb
      INTO v_met
      FROM data_quality_scores s
      WHERE s.product_id = p_product_id
      ORDER BY s.computed_at DESC
      LIMIT 1;
      v_met := COALESCE(v_met, false);
    WHEN 'evidence.product_data' THEN
      v_met := EXISTS (
        SELECT 1
        FROM data_points dp
        JOIN documents d ON d.id = dp.source_document_id
        WHERE dp.product_id = p_product_id
          AND d.status = 'available'
      );
    ELSE
      v_met := false;
  END CASE;

  RETURN v_met;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_compute_dpp_readiness(
  p_product_id UUID,
  p_profile_key TEXT DEFAULT 'textile_readiness_mvp',
  p_profile_version TEXT DEFAULT '1.0'
)
RETURNS dpp_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_profile dpp_requirement_profiles;
  v_requirement JSONB;
  v_requirement_key TEXT;
  v_met BOOLEAN;
  v_missing_fields JSONB := '[]'::jsonb;
  v_blocking_issues JSONB := '[]'::jsonb;
  v_readiness dpp_readiness_status;
  v_source_snapshot JSONB;
  v_fingerprint TEXT;
  v_record dpp_records;
  v_has_review_required BOOLEAN := false;
  v_requirement_results JSONB := '[]'::jsonb;
  v_composition_snapshot JSONB := '[]'::jsonb;
  v_traceability_snapshot JSONB := '[]'::jsonb;
  v_quality_snapshot JSONB := '{}'::jsonb;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'dpp_readiness_role_required';
  END IF;

  SELECT * INTO v_profile
  FROM dpp_requirement_profiles
  WHERE profile_key = p_profile_key
    AND profile_version = p_profile_version
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_dpp_requirement_profile_not_found';
  END IF;

  FOR v_requirement IN
    SELECT value FROM jsonb_array_elements(v_profile.definition -> 'requirements')
  LOOP
    v_requirement_key := v_requirement ->> 'key';
    v_met := tracefab_dpp_requirement_met(v_requirement_key, p_product_id);
    v_requirement_results := v_requirement_results || jsonb_build_array(
      jsonb_build_object(
        'key', v_requirement_key,
        'met', v_met
      )
    );

    IF NOT v_met THEN
      v_missing_fields := v_missing_fields || jsonb_build_array(
        jsonb_build_object(
          'key', v_requirement_key,
          'label', v_requirement ->> 'label',
          'blocking', COALESCE((v_requirement ->> 'blocking')::boolean, true)
        )
      );

      IF COALESCE((v_requirement ->> 'blocking')::boolean, true) THEN
        v_blocking_issues := v_blocking_issues || jsonb_build_array(
          jsonb_build_object(
            'key', v_requirement_key,
            'label', v_requirement ->> 'label',
            'reason', 'requirement_not_met'
          )
        );
      END IF;
    END IF;
  END LOOP;

  IF v_product.data_readiness = 'needs_review'
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT s.blocking_issues
         FROM data_quality_scores s
         WHERE s.product_id = p_product_id
         ORDER BY s.computed_at DESC
         LIMIT 1
       ) latest_score
       WHERE latest_score.blocking_issues <> '[]'::jsonb
     ) THEN
    v_has_review_required := true;
  END IF;

  v_readiness := CASE
    WHEN jsonb_array_length(v_blocking_issues) > 0 AND v_has_review_required
      THEN 'review_required'::dpp_readiness_status
    WHEN jsonb_array_length(v_blocking_issues) > 0
      THEN 'in_progress'::dpp_readiness_status
    WHEN v_has_review_required
      THEN 'review_required'::dpp_readiness_status
    ELSE 'data_ready'::dpp_readiness_status
  END;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'material_id', pm.material_id,
        'material_role', pm.material_role,
        'percentage', pm.percentage,
        'unit', pm.unit,
        'product_version', pm.product_version
      ) ORDER BY pm.material_id, pm.material_role, pm.product_version
    ),
    '[]'::jsonb
  )
  INTO v_composition_snapshot
  FROM product_materials pm
  WHERE pm.product_id = p_product_id
    AND pm.product_version = v_product.version;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'link_id', scl.id,
        'source_node_id', scl.source_node_id,
        'target_node_id', scl.target_node_id,
        'link_type', scl.link_type,
        'sequence_number', scl.sequence_number
      ) ORDER BY scl.sequence_number NULLS LAST, scl.id
    ),
    '[]'::jsonb
  )
  INTO v_traceability_snapshot
  FROM supply_chain_links scl
  WHERE scl.product_id = p_product_id;

  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'score_id', s.id,
        'computed_at', s.computed_at,
        'completeness', s.completeness,
        'freshness', s.freshness,
        'documentation_coverage', s.documentation_coverage,
        'consistency', s.consistency,
        'missing_fields', s.missing_fields,
        'blocking_issues', s.blocking_issues
      )
      FROM data_quality_scores s
      WHERE s.product_id = p_product_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ),
    '{}'::jsonb
  )
  INTO v_quality_snapshot;

  v_source_snapshot := jsonb_build_object(
    'product', jsonb_build_object(
      'id', v_product.id,
      'version', v_product.version,
      'reference', v_product.reference,
      'name', v_product.name,
      'description', v_product.description,
      'category', v_product.category,
      'country_of_manufacture', v_product.country_of_manufacture,
      'data_readiness', v_product.data_readiness,
      'data_completion', v_product.data_completion,
      'updated_at', v_product.updated_at
    ),
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'key', v_profile.profile_key,
      'version', v_profile.profile_version,
      'definition', v_profile.definition
    ),
    'composition', v_composition_snapshot,
    'traceability_links', v_traceability_snapshot,
    'latest_quality_score', v_quality_snapshot,
    'requirement_results', v_requirement_results,
    'captured_at', now()
  );
  v_fingerprint := md5((v_source_snapshot - 'captured_at')::TEXT);

  INSERT INTO dpp_records (
    product_id,
    product_version,
    requirement_profile_key,
    requirement_profile_version,
    requirement_profile_id,
    readiness_status,
    missing_fields,
    blocking_issues,
    public_projection,
    computed_at,
    computed_by,
    input_fingerprint,
    source_snapshot,
    reviewed_at,
    reviewed_by
  )
  VALUES (
    p_product_id,
    v_product.version,
    v_profile.profile_key,
    v_profile.profile_version,
    v_profile.id,
    v_readiness,
    v_missing_fields,
    v_blocking_issues,
    '{}'::jsonb,
    now(),
    tracefab_current_user_id(),
    v_fingerprint,
    v_source_snapshot,
    NULL,
    NULL
  )
  ON CONFLICT (product_id, product_version, requirement_profile_key, requirement_profile_version)
  DO UPDATE SET
    requirement_profile_id = EXCLUDED.requirement_profile_id,
    readiness_status = EXCLUDED.readiness_status,
    missing_fields = EXCLUDED.missing_fields,
    blocking_issues = EXCLUDED.blocking_issues,
    computed_at = EXCLUDED.computed_at,
    computed_by = EXCLUDED.computed_by,
    input_fingerprint = EXCLUDED.input_fingerprint,
    source_snapshot = EXCLUDED.source_snapshot,
    reviewed_at = NULL,
    reviewed_by = NULL
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_mark_dpp_ready_to_publish(p_dpp_record_id UUID)
RETURNS dpp_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record dpp_records;
  v_brand_organization_id UUID;
BEGIN
  SELECT r.* INTO v_record
  FROM dpp_records r
  WHERE r.id = p_dpp_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dpp_record_not_found';
  END IF;

  SELECT p.brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products p
  WHERE p.id = v_record.product_id;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'dpp_publish_review_role_required';
  END IF;

  IF v_record.readiness_status <> 'data_ready' THEN
    RAISE EXCEPTION 'dpp_record_not_data_ready';
  END IF;

  UPDATE dpp_records
  SET readiness_status = 'ready_to_publish',
      reviewed_at = now(),
      reviewed_by = tracefab_current_user_id()
  WHERE id = p_dpp_record_id
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS and privileges
-- -----------------------------------------------------------------------------

ALTER TABLE dpp_requirement_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY dpp_profiles_select_authenticated ON dpp_requirement_profiles
  FOR SELECT TO PUBLIC USING (status = 'active');

DROP POLICY IF EXISTS dpp_insert_brand ON dpp_records;
-- DPP records are computed and reviewed through functions only. There is no
-- public SELECT policy and no public projection in this chantier.

REVOKE EXECUTE ON FUNCTION tracefab_dpp_profiles_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) FROM PUBLIC;

GRANT SELECT ON dpp_requirement_profiles TO PUBLIC;
REVOKE INSERT, UPDATE ON dpp_records FROM PUBLIC;
GRANT SELECT ON dpp_records TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) TO PUBLIC;

COMMENT ON TABLE dpp_requirement_profiles IS 'Versioned operational readiness profiles. These are not final legal requirements.';
COMMENT ON TABLE dpp_records IS 'Versioned DPP readiness projections. This table does not constitute a final regulatory compliance declaration or public DPP.';
COMMENT ON COLUMN dpp_records.public_projection IS 'Reserved for a later public projection chantier; kept empty by the readiness workflow.';
COMMENT ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) IS 'Computes an operational readiness projection from a versioned profile and current source data.';
COMMENT ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) IS 'Marks a reviewed readiness record as ready_to_publish; it does not publish a public DPP.';


-- -----------------------------------------------------------------------------
-- Neon application order model
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE tracefab_order_status AS ENUM ('draft', 'submitted', 'confirmed', 'fulfilled', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  status tracefab_order_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracefab_orders_buyer
  ON orders(buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracefab_orders_product
  ON orders(product_id, created_at DESC);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_select_participant ON orders
  FOR SELECT TO PUBLIC USING (
    buyer_user_id = tracefab_current_user_id()
    OR (organization_id IS NOT NULL AND tracefab_is_org_member(organization_id))
  );
CREATE POLICY orders_insert_buyer ON orders
  FOR INSERT TO PUBLIC WITH CHECK (buyer_user_id = tracefab_current_user_id());
CREATE POLICY orders_update_participant ON orders
  FOR UPDATE TO PUBLIC
  USING (buyer_user_id = tracefab_current_user_id())
  WITH CHECK (buyer_user_id = tracefab_current_user_id());

COMMENT ON TABLE users IS 'Clerk identities synchronized by the trusted Tracefab API.';
COMMENT ON COLUMN users.clerk_user_id IS 'Clerk user subject; never a password or session token.';
COMMENT ON TABLE orders IS 'Operational Tracefab order records; separate from DPP readiness and not public by default.';
COMMENT ON TABLE dpp_records IS 'Operational DPP readiness projection; not final legal compliance and not a public DPP.';
