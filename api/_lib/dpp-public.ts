/**
 * Projection PUBLIQUE du passeport.
 *
 * Le résolveur interne (`wallet/dpp-data-resolver.ts`) porte des sources
 * techniques (`tracefab_products.sku`, `product_materials.percentage`, …) et
 * un `productId` UUID. Les servir tels quels à `/api/dpp/:identifiant`
 * publierait des identifiants internes et couplera l'API publique au schéma.
 *
 * Cette projection est une LISTE BLANCHE :
 *   — chaque champ public est nommé explicitement ;
 *   — les sources sont réduites à une catégorie lisible, jamais un nom de
 *     table, de colonne ou un identifiant ;
 *   — `productId` n'est jamais exposé ;
 *   — les objets venant de PostgreSQL sont remappés champ par champ, donc une
 *     colonne ajoutée demain ne fuit pas par accident.
 *
 * Ce module est pur : il ne lit ni base ni réseau, et se teste hors ligne.
 */
import type { DppMaterial, DppPassData, ProvenanceStatus, SourcedField } from './wallet/types.js';

export type PublicSourceCategory =
  | 'product_record'
  | 'materials_record'
  | 'supply_chain_record'
  | 'brand_record'
  | 'pef_assessment'
  | 'transaction_record'
  | 'published_record'
  | 'computed';

export const PUBLIC_SOURCE_LABELS: Record<PublicSourceCategory, string> = {
  product_record: 'Fiche produit',
  materials_record: 'Données matières',
  supply_chain_record: 'Chaîne d’approvisionnement',
  brand_record: 'Identité de marque',
  pef_assessment: 'Évaluation environnementale',
  transaction_record: 'Certificat de transaction',
  published_record: 'Publication relue',
  computed: 'Calcul déterministe',
};

export interface PublicField<T> {
  value: T | null;
  status: ProvenanceStatus;
  source: PublicSourceCategory | null;
}

export interface PublicMaterial {
  name: PublicField<string>;
  percentage: PublicField<number>;
  role: PublicField<string>;
  originCountry: PublicField<string>;
}

export interface PublicPassport {
  productName: PublicField<string>;
  productReference: PublicField<string>;
  sku: PublicField<string>;
  gtin: PublicField<string>;
  serialNumber: PublicField<string>;
  category: PublicField<string>;
  brandName: PublicField<string>;
  countryOfManufacture: PublicField<string>;
  countryOfDesign: PublicField<string>;
  weightGrams: PublicField<number>;
  composition: PublicField<string>;
  materials: PublicMaterial[];
  supplyChainSummary: PublicField<string>;
  pefScore: PublicField<number>;
  pefGrade: PublicField<string>;
  carbonFootprintKgCo2e: PublicField<number>;
  waterScarcityM3: PublicField<number>;
  circularityScore: PublicField<number>;
  verificationDate: PublicField<string>;
  transactionCertificateNumber: PublicField<string>;
  careInstructions: PublicField<string>;
  recyclingInstructions: PublicField<string>;
  links: {
    dppUrl: string;
    digitalLinkUri: PublicField<string>;
  };
  presentation: {
    source: 'live' | 'partial' | 'empty';
    sourcedFieldCount: number;
    missingFieldCount: number;
    unverifiedFieldCount: number;
    lastUpdatedAt: string | null;
    publicClaimsCount: number | null;
  };
  limits: {
    missingFields: number;
    unverifiedFields: number;
    claimsWithoutAcceptedEvidence: number;
    notice: string;
  };
  capabilities: {
    hasComposition: boolean;
    hasTraceability: boolean;
    hasCareInstructions: boolean;
    hasClaims: boolean;
  };
}

export interface PublicClaim {
  id: string;
  claimKey: string;
  statement: string;
  validationStatus: string;
  validFrom: string | null;
  validUntil: string | null;
  expired: boolean;
  acceptedEvidenceCount: number;
  evidenceLabels: string[];
  contradictingEvidenceCount: number;
  verifierDisplayName: string | null;
  reviewedAt: string | null;
}

export interface PublicHistoryEvent {
  id: string;
  eventType: string;
  businessOccurredAt: string | null;
  recordedAt: string;
  validationStatus: string;
  publicSummary: string;
  verifiedByName: string | null;
}

