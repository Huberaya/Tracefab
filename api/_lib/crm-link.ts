/**
 * Connexion prospect ↔ organisation réelle — Chantier Admin 06 (§1 Suppliers, §1 Product Usage).
 *
 * Module pur. Les requêtes (et donc RLS) restent dans les routes ; la DÉCISION —
 * ce que l'on a le droit d'afficher — est ici, donc testable.
 *
 * La règle qui traverse tout le module :
 *
 *   UN CHIFFRE MESURÉ NE S'AFFICHE QUE SI LA PLATEFORME L'A RÉELLEMENT RETOURNÉ.
 *
 * `suppliers_select_authorized` exige `tracefab_can_access_org()`, c'est-à-dire
 * d'ÊTRE MEMBRE de l'organisation. Un admin plateforme qui n'est pas membre d'un
 * client ne voit donc pas ses fournisseurs — et c'est voulu. L'interface doit le
 * dire, pas afficher zéro : zéro est une mesure, et une mesure inventée est pire
 * qu'un vide.
 */

export type Measurement = 'measured' | 'declared' | 'not_accessible';

/**
 * Trois états, et pas deux.
 *
 * Confondre `not_accessible` avec `declared` ferait passer une impossibilité de
 * voir pour une absence de donnée. Confondre `not_accessible` avec un zéro
 * mesuré afficherait un fait faux. Les trois sont donc distincts.
 */
export interface SupplierMetrics {
  suppliers: number;
  onboarded: number;
  /** Moyenne sur les fournisseurs ayant un taux renseigné ; null si aucun. */
  avgProfileCompletion: number | null;
  lastSubmittedAt: string | null;
}

export interface CompanyFacts {
  id: string;
  name: string;
  stage: string;
  priority: string;
  organization_id: string | null;
  supplier_count: number | null;
  product_count: number | null;
}

export interface ConnectedView {
  company_id: string;
  name: string;
  stage: string;
  priority: string;
  organization_id: string | null;
  measurement: Measurement;
  /** Ce que l'équipe a saisi. Toujours présent : c'est sa propre note. */
  declared: { supplier_count: number | null; product_count: number | null };
  /** Ce que la plateforme a réellement retourné. null sauf si `measured`. */
  measured: SupplierMetrics | null;
  /**
   * Écart entre déclaré et mesuré, quand les deux existent.
   *
   * C'est la seule information réellement nouvelle de cette vue : elle montre où
   * la perception commerciale et la réalité de la plateforme divergent. null dès
   * qu'un des deux manque — un écart calculé sur une absence serait inventé.
   */
  gap: number | null;
}

const num = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * @param orgVisible  la sonde `organizations` a-t-elle retourné une ligne ?
 *                    C'est la seule façon honnête de distinguer « RLS a bloqué »
 *                    de « cette organisation n'a vraiment aucun fournisseur ».
 * @param metrics     ce que la requête fournisseurs a retourné, ou null.
 */
export function buildConnectedView(params: {
  company: CompanyFacts;
  orgVisible: boolean;
  metrics: SupplierMetrics | null;
}): ConnectedView {
  const c = params.company;
  const declared = {
    supplier_count: num(c.supplier_count),
    product_count: num(c.product_count),
  };

  /* Pas de lien : rien à mesurer. Ce n'est pas une anomalie, c'est l'état normal
     d'un prospect qui n'est pas encore client. */
  if (!c.organization_id) {
    return {
      company_id: c.id, name: c.name, stage: c.stage, priority: c.priority,
      organization_id: null,
      measurement: 'declared',
      declared,
      measured: null,
      gap: null,
    };
  }

  /* Lien présent mais organisation invisible : RLS a refusé. On n'affiche AUCUN
     chiffre mesuré, pas même zéro. */
  if (!params.orgVisible || !params.metrics) {
    return {
      company_id: c.id, name: c.name, stage: c.stage, priority: c.priority,
      organization_id: c.organization_id,
      measurement: 'not_accessible',
      declared,
      measured: null,
      gap: null,
    };
  }

  const m = params.metrics;
  const measured: SupplierMetrics = {
    suppliers: Math.max(0, Math.trunc(num(m.suppliers) ?? 0)),
    onboarded: Math.max(0, Math.trunc(num(m.onboarded) ?? 0)),
    avgProfileCompletion: num(m.avgProfileCompletion),
    lastSubmittedAt: typeof m.lastSubmittedAt === 'string' ? m.lastSubmittedAt : null,
  };

  /* L'écart n'a de sens que si les deux nombres existent. */
  const gap = declared.supplier_count === null
    ? null
    : measured.suppliers - declared.supplier_count;

  return {
    company_id: c.id, name: c.name, stage: c.stage, priority: c.priority,
    organization_id: c.organization_id,
    measurement: 'measured',
    declared,
    measured,
    gap,
  };
}

/**
 * Un identifiant d'organisation proposé au lien.
 *
 * Validation de forme uniquement. L'existence est vérifiée par la route, qui
 * refuse un identifiant inconnu : sans clé étrangère (voir la migration), c'est
 * la seule protection contre un lien qui pointerait dans le vide.
 */
export function parseOrganizationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  /* UUID v1–v5. Un contrôle plus lâche laisserait passer n'importe quelle chaîne. */
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

/**
 * Agrégat d'une liste de vues connectées.
 *
 * Les trois populations sont comptées séparément : une moyenne qui mélangerait
 * des chiffres mesurés et des zéros de substitution serait fausse, et personne ne
 * pourrait le voir.
 */
export interface ConnectedSummary {
  measured: number;
  declared: number;
  notAccessible: number;
  /** Somme des fournisseurs réellement vus. Nulle si rien n'est mesuré. */
  measuredSuppliers: number;
  /** Moyenne du taux de profil sur les organisations mesurées ayant un taux. */
  avgProfileCompletion: number | null;
  lastSubmittedAt: string | null;
}

export function summarizeConnected(views: ConnectedView[]): ConnectedSummary {
  const list = Array.isArray(views) ? views : [];
  const measured = list.filter((v) => v.measurement === 'measured');
  const withRate = measured.filter((v) => v.measured?.avgProfileCompletion !== null && v.measured?.avgProfileCompletion !== undefined);

  const dates = measured
    .map((v) => v.measured?.lastSubmittedAt)
    .filter((d): d is string => typeof d === 'string')
    .sort();

  return {
    measured: measured.length,
    declared: list.filter((v) => v.measurement === 'declared').length,
    notAccessible: list.filter((v) => v.measurement === 'not_accessible').length,
    measuredSuppliers: measured.reduce((sum, v) => sum + (v.measured?.suppliers ?? 0), 0),
    avgProfileCompletion: withRate.length
      ? Math.round((withRate.reduce((s, v) => s + (v.measured?.avgProfileCompletion as number), 0)
        / withRate.length) * 10) / 10
      : null,
    lastSubmittedAt: dates.length ? dates[dates.length - 1] : null,
  };
}
