import type { Prisma, PrismaClient } from '@prisma/client';
import type { DppPassData } from './types.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Résout les données d'un passeport produit depuis la base, pour l'affichage DPP
 * et la génération des cartes Wallet.
 *
 * CE QUE CE MODULE NE FAIT PLUS
 *   Il ne fabrique rien. Chaque champ métier absent est `null`, et la provenance
 *   dit ce qui est sourcé et ce qui ne l'est pas. Auparavant, un produit sans
 *   évaluation PEF obtenait `pefScore: 78`, `pefGrade: 'B'`,
 *   `carbonFootprintKgCo2e: 3.42`, `circularityScore: 85` ; sans composition,
 *   « 100% Coton peigné » ; sans chaîne d'approvisionnement, « Filature ➔
 *   Tissage ➔ Ennoblissement ➔ Confection auditée » ; sans marque, « Tracefab
 *   Brand » ; et `verificationDate` retombait sur `new Date()` — une date de
 *   vérification inventée à aujourd'hui.
 *
 *   Ces valeurs étaient servies sur des routes anonymes, dans des cartes Wallet
 *   signées. Rien ne les distinguait de données réelles.
 */

/**
 * Valide un GTIN (8, 12, 13 ou 14 chiffres, chiffre de contrôle modulo 10).
 *
 * Sans cette validation, n'importe quelle chaîne était acceptée comme GTIN sur
 * une route consommateur. Un identifiant invalide doit être rejeté, pas résolu
 * au hasard.
 */
export function isValidGtin(value: string): boolean {
  const v = String(value || '').trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(v)) return false;
  const digits = v.split('').map(Number);
  const check = digits.pop() as number;
  const sum = digits.reduce((acc, d, i) => {
    // Le ponderateur alterne en partant de la droite : 3, 1, 3, 1...
    const fromRight = digits.length - i;
    return acc + d * (fromRight % 2 === 1 ? 3 : 1);
  }, 0);
  return (10 - (sum % 10)) % 10 === check;
}

export type DppResolveMode = 'any' | 'gtin';

export type DppResolveOptions = {
  /**
   * 'gtin' : l'identifiant DOIT être un GTIN valide et le produit est résolu
   * uniquement par son identifiant GTIN. C'est le mode des routes consommateur
   * `/api/dpp/:gtin` — un scan de QR code ne doit pas pouvoir résoudre un
   * produit par référence interne ou par SKU.
   *
   * 'any' : id, slug public, référence, SKU ou GTIN. Réservé aux surfaces
   * internes, qui connaissent déjà le produit.
   */
  mode?: DppResolveMode;
};

