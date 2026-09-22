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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role membership_role NOT NULL DEFAULT 'viewer',
  status membership_status NOT NULL DEFAULT 'active',
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brand_supplier_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status relationship_status NOT NULL DEFAULT 'invited',
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  responded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  supersedes_id UUID REFERENCES data_responses(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
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
  declared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
  computed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (product_id, product_version, requirement_profile_key, requirement_profile_version)
);

-- -----------------------------------------------------------------------------
-- 7. Audit
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
      AND m.user_id = auth.uid()
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
      AND m.user_id = auth.uid()
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
     AND m.user_id = auth.uid()
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF p_type = 'platform' THEN
    RAISE EXCEPTION 'platform_organization_not_user_creatable';
  END IF;

  INSERT INTO organizations (type, legal_name, display_name, country_code, status, created_by)
  VALUES (p_type, p_legal_name, p_display_name, p_country_code, 'active', auth.uid())
  RETURNING * INTO v_organization;

  INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at)
  VALUES (v_organization.id, auth.uid(), 'owner', 'active', now());

  RETURN v_organization;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_create_organization(organization_type, TEXT, TEXT, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_create_organization(organization_type, TEXT, TEXT, VARCHAR) TO authenticated;
REVOKE EXECUTE ON FUNCTION tracefab_is_org_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_is_org_member(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION tracefab_has_org_role(UUID, membership_role[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_has_org_role(UUID, membership_role[]) TO authenticated;
REVOKE EXECUTE ON FUNCTION tracefab_can_access_org(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_can_access_org(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION tracefab_can_access_shared_subject(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_can_access_shared_subject(UUID, TEXT, UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION tracefab_set_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_set_updated_at() TO authenticated;
REVOKE EXECUTE ON FUNCTION tracefab_validate_subject_ownership() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_validate_subject_ownership() TO authenticated;

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
  FOR SELECT TO authenticated USING (tracefab_is_org_member(id));
CREATE POLICY organizations_insert_creator ON organizations
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(id, ARRAY['owner', 'admin']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(id, ARRAY['owner', 'admin']::membership_role[]));

-- Memberships
CREATE POLICY memberships_select_member ON organization_memberships
  FOR SELECT TO authenticated USING (tracefab_is_org_member(organization_id));
CREATE POLICY memberships_insert_admin ON organization_memberships
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));
CREATE POLICY memberships_update_admin ON organization_memberships
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));

-- Invitations
CREATE POLICY invitations_select_admin ON organization_invitations
  FOR SELECT TO authenticated USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));
CREATE POLICY invitations_insert_admin ON organization_invitations
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]) AND invited_by = auth.uid());
CREATE POLICY invitations_update_admin ON organization_invitations
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[]));

-- Relationships
CREATE POLICY relationships_select_participant ON brand_supplier_relationships
  FOR SELECT TO authenticated USING (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));
CREATE POLICY relationships_insert_participant ON brand_supplier_relationships
  FOR INSERT TO authenticated WITH CHECK (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));
CREATE POLICY relationships_update_participant ON brand_supplier_relationships
  FOR UPDATE TO authenticated USING (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id))
  WITH CHECK (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));

-- Supplier profile and sites
CREATE POLICY suppliers_select_authorized ON suppliers
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(organization_id)
    OR tracefab_can_access_shared_subject(organization_id, 'supplier', id)
  );
CREATE POLICY suppliers_insert_admin ON suppliers
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));
CREATE POLICY suppliers_update_admin ON suppliers
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));

CREATE POLICY supplier_sites_select_authorized ON supplier_sites
  FOR SELECT TO authenticated USING (
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
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_sites.supplier_id AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );
CREATE POLICY supplier_sites_update_member ON supplier_sites
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_sites.supplier_id AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_sites.supplier_id AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );

-- Products and materials
CREATE POLICY products_select_brand ON tracefab_products
  FOR SELECT TO authenticated USING (tracefab_is_org_member(brand_organization_id));
CREATE POLICY products_insert_brand ON tracefab_products
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY products_update_brand ON tracefab_products
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY materials_select_authorized ON materials
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'material', id)
  );
CREATE POLICY materials_insert_owner ON materials
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY materials_update_owner ON materials
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY product_materials_select_authorized ON product_materials
  FOR SELECT TO authenticated USING (
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
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );
CREATE POLICY product_materials_update_brand ON product_materials
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = product_materials.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );

-- Traceability
CREATE POLICY nodes_select_authorized ON supply_chain_nodes
  FOR SELECT TO authenticated USING (
    (organization_id IS NOT NULL AND tracefab_can_access_org(organization_id))
    OR (supplier_site_id IS NOT NULL AND EXISTS (SELECT 1 FROM supplier_sites ss JOIN suppliers s ON s.id = ss.supplier_id WHERE ss.id = supply_chain_nodes.supplier_site_id AND (tracefab_can_access_org(s.organization_id) OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', ss.id))))
    OR (product_id IS NOT NULL AND EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_nodes.product_id AND tracefab_is_org_member(p.brand_organization_id)))
    OR (material_id IS NOT NULL AND EXISTS (SELECT 1 FROM materials m WHERE m.id = supply_chain_nodes.material_id AND (tracefab_can_access_org(m.owner_organization_id) OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id))))
  );
CREATE POLICY nodes_insert_authorized ON supply_chain_nodes
  FOR INSERT TO authenticated WITH CHECK (
    (organization_id IS NOT NULL AND tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
    OR (product_id IS NOT NULL AND EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_nodes.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])))
  );
