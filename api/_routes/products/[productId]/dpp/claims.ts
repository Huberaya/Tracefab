import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { accessibleProductForDppRead } from '../../../../_lib/dpp-access.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';

const STATUSES = new Set(['declared', 'documented', 'controlled', 'corroborated', 'third_party_verified', 'rejected']);
const SCOPES = new Set(['model', 'variant', 'batch', 'unit']);
const str = (value: unknown, max: number) => (
  typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null
);
const routeId = (req: VercelRequest) => (
  Array.isArray(req.query.productId) ? req.query.productId[0] : req.query.productId
);
const isoDate = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!['GET', 'POST'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const productId = routeId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);
    const body = req.method === 'POST' ? await readJsonBody<Record<string, unknown>>(req) : {};

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const access = await accessibleProductForDppRead(tx, productId, accessibleProduct);
      if (!access) return null;

      if (req.method === 'GET') {
        const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
          SELECT c.*,
            COALESCE(latest.resulting_status::text, c.validation_status::text) AS effective_validation_status,
            verifier.display_name AS verifier_display_name,
            latest.reviewed_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', e.id,
                  'documentId', e.document_id,
                  'relationship', e.relationship,
                  'coverageNote', e.coverage_note,
                  'verificationResult', e.verification_result,
                  'verificationReason', e.verification_reason,
                  'publicLabel', e.public_label,
                  'linkedAt', e.linked_at
                ) ORDER BY e.linked_at
              ) FILTER (WHERE e.id IS NOT NULL),
              '[]'
            ) AS evidence
          FROM dpp_claims c
          LEFT JOIN LATERAL (
            SELECT r.resulting_status, r.reviewer_organization_id, r.reviewed_at
            FROM dpp_claim_reviews r
            WHERE r.claim_id = c.id
            ORDER BY r.reviewed_at DESC, r.id DESC
            LIMIT 1
          ) latest ON true
          LEFT JOIN organizations verifier ON verifier.id = latest.reviewer_organization_id
          LEFT JOIN dpp_claim_evidence e ON e.claim_id = c.id
          WHERE c.product_id = ${productId}::uuid
          GROUP BY c.id, latest.resulting_status, latest.reviewer_organization_id,
                   latest.reviewed_at, verifier.display_name
          ORDER BY c.created_at DESC
          LIMIT 200`;
        return { claims: rows, asVerifier: access.asVerifier };
      }

      const claimKey = str(body.claimKey, 120);
      const statement = str(body.statement, 1000);
      const requestedStatus = str(body.validationStatus, 40) || 'declared';
      const scope = str(body.subjectScope, 20) || 'model';
      if (!claimKey || !/^[a-z][a-z0-9_.-]{2,119}$/.test(claimKey)) throw new Error('invalid_claim_key');
      if (!statement) throw new Error('invalid_claim_statement');
      if (!STATUSES.has(requestedStatus) || !SCOPES.has(scope)) throw new Error('invalid_claim_metadata');
      // La confiance se construit par une revue, pas à la création.
      if (requestedStatus !== 'declared') throw new Error('dpp_claim_initial_status_must_be_declared');
      for (const field of ['lifecycleEventId', 'supersedesClaimId'] as const) {
        if (body[field] != null && !isUuid(body[field])) throw new Error(`invalid_${field}`);
      }
      const validFrom = isoDate(body.validFrom);
      const validUntil = isoDate(body.validUntil);
      if (validFrom === undefined) throw new Error('invalid_valid_from');
      if (validUntil === undefined) throw new Error('invalid_valid_until');
      if (validFrom && validUntil && validUntil < validFrom) throw new Error('invalid_validity_period');

      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM tracefab_add_dpp_claim(
          ${productId}::uuid,
          ${claimKey},
          ${statement},
          ${str(body.publicStatement, 500)},
          'declared'::dpp_event_validation_status,
          ${body.lifecycleEventId || null}::uuid,
          ${scope},
          ${str(body.subjectReference, 120)},
          ${validFrom}::date,
          ${validUntil}::date,
          ${body.supersedesClaimId || null}::uuid,
          NULL
        )`;
      return { claim: rows[0] };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, req.method === 'POST' ? 201 : 200, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, { error: business.error });
    if (error instanceof Error && error.message.startsWith('invalid_')) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'dpp_claim_initial_status_must_be_declared') {
      return json(res, 400, { error: error.message });
    }
    console.error('DPP claims failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
