import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth';
import { withTracefabUserContext } from '../../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http';
import { sqlBusinessError } from '../../../_lib/sql-errors';
import { accessibleRequest, isUuid } from '../../../_lib/data-requests';
import { getQuestionnaire, questionnaireItemRows } from '../../../_lib/questionnaires';

type TemplateBody = {
  questionnaireKey?: string;
  questionnaireVersion?: string;
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
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const requestId = routeRequestId(req);
    if (!isUuid(requestId)) return json(res, 400, { error: 'invalid_request_id' });
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<TemplateBody>(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const request = await accessibleRequest(tx, user.id, requestId, {
        id: true,
        questionnaire_key: true,
        questionnaire_version: true,
      });
      if (!request) return null;

      const template = getQuestionnaire(
        body.questionnaireKey ?? request.questionnaire_key,
        body.questionnaireVersion ?? request.questionnaire_version,
      );
      if (!template) throw new Error('questionnaire_not_found');

      const existingCount = await tx.data_request_items.count({ where: { data_request_id: requestId } });
      if (existingCount > 0) throw new Error('questionnaire_already_applied');

      for (const item of questionnaireItemRows(template)) {
        await tx.$queryRaw`
          SELECT id
          FROM tracefab_add_data_request_item(
            ${requestId}::uuid,
            ${item.fieldKey},
            ${item.label},
            ${item.dataType}::data_type,
            ${item.required},
            ${item.evidenceRequired},
            ${item.helpText},
            ${JSON.stringify(item.validationRules)}::jsonb,
            ${item.evidenceKinds}::text[]
          )
        `;
      }

      const items = await tx.data_request_items.findMany({
        where: { data_request_id: requestId },
        orderBy: { sort_order: 'asc' },
      });
      return { template, items };
    });

    if (!result) return json(res, 404, { error: 'data_request_not_found' });
    return json(res, 201, {
      questionnaire: {
        key: result.template.key,
        version: result.template.version,
      },
      items: result.items.map(serializeItem),
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'questionnaire_already_applied' });
    }
    if (error instanceof Error && error.message === 'questionnaire_already_applied') {
      return json(res, 409, { error: error.message });
    }
    if (error instanceof Error && error.message === 'questionnaire_not_found') {
      return json(res, 404, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/data-requests/:requestId/items/from-template failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
