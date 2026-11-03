import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid, optionalString } from '../../../_lib/data-requests.js';
import { DATA_POINT_SELECT, serializeDataPoint } from '../../../_lib/data-points.js';
import { QUALITY_SCORE_SELECT, serializeQualityScore } from '../../../_lib/quality.js';

type ReviewBody = {
  status?: string;
  reviewComment?: string | null;
};

type ResponseRow = {
  id: string;
  data_request_item_id: string;
  value: unknown;
  data_type: string;
  status: string;
  source_document_id: string | null;
  responded_by: string | null;
  supersedes_id: string | null;
  submitted_at: Date;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  response_version: number;
  is_current: boolean;
  review_comment: string | null;
};

function routeResponseId(req: VercelRequest) {
  const value = req.query.responseId;
  return Array.isArray(value) ? value[0] : value;
}

function serializeResponse(response: ResponseRow) {
  return {
    id: response.id,
    itemId: response.data_request_item_id,
    value: response.value,
    dataType: response.data_type,
    status: response.status,
    sourceDocumentId: response.source_document_id,
    respondedBy: response.responded_by,
    supersedesId: response.supersedes_id,
    submittedAt: response.submitted_at,
    reviewedAt: response.reviewed_at,
    reviewedBy: response.reviewed_by,
    responseVersion: response.response_version,
    isCurrent: response.is_current,
    reviewComment: response.review_comment,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const responseId = routeResponseId(req);
    if (!isUuid(responseId)) return json(res, 400, { error: 'invalid_response_id' });
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<ReviewBody>(req);
    if (body.status !== 'verified_by_reviewer' && body.status !== 'needs_review') {
      return json(res, 400, { error: 'invalid_review_status' });
    }
    const reviewComment = optionalString(body.reviewComment, 'review_comment', 4000);

    const result = await withTracefabTenantContext(req, user, { types: ['brand'], roles: ['owner', 'admin', 'manager', 'auditor'] }, async (tx, tenant) => {
      const scopedResponse = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT dr.id
        FROM data_responses dr
        JOIN data_request_items item ON item.id = dr.data_request_item_id
        JOIN data_requests request ON request.id = item.data_request_id
        WHERE dr.id = ${responseId}::uuid
          AND request.brand_organization_id = ${tenant.organizationId}::uuid
        LIMIT 1
      `;
      if (!scopedResponse[0]) return null;
      const rows = await tx.$queryRaw<ResponseRow[]>`
        SELECT *
        FROM tracefab_review_data_response(
          ${responseId}::uuid,
          ${body.status}::data_value_status,
          ${reviewComment}
        )
      `;
      const reviewed = rows[0];
      if (!reviewed) throw new Error('data_response_review_failed');

      // Query parent request and field key to verify bridge execution
      const item = await tx.data_request_items.findUnique({
        where: { id: reviewed.data_request_item_id },
        select: {
          field_key: true,
          status: true,
          data_requests: {
            select: {
              id: true,
              status: true,
              product_id: true,
              supplier_organization_id: true,
            },
          },
        },
      });

      let dataPoint = null;
      let qualityScore = null;

      if (body.status === 'verified_by_reviewer' && item) {
        if (item.data_requests.product_id) {
          dataPoint = await tx.data_points.findFirst({
            where: {
              product_id: item.data_requests.product_id,
              data_key: item.field_key,
            },
            orderBy: { version: 'desc' },
            select: DATA_POINT_SELECT,
          });

          if (item.data_requests.status === 'approved') {
            qualityScore = await tx.data_quality_scores.findFirst({
              where: { product_id: item.data_requests.product_id },
              orderBy: { computed_at: 'desc' },
              select: QUALITY_SCORE_SELECT,
            });
          }
        }
      }

      return {
        response: reviewed,
        request: item?.data_requests ? { id: item.data_requests.id, status: item.data_requests.status } : null,
        dataPoint,
        qualityScore,
      };
    });

    if (!result) return json(res, 404, { error: 'data_response_not_found' });
    return json(res, 200, {
      response: serializeResponse(result.response),
      request: result.request,
      dataPoint: result.dataPoint ? serializeDataPoint(result.dataPoint) : null,
      qualityScore: serializeQualityScore(result.qualityScore),
      delivery: { status: 'queued' },
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/data-responses/:responseId/review failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
