import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId } from '../../_lib/supplier-profile.js';
import { qualityBundle, serializeQualityIssue, serializeQualityScore } from '../../_lib/quality.js';

type QualityBody = { calculationVersion?: string | null };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    const body = req.method === 'POST' ? await readJsonBody<QualityBody>(req) : {};
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      if (req.method === 'POST') {
        const calculationVersion = typeof body.calculationVersion === 'string' && body.calculationVersion.trim().length <= 120
          ? body.calculationVersion.trim() || 'supplier_quality_v1'
          : 'supplier_quality_v1';
        await tx.$queryRaw`SELECT * FROM tracefab_compute_supplier_quality(${supplier.id}::uuid, ${calculationVersion})`;
      }
      return qualityBundle(tx, { supplierId: supplier.id }, true);
    });
    if (!result) return json(res, 404, { error: 'supplier_profile_not_found' });
    return json(res, 200, { score: serializeQualityScore(result.score), issues: result.issues.map(serializeQualityIssue) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/quality failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
