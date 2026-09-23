import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { QualityIssueRecord } from '../../_lib/quality';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { isUuid } from '../../_lib/data-requests';
import { serializeQualityIssue } from '../../_lib/quality';

function routeIssueId(req: VercelRequest) {
  const value = req.query.issueId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const issueId = routeIssueId(req);
    if (!isUuid(issueId)) return json(res, 400, { error: 'invalid_issue_id' });
    const { user } = await requireClerkUser(req);
    const issue = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<QualityIssueRecord[]>`
        SELECT * FROM tracefab_acknowledge_quality_issue(${issueId}::uuid)
      `;
      return rows[0] ?? null;
    });
    if (!issue) throw new Error('quality_issue_not_found');
    return json(res, 200, { issue: serializeQualityIssue(issue) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'quality_issue_not_found') return json(res, 404, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/quality-issues/:issueId/acknowledge failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
