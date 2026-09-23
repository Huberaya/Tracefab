import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { accessibleRequest, isUuid, jsonObject, requiredString } from '../../_lib/data-requests';

type ItemBody = {
  fieldKey?: string;
  label?: string;
  dataType?: string;
  required?: boolean;
  evidenceRequired?: boolean;
  helpText?: string | null;
  validationRules?: Record<string, unknown> | null;
  evidenceKinds?: string[];
};

type ItemRow = {
  id: string;
  data_request_id: string;
  field_key: string;
  label: string;
  data_type: string;
  required: boolean;
  evidence_required: boolean;
  visibility: unknown;
  status: string;
  sort_order: number;
  created_at: Date;
  help_text: string | null;
  validation_rules: unknown;
  evidence_kinds: string[];
};

const DATA_TYPES = ['text', 'number', 'boolean', 'date', 'country', 'percentage', 'json', 'document'];

function routeRequestId(req: VercelRequest) {
  const value = req.query.requestId;
  return Array.isArray(value) ? value[0] : value;
}

function serializeItem(item: ItemRow) {
  return {
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
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const requestId = routeRequestId(req);
    if (!isUuid(requestId)) return json(res, 400, { error: 'invalid_request_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const request = await accessibleRequest(tx, user.id, requestId, { id: true });
      if (!request) return null;

      if (req.method === 'GET') {
        const items = await tx.data_request_items.findMany({
          where: { data_request_id: requestId },
          orderBy: { sort_order: 'asc' },
        });
        return { items };
      }

      const body = await readJsonBody<ItemBody>(req);
      const fieldKey = requiredString(body.fieldKey, 'field_key', 160);
      const label = requiredString(body.label, 'item_label', 240);
      if (typeof body.dataType !== 'string' || !DATA_TYPES.includes(body.dataType)) throw new Error('invalid_data_type');
      const required = body.required ?? false;
      const evidenceRequired = body.evidenceRequired ?? false;
      if (typeof required !== 'boolean' || typeof evidenceRequired !== 'boolean') throw new Error('invalid_item_boolean');
      const helpText = body.helpText === undefined || body.helpText === null ? null : requiredString(body.helpText, 'help_text', 2000);
      const validationRules = jsonObject(body.validationRules, 'validation_rules');
      const evidenceKinds = body.evidenceKinds ?? [];
      if (!Array.isArray(evidenceKinds) || evidenceKinds.length > 20 || evidenceKinds.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 80)) {
        throw new Error('invalid_evidence_kinds');
      }

      const rows = await tx.$queryRaw<ItemRow[]>`
        SELECT *
        FROM tracefab_add_data_request_item(
          ${requestId}::uuid,
          ${fieldKey},
          ${label},
          ${body.dataType}::data_type,
          ${required},
          ${evidenceRequired},
          ${helpText},
          ${JSON.stringify(validationRules)}::jsonb,
          ${evidenceKinds}::text[]
        )
      `;
      return { item: rows[0] };
    });

    if (!result) return json(res, 404, { error: 'data_request_not_found' });
    if ('items' in result) return json(res, 200, { items: result.items.map(serializeItem) });
    if (!result.item) throw new Error('data_request_item_creation_failed');
    return json(res, 201, { item: serializeItem(result.item) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'data_request_item_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET/POST /api/data-requests/:requestId/items failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