CREATE POLICY links_select_brand ON supply_chain_links
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_links.product_id AND tracefab_is_org_member(p.brand_organization_id))
  );
CREATE POLICY links_insert_brand ON supply_chain_links
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_links.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );

-- Requests and responses
CREATE POLICY requests_select_participant ON data_requests
  FOR SELECT TO authenticated USING (tracefab_can_access_org(brand_organization_id) OR tracefab_can_access_org(supplier_organization_id));
CREATE POLICY requests_insert_brand ON data_requests
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY requests_update_participant ON data_requests
  FOR UPDATE TO authenticated USING (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id))
  WITH CHECK (tracefab_is_org_member(brand_organization_id) OR tracefab_is_org_member(supplier_organization_id));

CREATE POLICY request_items_select_participant ON data_request_items
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND (tracefab_can_access_org(r.brand_organization_id) OR tracefab_can_access_org(r.supplier_organization_id)))
  );
CREATE POLICY request_items_insert_brand ON data_request_items
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  );
CREATE POLICY request_items_update_participant ON data_request_items
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND (tracefab_is_org_member(r.brand_organization_id) OR tracefab_is_org_member(r.supplier_organization_id)))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM data_requests r WHERE r.id = data_request_items.data_request_id AND (tracefab_is_org_member(r.brand_organization_id) OR tracefab_is_org_member(r.supplier_organization_id)))
  );

CREATE POLICY responses_select_participant ON data_responses
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM data_request_items i JOIN data_requests r ON r.id = i.data_request_id
      WHERE i.id = data_responses.data_request_item_id
        AND (tracefab_can_access_org(r.brand_organization_id) OR tracefab_can_access_org(r.supplier_organization_id))
    )
  );
CREATE POLICY responses_insert_supplier ON data_responses
  FOR INSERT TO authenticated WITH CHECK (
    responded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM data_request_items i JOIN data_requests r ON r.id = i.data_request_id
      WHERE i.id = data_responses.data_request_item_id
        AND tracefab_has_org_role(r.supplier_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );
CREATE POLICY responses_update_supplier ON data_responses
  FOR UPDATE TO authenticated USING (responded_by = auth.uid())
  WITH CHECK (responded_by = auth.uid());

-- Documents and data points
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'document', id)
  );
CREATE POLICY documents_insert_owner ON documents
  FOR INSERT TO authenticated WITH CHECK (tracefab_is_org_member(owner_organization_id) AND uploaded_by = auth.uid());
CREATE POLICY documents_update_owner ON documents
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY data_points_select_authorized ON data_points
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'data_point', id)
  );
CREATE POLICY data_points_insert_owner ON data_points
  FOR INSERT TO authenticated WITH CHECK (tracefab_is_org_member(owner_organization_id) AND declared_by = auth.uid());
CREATE POLICY data_points_update_owner ON data_points
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY shares_select_participant ON data_shares
  FOR SELECT TO authenticated USING (tracefab_is_org_member(supplier_organization_id) OR tracefab_is_org_member(grantee_organization_id));
CREATE POLICY shares_insert_supplier ON data_shares
  FOR INSERT TO authenticated WITH CHECK (
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
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));

-- Certifications and verification
CREATE POLICY certifications_select_authorized ON certifications
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'certification', id)
  );
CREATE POLICY certifications_insert_owner ON certifications
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));
CREATE POLICY certifications_update_owner ON certifications
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]));

CREATE POLICY verifications_select_authorized ON verification_records
  FOR SELECT TO authenticated USING (tracefab_can_access_org(owner_organization_id));
CREATE POLICY verifications_insert_authorized ON verification_records
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]));
CREATE POLICY verifications_update_authorized ON verification_records
  FOR UPDATE TO authenticated USING (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]))
  WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]));

CREATE POLICY quality_select_authorized ON data_quality_scores
  FOR SELECT TO authenticated USING (tracefab_can_access_org(owner_organization_id));
CREATE POLICY quality_insert_owner ON data_quality_scores
  FOR INSERT TO authenticated WITH CHECK (tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));

CREATE POLICY dpp_select_brand ON dpp_records
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = dpp_records.product_id AND tracefab_is_org_member(p.brand_organization_id))
  );
CREATE POLICY dpp_insert_brand ON dpp_records
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = dpp_records.product_id AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
  );

-- Append-only audit log
CREATE POLICY audit_select_admin ON audit_logs
  FOR SELECT TO authenticated USING (tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'auditor']::membership_role[]));
CREATE POLICY audit_insert_member ON audit_logs
  FOR INSERT TO authenticated WITH CHECK (tracefab_is_org_member(organization_id) AND actor_user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 12. Explicit grants: anonymous users receive no Tracefab access through RLS.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO authenticated;
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
TO authenticated;
COMMENT ON SCHEMA public IS 'Tracefab core tables are protected by organization-scoped RLS. Anonymous access is intentionally not provided by this migration.';
COMMENT ON TABLE data_points IS 'Canonical supplier/product/material facts with explicit provenance and non-binary quality status.';
COMMENT ON TABLE dpp_records IS 'Versioned readiness computations; not a claim of final regulatory compliance.';
COMMENT ON TABLE audit_logs IS 'Append-only application audit events. Critical writes should later move behind trusted database functions.';
