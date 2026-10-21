import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { buildDppSummary, fetchLatestDppRecord } from '../../../../_lib/dpp.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) {
      return json(res, 400, { error: 'invalid_product_id' });
    }

    const { user } = await requireClerkUser(req);

    const result = await withTracefabRequestContext(req, user, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;

      // 1. Get latest record to ensure it is in data_ready status
      const latestRecord = await fetchLatestDppRecord(tx, productId);
      if (!latestRecord) {
        throw new Error('dpp_record_not_found');
      }

      if (latestRecord.readiness_status !== 'data_ready') {
        throw new Error('dpp_record_not_data_ready');
      }

      // Re-evaluate the strict publication gates against current source data.
      // A previously persisted 100% from an older/narrower profile must never
      // authorize publication after requirements have been tightened.
      const gateRows = await tx.$queryRaw<Array<{ all_met: boolean }>>`
        SELECT bool_and(tracefab_dpp_requirement_met(requirement_key, ${productId}::uuid)) AS all_met
        FROM unnest(ARRAY[
          'product.reference','product.name','product.description','product.category',
          'product.country_of_manufacture','product.required_attributes',
          'composition.complete','materials.origin_documented','traceability.graph',
          'traceability.documented','quality.no_open_issues','evidence.product_data',
          'product.not_draft'
        ]::text[]) AS requirement_key
      `;
      if (gateRows[0]?.all_met !== true) {
        throw new Error('dpp_publication_requirements_not_met');
      }

      // 2. Mark ready to publish using the stored procedure
      const updatedRows = await tx.$queryRaw<Array<{
        id: string;
        product_id: string;
        product_version: number;
        requirement_profile_key: string;
        requirement_profile_version: string;
        requirement_profile_id: string | null;
        readiness_status: string;
        missing_fields: unknown;
        blocking_issues: unknown;
        source_snapshot: unknown;
        computed_at: Date;
        computed_by: string | null;
        input_fingerprint: string | null;
        reviewed_at: Date | null;
        reviewed_by: string | null;
      }>>`
        SELECT
          id,
          product_id,
          product_version,
          requirement_profile_key,
          requirement_profile_version,
          requirement_profile_id,
          readiness_status::text,
          missing_fields,
          blocking_issues,
          source_snapshot,
          computed_at,
          computed_by,
          input_fingerprint,
          reviewed_at,
          reviewed_by
        FROM tracefab_mark_dpp_ready_to_publish(
          ${latestRecord.id}::uuid
        )
      `;

      const updatedRecord = updatedRows[0];
      return buildDppSummary(updatedRecord, productId);
    });

    if (!result) {
      return json(res, 404, { error: 'product_not_found' });
    }

    return json(res, 200, { dpp: result });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'dpp_publication_requirements_not_met') {
      return json(res, 409, { error: error.message });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/products/:productId/dpp/publish-review failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
