/**
 * Journal d'audit de la console Admin — Chantier Admin 04 (§16).
 *
 * Module pur : aucune requête, aucun client Prisma. Le vocabulaire des actions et
 * la construction des états avant/après sont décidés ici, et donc testés.
 *
 * Deux raisons de ne pas journaliser « tout l'objet » :
 *   - un `before_state` complet sur une entreprise de 3 000 produits gonfle la
 *     chaîne de hachage sans rien apporter à la relecture ;
 *   - un champ ajouté demain au modèle se retrouverait journalisé sans que
 *     personne l'ait décidé. Une liste blanche rend le journal prévisible.
 */

export const AUDIT_ENTITIES = [
  'crm_company', 'crm_contact', 'crm_task', 'crm_meeting', 'crm_pilot',
  'crm_saved_view', 'crm_import', 'crm_campaign', 'crm_lead',
] as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const AUDIT_ACTIONS = [
  'created', 'updated', 'deleted',
  'stage_changed', 'converted', 'lost',
  'task_completed', 'task_reopened',
  'meeting_scheduled', 'pilot_updated',
  'imported', 'list_saved', 'list_deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Champs journalisés, par entité. Tout le reste est ignoré. */
export const AUDIT_FIELDS: Record<AuditEntity, readonly string[]> = {
  crm_company: ['name', 'stage', 'priority', 'country_code', 'company_type', 'maturity',
    'product_count', 'supplier_count', 'estimated_value_eur', 'lost_reason',
    'converted_at', 'converted_value_eur', 'owner_name', 'dpp_interest', 'traceability_interest'],
  crm_contact: ['first_name', 'last_name', 'job_title', 'email', 'status',
    'is_decision_maker', 'influence_level', 'company_id'],
  crm_task: ['title', 'type', 'status', 'priority', 'due_at', 'assignee_name', 'company_id'],
  crm_meeting: ['subject', 'starts_at', 'ends_at', 'mode', 'company_id'],
  crm_pilot: ['status', 'starts_at', 'ends_at', 'supplier_count', 'product_count',
    'progress_pct', 'data_completeness_pct', 'evidence_coverage_pct', 'dpp_readiness_pct'],
  crm_saved_view: ['name'],
  crm_import: ['source', 'total', 'created', 'duplicate', 'invalid'],
  /*
   * Chantier Admin 07. Les compteurs d'une campagne n'y figurent pas : ils ne
   * sont pas stockés, donc il n'y a rien à comparer. Journaliser un nombre
   * calculé donnerait l'illusion d'un historique alors qu'il est rejouable.
   */
  crm_campaign: ['name', 'channel', 'status', 'objective', 'target_audience',
    'starts_at', 'ends_at', 'budget_eur', 'owner_name'],
  crm_lead: ['company_name', 'contact_name', 'email', 'status', 'campaign_id',
    'discard_reason', 'converted_company_id', 'country_code', 'sector'],
};

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

const normalize = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

/**
 * Diff compact entre deux états.
 *
 * Un champ absent de l'un et `null` dans l'autre n'est PAS un changement : c'est
 * la même absence exprimée deux fois. Le signaler noierait les vrais changements
 * dans du bruit, et un journal illisible est un journal que personne ne consulte.
 */
export function diffStates(
  entity: AuditEntity,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  const allowed = AUDIT_FIELDS[entity] || [];
  const changes: FieldChange[] = [];

  for (const field of allowed) {
    const from = normalize(before ? before[field] : null);
    const to = normalize(after ? after[field] : null);
    if (from === null && to === null) continue;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

/**
 * Paramètres prêts pour `appendImmutableAuditLog`.
 *
 * Le contexte d'organisation est toujours celui de la plateforme : la chaîne
 * d'audit de TRACEFAB est séparée de celle des marques et des fournisseurs, et
 * les politiques RLS d'`audit_logs` s'appuient sur cette colonne.
 */
export function buildAuditEntry(params: {
  admin: { platformOrganizationId: string; userId: string; fullName: string };
  entity: AuditEntity;
  action: AuditAction;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}) {
  const changes = diffStates(params.entity, params.before ?? null, params.after ?? null);
  return {
    organizationId: params.admin.platformOrganizationId,
    actorUserId: params.admin.userId,
    action: params.action,
    entityType: params.entity,
    entityId: params.entityId ?? null,
    beforeState: params.before ?? null,
    afterState: params.after ?? null,
    metadata: {
      actorName: params.admin.fullName,
      changedFields: changes.map((c) => c.field),
      changeCount: changes.length,
      ...(params.metadata || {}),
    },
  };
}

/** Filtres acceptés par GET /api/admin/audit — liste close, pas un `where` libre. */
export const AUDIT_FILTER_KEYS = ['action', 'entity_type', 'entity_id', 'since', 'actor'] as const;

export function sanitizeAuditFilters(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(AUDIT_FILTER_KEYS as readonly string[]).includes(key)) continue;
    /*
     * Une requête peut répéter un paramètre : `?action=a&action=b` arrive en
     * tableau. `String(['a','b'])` vaudrait `'a,b'` — une valeur non vide, donc
     * acceptée, qui n'est dans aucun vocabulaire et ne correspondrait à aucune
     * ligne. Le routeur valide `action` à part : sans ce garde, la valeur validée
     * et la valeur interrogée divergeraient sans que rien ne le signale.
     */
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (!text || text.length > 120) continue;
    out[key] = text;
  }
  return out;
}
