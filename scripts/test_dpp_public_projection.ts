import assert from 'node:assert/strict';
import {
  PUBLIC_SOURCE_LABELS,
  toPublicClaim,
  toPublicDppProjection,
  toPublicHistoryEvent,
  type PublicClaim,
} from '../api/_lib/dpp-public.js';
import type { DppPassData, ProvenanceStatus, SourcedField } from '../api/_lib/wallet/types.js';

let checks = 0;
const ok = (condition: unknown, label: string) => {
  assert.ok(condition, label);
  checks += 1;
  console.log(`  ok    ${label}`);
};

const field = <T,>(value: T | null, status: ProvenanceStatus, source: string | null): SourcedField<T> => ({
  value,
  status,
  source,
});
const sourced = <T,>(value: T, source: string) => field(value, 'sourced', source);
const missing = <T,>(source: string | null = null) => field<T>(null, 'not_filled', source);
const unavailable = <T,>(source: string | null = null) => field<T>(null, 'unavailable', source);

const dpp: DppPassData = {
  productId: '11111111-2222-4333-8444-555555555555',
  productName: sourced('Chemise réelle', 'tracefab_products.name'),
  productReference: sourced('REF-42', 'tracefab_products.reference'),
  sku: sourced('SKU-42', 'tracefab_products.sku'),
  gtin: sourced('3760123456789', 'product_identifiers.identifier_value (type gtin)'),
  serialNumber: sourced('DPP-3760123456789-v1', 'calcul: reference + version'),
  category: sourced('shirt', 'tracefab_products.category'),
  brandName: sourced('Maison Réelle', 'tracefab_public_brand.display_name'),
  countryOfManufacture: sourced('FR', 'tracefab_products.country_of_manufacture'),
  countryOfDesign: missing('tracefab_products.country_of_design'),
  weightGrams: sourced(180, 'tracefab_products.weight_grams'),
  composition: sourced('100% coton', 'product_materials + materials'),
  materials: [
    {
      name: sourced('Coton biologique', 'materials.name'),
      percentage: sourced(100, 'product_materials.percentage'),
      role: sourced('main', 'product_materials.material_role'),
      originCountry: field('PT', 'unverified', 'materials.origin_country_code'),
    },
  ],
  supplyChainSummary: sourced('Filature (spinning, PT) ➔ Confection (cutting, FR)', 'supply_chain_nodes (+ supplier_sites)'),
  pefScore: unavailable('product_pef_assessments'),
  pefGrade: missing('product_pef_assessments'),
  carbonFootprintKgCo2e: field(2.4, 'unverified', 'product_pef_assessments (pef)'),
  waterScarcityM3: unavailable('product_pef_assessments'),
  circularityScore: missing('product_pef_assessments'),
  verificationDate: sourced('2026-10-16', 'dpp_records.reviewed_at'),
  transactionCertificateNumber: sourced('TC-2026-0042', 'transaction_certificates.tc_number via mass_balance_allocations'),
  careInstructions: sourced('Lavage à 30 °C', 'tracefab_products.care_instructions'),
  recyclingInstructions: unavailable('aucune source dans le modèle'),
  dppUrl: 'https://tracefab.com/dpp/3760123456789',
  digitalLinkUri: sourced('https://id.gs1.org/01/3760123456789', 'gtin-engine.buildGs1DigitalLink sur GTIN reel'),
  presentation: { source: 'partial', sourcedFieldCount: 8, missingFieldCount: 4 },
};

const claims: PublicClaim[] = [
  toPublicClaim({
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    claim_key: 'composition.cotton',
    statement: 'Composition en coton biologique',
    validation_status: 'documented',
    valid_from: '2026-01-01',
    valid_until: '2027-01-01',
    expired: false,
    accepted_evidence_count: 1,
    evidence_labels: ['Certificat de composition'],
    contradicting_evidence_count: 0,
    verifier_display_name: null,
    reviewed_at: '2026-10-16T10:00:00Z',
    document_id: 'must-not-leak',
    storage_path: 'private/must-not-leak.pdf',
    coverage_note: 'note privée',
  })!,
  toPublicClaim({
    id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    claim_key: 'care.water',
    statement: 'Empreinte eau vérifiée par un tiers',
    validation_status: 'third_party_verified',
    accepted_evidence_count: 1,
    contradicting_evidence_count: 1,
    verifier_display_name: 'Bureau Veritas',
    reviewed_at: '2026-10-16T11:00:00Z',
  })!,
];

const projected = toPublicDppProjection(dpp, {
  lastUpdatedAt: '2026-10-16T12:00:00Z',
  claims,
});
const serialized = JSON.stringify(projected);

