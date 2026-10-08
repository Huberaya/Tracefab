/**
 * CHANTIER ADMIN 07 — chargeur partagé des métriques de campagne.
 *
 * UN SEUL CHARGEUR POUR TOUTES LES VUES. La liste des campagnes et le détail
 * d'une campagne doivent afficher les mêmes chiffres ; deux copies de cette
 * logique finiraient par diverger, et personne ne saurait laquelle croire.
 * C'est exactement le défaut qu'a évité le chantier 06.
 *
 * TROIS REQUÊTES, QUEL QUE SOIT LE NOMBRE DE CAMPAGNES. Aucun `findMany` par
 * campagne : une boucle produirait un N+1 qui rendrait la liste inutilisable
 * dès la vingtième campagne.
 *
 * Les métriques ne sont JAMAIS stockées. Un compteur enregistré divergerait dès
 * le premier lead supprimé.
 */
import { measureCampaign } from './crm-funnel.js';
import type { CampaignMetrics } from './crm-funnel.js';

export interface CampaignMetricRow {
  leads: number;
  byStatus: Record<string, number>;
  promoted: number;
  discarded: number;
  decided: number;
  customers: number;
  promotionRate: number | null;
  customerRate: number | null;
}

export interface FunnelTx {
  crm_leads: {
    groupBy: (args: unknown) => Promise<unknown>;
  };
  crm_companies: {
    groupBy: (args: unknown) => Promise<unknown>;
  };
}

interface StatusGroup { campaign_id: string | null; status: string; _count?: { _all?: number } }
interface PromotedGroup { campaign_id: string | null; _count?: { _all?: number } }
interface CustomerGroup { campaign_id: string | null; _count?: { _all?: number } }

const count = (g: { _count?: { _all?: number } }): number => {
  const n = g?._count?._all;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Mesure plusieurs campagnes en trois agrégations.
 *
 * `promoted` compte les leads portant réellement un `converted_company_id`,
 * jamais ceux dont le statut dit `converted`. Le statut est une déclaration ;
 * l'identifiant est un fait. Les deux peuvent diverger, et c'est le fait qui
 * gagne.
 */
export async function loadCampaignMetrics(
  tx: FunnelTx,
  platformOrganizationId: string,
  campaignIds: string[],
): Promise<Map<string, CampaignMetrics>> {
  const out = new Map<string, CampaignMetrics>();
  const ids = (Array.isArray(campaignIds) ? campaignIds : []).filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (!ids.length) return out;

  const [statusGroups, promotedGroups, customerGroups] = await Promise.all([
    tx.crm_leads.groupBy({
      by: ['campaign_id', 'status'],
      where: { platform_organization_id: platformOrganizationId, campaign_id: { in: ids } },
      _count: { _all: true },
    }) as Promise<StatusGroup[]>,
    tx.crm_leads.groupBy({
      by: ['campaign_id'],
      where: {
        platform_organization_id: platformOrganizationId,
        campaign_id: { in: ids },
        converted_company_id: { not: null },
      },
      _count: { _all: true },
    }) as Promise<PromotedGroup[]>,
    tx.crm_companies.groupBy({
      by: ['campaign_id'],
      where: {
        platform_organization_id: platformOrganizationId,
        campaign_id: { in: ids },
        stage: 'customer',
      },
      _count: { _all: true },
    }) as Promise<CustomerGroup[]>,
  ]);

  /* Les trois agrégats sont remontés dans la forme attendue par measureCampaign,
     qui reste la seule fonction à décider des taux. Ce chargeur ne calcule
     aucun pourcentage lui-même. */
  const byCampaign = new Map<string, { leads: { status: string; converted_company_id?: string }[]; customers: number }>();
  const ensure = (id: string) => {
    let e = byCampaign.get(id);
    if (!e) { e = { leads: [], customers: 0 }; byCampaign.set(id, e); }
    return e;
  };

  for (const g of Array.isArray(statusGroups) ? statusGroups : []) {
    if (!g?.campaign_id) continue;
    const n = count(g);
    const entry = ensure(g.campaign_id);
    for (let i = 0; i < n; i += 1) entry.leads.push({ status: g.status });
  }
  for (const g of Array.isArray(promotedGroups) ? promotedGroups : []) {
    if (!g?.campaign_id) continue;
    const n = count(g);
    const entry = ensure(g.campaign_id);
    /* Les `n` premiers leads sont marqués promus : seul leur nombre importe,
       puisque measureCampaign ne fait que les compter. */
    for (let i = 0; i < n && i < entry.leads.length; i += 1) {
      entry.leads[i].converted_company_id = 'measured';
    }
  }
  for (const g of Array.isArray(customerGroups) ? customerGroups : []) {
    if (!g?.campaign_id) continue;
    ensure(g.campaign_id).customers = count(g);
  }

  for (const id of ids) {
    const e = byCampaign.get(id) || { leads: [], customers: 0 };
    const m = measureCampaign(e.leads, Array.from({ length: e.customers }, () => ({ stage: 'customer' })));
    out.set(id, m);
  }
  return out;
}

/** Une campagne sans lead : des zéros, mais des taux `null` — pas 0 %. */
export function emptyCampaignMetrics(): CampaignMetrics {
  return measureCampaign([], []);
}
