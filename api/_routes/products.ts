import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '.././_lib/auth.js';
import { withTracefabUserContext } from '.././_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '.././_lib/http.js';
import { sqlBusinessError } from '.././_lib/sql-errors.js';
import { isUuid, PRODUCT_SELECT, serializeProduct } from '.././_lib/products.js';
import { isTenantError, requireActiveTenant, tenantFilter, requestedTenantId } from '.././_lib/tenant.js';
import { pageArgs, readPageRequest, slicePage } from '.././_lib/pagination.js';

type CreateProductBody = {
  brandOrganizationId?: string;
  reference?: string;
  name?: string;
  category?: string | null;
  sku?: string | null;
  reuseSourceProductId?: string | null;
};

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim() || null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const { user } = await requireClerkUser(req);

    if (req.method === 'GET') {
      // Pagination par curseur. `OFFSET` reparcourt et jette toutes les
      // lignes sautees a chaque page : son cout croit avec le numero de
      // page. Un curseur sur un identifiant indexe reste constant, et ne
      // decale pas les pages quand un produit est cree pendant le parcours.
      const page = readPageRequest(req);
      if (!page) return json(res, 400, { error: 'invalid_pagination' });

      const lifecycle = Array.isArray(req.query.lifecycle) ? req.query.lifecycle[0] : req.query.lifecycle;
      if (lifecycle !== undefined && lifecycle !== 'active' && lifecycle !== 'archived') {
        return json(res, 400, { error: 'invalid_product_lifecycle' });
      }
      const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
        // Le catalogue actif exclut les archives côté serveur. Le client ne
        // peut donc pas les réintroduire après reconnexion ou changement de tenant.
        const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
        const archived = lifecycle === 'archived';
        const rows = await tx.tracefab_products.findMany({
          where: {
            brand_organization_id: tenantFilter(tenant),
            status: archived ? 'archived' : { not: 'archived' },
          },
          select: PRODUCT_SELECT,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          ...pageArgs(page),
        });
        const archivedAt = new Map<string, Date>();
        if (archived && rows.length) {
          const entries = await tx.audit_logs.findMany({
            where: {
              organization_id: tenant.organizationId,
              action: 'product.archived',
              entity_type: 'product',
              entity_id: { in: rows.map(({ id }) => id) },
            },
            select: { entity_id: true, created_at: true },
            orderBy: { created_at: 'desc' },
          });
          for (const entry of entries) if (entry.entity_id && !archivedAt.has(entry.entity_id)) archivedAt.set(entry.entity_id, entry.created_at);
        }
        return { rows, archivedAt };
      }, requestedTenantId(req));

      const { items, nextCursor } = slicePage(result.rows, page);
      return json(res, 200, {
        products: items.map((product) => ({
          ...serializeProduct(product),
          archivedAt: result.archivedAt.get(product.id) ?? null,
        })),
        nextCursor,
      });
    }

    const body = await readJsonBody<CreateProductBody>(req);
    if (!isUuid(body.brandOrganizationId)) return json(res, 400, { error: 'invalid_brand_organization_id' });
    const reference = requiredString(body.reference, 'product_reference', 180);
    const name = requiredString(body.name, 'product_name', 240);
    const category = optionalString(body.category, 'product_category', 180);
    const sku = optionalString(body.sku, 'product_sku', 120);
    const reuseSourceProductId = body.reuseSourceProductId == null ? null : body.reuseSourceProductId;
    if (reuseSourceProductId !== null && !isUuid(reuseSourceProductId)) return json(res, 400, { error: 'invalid_reuse_source_product_id' });

    const product = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // Le produit est cree DANS le locataire actif, et nulle part ailleurs.
      // Sans cette garde, un corps de requete portant un autre
      // `brandOrganizationId` deplacement la creation hors du tenant affiche.
      const tenant = await requireActiveTenant(tx, req, user.id, {
        types: ['brand'],
        roles: reuseSourceProductId ? ['owner', 'admin'] : undefined,
      });
      if (body.brandOrganizationId !== tenant.organizationId) {
        throw new Error('brand_organization_mismatch');
      }
      let reuseSource: { id: string } | null = null;
      if (reuseSourceProductId) {
        reuseSource = await tx.tracefab_products.findFirst({
          where: {
            id: reuseSourceProductId,
            brand_organization_id: tenantFilter(tenant),
            status: 'archived',
          },
          select: { id: true },
        });
        if (!reuseSource) throw new Error('archived_source_product_not_found');
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM tracefab_create_product(
          ${tenant.organizationId}::uuid,
          ${reference},
          ${name},
          ${category},
          ${sku}
        )
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('product_creation_failed');
      const created = await tx.tracefab_products.findUnique({ where: { id }, select: PRODUCT_SELECT });
      if (!created) throw new Error('product_creation_failed');
      if (reuseSource) {
        await tx.audit_logs.create({ data: {
          organization_id: tenant.organizationId,
          action: 'product.reused',
          entity_type: 'product',
          entity_id: created.id,
          actor_user_id: user.id,
          after_state: { status: created.status, reference: created.reference },
          metadata: {
            source: 'brand_console',
            source_archived_product_id: reuseSource.id,
            copied_fields: ['name', 'category'],
            historical_relations_copied: false,
          },
        } });
      }
      return created;
    }, requestedTenantId(req));

    return json(res, 201, { product: serializeProduct(product) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'product_reference_already_exists' });
    }
    if (error instanceof Error && error.message === 'brand_organization_mismatch') {
      return json(res, 400, { error: 'brand_organization_mismatch' });
    }
    if (error instanceof Error && error.message === 'archived_source_product_not_found') {
      return json(res, 404, { error: error.message });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/products failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
