import type { Prisma } from '@prisma/client';
import { isUuid } from './data-requests.js';

export type DppReadinessStatus =
  | 'not_started'
  | 'in_progress'
  | 'review_required'
  | 'data_ready'
  | 'ready_to_publish'
  | 'published';

export type DppPillar = 'identification' | 'composition' | 'traceability' | 'quality';

export interface DppPillarInfo {
  key: DppPillar;
  name: string;
  description: string;
  icon: string;
  score: number;
  total: number;
  met: number;
  metPercent: number;
  items: Array<{
    key: string;
    label: string;
    met: boolean;
    blocking: boolean;
  }>;
}

export interface DppRecordSummary {
  id: string | null;
  productId: string;
  productVersion: number;
  profileKey: string;
  profileVersion: string;
  readinessStatus: DppReadinessStatus;
  statusLabel: string;
  completionScore: number;
  totalRequirements: number;
  metRequirements: number;
  blockingCount: number;
  missingFields: Array<{ key: string; label: string; blocking: boolean }>;
  blockingIssues: Array<{ key: string; label: string; reason: string }>;
  pillars: Record<DppPillar, DppPillarInfo>;
  canMarkReadyToPublish: boolean;
  isReadyToPublish: boolean;
  computedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  inputFingerprint: string | null;
}

export const DPP_STATUS_LABELS: Record<DppReadinessStatus, string> = {
  not_started: 'Non démarré',
  in_progress: 'Données incomplètes',
  review_required: 'Revue requise',
  data_ready: 'Structure technique complète · revue requise',
  ready_to_publish: 'Validé & Prêt à publier',
  published: 'Publié',
};

export const DPP_REQUIREMENT_LABELS: Record<string, string> = {
  'product.reference': 'Référence produit (SKU / Réf)',
  'product.name': 'Désignation commerciale',
  'product.description': 'Description détaillée (min. 30 caractères)',
  'product.category': 'Catégorie textile définie',
  'product.country_of_manufacture': 'Pays de confection (code ISO-2)',
  'product.required_attributes': 'Couleur, poids et tailles renseignés',
  'product.data_ready': 'Préparation générale des données produit',
  'product.not_draft': 'Produit sorti du statut brouillon',
  'composition.complete': 'Pourcentages matière totalisés à 100 %',
  'materials.origin_documented': 'Origine pays renseignée pour chaque matière',
  'traceability.graph': 'Structure du graphe de traçabilité présente',
  'traceability.documented': 'Toutes les étapes de traçabilité sont documentées',
  'quality.no_blocking_issues': 'Absence d’anomalie bloquante sur le score qualité',
  'quality.no_open_issues': 'Absence d’anomalie qualité ouverte',
  'evidence.product_data': 'Documents sources disponibles pour les données produit',
};

export function classifyRequirementPillar(key: string): DppPillar {
  if (key.startsWith('product.')) return 'identification';
  if (key.startsWith('composition.') || key.startsWith('material.')) return 'composition';
  if (key.startsWith('traceability.') || key.startsWith('supply_chain.')) return 'traceability';
  return 'quality';
}

export const PILLAR_METADATA: Record<DppPillar, { name: string; description: string; icon: string }> = {
  identification: {
    name: 'Identification & Caractéristiques',
    description: 'Référence, libellé, description, catégorie et pays de confection.',
    icon: '🏷️',
  },
  composition: {
    name: 'Composition Matières',
    description: 'Pourcentages de composition totalisés ; cela ne constitue pas une certification.',
    icon: '🧵',
  },
  traceability: {
    name: 'Traçabilité de la chaîne',
    description: 'Structure du graphe et couverture documentaire des étapes déclarées.',
    icon: '☍',
  },
  quality: {
    name: 'Qualité & Preuves',
    description: 'Anomalies ouvertes et présence de documents sources ; ce score ne vaut pas validation tierce.',
    icon: '🛡️',
  },
};

