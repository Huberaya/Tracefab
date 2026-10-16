import type { Prisma, PrismaClient } from '@prisma/client';
import type { DppPassData, DppMaterial, ProvenanceStatus, SourcedField } from './types.js';
import { validateGtin, buildGs1DigitalLink } from '../plm-erp/gtin-engine.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Resolution des donnees de passeport — sans la moindre valeur substituee.
 *
 * REGLE (chantier 1A-C) : aucune valeur metier n'est generee en l'absence de
 * donnee sourcée. Chaque champ porte son etat : sourced (avec sa source),
 * unverified, not_filled (« non renseigne ») ou unavailable (« indisponible »).
 * L'ancien resolveur completait les trous par des defauts plausibles —
 * « 100% Coton peigne », PEF 78/B, 3,42 kg CO2e, pays PT/FR, 250 g, une chaine
 * de fabrication inventee — que rien ne distinguait de donnees reelles.
 *
 * BARRIERE DE PUBLICATION : un produit n'est resolvable que s'il porte un
 * public_slug ET un dpp_records en readiness_status 'published', relu
 * (reviewed_at) — l'etat de publication explicite et l'autorisation
 * demonstrable exigees apres audit. Voir la migration 20261010120000, qui
 * aligne les politiques RLS publiques sur la meme condition.
 */

/* ------------------------------------------------- petits utilitaires de provenance */

