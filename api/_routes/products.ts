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

      const rows = await withTracefabUserContext(user.id, user.email, async (tx) => {
        // Locataire actif obligatoire. L'ancien code retombait sur
        // `{ in: organizationIds }` — l'union de toutes les organisations du
        // compte — quand `organizationId` etait absent : c'est le defaut
        // observe en Production le 2026-10-17 (produit de recette visible
        // depuis Ginger). Il n'y a plus de repli.
        const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
        return tx.tracefab_products.findMany({
          where: { brand_organization_id: tenantFilter(tenant) },
          select: PRODUCT_SELECT,
          // `id` departage les ex aequo : sans lui, deux produits crees dans
          // la meme milliseconde rendraient l'ordre non deterministe et le
          // curseur sauterait ou repeterait des lignes.
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          ...pageArgs(page),
        });
      }, requestedTenantId(req));

      const { items, nextCursor } = slicePage(rows, page);
      // `nextCursor` est ajoute, rien n'est retire : les clients actuels,
      // qui lisent `products` et ignorent le reste, continuent de marcher.
      return json(res, 200, { products: items.map(serializeProduct), nextCursor });
    }

    const body = await readJsonBody<CreateProductBody>(req);
    if (!isUuid(body.brandOrganizationId)) return json(res, 400, { error: 'invalid_brand_organization_id' });
    const reference = requiredString(body.reference, 'product_reference', 180);
    const name = requiredString(body.name, 'product_name', 240);
    const category = optionalString(body.category, 'product_category', 180);
    const sku = optionalString(body.sku, 'product_sku', 120);

    const product = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // Le produit est cree DANS le locataire actif, et nulle part ailleurs.
      // Sans cette garde, un corps de requete portant un autre
      // `brandOrganizationId` deplacement la creation hors du tenant affiche.
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      if (body.brandOrganizationId !== tenant.organizationId) {
        throw new Error('brand_organization_mismatch');
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
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/products failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
