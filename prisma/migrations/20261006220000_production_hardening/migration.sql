-- Production hardening: close RLS gaps introduced by later feature migrations.
-- Runtime SQL remains tenant-scoped; worker context is set only after HTTP-level
-- worker authentication in the API.

ALTER TABLE IF EXISTS tracefab_schema_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tracefab_schema_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tracefab_notification_outbox FORCE ROW LEVEL SECURITY;

-- Schema bindings are readable only through their existing subject-aware policy.
-- The catalog contains active, non-secret schema metadata and remains readable
-- through its existing active=true policy.
DROP POLICY IF EXISTS schema_bindings_insert_authorized ON tracefab_schema_bindings;
CREATE POLICY schema_bindings_insert_authorized ON tracefab_schema_bindings
  FOR INSERT TO PUBLIC WITH CHECK (
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = tracefab_schema_bindings.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    ))
    OR (material_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM materials m
      WHERE m.id = tracefab_schema_bindings.material_id
        AND tracefab_has_org_role(m.owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    ))
    OR (supplier_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = tracefab_schema_bindings.supplier_id
        AND tracefab_has_org_role(s.organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    ))
    OR (data_request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = tracefab_schema_bindings.data_request_id
        AND (
          tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
          OR tracefab_is_org_member(r.supplier_organization_id)
        )
    ))
  );

-- Scheduled reminder functions run with a trusted worker context after the
-- HTTP secret has been checked. Their source tables need a narrowly named RLS
-- escape hatch; it is not a database credential and is never accepted from a
-- browser request.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'organizations', 'organization_memberships', 'data_requests', 'data_request_items', 'data_responses'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_worker_select', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO PUBLIC USING (current_setting(''tracefab.worker_context'', true) = ''true'')',
      table_name || '_worker_select',
      table_name
    );
  END LOOP;
END $$;

-- The notification worker needs aggregate health reads after its HTTP secret has
-- been checked. The policy deliberately exposes no rows to unauthenticated SQL
-- sessions; normal users only see rows for owner/admin organizations.
DROP POLICY IF EXISTS notification_outbox_select_trusted ON tracefab_notification_outbox;
CREATE POLICY notification_outbox_select_trusted ON tracefab_notification_outbox
  FOR SELECT TO PUBLIC USING (
    current_setting('tracefab.worker_context', true) = 'true'
    OR tracefab_has_org_role(
      recipient_organization_id,
      ARRAY['owner', 'admin']::membership_role[]
    )
  );

DROP POLICY IF EXISTS notification_outbox_insert_trusted ON tracefab_notification_outbox;
CREATE POLICY notification_outbox_insert_trusted ON tracefab_notification_outbox
  FOR INSERT TO PUBLIC WITH CHECK (
    current_setting('tracefab.worker_context', true) = 'true'
    OR tracefab_current_user_id() IS NOT NULL
  );

DROP POLICY IF EXISTS notification_outbox_update_trusted ON tracefab_notification_outbox;
CREATE POLICY notification_outbox_update_trusted ON tracefab_notification_outbox
  FOR UPDATE TO PUBLIC
  USING (current_setting('tracefab.worker_context', true) = 'true')
  WITH CHECK (current_setting('tracefab.worker_context', true) = 'true');

GRANT SELECT ON tracefab_notification_outbox TO PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON tracefab_notification_outbox FROM PUBLIC;

-- Audit records are append-only from the application perspective.
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

COMMENT ON POLICY notification_outbox_select_trusted ON tracefab_notification_outbox IS
  'Worker reads require an authenticated internal request that sets tracefab.worker_context; user reads are owner/admin tenant-scoped.';
