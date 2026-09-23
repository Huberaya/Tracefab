import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { isUuid, optionalString } from '../../_lib/data-requests';
import {
  accessibleSupplier,
  qualityBundle,
  serializeQualityIssue,
  serializeQualityScore,
} from '../../_lib/quality';

type QualityBody = { calculationVersion?: string | null };

function routeSupplierId(req: VercelRequest) {
  const value = req.query.supplierId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const supplierId = routeSupplierId(req);
    if (!isUuid(supplierId)) return json(res, 400, { error: 'invalid_supplier_id' });
    const { user } = await requireClerkUser(req);
    const body = req.method === 'POST' ? await readJsonBody<QualityBody>(req) : {};
    const calculationVersion = optionalString(body.calculationVersion, 'calculation_version', 120) || 'supplier_quality_v1';

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await accessibleSupplier(tx, supplierId);
      if (!supplier) return null;
      if (req.method === 'POST') {
        await tx.$queryRaw`
          SELECT * FROM tracefab_compute_supplier_quality(
            ${supplierId}::uuid,
            ${calculationVersion}
          )
        `;
      }
      const bundle = await qualityBundle(tx, { supplierId }, supplier.isOwner);
      return bundle;
    });

    if (!result) return json(res, 404, { error: 'supplier_not_found' });
    return json(res, 200, {
      score: serializeQualityScore(result.score),
      issues: result.issues.map(serializeQualityIssue),
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET/POST /api/quality/suppliers/:supplierId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
