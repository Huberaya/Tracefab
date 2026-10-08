import type { Prisma } from '@prisma/client';
import { buildConnectedView, summarizeConnected } from './crm-link.js';
import type { ConnectedSummary, ConnectedView, SupplierMetrics } from './crm-link.js';

/**
 * Chargement des entreprises connectées — Chantier Admin 06.
 *
 * Partagé par /api/admin/suppliers et /api/admin/product-usage parce que les deux
 * lisent exactement les mêmes faits. Deux copies de cette logique divergeraient,
 * et deux vues qui affichent des chiffres différents pour la même entreprise
 * détruiraient la confiance dans les deux.
 *
 * Trois requêtes, quel que soit le nombre d'entreprises : les entreprises, la
 * sonde de visibilité des organisations, puis les fournisseurs des organisations
 * visibles. Un `findFirst` par entreprise serait un N+1.
 */

/** Statuts qui signifient « réellement embarqué », pas « invité ». */
export const ONBOARDED_STATUSES = ['submitted', 'approved'];

export async function loadConnectedCompanies(
  tx: Prisma.TransactionClient,
  platformOrganizationId: string,
): Promise<{ views: ConnectedView[]; summary: ConnectedSummary }> {
  const companies = (await tx.crm_companies.findMany({
    where: { platform_organization_id: platformOrganizationId },
    select: {
      id: true, name: true, stage: true, priority: true,
      organization_id: true, supplier_count: true, product_count: true,
    },
    orderBy: { name: 'asc' },
  })) as unknown as {
    id: string; name: string; stage: string; priority: string;
    organization_id: string | null; supplier_count: number | null; product_count: number | null;
  }[];

  const linkedIds = [...new Set(
    companies.map((c) => c.organization_id).filter((v): v is string => typeof v === 'string' && v.length > 0),
  )];

  /*
   * LA SONDE.
   *
   * Une requête fournisseurs vide est ambiguë : elle peut signifier « cette
   * organisation n'a aucun fournisseur » ou « RLS a tout filtré ». Interroger
   * `organizations` lève l'ambiguïté, parce que organizations_select_member exige
   * d'être membre : si la ligne revient, les chiffres qui suivent sont réels —
   * y compris un zéro réel.
   */
  const visibleOrgs = linkedIds.length
    ? ((await tx.organizations.findMany({
      where: { id: { in: linkedIds } },
      select: { id: true },
    })) as unknown as { id: string }[]).map((o) => o.id)
    : [];
  const visible = new Set(visibleOrgs);

  const grouped = visibleOrgs.length
    ? ((await tx.suppliers.groupBy({
      by: ['organization_id'],
      where: { organization_id: { in: visibleOrgs } },
      _count: { _all: true },
      _avg: { profile_completion: true },
      _max: { last_submitted_at: true },
    })) as unknown as {
      organization_id: string;
      _count: { _all: number };
      _avg: { profile_completion: unknown };
      _max: { last_submitted_at: unknown };
    }[])
    : [];

  const onboarded = visibleOrgs.length
    ? ((await tx.suppliers.groupBy({
      by: ['organization_id'],
      where: {
        organization_id: { in: visibleOrgs },
        onboarding_status: { in: ONBOARDED_STATUSES as unknown as string[] },
      },
      _count: { _all: true },
    })) as unknown as { organization_id: string; _count: { _all: number } }[])
    : [];

  const metricsByOrg = new Map<string, SupplierMetrics>();
  for (const row of grouped) {
    const onboardedRow = onboarded.find((o) => o.organization_id === row.organization_id);
    const rawAvg = row._avg?.profile_completion;
    const parsedAvg = rawAvg === null || rawAvg === undefined ? null : Number(rawAvg);
    const rawMax = row._max?.last_submitted_at;
    metricsByOrg.set(row.organization_id, {
      suppliers: row._count?._all ?? 0,
      onboarded: onboardedRow?._count?._all ?? 0,
      avgProfileCompletion:
        parsedAvg !== null && Number.isFinite(parsedAvg)
          ? Math.round(parsedAvg * 10) / 10
          : null,
      lastSubmittedAt:
        rawMax instanceof Date ? rawMax.toISOString()
          : typeof rawMax === 'string' ? rawMax : null,
    });
  }

  const views = companies.map((c) => buildConnectedView({
    company: {
      id: c.id, name: c.name, stage: c.stage, priority: c.priority,
      organization_id: c.organization_id,
      supplier_count: c.supplier_count, product_count: c.product_count,
    },
    orgVisible: Boolean(c.organization_id && visible.has(c.organization_id)),
    metrics: c.organization_id ? metricsByOrg.get(c.organization_id) ?? null : null,
  }));

  return { views, summary: summarizeConnected(views) };
}
