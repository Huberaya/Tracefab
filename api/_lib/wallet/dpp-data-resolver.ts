import type { Prisma, PrismaClient } from '@prisma/client';
import type { DppPassData } from './types.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Resolves full product passport data from the database for DPP viewing and Wallet generation.
 */
export async function resolveDppPassData(
  tx: PrismaTx,
  identifierOrId: string,
  baseUrl: string = 'https://tracefab.com'
): Promise<DppPassData | null> {
  const cleanId = String(identifierOrId || '').trim();
  if (!cleanId) return null;

  // Search by UUID, reference, GTIN or SKU
    // Barriere de publication. Sans elle, cette fonction resolvait N'IMPORTE
    // QUEL produit par reference, SKU ou GTIN — brouillons compris — et la
    // route /api/dpp/:id est anonyme. Sous BYPASSRLS rien ne s'y opposait.
    // Un produit n'est public que s'il porte un public_slug.
    const product = await (tx as any).tracefab_products.findFirst({
      where: {
        public_slug: { not: null },
        OR: [
          { id: cleanId.length === 36 ? cleanId : undefined },
          { public_slug: cleanId.toLowerCase() },
          { reference: cleanId },
          { sku: cleanId },
          { product_identifiers: { some: { identifier_value: cleanId } } },
        ],
      },
      include: {
        // `organizations` n'est PAS inclus : la table porte legal_name,
        // registration_number et clerk_organization_id. RLS filtre des lignes,
        // pas des colonnes. La marque est lue plus bas par
        // tracefab_public_brand(), qui ne rend que le nom affiche et le pays.
        product_identifiers: true,
      product_materials: {
        include: {
          materials: true,
        },
      },
      product_pef_assessments: {
        orderBy: { calculated_at: 'desc' },
        take: 1,
      },
      dpp_records: {
        orderBy: { computed_at: 'desc' },
        take: 1,
      },
      mass_balance_reconciliations: {
        orderBy: { created_at: 'desc' },
        take: 1,
      },
      supply_chain_nodes: {
        include: {
          supplier_sites: true,
        },
      },
    },
    // public_slug n'est unique QUE par marque
    // (tracefab_products_brand_organization_id_public_slug_key). Quatre
    // marques distinctes portent aujourd'hui le slug « mb-shirt-001 », donc une
    // URL publique sans marque est ambigue. Sans tri explicite PostgreSQL rend
    // une ligne arbitraire : le DPP servi pour une meme URL pouvait changer
    // d'une requete a l'autre. A defaut de pouvoir lever l'ambiguite ici, on la
    // rend au moins deterministe et stable.
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });

  if (!product) {
    return null;
  }

  // Identite de marque : deux colonnes, obtenues par une fonction dediee.
  // tracefab_public_brand() ne rend que display_name et country_code, et ne
  // rend rien si la marque n'a aucun produit publie.
  const marque = await (tx as any).$queryRaw<Array<{ display_name: string | null; country_code: string | null }>>`
    SELECT display_name, country_code FROM tracefab_public_brand(${product.brand_organization_id}::uuid)
  `;
  const brand = marque?.[0] ?? null;

  const gtin = product.product_identifiers?.find((i: any) => i.identifier_type === 'gtin')?.identifier_value || product.sku || '';
  const pef = product.product_pef_assessments?.[0];
  const mb = product.mass_balance_reconciliations?.[0];

  const materials = (product.product_materials || []).map((m: any) => ({
    name: m.materials?.name || 'Matière textile',
    percentage: Number(m.percentage) || 100,
    role: m.material_role,
    originCountry: m.materials?.origin_country_code || undefined,
  }));

  const compSummary = materials.length
    ? materials.map((m: any) => `${m.percentage}% ${m.name}`).join(', ')
    : '100% Coton peigné';

  // Format supply chain summary
  const nodes = product.supply_chain_nodes || [];
  const supplyChainSummary = nodes.length
    ? nodes.map((n: any) => `${n.label || 'Étape'} (${n.process_code || n.node_type}${n.supplier_sites?.country_code ? `, ${n.supplier_sites.country_code}` : ''})`).join(' ➔ ')
    : 'Filature ➔ Tissage ➔ Ennoblissement ➔ Confection auditée';

  const dppUrl = `${baseUrl}/p/${gtin || product.reference}`;
  const digitalLinkUri = `urn:epc:id:sgtin:3760123.${product.reference.replace(/[^0-9]/g, '').slice(-3) || '001'}.${product.version || 1}`;

  return {
    productId: product.id,
    brandName: brand?.display_name || 'Tracefab Brand',
    // Jamais la raison sociale sur une surface publique : elle n'apporte rien
    // au consommateur et elle identifie l'entreprise au registre.
    brandLegalName: brand?.display_name || 'Tracefab Brand',
    productName: product.name,
    productReference: product.reference,
    sku: product.sku || product.reference,
    gtin,
    serialNumber: `DPP-${gtin || product.reference}-v${product.version}`,
    category: product.category || 'Textile',
    countryOfManufacture: product.country_of_manufacture || 'PT',
    countryOfDesign: product.country_of_design || 'FR',
    weightGrams: product.weight_grams ? Number(product.weight_grams) : 250,
    certifiedComposition: compSummary,
    materials,
    pefScore: pef ? Number(pef.pef_eco_score) : 78,
    pefGrade: (pef ? pef.pef_grade : 'B') as any,
    carbonFootprintKgCo2e: pef ? Number(pef.carbon_footprint_kg_co2e) : 3.42,
    waterScarcityM3: pef ? Number(pef.water_scarcity_m3) : 0.85,
    circularityScore: pef ? Number(pef.circularity_score) : 85,
    dppUrl,
    digitalLinkUri,
    verificationDate: (product.updated_at || new Date()).toISOString().slice(0, 10),
    transactionCertificateNumber: mb ? `TC-VERIFIED-MB-${mb.id.slice(0, 8)}` : undefined,
    supplyChainSummary,
    careInstructions: 'Machine wash at 30°C inside out with similar colours. Gentle spin (600 rpm). Do not tumble dry. Iron on low heat.',
    recyclingInstructions: 'Single-material product, highly recyclable. At end of life, drop it in a textile collection point or return it in store.',
  };
}
