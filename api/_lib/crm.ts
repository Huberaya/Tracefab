/**
 * TRACEFAB COMMAND CENTER — logique CRM.
 *
 * Tout ce fichier est pur : aucune requête, aucun `process.env`. Les chiffres du
 * dashboard, la validation des saisies et les transitions du pipeline sont donc
 * exécutables et contre-vérifiables dans un test, sans base de données.
 *
 * Règle de fond : aucun chiffre n'est estimé ni inventé. `computeDashboard` ne
 * fait que compter les lignes qu'on lui donne.
 */

export const PIPELINE_STAGES = [
  'new',
  'qualified',
  'to_contact',
  'contacted',
  'replied',
  'meeting',
  'demo',
  'pilot',
  'customer',
] as const;

export const TERMINAL_STAGES = ['customer', 'lost'] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type CrmStage = PipelineStage | 'lost';

export const COMPANY_TYPES = [
  'fashion_brand',
  'textile_brand',
  'manufacturer',
  'textile_supplier',
  'mill',
  'dye_house',
  'garment_factory',
  'luxury_brand',
  'sportswear',
  'outdoor',
  'retailer',
  'marketplace',
  'other',
] as const;

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const MATURITIES = ['unknown', 'low', 'medium', 'high'] as const;
export const CONTACT_STATUSES = ['to_contact', 'contacted', 'replied', 'meeting', 'unresponsive', 'declined'] as const;
export const ACTIVITY_TYPES = [
  'created', 'status_change', 'note', 'email', 'call', 'meeting',
  'demo', 'proposal', 'pilot', 'conversion', 'lost',
] as const;

const oneOf = <T extends readonly string[]>(value: unknown, allowed: T): T[number] | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;

/**
 * Un compteur absent n'est pas un compteur à zéro. `null` signifie « non
 * renseigné » et l'interface l'affiche comme tel ; `0` est une déclaration.
 */
const optionalCount = (value: unknown, field: string, errors: string[]) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    errors.push(`${field}_must_be_a_non_negative_integer`);
    return null;
  }
  return parsed;
};

const optionalText = (value: unknown, max: number) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
};

const COUNTRY_RE = /^[A-Za-z]{2}$/;

/**
 * Lit un code pays SANS le tronquer.
 *
 * `optionalText(v, 2)` rendrait la validation inutile : « France » deviendrait
 * « Fr », qui est un code ISO valide. On lit la valeur entière, on la contrôle,
 * et on ne tronque que ce qui a déjà été accepté.
 */
const countryCodeInput = (value: unknown, errors: string[]) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!COUNTRY_RE.test(text)) {
    errors.push('country_code_must_be_iso_3166_alpha2');
    return null;
  }
  return text.toUpperCase();
};

export interface CompanyInput {
  name?: unknown;
  website?: unknown;
  country_code?: unknown;
  city?: unknown;
  industry?: unknown;
  company_type?: unknown;
  employee_band?: unknown;
  revenue_band?: unknown;
  product_count?: unknown;
  supplier_count?: unknown;
  maturity?: unknown;
  priority?: unknown;
  stage?: unknown;
  lost_reason?: unknown;
  source?: unknown;
  source_detail?: unknown;
  owner_name?: unknown;
  notes?: unknown;
  estimated_value_eur?: unknown;
  next_contact_at?: unknown;
}

/*
 * Forme plate volontaire. `npm run api:typecheck` ne passe ni --strict ni
 * --strictNullChecks, et sans strictNullChecks une union discriminante ne se
 * réduit pas : `if (!parsed.ok) parsed.errors` ne compile pas. On renvoie donc
 * toujours les deux champs et on teste `errors.length`.
 */
export interface ParseResult<T> {
  data: T | null;
  errors: string[];
}

/**
 * Valide une saisie d'entreprise.
 *
 * Le nom est obligatoire : sans lui la contrainte d'unicité
 * (organisation, nom) ne peut pas jouer son rôle anti-doublon. Le pays, s'il est
 * donné, doit être un code ISO à deux lettres — un pays en toutes lettres
 * rendrait les statistiques par pays inutilisables.
 */
