import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';

/**
 * Révocation d'un mandat de vérification.
 *
 * La raison est obligatoire (3 à 500 caractères) : une révocation sans motif
 * n'est pas auditable. La ligne de mandat n'est jamais supprimée, seule sa
 * date de révocation est conservée.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const raw = req.query.mandateId;
    const mandateId = Array.isArray(raw) ? raw[0] : raw;
    if (!isUuid(mandateId)) return json(res, 400, { error: 'invalid_mandate_id' });

    const body = await readJsonBody<Record<string, unknown>>(req);
    if (typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.trim().length > 500) {
      return json(res, 400, { error: 'invalid_revocation_reason' });
    }
    const reason = body.reason.trim();

    const { user } = await requireClerkUser(req);
    const rows = await withTracefabUserContext(user.id, user.email, async (tx) => tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM tracefab_revoke_dpp_verification_mandate(
        ${mandateId}::uuid,
        ${reason}
      )`);
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { mandate: rows[0] });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, { error: business.error });
    console.error('DPP verification mandate revocation failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