const VALIDATION_STATUSES = new Set([
  'declared',
  'documented',
  'controlled',
  'corroborated',
  'third_party_verified',
  'rejected',
]);

const PROVENANCE_STATUSES = new Set<ProvenanceStatus>([
  'sourced',
  'unverified',
  'not_filled',
  'unavailable',
]);

const SOURCE_RULES: Array<[RegExp, PublicSourceCategory]> = [
  [/^tracefab_products\b/, 'product_record'],
  [/^product_identifiers\b/, 'product_record'],
  [/^(product_materials|materials)\b/, 'materials_record'],
  [/^supply_chain_nodes\b/, 'supply_chain_record'],
  [/^tracefab_public_brand\b/, 'brand_record'],
  [/^product_pef_assessments\b/, 'pef_assessment'],
  [/^(transaction_certificates|mass_balance_allocations)\b/, 'transaction_record'],
  [/^dpp_records\b/, 'published_record'],
  [/^calcul\s*:/, 'computed'],
];

function publicSource(source: string | null | undefined): PublicSourceCategory | null {
  if (!source) return null;
  for (const [pattern, category] of SOURCE_RULES) {
    if (pattern.test(source)) return category;
  }
  return null;
}

function field<T>(value: SourcedField<T> | undefined | null): PublicField<T> {
  if (!value || typeof value !== 'object') {
    return { value: null, status: 'unavailable', source: null };
  }
  const status = PROVENANCE_STATUSES.has(value.status) ? value.status : 'unavailable';
  const raw = value.value;
  const safe =
    status === 'sourced' || status === 'unverified'
      ? (raw === undefined ? null : raw)
      : null;
  return { value: safe as T | null, status, source: publicSource(value.source) };
}

