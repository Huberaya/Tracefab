import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
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

    const cap = await withTracefabUserContext(user.id, user.email, async (tx) => {
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