function sourced<T>(value: T, source: string): SourcedField<T> {
  return { value, status: 'sourced', source };
}
function unverified<T>(value: T, source: string): SourcedField<T> {
  return { value, status: 'unverified', source };
}
function notFilled<T>(source: string | null = null): SourcedField<T> {
  return { value: null, status: 'not_filled', source };
}
function unavailable<T>(source: string | null = null): SourcedField<T> {
  return { value: null, status: 'unavailable', source };
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/**
 * Statuts de provenance les plus forts en premier : un champ n'est 'sourced'
 * que si toutes les lignes qui le portent sont verifiees.
 */
const VERIFIED_STATUSES = new Set(['documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party']);

function provenanceFromDataValueStatus(status: string | null | undefined): ProvenanceStatus {
  if (!status) return 'unverified';
  if (VERIFIED_STATUSES.has(status)) return 'sourced';
  return 'unverified';
}

/* ------------------------------------------------- resolution du produit */

/**
 * Conditions de publication explicite, miroir exact de
 * tracefab_product_is_public() (migration 20261010120000).
 */
const PUBLICATION_EXPLICITE = {
  public_slug: { not: null },
  dpp_records: {
    some: {
      readiness_status: 'published' as const,
      reviewed_at: { not: null },
    },
  },
};

const PRODUIT_INCLUS = {
  product_identifiers: true,
  product_materials: {
    include: {
      materials: true,
    },
  },
  product_pef_assessments: {
    orderBy: { calculated_at: 'desc' as const },
    take: 1,
  },
  dpp_records: {
    orderBy: { computed_at: 'desc' as const },
    take: 5,
  },
  mass_balance_reconciliations: {
    orderBy: { created_at: 'desc' as const },
    take: 1,
  },
  supply_chain_nodes: {
    include: {
      supplier_sites: true,
    },
  },
} satisfies Prisma.tracefab_productsInclude;

/**
 * Resout un produit PUBLIE par identifiant : UUID, public_slug, reference,
 * ou valeur d'identifiant produit (GTIN, EAN, UPC, SKU). La barriere de
 * publication s'applique a TOUS les chemins de resolution : un brouillon,
 * ou un produit sans etat publie explicite, ne resout jamais.
 */
export async function resolveDppPassData(
  tx: PrismaTx,
  identifierOrId: string,
  baseUrl: string = 'https://tracefab.com'
): Promise<DppPassData | null> {
  const cleanId = String(identifierOrId || '').trim();
  if (!cleanId) return null;

  // Le filtre OR est construit conditionnellement : une entree `{ id: undefined }`
  // laissee dans un `OR` Prisma est un objet vide, donc un sous-filtre neutre —
  // un piege silencieux. Ici, chaque entree reelle a une condition vraie.
  const orClauses: Prisma.tracefab_productsWhereInput[] = [
    { public_slug: cleanId.toLowerCase() },
    { reference: cleanId },
    { product_identifiers: { some: { identifier_value: cleanId } } },
  ];
  if (/^[0-9a-fA-F-]{36}$/.test(cleanId)) {
    orClauses.unshift({ id: cleanId.toLowerCase() });
  }

  const product = await (tx as any).tracefab_products.findFirst({
    where: {
      ...PUBLICATION_EXPLICITE,
      OR: orClauses,
    },
    include: PRODUIT_INCLUS,
    // public_slug n'est unique QUE par marque
    // (tracefab_products_brand_organization_id_public_slug_key). Plusieurs
    // marques peuvent porter le meme slug : on rend la resolution deterministe
    // et stable (le plus ancien produit publie gagne).
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });

  if (!product) return null;
  return buildPassData(tx, product, baseUrl);
}

/**
 * Resout STRICTEMENT par GTIN : identifiant valide (modulo-10 GS1), type
 * 'gtin' en base, produit reellement publie. C'est le chemin des routes
 * consommateur par GTIN (Wallet) : aucune correspondance large, aucun
 * repli sur une reference ou un SKU.
 */
export async function resolveDppPassDataByGtin(
  tx: PrismaTx,
  rawGtin: string,
  baseUrl: string = 'https://tracefab.com'
): Promise<DppPassData | null> {
  const validation = validateGtin(rawGtin);
  if (!validation.isValid) return null;
  const gtin = validation.cleanGtin;

  const identifier = await (tx as any).product_identifiers.findFirst({
    where: {
      identifier_type: 'gtin',
      identifier_value: gtin,
      tracefab_products: { is: PUBLICATION_EXPLICITE },
    },
    include: {
      tracefab_products: {
        include: PRODUIT_INCLUS,
      },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });

  const product = identifier?.tracefab_products;
  if (!product) return null;
  return buildPassData(tx, product, baseUrl);
}

/* ------------------------------------------------- construction des champs */

async function buildPassData(
  tx: PrismaTx,
  product: any,
  baseUrl: string
): Promise<DppPassData> {
  // Identite de marque : deux colonnes, obtenues par une fonction dediee.
  // tracefab_public_brand() ne rend que display_name et country_code.
  const marque = await (tx as any).$queryRaw<Array<{ display_name: string | null; country_code: string | null }>>`
    SELECT display_name, country_code FROM tracefab_public_brand(${product.brand_organization_id}::uuid)
  `;
  const brandRow = marque?.[0] ?? null;
  const brandName: SourcedField<string> = text(brandRow?.display_name)
    ? sourced(text(brandRow!.display_name)!, 'tracefab_public_brand.display_name')
    : unavailable('tracefab_public_brand');

  const gtinRow = (product.product_identifiers || []).find((i: any) => i.identifier_type === 'gtin');
  const gtinText = text(gtinRow?.identifier_value);
  const gtin: SourcedField<string> = gtinText
    ? sourced(gtinText, 'product_identifiers.identifier_value (type gtin)')
    : notFilled('product_identifiers');

  const sku: SourcedField<string> = text(product.sku)
    ? sourced(text(product.sku)!, 'tracefab_products.sku')
    : notFilled('tracefab_products.sku');

  const reference = text(product.reference) || '';
  const serialNumber = sourced(
    `DPP-${gtinText || reference || product.id}-v${product.version || 1}`,
    'calcul: reference + version',
  );

  // Composition : UNIQUEMENT les lignes reelles de product_materials/materials.
  const materialRows: any[] = product.product_materials || [];
  const materials: DppMaterial[] = materialRows.map((m: any) => ({
    name: text(m.materials?.name)
      ? sourced(text(m.materials.name)!, 'materials.name')
      : notFilled('materials.name'),
    percentage: m.percentage !== null && m.percentage !== undefined
      ? sourced(Number(m.percentage), 'product_materials.percentage')
      : notFilled('product_materials.percentage'),
    role: text(m.material_role)
      ? sourced(text(m.material_role)!, 'product_materials.material_role')
      : notFilled('product_materials.material_role'),
    originCountry: text(m.materials?.origin_country_code)
      ? sourced(text(m.materials.origin_country_code)!, 'materials.origin_country_code')
      : notFilled('materials.origin_country_code'),
  }));
  const composition: SourcedField<string> = materialRows.length
    ? sourced(
        materialRows
          .map((m: any) => `${Number(m.percentage)}% ${text(m.materials?.name) || '?'}`)
          .join(', '),
        'product_materials + materials',
      )
    : notFilled('product_materials');

  // Chaine de fabrication : UNIQUEMENT les noeuds du graphe, avec la
  // provenance portee par chaque noeud (data_value_status).
  const nodeRows: any[] = product.supply_chain_nodes || [];
  let supplyChainSummary: SourcedField<string>;
  if (nodeRows.length) {
    const summary = nodeRows
      .map((n: any) => {
        const pays = n.supplier_sites?.country_code ? `, ${n.supplier_sites.country_code}` : '';
        return `${text(n.label) || 'Étape'} (${text(n.process_code) || n.node_type}${pays})`;
      })
      .join(' ➔ ');
    const source = 'supply_chain_nodes (+ supplier_sites)';
    const tousVerifies = nodeRows.every((n: any) => VERIFIED_STATUSES.has(n.status));
    supplyChainSummary = tousVerifies ? sourced(summary, source) : unverified(summary, source);
  } else {
    supplyChainSummary = notFilled('supply_chain_nodes');
  }

  // Environnement : UNIQUEMENT si une evaluation PEF existe. Le statut de
  // l'evaluation porte la provenance (declared => non verifie).
  const pef = (product.product_pef_assessments || [])[0];
  const pefSource = pef
    ? `product_pef_assessments (${pef.assessment_method || 'pef'}, calcule le ${new Date(pef.calculated_at).toISOString().slice(0, 10)})`
    : 'product_pef_assessments';
  const pefField = <T,>(value: T | null | undefined, convert: (v: any) => T): SourcedField<T> => {
    if (!pef) return unavailable<T>(pefSource);
    if (value === null || value === undefined) return notFilled<T>(pefSource);
    const statut = provenanceFromDataValueStatus(pef.status);
    const converted = convert(value);
    return statut === 'sourced' ? sourced(converted, pefSource) : unverified(converted, pefSource);
  };

  // Poids, pays, entretien : colonnes produit, sans defaut.
  const weightGrams: SourcedField<number> = product.weight_grams !== null && product.weight_grams !== undefined
    ? sourced(Number(product.weight_grams), 'tracefab_products.weight_grams')
    : notFilled('tracefab_products.weight_grams');
  const countryOfManufacture: SourcedField<string> = text(product.country_of_manufacture)
    ? sourced(text(product.country_of_manufacture)!, 'tracefab_products.country_of_manufacture')
    : notFilled('tracefab_products.country_of_manufacture');
  const countryOfDesign: SourcedField<string> = text(product.country_of_design)
    ? sourced(text(product.country_of_design)!, 'tracefab_products.country_of_design')
    : notFilled('tracefab_products.country_of_design');

  const care = product.care_instructions;
  const careString = typeof care === 'string'
    ? text(care)
    : (care && typeof care === 'object' && Object.keys(care).length
        ? Object.entries(care).map(([k, v]) => `${k} : ${String(v)}`).join('\n')
        : null);
  const careInstructions: SourcedField<string> = careString
    ? sourced(careString, 'tracefab_products.care_instructions')
    : notFilled('tracefab_products.care_instructions');

  // Recyclage : aucun modele de donnee ne porte cette information. Elle est
  // INDISPONIBLE — l'ancien texte « Single-material product, highly
  // recyclable » etait une affirmation commerciale sans source.
  const recyclingInstructions = unavailable<string>('aucune source dans le modele');

  // Date de verification : l'acte de relecture qui autorise la publication
  // (dpp_records.reviewed_at). Jamais tracefab_products.updated_at, qui n'a
  // aucun rapport avec une verification.
  const publie = (product.dpp_records || []).find(
    (d: any) => d.readiness_status === 'published' && d.reviewed_at,
  );
  const verificationDate: SourcedField<string> = publie?.reviewed_at
    ? sourced(new Date(publie.reviewed_at).toISOString().slice(0, 10), 'dpp_records.reviewed_at')
    : notFilled('dpp_records.reviewed_at');

  // Certificat de transaction : le VRAI numero, via les allocations de masse
  // bilancielle. L'ancien « TC-VERIFIED-MB-<id> » etait fabrique a partir
  // d'un identifiant interne.
  const tcRow: any[] = await (tx as any).$queryRaw`
    SELECT tc.tc_number AS tc_number
    FROM mass_balance_allocations a
    JOIN transaction_certificates tc ON tc.id = a.transaction_certificate_id
    WHERE a.product_id = ${product.id}::uuid
    ORDER BY a.created_at DESC
    LIMIT 1
  `;
  const tcNumber = text(tcRow?.[0]?.tc_number);
  const transactionCertificateNumber: SourcedField<string> = tcNumber
    ? sourced(tcNumber, 'transaction_certificates.tc_number via mass_balance_allocations')
    : notFilled('transaction_certificates');

  // Liens derives.
  const dppUrl = `${baseUrl.replace(/\/+$/, '')}/dpp/${encodeURIComponent(gtinText || reference || product.id)}`;
  const digitalLinkUri: SourcedField<string> = gtinText
    ? sourced(buildGs1DigitalLink({ gtin: gtinText }), 'gtin-engine.buildGs1DigitalLink sur GTIN reel')
    : notFilled('product_identifiers');

  // Presentation : seules les donnees METIER entrent dans le compte — ni
  // l'identite (nom, reference, marque : elle existe par construction), ni la
  // date de relecture ou le lien digital (meta-donnees de publication).
  // 'empty' = aucune donnee metier sourcee ; 'live' = toutes presentes et
  // sourcees ; sinon 'partial'.
  const businessFields: SourcedField<unknown>[] = [
    sku, gtin, categoryField(product), countryOfManufacture, countryOfDesign,
    weightGrams, composition, supplyChainSummary,
    pefField(pef?.pef_eco_score, Number), pefField(pef?.pef_grade, String),
    pefField(pef?.carbon_footprint_kg_co2e, Number), pefField(pef?.water_scarcity_m3, Number),
    pefField(pef?.circularity_score, Number),
    transactionCertificateNumber, careInstructions, recyclingInstructions,
  ];
  const sourcedFieldCount = businessFields.filter((f) => f.status === 'sourced').length;
  const missingFieldCount = businessFields.filter((f) => f.status === 'not_filled' || f.status === 'unavailable').length;

  return {
    productId: product.id,
    productName: sourced(String(product.name), 'tracefab_products.name'),
    productReference: reference ? sourced(reference, 'tracefab_products.reference') : notFilled('tracefab_products.reference'),
    sku,
    gtin,
    serialNumber,
    category: categoryField(product),
    brandName,
    countryOfManufacture,
    countryOfDesign,
    weightGrams,
    composition,
    materials,
    supplyChainSummary,
    pefScore: pefField(pef?.pef_eco_score, Number),
    pefGrade: pefField(pef?.pef_grade, String),
    carbonFootprintKgCo2e: pefField(pef?.carbon_footprint_kg_co2e, Number),
    waterScarcityM3: pefField(pef?.water_scarcity_m3, Number),
    circularityScore: pefField(pef?.circularity_score, Number),
    verificationDate,
    transactionCertificateNumber,
    careInstructions,
    recyclingInstructions,
    dppUrl,
    digitalLinkUri,
    presentation: {
      // 'live' uniquement si de vraies donnees metier sont presentees ; un
      // passeport sans aucune source s'annonce vide, jamais « live ».
      source: sourcedFieldCount > 0 ? (missingFieldCount > 0 ? 'partial' : 'live') : 'empty',
      sourcedFieldCount,
      missingFieldCount,
    },
  };
}

function categoryField(product: any): SourcedField<string> {
  return text(product.category)
    ? sourced(text(product.category)!, 'tracefab_products.category')
    : notFilled('tracefab_products.category');
}
