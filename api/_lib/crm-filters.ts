import { COMPANY_TYPES, MATURITIES, PIPELINE_STAGES, PRIORITIES } from './crm.js';
import { INTEREST_LEVELS } from './crm-import.js';

/**
 * Filtres de prospection (§9) — Chantier Admin 03.
 *
 * Module pur, sans import Prisma : il transforme un objet de requête en clause
 * `where`, et rien d'autre.
 *
 * Il existe pour une raison précise : la liste à l'écran et son export CSV
 * doivent filtrer **exactement** de la même façon. Deux implémentations
 * séparées finiraient par diverger, et un export qui ne correspond pas à ce qui
 * est affiché est pire qu'une absence d'export — il a l'air fiable.
 */

export interface FilterSource {
  [key: string]: string | string[] | undefined;
}

/*
 * Forme plate, pas d'union discriminée : `tsconfig.api.json` ne passe ni
 * `--strict` ni `--strictNullChecks`, donc `{ok:true;where}|{ok:false;error}` ne
 * se réduit pas et `outcome.error` est TS2339.
 */
export interface FilterOutcome {
  where: Record<string, unknown>;
  error: string | null;
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const positiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Construit la clause `where`. `platformOrganizationId` est toujours posé en
 * premier : un filtre ne peut pas élargir la portée au-delà de l'organisation.
 */
export function buildCompanyFilters(
  query: FilterSource,
  platformOrganizationId: string,
  now: Date = new Date(),
): FilterOutcome {
  const where: Record<string, unknown> = { platform_organization_id: platformOrganizationId };

  const stage = one(query.stage);
  if (typeof stage === 'string' && stage) {
    if (![...PIPELINE_STAGES, 'lost'].includes(stage)) return { where: {}, error: 'stage_unknown' };
    where.stage = stage;
  }

  const priority = one(query.priority);
  if (typeof priority === 'string' && priority) {
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
      return { where: {}, error: 'priority_unknown' };
    }
    where.priority = priority;
  }

  const companyType = one(query.company_type);
  if (typeof companyType === 'string' && companyType) {
    if (!COMPANY_TYPES.includes(companyType as (typeof COMPANY_TYPES)[number])) {
      return { where: {}, error: 'company_type_unknown' };
    }
    where.company_type = companyType;
  }

  const maturity = one(query.maturity);
  if (typeof maturity === 'string' && maturity) {
    if (!MATURITIES.includes(maturity as (typeof MATURITIES)[number])) {
      return { where: {}, error: 'maturity_unknown' };
    }
    where.maturity = maturity;
  }

  /* §9 : intérêt DPP et intérêt traçabilité. `unknown` est un filtre légitime —
     c'est précisément « les non qualifiés », le travail qui reste à faire. */
  for (const key of ['dpp_interest', 'traceability_interest'] as const) {
    const value = one(query[key]);
    if (typeof value === 'string' && value) {
      if (!INTEREST_LEVELS.includes(value as (typeof INTEREST_LEVELS)[number])) {
        return { where: {}, error: `${key}_unknown` };
      }
      where[key] = value;
    }
  }

  const country = one(query.country);
  if (typeof country === 'string' && country) where.country_code = country.toUpperCase();

  /* §9 : taille. `employee_band` est une chaîne libre (« 250-500 »), donc un
     `contains` insensible à la casse — pas un intervalle numérique inventé. */
  const employeeBand = one(query.employee_band);
  if (typeof employeeBand === 'string' && employeeBand.trim()) {
    where.employee_band = { contains: employeeBand.trim(), mode: 'insensitive' };
  }

  /* §9 : nombre de produits et de fournisseurs, en intervalle. */
  for (const field of ['product_count', 'supplier_count'] as const) {
    const minRaw = one(query[`${field}_min`]);
    const maxRaw = one(query[`${field}_max`]);
    const range: Record<string, number> = {};
    if (minRaw !== undefined && minRaw !== '') {
      const min = positiveInt(minRaw);
      if (min === null) return { where: {}, error: `${field}_min_must_be_an_integer` };
      range.gte = min;
    }
    if (maxRaw !== undefined && maxRaw !== '') {
      const max = positiveInt(maxRaw);
      if (max === null) return { where: {}, error: `${field}_max_must_be_an_integer` };
      range.lte = max;
    }
    if (range.gte !== undefined && range.lte !== undefined && range.gte > range.lte) {
      return { where: {}, error: `${field}_range_inverted` };
    }
    if (Object.keys(range).length) where[field] = range;
  }

  const search = one(query.q);
  if (typeof search === 'string' && search.trim()) {
    const term = search.trim();
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { website: { contains: term, mode: 'insensitive' } },
      { city: { contains: term, mode: 'insensitive' } },
      { industry: { contains: term, mode: 'insensitive' } },
    ];
  }

  /*
   * `due=today` exclut clients et perdus : relancer un client gagné n'est pas une
   * action de prospection. Posé APRÈS `stage`, et volontairement — si les deux
   * sont demandés, c'est `due` qui gagne, parce que c'est la vue « à faire ».
   */
  const due = one(query.due);
  if (due === 'today') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    where.next_contact_at = { lte: end };
    where.stage = { notIn: ['customer', 'lost'] };
  }

  return { where, error: null };
}

/** Reconstruit une query string à partir de filtres persistés dans une liste. */
export function filtersToQueryString(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const text = String(value ?? '').trim();
    if (text) params.set(key, text);
  }
  return params.toString();
}
