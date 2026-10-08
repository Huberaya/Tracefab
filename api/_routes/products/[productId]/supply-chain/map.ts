import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../_lib/products.js';

/* Chantier 11 — Supply Chain Graph & Map : sites geographiques du graphe.
   Pour chaque noeud du graphe produit referenceant un site fournisseur,
   retourne le site (nom, pays, ville, latitude, longitude). Meme garde que
   /api/products/:id/supply-chain : le produit doit appartenir a une
   organisation de marque active de l'utilisateur. Aucun fallback invente :
   un noeud sans site ou un site sans coordonnees est simplement absent. */

type MapRow = {
  node_id: string;
  node_type: string;
  label: string;
  site_id: string;
  site_name: string;
  country_code: string;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
};

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: brandOrgIds } },
        select: { id: true, name: true, reference: true },
      });
      if (!product) return null;
      const sites = await tx.$queryRaw<MapRow[]>`
        SELECT DISTINCT
          n.id::text AS node_id,
          n.node_type::text AS node_type,
          n.label,
          s.id::text AS site_id,
          s.name AS site_name,
          s.country_code,
          s.city,
          s.latitude,
          s.longitude
        FROM supply_chain_nodes n
        JOIN supply_chain_links l
          ON l.product_id = ${productId}::uuid
         AND (l.source_node_id = n.id OR l.target_node_id = n.id)
        JOIN supplier_sites s ON s.id = n.supplier_site_id
        WHERE n.supplier_site_id IS NOT NULL
        ORDER BY s.country_code, s.name
      `;
      return { product, sites };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, {
      product: result.product,
      sites: result.sites.map((site) => ({
        nodeId: site.node_id,
        nodeType: site.node_type,
        label: site.label,
        siteId: site.site_id,
        siteName: site.site_name,
        countryCode: site.country_code,
        city: site.city,
        latitude: site.latitude,
        longitude: site.longitude,
      })),
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/products/:productId/supply-chain/map failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
