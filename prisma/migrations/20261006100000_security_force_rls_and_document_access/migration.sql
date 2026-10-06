-- Migration: 20261006100000_security_force_rls_and_document_access
--
-- Chantier 1: Security, Multi-Tenant Isolation & Product Data Points
--
-- 1. FORCE ROW LEVEL SECURITY on all tenant and domain tables so that
--    even database owners/superusers cannot bypass multi-tenant isolation
--    when querying directly.
-- 2. Add tracefab_can_access_document helper to strictly enforce document
--    authorization across organizations (owner, shares, data responses, certifications, product data points).
-- 3. Update documents_select_authorized and data_points_select_authorized policies.
-- 4. Harden cross-tenant SELECT policies for organizations, suppliers, supplier_sites,
--    materials, and certifications so active brand-supplier relationships and product
--    linkages can read necessary partner metadata under strict FORCE RLS without leakage.

ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE brand_supplier_relationships FORCE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_sites FORCE ROW LEVEL SECURITY;
ALTER TABLE tracefab_products FORCE ROW LEVEL SECURITY;
ALTER TABLE materials FORCE ROW LEVEL SECURITY;
ALTER TABLE product_materials FORCE ROW LEVEL SECURITY;
ALTER TABLE product_identifiers FORCE ROW LEVEL SECURITY;
ALTER TABLE supply_chain_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE supply_chain_links FORCE ROW LEVEL SECURITY;
ALTER TABLE data_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE data_request_items FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE data_responses FORCE ROW LEVEL SECURITY;
ALTER TABLE data_points FORCE ROW LEVEL SECURITY;
ALTER TABLE data_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE certifications FORCE ROW LEVEL SECURITY;
ALTER TABLE verification_records FORCE ROW LEVEL SECURITY;
ALTER TABLE data_quality_scores FORCE ROW LEVEL SECURITY;
ALTER TABLE data_quality_issues FORCE ROW LEVEL SECURITY;
ALTER TABLE dpp_requirement_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE dpp_records FORCE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE tracefab_notification_outbox FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION tracefab_can_access_document(p_document_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = p_document_id
      AND d.status = 'available'
      AND (
        -- User is member of document owner organization
        tracefab_can_access_org(d.owner_organization_id)
        -- Or document is explicitly shared via data_shares
        OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
        -- Or document is evidence in a data response for a request belonging to user's brand or supplier org
        OR EXISTS (
          SELECT 1
          FROM data_responses resp
          JOIN data_request_items item ON item.id = resp.data_request_item_id
          JOIN data_requests req ON req.id = item.data_request_id
          WHERE resp.source_document_id = d.id
            AND (tracefab_is_org_member(req.brand_organization_id) OR tracefab_is_org_member(req.supplier_organization_id))
        )
        -- Or document is attached to a certification for an organization or product accessible to user
        OR EXISTS (
          SELECT 1
          FROM certifications cert
          WHERE cert.document_id = d.id
            AND (
              tracefab_can_access_org(cert.owner_organization_id)
              OR (cert.product_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM tracefab_products p
                WHERE p.id = cert.product_id AND tracefab_is_org_member(p.brand_organization_id)
              ))
              OR (cert.supplier_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM suppliers s
                JOIN brand_supplier_relationships r ON r.supplier_organization_id = s.organization_id
                WHERE s.id = cert.supplier_id AND tracefab_is_org_member(r.brand_organization_id) AND r.status = 'active'
              ))
            )
        )
        -- Or document is attached to a product data point accessible to user's brand
        OR EXISTS (
          SELECT 1
          FROM data_points dp
          JOIN tracefab_products p ON p.id = dp.product_id
          WHERE dp.source_document_id = d.id
            AND tracefab_is_org_member(p.brand_organization_id)
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION tracefab_can_access_document(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_can_access_document(UUID) TO PUBLIC;

-- Update documents SELECT policy to use the unified access function
DROP POLICY IF EXISTS documents_select_authorized ON documents;
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO PUBLIC USING (
    status <> 'deleted'
    AND tracefab_can_access_document(id)
  );

-- Update data_points SELECT policy so that brand members can select data points belonging to their products
DROP POLICY IF EXISTS data_points_select_authorized ON data_points;
CREATE POLICY data_points_select_authorized ON data_points
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'data_point', id)
    OR (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = data_points.product_id
        AND tracefab_is_org_member(p.brand_organization_id)
    ))
  );

