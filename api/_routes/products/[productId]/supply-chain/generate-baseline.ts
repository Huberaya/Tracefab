import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../_lib/products.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import {
  computeTraceabilitySummary,
  groupGraphByStages,
  type SupplyChainGraphPayload,
  type SupplyChainNodeRecord,
  type SupplyChainLinkRecord,
} from '../../../../_lib/supply-chain.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: brandOrgIds } },
        select: { id: true, name: true, reference: true, version: true, brand_organization_id: true },
      });
      if (!product) return null;

      const membership = await tx.organization_memberships.findFirst({
        where: {
          organization_id: product.brand_organization_id,
          user_id: user.id,
          status: 'active',
          role: { in: ['owner', 'admin', 'manager', 'contributor'] },
        },
        select: { id: true },
      });
      if (!membership) throw new Error('traceability_brand_role_required');

      // Fetch product materials
      const productMaterials = await tx.product_materials.findMany({
        where: { product_id: productId, product_version: product.version },
        include: {
          materials: {
            include: {
              organizations: {
                include: {
                  suppliers: {
                    include: {
                      supplier_sites: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      // 1. Create Product Finished Good Node (Tier 0)
      const existingProductNode = await tx.supply_chain_nodes.findFirst({
        where: { product_id: productId, node_type: 'product' },
      });
      let productNodeId = existingProductNode?.id;

      if (!productNodeId) {
        const pRows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
          SELECT * FROM tracefab_create_supply_chain_node(
            ${productId}::uuid,
            'product'::node_type,
            ${`Produit fini · ${product.name}`},
            ${product.brand_organization_id}::uuid,
            NULL::uuid,
            ${productId}::uuid,
            NULL::uuid,
            'packaging',
            '{"tier": 0, "stage": "finished_good"}'::jsonb,
            NULL::uuid,
            CURRENT_DATE
          )
        `;
        productNodeId = pRows[0]?.id;
      }

      if (!productNodeId) throw new Error('traceability_product_node_failed');

      // 2. Iterate materials to build stages
      let seq = 1;
      for (const pm of productMaterials) {
        const mat = pm.materials;
        const supplier = mat.organizations?.suppliers;
        const site = supplier?.supplier_sites?.[0];

        // Tier 4: Material node
        const mRows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
          SELECT * FROM tracefab_create_supply_chain_node(
            ${productId}::uuid,
            'material'::node_type,
            ${`Matière · ${mat.name}`},
            ${mat.owner_organization_id}::uuid,
            NULL::uuid,
            NULL::uuid,
            ${mat.id}::uuid,
            'ginning',
            '{"tier": 4, "stage": "raw_material"}'::jsonb,
            NULL::uuid,
            CURRENT_DATE
          )
        `;
        const materialNodeId = mRows[0]?.id;
        if (!materialNodeId) continue;

        // Tier 3: Spinning node
        const spRows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
          SELECT * FROM tracefab_create_supply_chain_node(
            ${productId}::uuid,
            'process'::node_type,
            ${`Filature · ${mat.name}`},
            ${mat.owner_organization_id}::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            'spinning',
            '{"tier": 3, "stage": "spinning"}'::jsonb,
            NULL::uuid,
            CURRENT_DATE
          )
        `;
        const spinningNodeId = spRows[0]?.id;

        // Tier 2: Weaving & Dyeing node
        const wvRows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
          SELECT * FROM tracefab_create_supply_chain_node(
            ${productId}::uuid,
            'process'::node_type,
            ${`Tissage & Teinture · ${mat.name}`},
            ${mat.owner_organization_id}::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            'weaving',
            '{"tier": 2, "stage": "fabric_and_dyeing"}'::jsonb,
            NULL::uuid,
            CURRENT_DATE
          )
        `;
        const weavingNodeId = wvRows[0]?.id;

        // Tier 1: Assembly / Site node (or fallback process)
        let assemblyNodeId: string | undefined;
        if (site) {
          const stRows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
            SELECT * FROM tracefab_create_supply_chain_node(
              ${productId}::uuid,
              'site'::node_type,
              ${`Confection · ${site.name} (${site.country_code})`},
              NULL::uuid,
              ${site.id}::uuid,
              NULL::uuid,
              NULL::uuid,
              'sewing',
              '{"tier": 1, "stage": "assembly_site"}'::jsonb,
              NULL::uuid,
              CURRENT_DATE
            )
          `;
          assemblyNodeId = stRows[0]?.id;
        } else {
          const prRows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
            SELECT * FROM tracefab_create_supply_chain_node(
              ${productId}::uuid,
              'process'::node_type,
              'Coupe & Confection (Atelier)',
              NULL::uuid,
              NULL::uuid,
              NULL::uuid,
              NULL::uuid,
              'sewing',
              '{"tier": 1, "stage": "assembly"}'::jsonb,
              NULL::uuid,
              CURRENT_DATE
            )
          `;
          assemblyNodeId = prRows[0]?.id;
        }

        // Connect links:
        // Link 1: Material -> Spinning
        if (materialNodeId && spinningNodeId) {
          await tx.$queryRaw<SupplyChainLinkRecord[]>`
            SELECT * FROM tracefab_add_supply_chain_link(
              ${productId}::uuid,
              ${materialNodeId}::uuid,
              ${spinningNodeId}::uuid,
              'transformed_at'::supply_chain_link_type,
              ${seq++},
              CURRENT_DATE,
              NULL::date,
              NULL::uuid,
              '{"description": "Transformation de la fibre en fil"}'::jsonb
            )
          `;
        }

        // Link 2: Spinning -> Weaving
        if (spinningNodeId && weavingNodeId) {
          await tx.$queryRaw<SupplyChainLinkRecord[]>`
            SELECT * FROM tracefab_add_supply_chain_link(
              ${productId}::uuid,
              ${spinningNodeId}::uuid,
              ${weavingNodeId}::uuid,
              'next_step'::supply_chain_link_type,
              ${seq++},
              CURRENT_DATE,
              NULL::date,
              NULL::uuid,
              '{"description": "Tissage du fil et teinture de l étoffe"}'::jsonb
            )
          `;
        }

        // Link 3: Weaving -> Assembly
        if (weavingNodeId && assemblyNodeId) {
          await tx.$queryRaw<SupplyChainLinkRecord[]>`
            SELECT * FROM tracefab_add_supply_chain_link(
              ${productId}::uuid,
              ${weavingNodeId}::uuid,
              ${assemblyNodeId}::uuid,
              'next_step'::supply_chain_link_type,
              ${seq++},
              CURRENT_DATE,
              NULL::date,
              NULL::uuid,
              '{"description": "Acheminement pour coupe et confection"}'::jsonb
            )
          `;
        }

        // Link 4: Assembly -> Product Finished Good
        if (assemblyNodeId && productNodeId) {
          await tx.$queryRaw<SupplyChainLinkRecord[]>`
            SELECT * FROM tracefab_add_supply_chain_link(
              ${productId}::uuid,
              ${assemblyNodeId}::uuid,
              ${productNodeId}::uuid,
              'manufactured_at'::supply_chain_link_type,
              ${seq++},
              CURRENT_DATE,
              NULL::date,
              NULL::uuid,
              '{"description": "Produit confectionné et prêt pour mise en distribution"}'::jsonb
            )
          `;
        }
      }

      // Fetch refreshed graph
      const graphRows = await tx.$queryRaw<Array<{ graph: SupplyChainGraphPayload }>>`
        SELECT tracefab_get_product_traceability(${productId}::uuid) AS graph
      `;
      const graph = graphRows[0]?.graph ?? { product_id: productId, nodes: [], links: [] };
      const stages = groupGraphByStages(graph.nodes);
      const summary = computeTraceabilitySummary(graph.nodes, graph.links);

      return { product, graph, stages, summary };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 201, {
      product: result.product,
      graph: result.graph,
      stages: result.stages,
      summary: result.summary,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && (/^invalid_|^traceability_/.test(error.message))) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/products/:productId/supply-chain/generate-baseline failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