export function parseCompanyInput(body: CompanyInput): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];
  const name = optionalText(body.name, 200);
  if (!name) errors.push('name_required');

  const countryCode = countryCodeInput(body.country_code, errors);

  const companyType = body.company_type === undefined ? null : oneOf(body.company_type, COMPANY_TYPES);
  if (body.company_type !== undefined && companyType === null) errors.push('company_type_unknown');

  const maturity = body.maturity === undefined ? null : oneOf(body.maturity, MATURITIES);
  if (body.maturity !== undefined && maturity === null) errors.push('maturity_unknown');

  const priority = body.priority === undefined ? null : oneOf(body.priority, PRIORITIES);
  if (body.priority !== undefined && priority === null) errors.push('priority_unknown');

  const stage = body.stage === undefined ? null : oneOf(body.stage, [...PIPELINE_STAGES, 'lost']);
  if (body.stage !== undefined && stage === null) errors.push('stage_unknown');

  const lostReason = optionalText(body.lost_reason, 500);
  if (stage === 'lost' && !lostReason) errors.push('lost_reason_required');

  const productCount = optionalCount(body.product_count, 'product_count', errors);
  const supplierCount = optionalCount(body.supplier_count, 'supplier_count', errors);
  const estimatedValue = optionalCount(body.estimated_value_eur, 'estimated_value_eur', errors);

  const nextContactAt = optionalText(body.next_contact_at, 40);
  if (nextContactAt && Number.isNaN(Date.parse(nextContactAt))) errors.push('next_contact_at_must_be_a_date');

  const website = optionalText(body.website, 300);

  if (errors.length) return { data: null, errors };

  const data: Record<string, unknown> = { name };
  const assign = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) data[key] = value;
  };
  assign('website', website);
  assign('country_code', countryCode);
  assign('city', optionalText(body.city, 120));
  assign('industry', optionalText(body.industry, 160));
  assign('company_type', companyType);
  assign('employee_band', optionalText(body.employee_band, 60));
  assign('revenue_band', optionalText(body.revenue_band, 60));
  assign('product_count', productCount);
  assign('supplier_count', supplierCount);
  assign('maturity', maturity);
  assign('priority', priority);
  assign('stage', stage);
  assign('lost_reason', lostReason);
  assign('source', optionalText(body.source, 120));
  assign('source_detail', optionalText(body.source_detail, 300));
  assign('owner_name', optionalText(body.owner_name, 120));
  assign('notes', optionalText(body.notes, 4000));
  assign('estimated_value_eur', estimatedValue);
  assign('next_contact_at', nextContactAt ? new Date(nextContactAt).toISOString() : null);

  return { data, errors: [] };
}

export function parseContactInput(body: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];

  const firstName = optionalText(body.first_name, 120);
  const lastName = optionalText(body.last_name, 120);
  if (!firstName && !lastName) errors.push('first_name_or_last_name_required');

  const email = optionalText(body.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email_invalid');

  const countryCode = countryCodeInput(body.country_code, errors);

  const status = body.status === undefined ? null : oneOf(body.status, CONTACT_STATUSES);
  if (body.status !== undefined && status === null) errors.push('status_unknown');

  const influence = body.influence_level === undefined || body.influence_level === null || body.influence_level === ''
    ? null
    : Number(body.influence_level);
  if (influence !== null && (!Number.isInteger(influence) || influence < 0 || influence > 5)) {
    errors.push('influence_level_must_be_between_0_and_5');
  }

  const linkedin = optionalText(body.linkedin_url, 300);
  if (linkedin && !/^https?:\/\//.test(linkedin)) errors.push('linkedin_url_must_be_http');

  if (errors.length) return { data: null, errors };

  const data: Record<string, unknown> = {};
  const assign = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) data[key] = value;
  };
  assign('first_name', firstName);
  assign('last_name', lastName);
  assign('job_title', optionalText(body.job_title, 160));
  assign('email', email?.toLowerCase() ?? null);
  assign('phone', optionalText(body.phone, 40));
  assign('linkedin_url', linkedin);
  assign('country_code', countryCode);
  assign('language', optionalText(body.language, 8));
  assign('is_decision_maker', body.is_decision_maker === true || body.is_decision_maker === 'true');
  assign('influence_level', influence);
  assign('status', status);
  assign('notes', optionalText(body.notes, 4000));
  assign('next_action', optionalText(body.next_action, 300));

  return { data, errors: [] };
}

