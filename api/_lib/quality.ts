import type { Prisma } from '@prisma/client';

export const QUALITY_SCORE_SELECT = {
  id: true,
  owner_organization_id: true,
  supplier_id: true,
  product_id: true,
  completeness: true,
  freshness: true,
  documentation_coverage: true,
  consistency: true,
  missing_fields: true,
  blocking_issues: true,
  calculation_version: true,
  computed_at: true,
} satisfies Prisma.data_quality_scoresSelect;

export const QUALITY_ISSUE_SELECT = {
  id: true,
  owner_organization_id: true,
  supplier_id: true,
  product_id: true,
  rule_key: true,
  rule_version: true,
  severity: true,
  status: true,
  field_key: true,
  message: true,
  details: true,
  detected_at: true,
  acknowledged_at: true,
  acknowledged_by: true,
  resolved_at: true,
  resolved_by: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.data_quality_issuesSelect;

export type QualityScoreRecord = Prisma.data_quality_scoresGetPayload<{ select: typeof QUALITY_SCORE_SELECT }>;
export type QualityIssueRecord = Prisma.data_quality_issuesGetPayload<{ select: typeof QUALITY_ISSUE_SELECT }>;

type AccessRow = {
  id: string;
  owner_organization_id: string;
  is_owner: boolean;
};

export function serializeQualityScore(score: QualityScoreRecord | null) {
  if (!score) return null;
  return {
    id: score.id,
    ownerOrganizationId: score.owner_organization_id,
    supplierId: score.supplier_id,
    productId: score.product_id,
    completeness: String(score.completeness),
    freshness: String(score.freshness),
    documentationCoverage: String(score.documentation_coverage),
    consistency: String(score.consistency),
    missingFields: score.missing_fields,
    blockingIssues: score.blocking_issues,
    calculationVersion: score.calculation_version,
    computedAt: score.computed_at,
  };
}

export function serializeQualityIssue(issue: QualityIssueRecord) {
  return {
    id: issue.id,
    ownerOrganizationId: issue.owner_organization_id,
    supplierId: issue.supplier_id,
    productId: issue.product_id,
    ruleKey: issue.rule_key,
    ruleVersion: issue.rule_version,
    severity: issue.severity,
    status: issue.status,
    fieldKey: issue.field_key,
    message: issue.message,
    details: issue.details,
    detectedAt: issue.detected_at,
    acknowledgedAt: issue.acknowledged_at,
    acknowledgedBy: issue.acknowledged_by,
    resolvedAt: issue.resolved_at,
    resolvedBy: issue.resolved_by,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

export async function accessibleSupplier(
  tx: Prisma.TransactionClient,
  supplierId: string,
): Promise<{ id: string; ownerOrganizationId: string; isOwner: boolean } | null> {
  const rows = await tx.$queryRaw<AccessRow[]>`
    SELECT
      s.id,
      s.organization_id AS owner_organization_id,
      tracefab_can_access_org(s.organization_id) AS is_owner
    FROM suppliers s
    WHERE s.id = ${supplierId}::uuid
      AND (
        tracefab_can_access_org(s.organization_id)
        OR tracefab_can_access_shared_subject(s.organization_id, 'supplier', s.id)
      )
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? { id: row.id, ownerOrganizationId: row.owner_organization_id, isOwner: row.is_owner }
    : null;
}

export async function accessibleProduct(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<{ id: string; ownerOrganizationId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; owner_organization_id: string }>>`
    SELECT id, brand_organization_id AS owner_organization_id
    FROM tracefab_products
    WHERE id = ${productId}::uuid
      AND tracefab_can_access_org(brand_organization_id)
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { id: row.id, ownerOrganizationId: row.owner_organization_id } : null;
}

export async function qualityBundle(
  tx: Prisma.TransactionClient,
  subject: { supplierId?: string; productId?: string },
  includeIssues: boolean,
) {
  const where = subject.supplierId ? { supplier_id: subject.supplierId } : { product_id: subject.productId };
  const score = await tx.data_quality_scores.findFirst({
    where,
    select: QUALITY_SCORE_SELECT,
    orderBy: { computed_at: 'desc' },
  });
  const issues = includeIssues
    ? await tx.data_quality_issues.findMany({
      where: { ...where, status: { not: 'resolved' } },
      select: QUALITY_ISSUE_SELECT,
      orderBy: { detected_at: 'desc' },
    })
    : [];
  return { score, issues };
}