-- Cross-tenant SELECT reinforcement: organizations
DROP POLICY IF EXISTS organizations_select_member ON organizations;
CREATE POLICY organizations_select_member ON organizations
  FOR SELECT TO PUBLIC USING (
    tracefab_is_org_member(id)
    OR EXISTS (
      SELECT 1 FROM brand_supplier_relationships rel
      WHERE (
        (rel.supplier_organization_id = organizations.id AND tracefab_is_org_member(rel.brand_organization_id))
        OR (rel.brand_organization_id = organizations.id AND tracefab_is_org_member(rel.supplier_organization_id))
      )
      AND rel.status IN ('active', 'invited')
    )
    OR EXISTS (
      SELECT 1 FROM organization_invitations inv
      WHERE inv.organization_id = organizations.id
        AND (inv.email = tracefab_current_user_email() OR inv.invited_by = tracefab_current_user_id())
    )
  );

-- Cross-tenant SELECT reinforcement: suppliers
DROP POLICY IF EXISTS suppliers_select_authorized ON suppliers;
CREATE POLICY suppliers_select_authorized ON suppliers
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(organization_id)
    OR tracefab_can_access_shared_subject(organization_id, 'supplier', id)
    OR EXISTS (
      SELECT 1 FROM brand_supplier_relationships rel
      WHERE rel.supplier_organization_id = suppliers.organization_id
        AND tracefab_is_org_member(rel.brand_organization_id)
        AND rel.status = 'active'
    )
  );

-- Cross-tenant SELECT reinforcement: supplier_sites
DROP POLICY IF EXISTS supplier_sites_select_authorized ON supplier_sites;
CREATE POLICY supplier_sites_select_authorized ON supplier_sites
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = supplier_sites.supplier_id
        AND (
          tracefab_can_access_org(s.organization_id)
          OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', supplier_sites.id)
          OR EXISTS (
            SELECT 1 FROM brand_supplier_relationships rel
            WHERE rel.supplier_organization_id = s.organization_id
              AND tracefab_is_org_member(rel.brand_organization_id)
              AND rel.status = 'active'
          )
        )
    )
  );

-- Cross-tenant SELECT reinforcement: materials
DROP POLICY IF EXISTS materials_select_authorized ON materials;
CREATE POLICY materials_select_authorized ON materials
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'material', id)
    OR EXISTS (
      SELECT 1 FROM product_materials pm
      JOIN tracefab_products p ON p.id = pm.product_id
      WHERE pm.material_id = materials.id
        AND tracefab_can_access_org(p.brand_organization_id)
    )
    OR EXISTS (
      SELECT 1 FROM brand_supplier_relationships rel
      WHERE rel.supplier_organization_id = materials.owner_organization_id
        AND tracefab_is_org_member(rel.brand_organization_id)
        AND rel.status = 'active'
    )
  );

-- Cross-tenant SELECT reinforcement: certifications
DROP POLICY IF EXISTS certifications_select_authorized ON certifications;
CREATE POLICY certifications_select_authorized ON certifications
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR (supplier_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM suppliers s
      JOIN brand_supplier_relationships r ON r.supplier_organization_id = s.organization_id
      WHERE s.id = certifications.supplier_id AND tracefab_is_org_member(r.brand_organization_id) AND r.status = 'active'
    ))
    OR (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = certifications.product_id AND tracefab_is_org_member(p.brand_organization_id)
    ))
  );

COMMENT ON FUNCTION tracefab_can_access_document(UUID) IS 'Validates tenant access to an available document across ownership, shares, data requests and certifications.';
