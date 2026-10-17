import type { VercelRequest, VercelResponse } from '../../../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../../../_lib/context.js';
import { isUuid } from '../../../../../../_lib/data-requests.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../../../_lib/http.js';
import { accessibleProduct } from '../../../../../../_lib/quality.js';
import { accessibleProductForDppRead } from '../../../../../../_lib/dpp-access.js';
import { sqlBusinessError } from '../../../../../../_lib/sql-errors.js';

const REVIEW_STATUSES = new Set([
  'documented',
  'controlled',
  'corroborated',
  'third_party_verified',
  'rejected',
]);
const value = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const text = (v: unknown, max: number) => (
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null
);

/**
 * Revue d'une affirmation DPP.
 *
 * Deux chemins :
 *   — revue interne (reviewerOrganizationId absent) : un manager/auditeur de
 *     la marque atteste documenté / contrôlé / corroboré ou rejette ;
 *   — revue tierce (reviewerOrganizationId fourni) : un organisme `verifier`
 *     mandaté par la marque atteste third_party_verified ou rejette.
 *
 * Les règles d'autorisation sont dans `tracefab_review_dpp_claim`; la route ne
 * fait que valider la forme et vérifier que l'affirmation appartient au
 * produit. Aucun statut n'est accepté depuis le corps sans passer par la
 * fonction SQL qui vérifie les preuves.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const productId = value(req.query.productId);
    const claimId = value(req.query.claimId);
    if (!isUuid(productId) || !isUuid(claimId)) return json(res, 400, { error: 'invalid_identifier' });

    const body = await readJsonBody<Record<string, unknown>>(req);
    const resultingStatus = text(body.resultingStatus, 40);
    const method = text(body.method, 200);
    const notes = body.notes == null ? null : text(body.notes, 2000);
    const reviewerOrganizationId = body.reviewerOrganizationId == null
      ? null
      : text(body.reviewerOrganizationId, 36);
    if (!resultingStatus || !REVIEW_STATUSES.has(resultingStatus)) {
      return json(res, 400, { error: 'invalid_review_status' });
    }
    if (!method) return json(res, 400, { error: 'invalid_review_method' });
    if (body.notes != null && notes === null) return json(res, 400, { error: 'invalid_review_notes' });
    if (reviewerOrganizationId !== null && !isUuid(reviewerOrganizationId)) {
      return json(res, 400, { error: 'invalid_reviewer_organization_id' });
    }

    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const access = await accessibleProductForDppRead(tx, productId, accessibleProduct);
      if (!access) return { kind: 'product_not_found' as const };

      const claim = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM dpp_claims
        WHERE id = ${claimId}::uuid AND product_id = ${productId}::uuid
        LIMIT 1`;
      if (!claim[0]) return { kind: 'claim_not_found' as const };

      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM tracefab_review_dpp_claim(
          ${claimId}::uuid,
          ${resultingStatus}::dpp_event_validation_status,
          ${method},
          ${notes},
          ${reviewerOrganizationId}::uuid
        )`;
      return { kind: 'ok' as const, review: rows[0] };
    });

    if (result.kind === 'product_not_found') return json(res, 404, { error: 'product_not_found' });
    if (result.kind === 'claim_not_found') return json(res, 404, { error: 'claim_not_found' });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 201, { review: result.review });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, { error: business.error });
    if (error instanceof Error && error.message.startsWith('invalid_')) {
      return json(res, 400, { error: error.message });
    }
    console.error('DPP claim review failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
