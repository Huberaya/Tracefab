import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { exportAuditDossierJson } from '../../../_lib/bulk-operations/compliance-exporter.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const dossier = await withTracefabTenantContext(
      req,
      user,
      { types: ['brand'], roles: ['owner', 'admin', 'manager', 'auditor'] },
      async (tx, tenant) => exportAuditDossierJson(tx, tenant.organizationId),
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracefab-audit-dossier-${dateStr}.json"`);
    res.status(200).send(JSON.stringify(dossier, null, 2));
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Export audit dossier error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
