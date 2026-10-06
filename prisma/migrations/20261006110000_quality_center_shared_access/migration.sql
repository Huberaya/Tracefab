-- Quality Center: make supplier-scoped findings readable through the same
-- object-scoped share contract as quality score snapshots. Mutations remain
-- function-only and no direct INSERT/UPDATE policy is introduced.

DROP POLICY IF EXISTS quality_issues_select_owner ON data_quality_issues;
CREATE POLICY quality_issues_select_authorized ON data_quality_issues
  FOR SELECT TO PUBLIC USING (
    tracefab_can_access_org(owner_organization_id)
    OR (
      supplier_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM suppliers s
        WHERE s.id = data_quality_issues.supplier_id
          AND tracefab_can_access_shared_subject(s.organization_id, 'supplier', s.id)
      )
    )
  );

GRANT SELECT ON data_quality_issues TO PUBLIC;
