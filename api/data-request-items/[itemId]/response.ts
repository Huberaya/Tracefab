import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { isUuid } from '../../_lib/data-requests';

type ResponseBody = {
  value?: unknown;
  sourceDocumentId?: string | null;
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

function routeItemId(req: VercelRequest) {
  const value = req.query.itemId;
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
    const itemId = routeItemId(req);
    if (!isUuid(itemId)) return json(res, 400, { error: 'invalid_item_id' });
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<ResponseBody>(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'value') || body.value === undefined || body.value === null) {
      return json(res, 400, { error: 'invalid_response_value' });
    }
    const sourceDocumentId = body.sourceDocumentId === undefined || body.sourceDocumentId === null || body.sourceDocumentId === ''
      ? null
      : isUuid(body.sourceDocumentId) ? body.sourceDocumentId : null;
    if (body.sourceDocumentId && !sourceDocumentId) return json(res, 400, { error: 'invalid_source_document_id' });

    const rows = await withTracefabUserContext(user.id, user.email, (tx) =>
      tx.$queryRaw<ResponseRow[]>`
        SELECT *
        FROM tracefab_submit_data_response(
          ${itemId}::uuid,
          ${JSON.stringify(body.value)}::jsonb,
          ${sourceDocumentId}::uuid
        )
      `,
    );
    if (!rows[0]) throw new Error('data_response_creation_failed');
    return json(res, 201, { response: serializeResponse(rows[0]) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/data-request-items/:itemId/response failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
