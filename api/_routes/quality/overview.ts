import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

const ISSUE_SEVERITIES = new Set(['info', 'warning', 'blocking']);
const ISSUE_STATUSES = new Set(['open', 'acknowledged', 'resolved', 'waived']);

type OverviewIssue = {
  id: string;
  ownerOrganizationId: string;
  ownerOrganizationName: string;
  subjectType: 'product' | 'supplier';
  subjectId: string | null;
  subjectName: string;
  ruleKey: string;
  severity: string;
  status: string;
  fieldKey: string | null;
  message: string;
  details: unknown;
  detectedAt: Date;
};

type OverviewScore = {
  id: string;
  ownerOrganizationId: string;
  subjectType: 'product' | 'supplier';
  subjectId: string;
  subjectName: string;
  completeness: string;
  freshness: string;
  documentationCoverage: string;
  consistency: string;
  computedAt: Date;
};

function queryValue(req: VercelRequest, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

function positiveLimit(value: string | undefined) {
  if (!value) return 50;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const severity = queryValue(req, 'severity');
    const status = queryValue(req, 'status');
    const limit = positiveLimit(queryValue(req, 'limit'));
    if (severity && !ISSUE_SEVERITIES.has(severity)) return json(res, 400, { error: 'invalid_quality_severity' });
    if (status && !ISSUE_STATUSES.has(status)) return json(res, 400, { error: 'invalid_quality_status' });
    if (limit === null) return json(res, 400, { error: 'invalid_quality_limit' });

    const { user } = await requireClerkUser(req);
    const severityClause = severity ? Prisma.sql`AND i.severity = ${severity}::quality_issue_severity` : Prisma.empty;
    const statusClause = status ? Prisma.sql`AND i.status = ${status}::quality_issue_status` : Prisma.empty;
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const issueRows = await tx.$queryRaw<OverviewIssue[]>`
        SELECT
          i.id,
          i.owner_organization_id AS "ownerOrganizationId",
          COALESCE(owner_org.display_name, owner_org.legal_name) AS "ownerOrganizationName",
          CASE WHEN i.product_id IS NOT NULL THEN 'product' ELSE 'supplier' END AS "subjectType",
          COALESCE(i.product_id, i.supplier_id) AS "subjectId",
          COALESCE(product.name, supplier_org.display_name, supplier_org.legal_name, 'Sujet qualité') AS "subjectName",
          i.rule_key AS "ruleKey",
          i.severity,
          i.status,
          i.field_key AS "fieldKey",
          i.message,
          i.details,
          i.detected_at AS "detectedAt"
        FROM data_quality_issues i
        JOIN organizations owner_org ON owner_org.id = i.owner_organization_id
        LEFT JOIN tracefab_products product ON product.id = i.product_id
        LEFT JOIN suppliers supplier ON supplier.id = i.supplier_id
        LEFT JOIN organizations supplier_org ON supplier_org.id = supplier.organization_id
        WHERE (
          tracefab_can_access_org(i.owner_organization_id)
          OR (
            i.supplier_id IS NOT NULL
            AND tracefab_can_access_shared_subject(i.owner_organization_id, 'supplier', i.supplier_id)
          )
        )
        ${severityClause}
        ${statusClause}
        ORDER BY
          CASE i.severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          i.detected_at DESC
        LIMIT ${limit}
      `;

      const scoreRows = await tx.$queryRaw<OverviewScore[]>`
        WITH latest AS (
          SELECT DISTINCT ON (COALESCE(s.product_id, s.supplier_id))
            s.id,
            s.owner_organization_id AS "ownerOrganizationId",
            CASE WHEN s.product_id IS NOT NULL THEN 'product' ELSE 'supplier' END AS "subjectType",
            COALESCE(s.product_id, s.supplier_id) AS "subjectId",
            s.completeness,
            s.freshness,
            s.documentation_coverage AS "documentationCoverage",
            s.consistency,
            s.computed_at AS "computedAt"
          FROM data_quality_scores s
          WHERE tracefab_can_access_org(s.owner_organization_id)
          ORDER BY COALESCE(s.product_id, s.supplier_id), s.computed_at DESC
        )
        SELECT
          latest.*,
          COALESCE(product.name, supplier_org.display_name, supplier_org.legal_name, 'Sujet qualité') AS "subjectName"
        FROM latest
        LEFT JOIN tracefab_products product ON latest."subjectType" = 'product' AND product.id = latest."subjectId"
        LEFT JOIN suppliers supplier ON latest."subjectType" = 'supplier' AND supplier.id = latest."subjectId"
        LEFT JOIN organizations supplier_org ON supplier_org.id = supplier.organization_id
        ORDER BY latest."computedAt" DESC
        LIMIT 200
      `;

      const metricRows = await tx.$queryRaw<Array<{ severity: string; status: string; count: bigint }>>`
        SELECT severity, status, count(*)::bigint AS count
        FROM data_quality_issues i
        WHERE (
          tracefab_can_access_org(i.owner_organization_id)
          OR (
            i.supplier_id IS NOT NULL
            AND tracefab_can_access_shared_subject(i.owner_organization_id, 'supplier', i.supplier_id)
          )
        )
        GROUP BY severity, status
      `;

      const metrics = { totalIssues: 0, openIssues: 0, blockingIssues: 0, warningIssues: 0, acknowledgedIssues: 0, waivedIssues: 0 };
      for (const row of metricRows) {
        const count = Number(row.count);
        metrics.totalIssues += count;
        if (row.status === 'open') metrics.openIssues += count;
        if (row.status === 'acknowledged') metrics.acknowledgedIssues += count;
        if (row.status === 'waived') metrics.waivedIssues += count;
        if (row.severity === 'blocking' && row.status !== 'resolved' && row.status !== 'waived') metrics.blockingIssues += count;
        if (row.severity === 'warning' && row.status !== 'resolved' && row.status !== 'waived') metrics.warningIssues += count;
      }

      return {
        metrics,
        issues: issueRows,
        scores: scoreRows,
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/quality/overview failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
