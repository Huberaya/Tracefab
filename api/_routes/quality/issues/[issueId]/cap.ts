import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { createQualityCap } from '../../../../_lib/quality-cap/cap-manager.js';

function routeIssueId(req: VercelRequest) {
  const value = req.query.issueId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const issueId = routeIssueId(req);
    if (!isUuid(issueId)) {
      return json(res, 400, { error: 'invalid_issue_id' });
    }

    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<Record<string, unknown>>(req);

    const supplierOrganizationId = typeof body.supplierOrganizationId === 'string' ? body.supplierOrganizationId : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    const dueDate = typeof body.dueDate === 'string' ? body.dueDate.trim() : '';
    const priority = typeof body.priority === 'string' ? body.priority : 'high';

    if (!isUuid(supplierOrganizationId)) {
      return json(res, 400, { error: 'invalid_supplier_organization_id' });
    }
    if (!title) {
      return json(res, 400, { error: 'title_required' });
    }
    if (!instructions) {
      return json(res, 400, { error: 'instructions_required' });
    }
    if (!dueDate) {
      return json(res, 400, { error: 'due_date_required' });
    }

    const cap = await withTracefabTenantContext(req, user, { types: ['brand'], roles: ['owner', 'admin', 'manager', 'contributor'] }, async (tx, tenant) => {
      const issue = await tx.data_quality_issues.findFirst({
        where: { id: issueId, owner_organization_id: tenant.organizationId },
        select: { id: true },
      });
      if (!issue) return null;
      const relationship = await tx.brand_supplier_relationships.findFirst({
        where: {
          brand_organization_id: tenant.organizationId,
          supplier_organization_id: supplierOrganizationId,
          status: 'active',
        },
        select: { id: true },
      });
      if (!relationship) return null;
      return await createQualityCap(tx, {
        qualityIssueId: issueId,
        supplierOrganizationId,
        title,
        instructions,
        dueDate,
        priority,
        userId: user.id,
      });
    });

    if (!cap) return json(res, 404, { error: 'quality_issue_or_supplier_relationship_not_found' });
    return json(res, 201, {
      message: 'cap_created',
      cap,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Create CAP error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
