import type { Prisma, PrismaClient } from '@prisma/client';
import type { DppPassData } from './types.js';
import { buildGs1DigitalLink } from '../plm-erp/gtin-engine.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Plusieurs produits publies repondent au meme identifiant public.
 *
 * Distinct de « introuvable » : la donnee existe, mais rien ne permet de
 * decider laquelle est demandee. Les routes publiques doivent le signaler
 * plutot que de choisir a la place du lecteur.
 */
export class IdentifiantPublicAmbigu extends Error {
  readonly identifiant: string;
  constructor(identifiant: string) {
    super(`identifiant public ambigu : ${identifiant}`);
    this.name = 'IdentifiantPublicAmbigu';
    this.identifiant = identifiant;
  }
}

/**
 * `care_instructions` est un objet JSON libre (`@default("{}")`), valide par
 * la route d'ecriture comme « objet, ni tableau ni null », sans schema impose.
 * On n'en retient que les valeurs textuelles non vides, et on ne rend rien
 * quand l'objet est vide — ce qui est le cas par defaut pour la quasi-totalite
 * des produits.
 */
function consignesEntretien(brut: unknown): string | undefined {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return undefined;
  const morceaux = Object.values(brut as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return morceaux.length ? morceaux.join(' ') : undefined;
}

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
    const correspondants = await (tx as any).tracefab_products.findMany({
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
    // AUCUN DES CRITERES CI-DESSUS N'EST UNIQUE AU NIVEAU MONDIAL.
    //
    // `public_slug` ne l'est que par marque
    // (tracefab_products_brand_organization_id_public_slug_key), et la
    // migration 35 le retro-remplit avec `lower(reference)` : deux marques
    // employant la meme reference produisent donc le meme slug public.
    // `reference` et `sku` ont exactement le meme defaut, et rien n'impose
    // l'unicite d'un GTIN dans product_identifiers.
    //
    // Un `findFirst` trie rendait alors une ligne « deterministe mais
    // arbitraire » : stable d'une requete a l'autre, et potentiellement le
    // passeport d'UNE AUTRE MARQUE. Pour un produit de tracabilite, servir les
    // donnees du voisin est pire que ne rien servir.
    //
    // On lit donc deux lignes pour savoir s'il y en a plus d'une, et on refuse
    // si c'est le cas. Le tri reste, pour que la ligne retenue dans le cas non
    // ambigu ne depende pas du plan d'execution.
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: 2,
  });

  if (correspondants.length > 1) {
    throw new IdentifiantPublicAmbigu(cleanId);
  }
  const product = correspondants[0] ?? null;

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

  // Pas de matiere declaree => pas de composition. L'ancien repli annoncait
  // « 100% Coton peigne » pour n'importe quel produit, ce qui est une
  // allegation de composition sur un produit dont on ne sait rien.
  const compSummary = materials.length
    ? materials.map((m: any) => `${m.percentage}% ${m.name}`).join(', ')
    : undefined;

  // Format supply chain summary
  const nodes = product.supply_chain_nodes || [];
  // Idem : une chaine d'approvisionnement non saisie reste vide. Afficher
  // « Filature -> Tissage -> Ennoblissement -> Confection auditee » revenait a
  // decrire, et a qualifier d'auditee, une chaine inconnue.
  const supplyChainSummary = nodes.length
    ? nodes.map((n: any) => `${n.label || 'Étape'} (${n.process_code || n.node_type}${n.supplier_sites?.country_code ? `, ${n.supplier_sites.country_code}` : ''})`).join(' ➔ ')
    : undefined;

  const dppUrl = `${baseUrl}/p/${gtin || product.reference}`;
  // LIEN NUMERIQUE GS1 — seulement quand un GTIN reel existe.
  //
  // L'expression precedente fabriquait un URN EPC :
  //
  //     urn:epc:id:sgtin:3760123.<3 chiffres de la reference>.<version>
  //
  // Trois problemes. `3760123` est un prefixe d'entreprise GS1 en dur, qui
  // n'appartient pas aux marques servies — l'URN designait donc le produit de
  // quelqu'un d'autre. Les trois derniers chiffres de la reference ne sont pas
  // une reference article. Et le numero de VERSION du produit etait place en
  // numero de serie, ce qui n'a aucun sens : deux exemplaires partagent une
  // version, un numero de serie les distingue.
  //
  // On s'en remet au constructeur canonique du depot, alimente par le GTIN
  // reellement enregistre. Sans GTIN, il n'existe pas de lien numerique GS1
  // valide : le champ reste vide et le code QR retombe sur l'URL du passeport.
  const digitalLinkUri = gtin ? buildGs1DigitalLink({ gtin, linkType: 'gs1:pip' }) : undefined;

  return {
    productId: product.id,
    brandName: brand?.display_name || 'Marque non communiquée',
    // Jamais la raison sociale sur une surface publique : elle n'apporte rien
    // au consommateur et elle identifie l'entreprise au registre.
    brandLegalName: brand?.display_name || 'Marque non communiquée',
    brandCountry: brand?.country_code || undefined,
    productName: product.name,
    productReference: product.reference,
    sku: product.sku || product.reference,
    gtin,
    serialNumber: `DPP-${gtin || product.reference}-v${product.version}`,
    category: product.category || 'Textile',
    // AUCUNE VALEUR PAR DEFAUT SOUS CETTE LIGNE.
    //
    // Chacun de ces champs portait un repli : PT, FR, 250 g, et surtout un
    // profil environnemental complet (score 78, grade B, 3,42 kg CO2e,
    // 0,85 m3, circularite 85) servi a tout produit depourvu d'analyse PEF.
    // Rien ne distinguait ce profil d'une mesure reelle, ni dans la reponse
    // d'API, ni sur le laissez-passer Wallet. `undefined` est la seule
    // reponse honnete a « quelle est l'empreinte de ce produit ? » quand elle
    // n'a pas ete calculee.
    countryOfManufacture: product.country_of_manufacture || undefined,
    countryOfDesign: product.country_of_design || undefined,
    weightGrams: product.weight_grams ? Number(product.weight_grams) : undefined,
    certifiedComposition: compSummary,
    materials,
    pefScore: pef ? Number(pef.pef_eco_score) : undefined,
    pefGrade: (pef ? pef.pef_grade : undefined) as any,
    carbonFootprintKgCo2e: pef ? Number(pef.carbon_footprint_kg_co2e) : undefined,
    waterScarcityM3: pef ? Number(pef.water_scarcity_m3) : undefined,
    circularityScore: pef ? Number(pef.circularity_score) : undefined,
    dppUrl,
    digitalLinkUri,
    // Date de derniere modification du produit, pas une date de verification
    // par un tiers. On ne la rend que si elle existe reellement.
    verificationDate: product.updated_at ? product.updated_at.toISOString().slice(0, 10) : undefined,
    transactionCertificateNumber: mb ? `TC-VERIFIED-MB-${mb.id.slice(0, 8)}` : undefined,
    supplyChainSummary,
    // Consignes d'entretien et de fin de vie : elles dependent de la matiere
    // reelle. « Produit monomatiere, hautement recyclable » applique a tout le
    // catalogue est faux des qu'un produit melange deux fibres. Tant qu'elles
    // ne sont pas saisies par la marque, on n'affiche rien.
    careInstructions: consignesEntretien(product.care_instructions),
    // Aucune colonne ne porte de consigne de fin de vie. L'ancien texte
    // (« Produit monomatiere, hautement recyclable ») etait donc affirme pour
    // tout le catalogue, y compris pour des produits multi-fibres ou il est
    // faux. Tant que la donnee n'existe pas, la rubrique reste vide.
    recyclingInstructions: undefined,
  };
}
