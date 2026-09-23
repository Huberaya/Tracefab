import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import { accessibleRequest, isUuid, REQUEST_SELECT, serializeRequest } from '../_lib/data-requests';

const DETAIL_SELECT = {
  ...REQUEST_SELECT,
  data_request_items: {
    select: {
      id: true,
      data_request_id: true,
      field_key: true,
      label: true,
      data_type: true,
      required: true,
      evidence_required: true,
      visibility: true,
      status: true,
      sort_order: true,
      created_at: true,
      help_text: true,
      validation_rules: true,
      evidence_kinds: true,
      data_responses: {
        select: {
          id: true,
          data_request_item_id: true,
          value: true,
          data_type: true,
          status: true,
          source_document_id: true,
          responded_by: true,
          supersedes_id: true,
          submitted_at: true,
          reviewed_at: true,
          reviewed_by: true,
          response_version: true,
          is_current: true,
          review_comment: true,
        },
        orderBy: { response_version: 'desc' },
      },
    },
    orderBy: { sort_order: 'asc' },
  },
} satisfies Prisma.data_requestsSelect;

type RequestDetail = Prisma.data_requestsGetPayload<{ select: typeof DETAIL_SELECT }>;

function routeRequestId(req: VercelRequest) {
  const value = req.query.requestId;
  return Array.isArray(value) ? value[0] : value;
}

function serializeDetail(request: RequestDetail) {
  return {
    request: serializeRequest(request),
    items: request.data_request_items.map((item) => ({
      id: item.id,
      requestId: item.data_request_id,
      fieldKey: item.field_key,
      label: item.label,
      dataType: item.data_type,
      required: item.required,
      evidenceRequired: item.evidence_required,
      visibility: item.visibility,
      status: item.status,
      sortOrder: item.sort_order,
      createdAt: item.created_at,
      helpText: item.help_text,
      validationRules: item.validation_rules,
      evidenceKinds: item.evidence_kinds,
      responses: item.data_responses.map((response) => ({
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
      })),
    })),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const requestId = routeRequestId(req);
    if (!isUuid(requestId)) return json(res, 400, { error: 'invalid_request_id' });
    const { user } = await requireClerkUser(req);
    const request = await withTracefabUserContext(user.id, user.email, (tx) =>
      accessibleRequest(tx, user.id, requestId, DETAIL_SELECT),
    );
    if (!request) return json(res, 404, { error: 'data_request_not_found' });
    return json(res, 200, serializeDetail(request));
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/data-requests/:requestId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