export function buildDppSummary(
  record: {
    id?: string | null;
    product_id: string;
    product_version: number;
    requirement_profile_key?: string | null;
    requirement_profile_version?: string | null;
    readiness_status: string;
    missing_fields?: unknown;
    blocking_issues?: unknown;
    source_snapshot?: unknown;
    computed_at?: Date | string | null;
    reviewed_at?: Date | string | null;
    reviewed_by?: string | null;
    input_fingerprint?: string | null;
  } | null,
  fallbackProductId: string,
  productVersion = 1,
): DppRecordSummary {
  const missingList: Array<{ key: string; label: string; blocking: boolean }> = Array.isArray(record?.missing_fields)
    ? (record?.missing_fields as Array<{ key: string; label: string; blocking: boolean }>)
    : [];

  const blockingList: Array<{ key: string; label: string; reason: string }> = Array.isArray(record?.blocking_issues)
    ? (record?.blocking_issues as Array<{ key: string; label: string; reason: string }>)
    : [];

  // Parse source_snapshot requirement_results if available
  const snapshot = record?.source_snapshot as Record<string, unknown> | undefined;
  const snapshotResults = Array.isArray(snapshot?.requirement_results)
    ? (snapshot?.requirement_results as Array<{ key: string; met: boolean }>)
    : [];

  // Standard requirements list
  const standardKeys = [
    'product.reference',
    'product.name',
    'product.description',
    'product.category',
    'product.country_of_manufacture',
    'product.required_attributes',
    'composition.complete',
    'materials.origin_documented',
    'traceability.graph',
    'traceability.documented',
    'quality.no_open_issues',
    'evidence.product_data',
    'product.not_draft',
  ];

  const pillars: Record<DppPillar, DppPillarInfo> = {
    identification: {
      key: 'identification',
      ...PILLAR_METADATA.identification,
      score: 0,
      total: 0,
      met: 0,
      metPercent: 0,
      items: [],
    },
    composition: {
      key: 'composition',
      ...PILLAR_METADATA.composition,
      score: 0,
      total: 0,
      met: 0,
      metPercent: 0,
      items: [],
    },
    traceability: {
      key: 'traceability',
      ...PILLAR_METADATA.traceability,
      score: 0,
      total: 0,
      met: 0,
      metPercent: 0,
      items: [],
    },
    quality: {
      key: 'quality',
      ...PILLAR_METADATA.quality,
      score: 0,
      total: 0,
      met: 0,
      metPercent: 0,
      items: [],
    },
  };

  let totalReqCount = 0;
  let totalMetCount = 0;

  for (const key of standardKeys) {
    const pillarKey = classifyRequirementPillar(key);
    const label = DPP_REQUIREMENT_LABELS[key] || key;
    const isMissing = missingList.some((m) => m.key === key);
    const isBlocking = blockingList.some((b) => b.key === key)
      || missingList.some((m) => m.key === key && m.blocking);

    // Fail closed: a requirement absent from the persisted evaluation is not
    // silently considered met. This also prevents records calculated with an
    // older, narrower profile from becoming publication-ready.
    const snapshotMet = snapshotResults.find((r) => r.key === key)?.met;
    const met = snapshotMet === true && !isMissing;

    pillars[pillarKey].total += 1;
    totalReqCount += 1;
    if (met) {
      pillars[pillarKey].met += 1;
      totalMetCount += 1;
    }

    pillars[pillarKey].items.push({
      key,
      label,
      met,
      blocking: isBlocking,
    });
  }

  // Calculate pillar percentages
  for (const pillar of Object.values(pillars)) {
    pillar.metPercent = pillar.total > 0 ? Math.round((pillar.met / pillar.total) * 100) : 0;
    pillar.score = pillar.metPercent;
  }

  const completionScore = totalReqCount > 0 ? Math.round((totalMetCount / totalReqCount) * 100) : 0;
  const rawStatus = (record?.readiness_status || 'not_started') as DppReadinessStatus;
  const readinessStatus: DppReadinessStatus =
    rawStatus === 'data_ready' || rawStatus === 'ready_to_publish' || rawStatus === 'published' || rawStatus === 'review_required' || rawStatus === 'in_progress'
      ? rawStatus
      : 'not_started';

  return {
    id: record?.id || null,
    productId: record?.product_id || fallbackProductId,
    productVersion: record?.product_version || productVersion,
    profileKey: record?.requirement_profile_key || 'textile_readiness_mvp',
    profileVersion: record?.requirement_profile_version || '1.0',
    readinessStatus,
    statusLabel: DPP_STATUS_LABELS[readinessStatus] || 'Non démarré',
    completionScore,
    totalRequirements: totalReqCount,
    metRequirements: totalMetCount,
    blockingCount: blockingList.length,
    missingFields: missingList,
    blockingIssues: blockingList,
    pillars,
    canMarkReadyToPublish: readinessStatus === 'data_ready'
      && totalReqCount > 0
      && totalMetCount === totalReqCount
      && blockingList.length === 0
      && missingList.length === 0,
    isReadyToPublish: readinessStatus === 'ready_to_publish',
    computedAt: record?.computed_at ? new Date(record.computed_at).toISOString() : null,
    reviewedAt: record?.reviewed_at ? new Date(record.reviewed_at).toISOString() : null,
    reviewedBy: record?.reviewed_by || null,
    inputFingerprint: record?.input_fingerprint || null,
  };
}

export async function fetchLatestDppRecord(tx: Prisma.TransactionClient, productId: string) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    product_id: string;
    product_version: number;
    requirement_profile_key: string;
    requirement_profile_version: string;
    requirement_profile_id: string | null;
    readiness_status: string;
    missing_fields: unknown;
    blocking_issues: unknown;
    source_snapshot: unknown;
    computed_at: Date;
    computed_by: string | null;
    input_fingerprint: string | null;
    reviewed_at: Date | null;
    reviewed_by: string | null;
  }>>`
    SELECT
      id,
      product_id,
      product_version,
      requirement_profile_key,
      requirement_profile_version,
      requirement_profile_id,
      readiness_status::text,
      missing_fields,
      blocking_issues,
      source_snapshot,
      computed_at,
      computed_by,
      input_fingerprint,
      reviewed_at,
      reviewed_by
    FROM dpp_records
    WHERE product_id = ${productId}::uuid
    ORDER BY computed_at DESC
    LIMIT 1
  `;

  return rows[0] || null;
}