function material(m: DppMaterial): PublicMaterial {
  return {
    name: field(m?.name),
    percentage: field(m?.percentage),
    role: field(m?.role),
    originCountry: field(m?.originCountry),
  };
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toPublicDppProjection(
  dpp: DppPassData,
  options: {
    lastUpdatedAt?: string | null;
    publicClaimsCount?: number | null;
    claims?: PublicClaim[];
  } = {},
): PublicPassport {
  const materials = Array.isArray(dpp.materials) ? dpp.materials.slice(0, 100).map(material) : [];

  const businessFields: Array<PublicField<unknown>> = [
    field(dpp.sku),
    field(dpp.gtin),
    field(dpp.category),
    field(dpp.countryOfManufacture),
    field(dpp.countryOfDesign),
    field(dpp.weightGrams),
    field(dpp.composition),
    field(dpp.supplyChainSummary),
    field(dpp.pefScore),
    field(dpp.pefGrade),
    field(dpp.carbonFootprintKgCo2e),
    field(dpp.waterScarcityM3),
    field(dpp.circularityScore),
    field(dpp.transactionCertificateNumber),
    field(dpp.careInstructions),
    field(dpp.recyclingInstructions),
  ];

  const unverifiedFieldCount = businessFields.filter((f) => f.status === 'unverified').length;
  const missingFieldCount = businessFields.filter(
    (f) => f.status === 'not_filled' || f.status === 'unavailable',
  ).length;

  const claims = options.claims || [];
  const claimsWithoutAcceptedEvidence = claims.filter(
    (claim) =>
      ['documented', 'controlled', 'corroborated', 'third_party_verified'].includes(
        claim.validationStatus,
      ) && claim.acceptedEvidenceCount === 0,
  ).length;

  const compliance = {
    missingFields: missingFieldCount,
    unverifiedFields: unverifiedFieldCount,
    claimsWithoutAcceptedEvidence,
    notice:
      'Les informations non renseignées, non vérifiées ou indisponibles ne sont jamais remplacées par une valeur supposée.',
  };

  return {
    productName: field(dpp.productName),
    productReference: field(dpp.productReference),
    sku: field(dpp.sku),
    gtin: field(dpp.gtin),
    serialNumber: field(dpp.serialNumber),
    category: field(dpp.category),
    brandName: field(dpp.brandName),
    countryOfManufacture: field(dpp.countryOfManufacture),
    countryOfDesign: field(dpp.countryOfDesign),
    weightGrams: field(dpp.weightGrams),
    composition: field(dpp.composition),
    materials,
    supplyChainSummary: field(dpp.supplyChainSummary),
    pefScore: field(dpp.pefScore),
    pefGrade: field(dpp.pefGrade),
    carbonFootprintKgCo2e: field(dpp.carbonFootprintKgCo2e),
    waterScarcityM3: field(dpp.waterScarcityM3),
    circularityScore: field(dpp.circularityScore),
    verificationDate: field(dpp.verificationDate),
    transactionCertificateNumber: field(dpp.transactionCertificateNumber),
    careInstructions: field(dpp.careInstructions),
    recyclingInstructions: field(dpp.recyclingInstructions),
    links: {
      dppUrl: String(dpp.dppUrl || ''),
      digitalLinkUri: field(dpp.digitalLinkUri),
    },
    presentation: {
      source: dpp.presentation?.source === 'live' || dpp.presentation?.source === 'partial'
        ? dpp.presentation.source
        : 'empty',
      sourcedFieldCount: Number(dpp.presentation?.sourcedFieldCount || 0),
      missingFieldCount: Number(dpp.presentation?.missingFieldCount || 0),
      unverifiedFieldCount,
      lastUpdatedAt: isoDate(options.lastUpdatedAt),
      publicClaimsCount: options.publicClaimsCount ?? (options.claims ? options.claims.length : null),
    },
    limits: compliance,
    capabilities: {
      hasComposition: materials.some((m) => m.percentage.status === 'sourced') ||
        field(dpp.composition).status === 'sourced',
      hasTraceability: field(dpp.supplyChainSummary).status === 'sourced' ||
        field(dpp.supplyChainSummary).status === 'unverified',
      hasCareInstructions: field(dpp.careInstructions).status === 'sourced',
      hasClaims: (options.publicClaimsCount ?? (options.claims ? options.claims.length : 0)) > 0,
    },
  };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function nullableText(value: unknown, max: number): string | null {
  const s = text(value, max);
  return s ? s : null;
}

function safeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const s = String(value);
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Remappe une ligne de `tracefab_public_dpp_claims`. La fonction SQL est déjà
 * en liste blanche, mais l'API ne renvoie pas `SELECT *` pour autant : une
 * colonne ajoutée demain ne doit pas devenir publique sans décision.
 */
export function toPublicClaim(row: Record<string, unknown>): PublicClaim | null {
  const id = text(row.id, 36);
  const statement = text(row.statement, 500);
  if (!id || !statement) return null;
  const status = text(row.validation_status, 40);
  const labels = Array.isArray(row.evidence_labels)
    ? row.evidence_labels
        .map((label) => text(label, 200))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  return {
    id,
    claimKey: text(row.claim_key, 120),
    statement,
    validationStatus: VALIDATION_STATUSES.has(status) ? status : 'unknown',
    validFrom: safeDate(row.valid_from),
    validUntil: safeDate(row.valid_until),
    expired: row.expired === true,
    acceptedEvidenceCount: Math.max(0, Number(row.accepted_evidence_count) || 0),
    evidenceLabels: labels,
    contradictingEvidenceCount: Math.max(0, Number(row.contradicting_evidence_count) || 0),
    verifierDisplayName: nullableText(row.verifier_display_name, 200),
    reviewedAt: safeDate(row.reviewed_at),
  };
}

/**
 * Remappe un événement public. `actor_user_id`, `details`, `metadata`,
 * `evidence_document_ids` et `owner_organization_id` ne sortent jamais.
 */
export function toPublicHistoryEvent(row: Record<string, unknown>): PublicHistoryEvent {
  const status = text(row.validation_status, 40);
  return {
    id: text(row.id, 36),
    eventType: text(row.event_type, 80),
    businessOccurredAt: safeDate(row.business_occurred_at),
    recordedAt: safeDate(row.recorded_at) || '',
    validationStatus: VALIDATION_STATUSES.has(status) ? status : 'unknown',
    publicSummary: text(row.public_summary, 500),
    verifiedByName: nullableText(row.verified_by_name, 200),
  };
}
