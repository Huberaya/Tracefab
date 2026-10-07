import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { prisma } from '../../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { validateGtin, buildGs1DigitalLink } from '../../../_lib/plm-erp/gtin-engine.js';
import { fetchLatestDppRecord, buildDppSummary } from '../../../_lib/dpp.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const rawGtin = String(req.query.gtin || '').trim();
  const validation = validateGtin(rawGtin);

  if (!validation.isValid) {
    return json(res, 400, {
      error: 'Code GTIN invalide selon l\'algorithme GS1 modulo-10.',
      validation,
    });
  }

  const cleanGtin = validation.cleanGtin;
  const linkType = (req.query.linkType as string) || 'gs1:dpp';

  // Find product with this GTIN
  const identifier = await prisma.product_identifiers.findFirst({
    where: {
      identifier_value: cleanGtin,
      identifier_type: { in: ['gtin', 'ean', 'upc'] },
    },
    include: {
      tracefab_products: {
        include: {
          product_materials: {
            include: { materials: true },
          },
          supply_chain_nodes: true,
        },
      },
    },
  });

  if (!identifier || !identifier.tracefab_products) {
    return json(res, 404, {
      error: `Aucun produit enregistré sous le GTIN GS1 ${cleanGtin}.`,
      gtin: cleanGtin,
      digitalLink: validation.digitalLinkUri,
    });
  }

  const product = identifier.tracefab_products;

  // Handle linkType resolution
  if (linkType === 'gs1:pip') {
    return json(res, 200, {
      '@context': 'https://gs1.org/voc/',
      type: 'Product',
      gtin: cleanGtin,
      productName: product.name,
      productDescription: product.description,
      brandName: product.category || 'Tracefab Brand',
      sku: product.sku,
      countryOfOrigin: product.country_of_manufacture,
      materials: product.product_materials.map((pm) => ({
        materialName: pm.materials.name,
        materialType: pm.materials.material_type,
        percentage: Number(pm.percentage || 100),
      })),
      digitalLink: buildGs1DigitalLink({ gtin: cleanGtin, linkType: 'gs1:pip' }),
    });
  }

  if (linkType === 'gs1:epcis') {
    const links = await prisma.supply_chain_links.findMany({ where: { product_id: product.id } });
    const nodeIds = [...new Set(links.flatMap((l) => [l.source_node_id, l.target_node_id]))];
    const nodes = await prisma.supply_chain_nodes.findMany({
      where: {
        OR: [
          { product_id: product.id },
          ...(nodeIds.length > 0 ? [{ id: { in: nodeIds } }] : []),
        ],
      },
    });

    return json(res, 200, {
      '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld'],
      type: 'EPCISQueryResult',
      gtin: cleanGtin,
      productId: product.id,
      traceability: { nodes, links },
      digitalLink: buildGs1DigitalLink({ gtin: cleanGtin, linkType: 'gs1:epcis' }),
    });
  }

  // Default: Digital Product Passport (gs1:dpp)
  const latestDpp = await fetchLatestDppRecord(prisma, product.id);
  const dppSummary = buildDppSummary(latestDpp, product.id, product.version);
  const acceptHeader = req.headers.accept || '';

  if (acceptHeader.includes('text/html') && !req.query.format) {
    res.setHeader('Location', `/dpp/?productId=${encodeURIComponent(product.id)}&gtin=${cleanGtin}`);
    res.statusCode = 302;
    res.end();
    return;
  }

  return json(res, 200, {
    '@context': 'https://gs1.org/voc/',
    type: 'DigitalProductPassport',
    gtin: cleanGtin,
    productId: product.id,
    productReference: product.reference,
    productName: product.name,
    countryOfManufacture: product.country_of_manufacture,
    dppReadiness: dppSummary.readinessStatus,
    dppStatusLabel: dppSummary.statusLabel,
    dppScore: dppSummary.completionScore,
    pillars: dppSummary.pillars,
    gs1LinkResolution: {
      canonicalDigitalLink: validation.digitalLinkUri,
      linkType: 'gs1:dpp',
      availableLinkTypes: ['gs1:dpp', 'gs1:pip', 'gs1:epcis', 'gs1:certificationInfo'],
    },
  });
}
