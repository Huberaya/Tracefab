import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { isUuid, optionalString } from '../../_lib/data-requests';

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
    const response = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<ResponseRow[]>`
        SELECT *
        FROM tracefab_review_data_response(
          ${responseId}::uuid,
          ${body.status}::data_value_status,
          ${reviewComment}
        )
      `;
      if (!rows[0]) throw new Error('data_response_review_failed');
      return rows[0];
    });

    return json(res, 200, {
      response: serializeResponse(response),
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