ok(!serialized.includes('11111111-2222-4333-8444-555555555555'), 'UUID interne du produit absent');
ok(!serialized.includes('productId'), 'clé productId absente');
ok(!serialized.includes('tracefab_'), 'aucun nom de table interne');
ok(!serialized.includes('product_materials'), 'aucun nom de colonne interne');
ok(!serialized.includes('storage_path'), 'aucun chemin de stockage');
ok(!serialized.includes('document_id'), 'aucun identifiant documentaire');
ok(projected.productName.value === 'Chemise réelle' && projected.productName.status === 'sourced', 'valeur sourcee conservée');
ok(projected.sku.source === 'product_record', 'source produit catégorisée');
ok(projected.materials[0].percentage.source === 'materials_record', 'source matière catégorisée');
ok(projected.materials[0].originCountry.status === 'unverified', 'statut non vérifié conservé');
ok(projected.transactionCertificateNumber.source === 'transaction_record', 'source certificat de transaction catégorisée');
ok(projected.verificationDate.source === 'published_record', 'source de publication catégorisée');
ok(projected.serialNumber.source === 'computed', 'source calculée catégorisée');
ok(projected.pefScore.source === 'pef_assessment' && projected.pefScore.status === 'unavailable', 'source d’évaluation catégorisée');
ok(projected.recyclingInstructions.source === null && projected.recyclingInstructions.status === 'unavailable', 'source inconnue réduite à null');
ok(projected.countryOfDesign.status === 'not_filled' && projected.countryOfDesign.value === null, 'champ manquant explicite, sans valeur inventée');
ok(projected.presentation.lastUpdatedAt === '2026-10-16T12:00:00.000Z', 'date de mise à jour normalisée');
ok(projected.presentation.publicClaimsCount === 2, 'nombre d’affirmations publiques exact');
ok(projected.limits.unverifiedFields === 1, 'compteur de champs non vérifiés exact');
ok(projected.limits.missingFields === 6, 'compteur de champs manquants exact');
ok(projected.capabilities.hasComposition && projected.capabilities.hasTraceability && projected.capabilities.hasClaims, 'capacités déclarées dérivées des données');
ok(projected.capabilities.hasCareInstructions, 'instructions d’entretien détectées');
ok(Object.keys(PUBLIC_SOURCE_LABELS).every((key) => typeof PUBLIC_SOURCE_LABELS[key as keyof typeof PUBLIC_SOURCE_LABELS] === 'string'), 'libellés de source lisibles présents');

ok(claims[0].evidenceLabels.length === 1 && claims[0].acceptedEvidenceCount === 1, 'preuve acceptée comptée');
ok(!('document_id' in claims[0]) && !('storage_path' in claims[0]) && !('coverage_note' in claims[0]), 'affirmation publique sans métadonnée privée');
ok(claims[1].contradictingEvidenceCount === 1, 'contradiction acceptée signalée');
ok(claims[1].verifierDisplayName === 'Bureau Veritas', 'vérificateur tiers identifié');
ok(claims[0].validFrom === '2026-01-01T00:00:00.000Z', 'date de validité normalisée');

const xss = '<img src=x onerror="window.__xss=1"> Composition';
const xssClaim = toPublicClaim({ id: 'cccccccc-dddd-4eee-8fff-000000000000', statement: xss, validation_status: 'declared' })!;
ok(xssClaim.statement === xss, 'contenu hostile conservé comme texte, sans transformation HTML');
ok(!xssClaim.statement.includes('<script'), 'aucune balise script interprétée');

const event = toPublicHistoryEvent({
  id: 'dddddddd-eeee-4fff-8000-111111111111',
  event_type: 'data_corrected',
  recorded_at: '2026-10-16T10:00:00Z',
  business_occurred_at: null,
  validation_status: 'documented',
  public_summary: 'Composition corrigée',
  verified_by_name: null,
  actor_user_id: 'must-not-leak',
  owner_organization_id: 'must-not-leak',
  details: { secret: 'must-not-leak' },
  evidence_document_ids: ['must-not-leak'],
});
ok(!JSON.stringify(event).includes('must-not-leak'), 'événement public sans acteur, tenant, détail ni document');
ok(event.validationStatus === 'documented' && event.publicSummary === 'Composition corrigée', 'événement public remappé');

const invalid = toPublicHistoryEvent({ id: 'x', validation_status: 'forged', recorded_at: 'not-a-date' });
ok(invalid.validationStatus === 'unknown' && invalid.recordedAt === '', 'statut inconnu et date invalide explicités, jamais inventés');
ok(toPublicClaim({ id: 'x', statement: '' }) === null, 'affirmation vide non publiée');

console.log(`\nProjection publique DPP : ${checks} assertions de liste blanche réussies.`);