/* -------------------------------------------------------------------------- *
 * Pipeline
 * -------------------------------------------------------------------------- */

/**
 * Ensembles qui définissent chaque compteur du tableau de bord.
 *
 * Chaque étape du funnel compte aussi toutes celles qui la suivent : une
 * entreprise en `demo` a nécessairement été contactée. C'est ce qui rend les
 * chiffres cohérents entre eux, et c'est vérifiable sans base.
 */
const AT_LEAST: Record<string, readonly CrmStage[]> = {
  contacted: ['contacted', 'replied', 'meeting', 'demo', 'pilot', 'customer'],
  replied: ['replied', 'meeting', 'demo', 'pilot', 'customer'],
  meeting: ['meeting', 'demo', 'pilot', 'customer'],
  demo: ['demo', 'pilot', 'customer'],
  pilot: ['pilot', 'customer'],
};

export interface DashboardRow {
  stage: CrmStage;
  estimated_value_eur?: number | null;
  next_contact_at?: string | Date | null;
}

export interface DashboardTotals {
  totalProspects: number;
  newProspects: number;
  toContact: number;
  contacted: number;
  replies: number;
  meetings: number;
  demos: number;
  pilots: number;
  customers: number;
  lost: number;
  estimatedValueEur: number;
  conversionRate: number | null;
  dueToday: number;
  byStage: Record<string, number>;
  byCountry: Record<string, number>;
  byCompanyType: Record<string, number>;
}

const startOfDay = (reference: Date) =>
  new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();

/**
 * Calcule les indicateurs du tableau de bord à partir de lignes réelles.
 *
 * Aucun chiffre n'est extrapolé : une case vide reste vide. `conversionRate`
 * vaut `null` quand aucune opportunité n'est encore tranchée — afficher 0 %
 * laisserait croire à une mesure alors qu'il n'y a rien à mesurer.
 */
export function computeDashboard(
  rows: (DashboardRow & { country_code?: string | null; company_type?: string | null })[],
  now: Date = new Date(),
): DashboardTotals {
  const byStage: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  const byCompanyType: Record<string, number> = {};

  let newProspects = 0;
  let toContact = 0;
  let customers = 0;
  let lost = 0;
  let estimatedValueEur = 0;
  let dueToday = 0;

  const today = startOfDay(now);

  for (const row of rows) {
    byStage[row.stage] = (byStage[row.stage] || 0) + 1;

    const country = row.country_code || 'unknown';
    byCountry[country] = (byCountry[country] || 0) + 1;

    const type = row.company_type || 'other';
    byCompanyType[type] = (byCompanyType[type] || 0) + 1;

    if (row.stage === 'new') newProspects += 1;
    if (row.stage === 'qualified' || row.stage === 'to_contact') toContact += 1;
    if (row.stage === 'customer') customers += 1;
    if (row.stage === 'lost') lost += 1;
    if (typeof row.estimated_value_eur === 'number' && Number.isFinite(row.estimated_value_eur)) {
      estimatedValueEur += row.estimated_value_eur;
    }

    if (row.next_contact_at) {
      const when = new Date(row.next_contact_at);
      if (!Number.isNaN(when.getTime()) && startOfDay(when) <= today && row.stage !== 'customer' && row.stage !== 'lost') {
        dueToday += 1;
      }
    }
  }

  const decided = customers + lost;

  return {
    totalProspects: rows.length,
    newProspects,
    toContact,
    contacted: countAtLeast(rows, 'contacted'),
    replies: countAtLeast(rows, 'replied'),
    meetings: countAtLeast(rows, 'meeting'),
    demos: countAtLeast(rows, 'demo'),
    pilots: countAtLeast(rows, 'pilot'),
    customers,
    lost,
    estimatedValueEur,
    conversionRate: decided === 0 ? null : Math.round((customers / decided) * 1000) / 10,
    dueToday,
    byStage,
    byCountry,
    byCompanyType,
  };
}

