import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '.././_lib/auth.js';
import { withTracefabUserContext } from '.././_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '.././_lib/http.js';
import { sqlBusinessError } from '.././_lib/sql-errors.js';
import { getSchema } from '.././_lib/schema-catalog.js';
import { isTenantError, requireActiveTenant, requestedTenantId as activeTenantId } from '.././_lib/tenant.js';
import {
  isUuid,
  parseDate,
  requiredString,
  optionalString,
  REQUEST_SELECT,
  serializeRequest,
} from '.././_lib/data-requests.js';

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
      const scope = Array.isArray(req.query.scope) ? req.query.scope[0] : req.query.scope;
      const requests = await withTracefabUserContext(user.id, user.email, async (tx) => {
        // Locataire actif obligatoire. Le repli precedent listait les demandes
        // de toutes les organisations du compte : un administrateur de deux
        // tenants voyait les demandes de collecte de l'autre.
        const tenant = await requireActiveTenant(tx, req, user.id);
        const scoped = { in: [tenant.organizationId] };

        if (scope === 'supplier') {
          // Le portail fournisseur nomme deja son organisation ; la requete est
          // bornee a ce seul locataire, jamais a l'union des adhesions.
          return tx.data_requests.findMany({
            where: { supplier_organization_id: scoped, status: { not: 'draft' } },
            select: REQUEST_SELECT,
            orderBy: { last_activity_at: 'desc' },
          });
        }
        return tx.data_requests.findMany({
          where: {
            OR: [
              { brand_organization_id: scoped },
              { supplier_organization_id: scoped, status: { not: 'draft' } },
            ],
          },
          select: REQUEST_SELECT,
          orderBy: { last_activity_at: 'desc' },
        });
      }, activeTenantId(req));
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
    const boundSchema = getSchema(questionnaireKey, questionnaireVersion);
    if (!boundSchema || !boundSchema.subjectTypes.includes('data_request')) throw new Error('invalid_questionnaire_schema');
    const dueAt = parseDate(body.dueAt, 'due_at');
    const idempotencyKey = optionalString(body.idempotencyKey, 'idempotency_key', 200);

    const request = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // La demande est creee POUR le locataire actif. Sans cette garde, un corps
      // portant le brandOrganizationId de l'autre tenant du compte deplacement
      // la creation hors du tenant affiche.
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      if (body.brandOrganizationId !== tenant.organizationId) {
        throw new Error('brand_organization_mismatch');
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM tracefab_create_data_request(
          ${tenant.organizationId}::uuid,
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
      await tx.$queryRaw`SELECT id FROM tracefab_bind_schema(${questionnaireKey}, ${questionnaireVersion}, 'data_request', ${id}::uuid)`;
      return created;
    }, activeTenantId(req));

    return json(res, 201, { request: serializeRequest(request) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'brand_organization_mismatch') {
      return json(res, 400, { error: 'brand_organization_mismatch' });
    }
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
