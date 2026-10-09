/**
 * §10 HISTORY — l'historique commercial complet d'une entreprise.
 *
 * POURQUOI CE MODULE EXISTE
 *   L'onglet ACTIVITY montre `crm_activities`, le journal append-only. Or toutes
 *   les sources n'y écrivent pas :
 *     - un changement de stade  → journalisé (companies/[companyId]/stage.ts)
 *     - une réunion             → journalisée (meetings.ts)
 *     - une tâche               → PAS journalisée (tasks.ts n'écrit rien)
 *   Présenter la timeline comme « l'historique » ferait donc disparaître les
 *   tâches. §14 exige que la conversion conserve l'intégralité de l'historique
 *   commercial ; un onglet qui en omet une partie rendrait cette promesse fausse
 *   à l'écran alors même qu'elle est vraie en base.
 *
 *   HISTORY est donc l'UNION des sources, chaque ligne portant sa provenance.
 *   Ce n'est pas une vue décorative : c'est la preuve, visible, que rien n'est
 *   perdu.
 *
 * Module PUR — aucun import, aucune base. Testable isolément.
 */

export type HistorySource = 'activity' | 'task' | 'meeting';

export interface HistoryEntry {
  /** Identifiant stable : sert de clé de rendu ET de départage. */
  key: string;
  source: HistorySource;
  /** Date ISO utilisée pour le tri. Toujours présente. */
  at: string;
  title: string;
  detail: string | null;
  actor: string | null;
  /** Type d'activité, type de tâche, ou mode de réunion. */
  kind: string | null;
  /** Une tâche porte un statut propre ; les autres sources n'en ont pas. */
  status: string | null;
}

export interface CompanyHistory {
  entries: HistoryEntry[];
  /**
   * `true` si au moins une source a été tronquée côté serveur. L'interface doit
   * le dire : un historique affiché comme complet alors qu'il est coupé est un
   * mensonge silencieux.
   */
  truncated: boolean;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** Une date absente ou invalide ne doit pas faire disparaître la ligne. */
const dateOf = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length === 0) return null;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Première date utilisable, dans l'ordre de préférence. Une tâche accomplie est
 * datée de son accomplissement : c'est l'événement qui compte dans un historique,
 * pas son échéance théorique.
 */
const firstDate = (...candidates: unknown[]): string | null => {
  for (const c of candidates) {
    const d = dateOf(c);
    if (d) return d;
  }
  return null;
};

export function buildCompanyHistory(input: {
  activities?: unknown;
  tasks?: unknown;
  meetings?: unknown;
  activitiesTruncated?: boolean;
  tasksTruncated?: boolean;
  meetingsTruncated?: boolean;
}): CompanyHistory {
  const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
  const entries: HistoryEntry[] = [];

  for (const a of rows(input.activities)) {
    const at = dateOf(a.occurred_at) ?? dateOf(a.created_at);
    if (!at) continue;
    entries.push({
      key: `activity:${str(a.id) ?? at}`,
      source: 'activity',
      at,
      title: str(a.summary) ?? '',
      detail: str(a.detail),
      actor: str(a.actor_name),
      kind: str(a.type),
      status: null,
    });
  }

  for (const t of rows(input.tasks)) {
    const status = str(t.status);
    /* Une tâche `done` est un événement daté de son accomplissement. Une tâche
       ouverte ou annulée n'a pas encore d'événement : on la date de son
       échéance, à défaut de sa création — mais on ne l'invente pas. */
    const at = status === 'done'
      ? firstDate(t.completed_at, t.due_at, t.created_at)
      : firstDate(t.due_at, t.created_at);
    if (!at) continue;
    entries.push({
      key: `task:${str(t.id) ?? at}`,
      source: 'task',
      at,
      title: str(t.title) ?? '',
      detail: str(t.detail),
      actor: str(t.assignee_name),
      kind: str(t.type),
      status,
    });
  }

  for (const m of rows(input.meetings)) {
    const at = dateOf(m.starts_at) ?? dateOf(m.created_at);
    if (!at) continue;
    entries.push({
      key: `meeting:${str(m.id) ?? at}`,
      source: 'meeting',
      at,
      title: str(m.subject) ?? '',
      /* `outcome` et `notes` sont deux champs distincts en base : les
         concaténer ici perdrait la distinction entre ce qui a été décidé et ce
         qui a été remarqué. On sert les deux, l'interface les sépare. */
      detail: [str(m.outcome), str(m.notes)].filter(Boolean).join('\n') || null,
      actor: str(m.attendees),
      kind: str(m.mode),
      status: null,
    });
  }

  /*
   * Tri descendant, puis départage DÉTERMINISTE par clé.
   * Sans second critère, deux lignes à la même seconde sortent dans l'ordre du
   * moteur : l'interface saute d'un rendu à l'autre et un test devient aléatoire.
   */
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    entries,
    truncated: Boolean(
      input.activitiesTruncated || input.tasksTruncated || input.meetingsTruncated,
    ),
  };
}

/**
 * Répartition par source, pour l'en-tête de l'onglet.
 * Compter côté serveur évite que l'interface n'affiche un total qui ne
 * corresponde pas à ce qu'elle a reçu.
 */
export function historyCounts(history: CompanyHistory): Record<HistorySource, number> {
  const counts: Record<HistorySource, number> = { activity: 0, task: 0, meeting: 0 };
  for (const e of history.entries) counts[e.source] += 1;
  return counts;
}