function countAtLeast(rows: DashboardRow[], key: keyof typeof AT_LEAST) {
  const allowed = AT_LEAST[key] as readonly string[];
  return rows.reduce((total, row) => (allowed.includes(row.stage) ? total + 1 : total), 0);
}

/**
 * Transitions autorisées.
 *
 * Une régression est permise — un commercial doit pouvoir revenir en arrière
 * quand un rendez-vous tombe à l'eau. Ce qui ne l'est pas : sortir d'un état
 * terminal sans raison. Perdre un prospect exige `lost_reason` (contrainte en
 * base également), et un client gagné ne redevient pas `new` silencieusement.
 */
export function canTransition(from: CrmStage, to: CrmStage, hasLostReason: boolean) {
  if (from === to) return { ok: true, activity: null as null | 'status_change' };
  if (to === 'lost') {
    return hasLostReason
      ? { ok: true, activity: 'lost' as const }
      : { ok: false, error: 'lost_reason_required' };
  }
  if (from === 'lost' && to !== 'customer') {
    return { ok: true, activity: 'status_change' as const };
  }
  return { ok: true, activity: to === 'customer' ? ('conversion' as const) : ('status_change' as const) };
}

export function stageRank(stage: CrmStage) {
  if (stage === 'lost') return -1;
  return PIPELINE_STAGES.indexOf(stage as PipelineStage);
}

/* ========================================================================== *
 * Chantier Admin 02 — tâches, rendez-vous, pilotes, conversion, analytics.
 * Toujours pur : aucune requête, aucun process.env.
 * ========================================================================== */

export const TASK_TYPES = [
  'call', 'email', 'follow_up', 'book_demo', 'prepare_demo',
  'send_proposal', 'follow_pilot', 'other',
] as const;

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const MEETING_MODES = ['onsite', 'video', 'call'] as const;
export const PILOT_STATUSES = ['planned', 'active', 'completed', 'abandoned'] as const;

const DAY_MS = 86400000;

const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Classe une tâche dans le seul seau qui compte pour une journée commerciale.
 *
 * `overdue` prime sur `today` : une tâche en retard dont l'échéance est
 * aujourd'hui est en retard, pas « du jour ». Un commercial qui verrait la
 * seconde étiquette croirait être à l'heure.
 */
export function taskBucket(
  task: { status: string; due_at?: string | Date | null },
  now: Date = new Date(),
): 'overdue' | 'today' | 'upcoming' | 'undated' | 'closed' {
  if (task.status !== 'open') return 'closed';
  if (!task.due_at) return 'undated';
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return 'undated';
  const today = startOf(now);
  const dueDay = startOf(due);
  if (dueDay < today) return 'overdue';
  if (dueDay === today) return 'today';
  return 'upcoming';
}

export interface TaskRow {
  status: string;
  due_at?: string | Date | null;
  priority?: string;
}

/** Vue TODAY : ce qu'il faut faire, ce qui est en retard, ce qui est fait. */
export function computeToday(tasks: TaskRow[], now: Date = new Date()) {
  const buckets = { overdue: 0, today: 0, upcoming: 0, undated: 0, closed: 0 };
  for (const task of tasks) buckets[taskBucket(task, now)] += 1;
  return {
    ...buckets,
    open: buckets.overdue + buckets.today + buckets.upcoming + buckets.undated,
    actionable: buckets.overdue + buckets.today,
    total: tasks.length,
  };
}

export function parseTaskInput(body: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];
  const title = optionalText(body.title, 200);
  if (!title) errors.push('title_required');

  const type = body.type === undefined ? null : oneOf(body.type, TASK_TYPES);
  if (body.type !== undefined && type === null) errors.push('task_type_unknown');

  const status = body.status === undefined ? null : oneOf(body.status, TASK_STATUSES);
  if (body.status !== undefined && status === null) errors.push('task_status_unknown');

  const priority = body.priority === undefined ? null : oneOf(body.priority, PRIORITIES);
  if (body.priority !== undefined && priority === null) errors.push('priority_unknown');

  const dueAt = optionalText(body.due_at, 40);
  if (dueAt && Number.isNaN(Date.parse(dueAt))) errors.push('due_at_must_be_a_date');

  if (errors.length) return { data: null, errors };

  const data: Record<string, unknown> = { title };
  const assign = (k: string, v: unknown) => { if (v !== null && v !== undefined) data[k] = v; };
  assign('type', type);
  assign('status', status);
  assign('priority', priority);
  assign('detail', optionalText(body.detail, 2000));
  assign('assignee_name', optionalText(body.assignee_name, 120));
  assign('company_id', optionalText(body.company_id, 64));
  assign('contact_id', optionalText(body.contact_id, 64));
  assign('due_at', dueAt ? new Date(dueAt).toISOString() : null);
  return { data, errors: [] };
}

