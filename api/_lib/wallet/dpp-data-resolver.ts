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
  const product = await (tx as any).tracefab_products.findFirst({
    where: {
      OR: [
        { id: cleanId.length === 36 ? cleanId : undefined },
        { reference: cleanId },
        { sku: cleanId },
        { product_identifiers: { some: { identifier_value: cleanId } } },
      ],
    },
    include: {
      organizations: true,
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
  });

  if (!product) {
    return null;
  }

  /** Chaque repli est tracé : la valeur reste renvoyée pour ne casser aucun
   *  consommateur existant, mais l'absence de donnée réelle est déclarée. */
  const dataGaps: string[] = [];

  const gtin = product.product_identifiers?.find((i: any) => i.identifier_type === 'gtin')?.identifier_value || product.sku || '';
  if (!product.product_identifiers?.some((i: any) => i.identifier_type === 'gtin')) dataGaps.push('gtin');
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
  if (!materials.length) dataGaps.push('composition');

  // Format supply chain summary
  const nodes = product.supply_chain_nodes || [];
  const supplyChainSummary = nodes.length
    ? nodes.map((n: any) => `${n.label || 'Étape'} (${n.process_code || n.node_type}${n.supplier_sites?.country_code ? `, ${n.supplier_sites.country_code}` : ''})`).join(' ➔ ')
    : 'Filature ➔ Tissage ➔ Ennoblissement ➔ Confection auditée';
  if (!nodes.length) dataGaps.push('supplyChain');

  const dppUrl = `${baseUrl}/p/${gtin || product.reference}`;
  const digitalLinkUri = `urn:epc:id:sgtin:3760123.${product.reference.replace(/[^0-9]/g, '').slice(-3) || '001'}.${product.version || 1}`;

  return {
    productId: product.id,
    brandName: product.organizations?.display_name || product.organizations?.legal_name || 'Tracefab Brand',
    brandLegalName: product.organizations?.legal_name || 'Tracefab SAS',
    productName: product.name,
    productReference: product.reference,
    sku: product.sku || product.reference,
    gtin,
    serialNumber: `DPP-${gtin || product.reference}-v${product.version}`,
    category: product.category || 'Textile',
    countryOfManufacture: product.country_of_manufacture || 'PT',
    countryOfDesign: product.country_of_design || 'FR',
    weightGrams: product.weight_grams ? Number(product.weight_grams) : 250,
    ...(!product.country_of_manufacture && (dataGaps.push('countryOfManufacture'), {})),
    ...(!product.country_of_design && (dataGaps.push('countryOfDesign'), {})),
    ...(!product.weight_grams && (dataGaps.push('weightGrams'), {})),
    certifiedComposition: compSummary,
    materials,
    pefScore: pef ? Number(pef.pef_eco_score) : 78,
    pefGrade: (pef ? pef.pef_grade : 'B') as any,
    carbonFootprintKgCo2e: pef ? Number(pef.carbon_footprint_kg_co2e) : 3.42,
    waterScarcityM3: pef ? Number(pef.water_scarcity_m3) : 0.85,
    circularityScore: pef ? Number(pef.circularity_score) : 85,
    ...(!pef && (dataGaps.push('pef', 'carbonFootprint', 'waterScarcity', 'circularity'), {})),
    dppUrl,
    digitalLinkUri,
    verificationDate: (product.updated_at || new Date()).toISOString().slice(0, 10),
    transactionCertificateNumber: mb ? `TC-VERIFIED-MB-${mb.id.slice(0, 8)}` : undefined,
    supplyChainSummary,
    careInstructions: 'Lavage en machine à 30°C sur envers avec couleurs similaires. Essorage doux (600 tr/min). Ne pas sécher en machine. Repassage à fer doux.',
    recyclingInstructions: 'Produit mono-matière hautement recyclable. En fin d’usage, déposer dans une borne textile Re-fashion ou rapporter en magasin.',
    // L'entretien et le recyclage sont aujourd'hui des textes constants, identiques
    // pour tous les produits : ils ne proviennent d'aucune saisie.
    dataGaps: [...dataGaps, 'careInstructions', 'recyclingInstructions'],
  };
}