export async function resolveDppPassData(
  tx: PrismaTx,
  identifierOrId: string,
  baseUrl: string = 'https://tracefab.com',
  options: DppResolveOptions = {},
): Promise<DppPassData | null> {
  const mode = options.mode ?? 'any';
  const cleanId = String(identifierOrId || '').trim();
  if (!cleanId) return null;

  if (mode === 'gtin' && !isValidGtin(cleanId)) return null;

  /*
   * Barrière de publication : un produit n'est public que s'il porte un
   * public_slug. Sans elle, cette fonction résolvait n'importe quel produit,
   * brouillons compris, sur une route anonyme.
   */
  const where = {
    public_slug: { not: null },
    ...(mode === 'gtin'
      ? { product_identifiers: { some: { identifier_type: 'gtin', identifier_value: cleanId } } }
      : {
          OR: [
            { id: cleanId.length === 36 ? cleanId : undefined },
            { public_slug: cleanId.toLowerCase() },
            { reference: cleanId },
            { sku: cleanId },
            { product_identifiers: { some: { identifier_value: cleanId } } },
          ],
        }),
  };

  // public_slug n'est unique QUE par marque. Plusieurs marques peuvent porter le
  // même slug, donc une URL publique sans marque est ambiguë. On compte les
  // correspondances et on le déclare dans la provenance plutôt que de laisser le
  // lecteur croire à une résolution certaine.
  const matching = await (tx as any).tracefab_products.count({ where });

  const product = await (tx as any).tracefab_products.findFirst({
    where,
    include: {
      // `organizations` n'est PAS inclus : la table porte legal_name,
      // registration_number et clerk_organization_id. RLS filtre des lignes, pas
      // des colonnes. La marque est lue plus bas par tracefab_public_brand().
      product_identifiers: true,
      product_materials: { include: { materials: true } },
      product_pef_assessments: { orderBy: { calculated_at: 'desc' }, take: 1 },
      dpp_records: { orderBy: { computed_at: 'desc' }, take: 1 },
      mass_balance_reconciliations: { orderBy: { created_at: 'desc' }, take: 1 },
      supply_chain_nodes: { include: { supplier_sites: true } },
    },
    // À défaut de pouvoir lever l'ambiguïté ici, on la rend au moins déterministe
    // et stable : sans tri explicite, PostgreSQL rend une ligne arbitraire.
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });

  if (!product) return null;

  // Identité de marque : deux colonnes, obtenues par une fonction dédiée.
  const marque = await (tx as any).$queryRaw<Array<{ display_name: string | null; country_code: string | null }>>`
    SELECT display_name, country_code FROM tracefab_public_brand(${product.brand_organization_id}::uuid)
  `;
  const brand = marque?.[0] ?? null;

  const gtinIdentifier = product.product_identifiers?.find(
    (i: any) => i.identifier_type === 'gtin',
  )?.identifier_value ?? null;

  const pef = product.product_pef_assessments?.[0] ?? null;
  const dppRecord = product.dpp_records?.[0] ?? null;

  const materials = (product.product_materials || []).map((m: any) => ({
    // Pas de « Matière textile » de substitution : une ligne de composition sans
    // nom est une donnée absente, pas une matière générique.
    name: m.materials?.name ?? null,
    percentage: m.percentage === null || m.percentage === undefined ? null : Number(m.percentage),
    role: m.material_role ?? null,
    originCountry: m.materials?.origin_country_code ?? null,
  }));

  const compSummary = materials.length
    ? materials
        .filter((m: any) => m.name !== null)
        .map((m: any) => `${m.percentage === null ? '?' : m.percentage}% ${m.name}`)
        .join(', ') || null
    : null;

  const nodes = product.supply_chain_nodes || [];
  const supplyChainSummary = nodes.length
    ? nodes
        .map((n: any) => `${n.label || n.process_code || n.node_type}${n.supplier_sites?.country_code ? ` (${n.supplier_sites.country_code})` : ''}`)
        .join(' ➔ ')
    : null;

  /*
   * `care_instructions` est une colonne Json réelle, écrite et validée par
   * PATCH /api/products/:id. Elle était ignorée au profit d'un texte d'entretien
   * anglais codé en dur. S'il n'y a aucune consigne enregistrée, c'est `null`.
   */
  const care = product.care_instructions;
  const careInstructions =
    care && typeof care === 'object' && !Array.isArray(care) && Object.keys(care).length > 0
      ? (care as Record<string, unknown>)
      : null;

  const identifierForUrl = gtinIdentifier || product.reference;
  const dppUrl = `${baseUrl}/p/${identifierForUrl}`;
  const digitsOnly = product.reference.replace(/[^0-9]/g, '');
  const digitalLinkUri = gtinIdentifier
    ? `https://id.tracefab.com/01/${gtinIdentifier}/21/${product.version || 1}`
    : `urn:epc:id:sgtin:3760123.${digitsOnly.slice(-3) || '001'}.${product.version || 1}`;

  const resolvedBy: DppPassData['provenance']['resolvedBy'] =
    mode === 'gtin' || gtinIdentifier === cleanId
      ? 'gtin'
      : product.public_slug === cleanId.toLowerCase()
        ? 'public_slug'
        : product.reference === cleanId
          ? 'reference'
          : product.sku === cleanId
            ? 'sku'
            : 'id';

  const value: Record<string, unknown> = {
    brandName: brand?.display_name ?? null,
    brandLegalName: brand?.display_name ?? null,
    category: product.category ?? null,
    countryOfManufacture: product.country_of_manufacture ?? null,
    countryOfDesign: product.country_of_design ?? null,
    weightGrams: product.weight_grams === null || product.weight_grams === undefined ? null : Number(product.weight_grams),
    certifiedComposition: compSummary,
    pefScore: pef ? Number(pef.pef_eco_score) : null,
    pefGrade: pef ? pef.pef_grade : null,
    carbonFootprintKgCo2e: pef ? Number(pef.carbon_footprint_kg_co2e) : null,
    waterScarcityM3: pef ? Number(pef.water_scarcity_m3) : null,
    circularityScore: pef ? Number(pef.circularity_score) : null,
    // Ni updated_at, ni aujourd'hui : la date de calcul du DPP, ou rien.
    verificationDate: dppRecord?.computed_at ? new Date(dppRecord.computed_at).toISOString().slice(0, 10) : null,
    /*
     * Le numéro de certificat est `transaction_certificates.tc_number`, une
     * colonne @unique. Auparavant il était fabriqué :
     * `TC-VERIFIED-MB-${mb.id.slice(0, 8)}` — un identifiant de réconciliation
     * présenté comme un certificat vérifié.
     *
     * Cette table ne porte AUCUNE politique de lecture publique
     * (`tc_select_parties` seulement). Sur une route anonyme elle rend donc 0
     * ligne, et le champ est `null`. L'exposer publiquement exigerait une
     * politique dédiée : c'est une décision produit, pas un correctif.
     */
    transactionCertificateNumber: null,
    supplyChainSummary,
    careInstructions,
    recyclingInstructions: null,
  };

  const sourced = Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k]) => k);
  const notProvided = Object.keys(value).filter((k) => !sourced.includes(k));

  return {
    productId: product.id,
    brandName: value.brandName as string | null,
    brandLegalName: value.brandLegalName as string | null,
    productName: product.name,
    productReference: product.reference,
    sku: product.sku ?? null,
    gtin: gtinIdentifier,
    serialNumber: `DPP-${identifierForUrl}-v${product.version || 1}`,
    category: value.category as string | null,
    countryOfManufacture: value.countryOfManufacture as string | null,
    countryOfDesign: value.countryOfDesign as string | null,
    weightGrams: value.weightGrams as number | null,
    certifiedComposition: value.certifiedComposition as string | null,
    materials,
    pefScore: value.pefScore as number | null,
    pefGrade: value.pefGrade as string | null,
    carbonFootprintKgCo2e: value.carbonFootprintKgCo2e as number | null,
    waterScarcityM3: value.waterScarcityM3 as number | null,
    circularityScore: value.circularityScore as number | null,
    dppUrl,
    digitalLinkUri,
    verificationDate: value.verificationDate as string | null,
    transactionCertificateNumber: null,
    supplyChainSummary: value.supplyChainSummary as string | null,
    careInstructions: value.careInstructions as Record<string, unknown> | null,
    recyclingInstructions: null,
    provenance: {
      /*
       * 'live' exige au moins une donnée SUBSTANTIELLE du passeport.
       *
       * « Au moins un champ sourcé » ne suffit pas : le nom de marque vient de
       * tracefab_public_brand() et est donc toujours sourcé pour un produit
       * publié. Un passeport réduit à un nom de marque, sans composition, sans
       * chaîne, sans score et sans date de calcul, n'est pas un passeport live —
       * c'est un passeport incomplet, et l'affichage doit le dire.
       */
      status: ['certifiedComposition', 'supplyChainSummary', 'pefScore', 'verificationDate']
        .some((k) => value[k] !== null && value[k] !== undefined)
        ? 'live'
        : 'incomplete',
      sourced,
      notProvided,
      resolvedBy,
      ambiguousWith: matching,
    },
  };
}