export function parseMeetingInput(body: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];
  const subject = optionalText(body.subject, 200);
  if (!subject) errors.push('subject_required');

  const startsAt = optionalText(body.starts_at, 40);
  if (!startsAt) errors.push('starts_at_required');
  else if (Number.isNaN(Date.parse(startsAt))) errors.push('starts_at_must_be_a_date');

  const endsAt = optionalText(body.ends_at, 40);
  if (endsAt && Number.isNaN(Date.parse(endsAt))) errors.push('ends_at_must_be_a_date');
  if (startsAt && endsAt
    && !Number.isNaN(Date.parse(startsAt)) && !Number.isNaN(Date.parse(endsAt))
    && Date.parse(endsAt) <= Date.parse(startsAt)) {
    errors.push('ends_at_must_be_after_starts_at');
  }

  const mode = body.mode === undefined ? null : oneOf(body.mode, MEETING_MODES);
  if (body.mode !== undefined && mode === null) errors.push('meeting_mode_unknown');

  if (errors.length) return { data: null, errors };

  const data: Record<string, unknown> = {
    subject,
    starts_at: new Date(startsAt as string).toISOString(),
  };
  const assign = (k: string, v: unknown) => { if (v !== null && v !== undefined) data[k] = v; };
  assign('ends_at', endsAt ? new Date(endsAt).toISOString() : null);
  assign('mode', mode);
  assign('location', optionalText(body.location, 200));
  assign('attendees', optionalText(body.attendees, 500));
  assign('outcome', optionalText(body.outcome, 2000));
  assign('notes', optionalText(body.notes, 4000));
  assign('company_id', optionalText(body.company_id, 64));
  assign('contact_id', optionalText(body.contact_id, 64));
  return { data, errors: [] };
}

const optionalPercent = (value: unknown, field: string, errors: string[]) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    errors.push(`${field}_must_be_between_0_and_100`);
    return null;
  }
  return parsed;
};

export function parsePilotInput(body: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];

  const status = body.status === undefined ? null : oneOf(body.status, PILOT_STATUSES);
  if (body.status !== undefined && status === null) errors.push('pilot_status_unknown');

  const startsAt = optionalText(body.starts_at, 40);
  if (startsAt && Number.isNaN(Date.parse(startsAt))) errors.push('starts_at_must_be_a_date');
  const endsAt = optionalText(body.ends_at, 40);
  if (endsAt && Number.isNaN(Date.parse(endsAt))) errors.push('ends_at_must_be_a_date');
  if (startsAt && endsAt
    && !Number.isNaN(Date.parse(startsAt)) && !Number.isNaN(Date.parse(endsAt))
    && Date.parse(endsAt) <= Date.parse(startsAt)) {
    errors.push('ends_at_must_be_after_starts_at');
  }

  const supplierCount = optionalCount(body.supplier_count, 'supplier_count', errors);
  const productCount = optionalCount(body.product_count, 'product_count', errors);
  const potential = optionalCount(body.commercial_potential_eur, 'commercial_potential_eur', errors);

  const data: Record<string, unknown> = {};
  const assign = (k: string, v: unknown) => { if (v !== null && v !== undefined) data[k] = v; };
  assign('status', status);
  assign('starts_at', startsAt ? new Date(startsAt).toISOString() : null);
  assign('ends_at', endsAt ? new Date(endsAt).toISOString() : null);
  assign('supplier_count', supplierCount);
  assign('product_count', productCount);
  assign('commercial_potential_eur', potential);
  assign('progress_pct', optionalPercent(body.progress_pct, 'progress_pct', errors));
  assign('data_completeness_pct', optionalPercent(body.data_completeness_pct, 'data_completeness_pct', errors));
  assign('evidence_coverage_pct', optionalPercent(body.evidence_coverage_pct, 'evidence_coverage_pct', errors));
  assign('dpp_readiness_pct', optionalPercent(body.dpp_readiness_pct, 'dpp_readiness_pct', errors));
  assign('objectives', optionalText(body.objectives, 2000));
  assign('issues', optionalText(body.issues, 4000));
  assign('results', optionalText(body.results, 4000));
  assign('company_id', optionalText(body.company_id, 64));
  assign('organization_id', optionalText(body.organization_id, 64));

  if (errors.length) return { data: null, errors };
  return { data, errors: [] };
}

