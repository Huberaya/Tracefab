import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from './_lib/auth';
import { withTracefabUserContext } from './_lib/context';
import { json, methodNotAllowed, readJsonBody } from './_lib/http';
import { sqlBusinessError } from './_lib/sql-errors';
import { activeOrganizationIds } from './_lib/products';
import {
  isUuid,
  parseDate,
  requiredString,
  optionalString,
  REQUEST_SELECT,
  serializeRequest,
} from './_lib/data-requests';

type CreateRequestBody = {
  brandOrganizationId?: string;
  supplierOrganizationId?: string;
  productId?: string | null;
  title?: string;
  questionnaireKey?: string;
  questionnaireVersion?: string;
  dueAt?: string | null;
  idempotencyKey?: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const { user } = await requireClerkUser(req);

    if (req.method === 'GET') {
      const requests = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const organizationIds = await activeOrganizationIds(tx, user.id);
        if (organizationIds.length === 0) return [];
        return tx.data_requests.findMany({
          where: {
            OR: [
              { brand_organization_id: { in: organizationIds } },
              { supplier_organization_id: { in: organizationIds }, status: { not: 'draft' } },
            ],
          },
          select: REQUEST_SELECT,
          orderBy: { last_activity_at: 'desc' },
        });
      });
      return json(res, 200, { requests: requests.map(serializeRequest) });
    }

    const body = await readJsonBody<CreateRequestBody>(req);
    if (!isUuid(body.brandOrganizationId)) return json(res, 400, { error: 'invalid_brand_organization_id' });
    if (!isUuid(body.supplierOrganizationId)) return json(res, 400, { error: 'invalid_supplier_organization_id' });
    const productId = body.productId === undefined || body.productId === null || body.productId === ''
      ? null
      : isUuid(body.productId) ? body.productId : null;
    if (body.productId && !productId) return json(res, 400, { error: 'invalid_product_id' });
    const title = requiredString(body.title, 'request_title', 240);
    const questionnaireKey = requiredString(body.questionnaireKey, 'questionnaire_key', 160);
    const questionnaireVersion = requiredString(body.questionnaireVersion, 'questionnaire_version', 80);
    const dueAt = parseDate(body.dueAt, 'due_at');
    const idempotencyKey = optionalString(body.idempotencyKey, 'idempotency_key', 200);

    const request = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM tracefab_create_data_request(
          ${body.brandOrganizationId}::uuid,
          ${body.supplierOrganizationId}::uuid,
          ${productId}::uuid,
          ${title},
          ${questionnaireKey},
          ${questionnaireVersion},
          ${dueAt},
          ${idempotencyKey}
        )
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('data_request_creation_failed');
      const created = await tx.data_requests.findUnique({ where: { id }, select: REQUEST_SELECT });
      if (!created) throw new Error('data_request_creation_failed');
      return created;
    });

    return json(res, 201, { request: serializeRequest(request) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'data_request_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/data-requests failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