/* -------------------------------------------------------------------------- *
 * Conversion prospect → client
 * -------------------------------------------------------------------------- */

/**
 * Garde-fou de conversion.
 *
 * La conversion ne déplace rien : la ligne entreprise reste, ses contacts,
 * activités, tâches et rendez-vous restent attachés par company_id. Rien n'est
 * perdu parce que rien n'est déplacé — et c'est vérifié par un test, pas affirmé.
 */
export function canConvert(company: { stage: string; converted_at?: string | Date | null }) {
  if (company.stage === 'customer') {
    return { ok: false, error: 'already_a_customer' };
  }
  return { ok: true, convertedAt: company.converted_at ? new Date(company.converted_at).toISOString() : null };
}

/** Durée en jours entre la création et la conversion. */
export function daysToConvert(row: { created_at?: string | Date | null; converted_at?: string | Date | null }) {
  if (!row.created_at || !row.converted_at) return null;
  const a = new Date(row.created_at).getTime();
  const b = new Date(row.converted_at).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round(((b - a) / DAY_MS) * 10) / 10;
}

export interface AnalyticsRow {
  stage: string;
  country_code?: string | null;
  company_type?: string | null;
  industry?: string | null;
  source?: string | null;
  created_at?: string | Date | null;
  converted_at?: string | Date | null;
}

/**
 * Statistiques commerciales.
 *
 * Aucune moyenne n'est produite sur un échantillon vide : `avgDaysToConvert` vaut
 * `null`, pas 0. Un « 0 jour » laisserait croire à une conversion instantanée
 * mesurée alors qu'il n'y a rien à mesurer.
 */
export function computeAnalytics(rows: AnalyticsRow[]) {
  const byCountry: Record<string, { total: number; customers: number; lost: number }> = {};
  const bySource: Record<string, { total: number; customers: number; lost: number }> = {};
  const byStage: Record<string, number> = {};
  const durations: number[] = [];

  let customers = 0;
  let lost = 0;

  for (const row of rows) {
    byStage[row.stage] = (byStage[row.stage] || 0) + 1;

    const country = row.country_code || 'unknown';
    byCountry[country] = byCountry[country] || { total: 0, customers: 0, lost: 0 };
    byCountry[country].total += 1;

    const source = row.source || 'unknown';
    bySource[source] = bySource[source] || { total: 0, customers: 0, lost: 0 };
    bySource[source].total += 1;

    if (row.stage === 'customer') {
      customers += 1;
      byCountry[country].customers += 1;
      bySource[source].customers += 1;
      const d = daysToConvert(row);
      if (d !== null) durations.push(d);
    }
    if (row.stage === 'lost') {
      lost += 1;
      byCountry[country].lost += 1;
      bySource[source].lost += 1;
    }
  }

  const rate = (c: number, l: number) => (c + l === 0 ? null : Math.round((c / (c + l)) * 1000) / 10);

  const withRates = (map: Record<string, { total: number; customers: number; lost: number }>) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, {
      ...v,
      conversionRate: rate(v.customers, v.lost),
    }]));

  return {
    total: rows.length,
    customers,
    lost,
    byStage,
    byCountry: withRates(byCountry),
    bySource: withRates(bySource),
    avgDaysToConvert: durations.length
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null,
    conversionsMeasured: durations.length,
  };
}
