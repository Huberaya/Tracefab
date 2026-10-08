/**
 * CHANTIER ADMIN 07 — Campagnes et Leads (§1)
 *
 * Module PUR : zéro import. Il peut donc être exécuté directement dans un test,
 * sans client Prisma ni base — ce qui est la seule façon de vérifier une
 * décision métier dans cet environnement.
 *
 * TROIS PRINCIPES PORTENT TOUT LE MODULE
 *
 * 1. Rien n'est inventé. Une empreinte de doublon, une provenance, un taux de
 *    conversion : tout dérive de ce que la ligne contient réellement. Quand il
 *    n'y a rien à dire, on renvoie `null`, pas une valeur plausible.
 *
 * 2. Un taux sur un échantillon vide est `null`, jamais 0. « 0 % de conversion »
 *    est une mesure ; « aucune donnée » est une absence. Les confondre fait
 *    prendre une campagne jamais lancée pour une campagne ratée.
 *
 * 3. Promouvoir un lead ne le supprime pas. La ligne de lead reste, avec sa
 *    provenance et sa date de collecte : c'est l'historique commercial (§14),
 *    et le supprimer détruirait la seule trace de l'origine du client.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'converted' | 'discarded';
export type CampaignStatus = 'draft' | 'planned' | 'running' | 'paused' | 'completed' | 'cancelled';
export type CampaignChannel =
  | 'email' | 'linkedin' | 'phone' | 'event' | 'webinar'
  | 'referral' | 'partner' | 'content' | 'other';

export const LEAD_STATUSES: LeadStatus[] =
  ['new', 'contacted', 'qualified', 'converted', 'discarded'];
export const CAMPAIGN_STATUSES: CampaignStatus[] =
  ['draft', 'planned', 'running', 'paused', 'completed', 'cancelled'];
export const CAMPAIGN_CHANNELS: CampaignChannel[] =
  ['email', 'linkedin', 'phone', 'event', 'webinar', 'referral', 'partner', 'content', 'other'];

/* Statuts qui signifient « la campagne a tranché pour ce lead ». */
export const DECIDED_LEAD_STATUSES: LeadStatus[] = ['converted', 'discarded'];

export interface ParseResult<T> {
  data: T | null;
  errors: string[];
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
};

/** Un code pays est deux lettres. Rien d'autre n'est accepté. */
export function parseCountryCode(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
}

/**
 * Un email est validé en FORME seulement. Ce module ne vérifie pas qu'une boîte
 * existe : le faire exigerait d'envoyer du courrier, et §12 interdit de
 * considérer un envoi comme acquis sans trace de consentement.
 */
export function parseEmail(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  return EMAIL_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * Un domaine, sans schéma ni chemin. Sert d'identité de secours quand aucun
 * email n'est connu — c'est le cas le plus fréquent sur un salon.
 */
export function parseWebsite(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const bare = s.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(bare) ? bare : null;
}

/* -------------------------------------------------------------------------- */
/* Empreinte de doublon (§8)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Calcule l'empreinte qui porte l'évitement des doublons à l'import.
 *
 * L'empreinte est PRÉFIXÉE par son type. Sans cela, `acme.com` saisi comme nom
 * d'entreprise et `acme.com` saisi comme site produiraient la même clé, et deux
 * réalités différentes seraient fusionnées.
 *
 * Ordre de préférence : email, puis domaine, puis nom. On descend dans la liste
 * uniquement si le niveau supérieur est absent — jamais on ne combine deux
 * sources, car une combinaison changerait l'empreinte dès qu'un champ est
 * complété plus tard, et le doublon réapparaîtrait.
 *
 * Renvoie `null` si la ligne ne contient RIEN d'identifiant. Le cas ne devrait
 * pas exister (company_name est obligatoire) mais s'il existe, il faut le dire
 * plutôt que de fabriquer une clé à partir de rien.
 */
export function leadDuplicateKey(input: {
  email?: unknown;
  website?: unknown;
  company_name?: unknown;
}): string | null {
  const email = parseEmail(input.email);
  if (email) return `email:${email}`;
  const site = parseWebsite(input.website);
  if (site) return `web:${site}`;
  const name = text(input.company_name);
  if (name) return `name:${name.toLowerCase().replace(/\s+/g, ' ')}`;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

const LEAD_FIELDS = ['company_name', 'contact_name', 'contact_job_title', 'email', 'phone',
  'linkedin_url', 'website', 'city', 'sector', 'source', 'source_detail', 'notes',
  'discard_reason'];

export interface LeadInput {
  company_name?: unknown;
  campaign_id?: unknown;
  contact_name?: unknown;
  contact_job_title?: unknown;
  email?: unknown;
  phone?: unknown;
  linkedin_url?: unknown;
  website?: unknown;
  country_code?: unknown;
  city?: unknown;
  sector?: unknown;
  status?: unknown;
  discard_reason?: unknown;
  source?: unknown;
  source_detail?: unknown;
  collected_at?: unknown;
  notes?: unknown;
}

/**
 * `collected_at` est la date de COLLECTE, pas la date d'import (§9). Elle est
 * acceptée si l'appelant la fournit — un fichier reçu en mars et importé en
 * octobre doit garder mars. Absente, elle reste absente : la remplir avec
 * `now()` ferait croire à une fraîcheur qui n'a pas été observée.
 */
export function parseCollectedAt(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseLeadInput(input: LeadInput): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};

  const name = text(input.company_name);
  if (input.company_name !== undefined) {
    if (!name) errors.push('company_name_required');
    else data.company_name = name;
  }

  for (const key of LEAD_FIELDS) {
    if (key === 'company_name' || input[key] === undefined) continue;
    const v = text(input[key]);
    /* Un null explicite vide le champ : sans cela une correction serait
       impossible et une donnée erronée deviendrait définitive. */
    data[key] = input[key] === null ? null : v;
  }

  if (input.email !== undefined && input.email !== null) {
    const email = parseEmail(input.email);
    if (!email) errors.push('email_invalid');
    else data.email = email;
  }

  if (input.website !== undefined && input.website !== null) {
    const site = parseWebsite(input.website);
    if (!site) errors.push('website_invalid');
    else data.website = site;
  }

  if (input.country_code !== undefined) {
    if (input.country_code === null) data.country_code = null;
    else {
      const cc = parseCountryCode(input.country_code);
      if (!cc) errors.push('country_code_invalid');
      else data.country_code = cc;
    }
  }

  if (input.status !== undefined) {
    const st = text(input.status) as LeadStatus | null;
    if (!st || !LEAD_STATUSES.includes(st)) errors.push('status_invalid');
    else {
      data.status = st;
      /* Un lead écarté sans raison est une donnée perdue : personne ne saura
         jamais s'il était hors cible, en double, ou simplement oublié. */
      if (st === 'discarded' && !text(input.discard_reason) && !text(data.discard_reason as string)) {
        errors.push('discard_reason_required');
      }
    }
  }

  /* `converted` ne se décrète pas : c'est la promotion qui l'écrit, avec
     l'entreprise créée. L'accepter ici produirait des leads « convertis »
     sans aucun client derrière. */
  if (data.status === 'converted') errors.push('status_converted_not_settable');

  if (input.campaign_id !== undefined) {
    if (input.campaign_id === null) data.campaign_id = null;
    else if (typeof input.campaign_id !== 'string' || !UUID_RE.test(input.campaign_id)) {
      errors.push('campaign_id_must_be_uuid');
    } else data.campaign_id = input.campaign_id;
  }

  if (input.collected_at !== undefined) {
    if (input.collected_at === null) data.collected_at = null;
    else {
      const at = parseCollectedAt(input.collected_at);
      if (!at) errors.push('collected_at_invalid');
      else data.collected_at = at;
    }
  }

  if (errors.length) return { data: null, errors };
  return { data, errors: [] };
}

/* -------------------------------------------------------------------------- */
/* Campagnes                                                                  */
/* -------------------------------------------------------------------------- */

export interface CampaignInput {
  name?: unknown;
  channel?: unknown;
  status?: unknown;
  objective?: unknown;
  target_audience?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
  budget_eur?: unknown;
  owner_name?: unknown;
  notes?: unknown;
}

export function parseCampaignInput(input: CampaignInput): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};

  const name = text(input.name);
  if (input.name !== undefined) {
    if (!name) errors.push('name_required');
    else data.name = name;
  }

  for (const key of ['objective', 'target_audience', 'owner_name', 'notes']) {
    if (input[key] === undefined) continue;
    data[key] = input[key] === null ? null : text(input[key]);
  }

  if (input.channel !== undefined) {
    const ch = text(input.channel) as CampaignChannel | null;
    if (!ch || !CAMPAIGN_CHANNELS.includes(ch)) errors.push('channel_invalid');
    else data.channel = ch;
  }

  if (input.status !== undefined) {
    const st = text(input.status) as CampaignStatus | null;
    if (!st || !CAMPAIGN_STATUSES.includes(st)) errors.push('status_invalid');
    else data.status = st;
  }

  for (const key of ['starts_at', 'ends_at'] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null) { data[key] = null; continue; }
    const raw = text(input[key]);
    const d = raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) errors.push(`${key}_invalid`);
    else data[key] = d.toISOString();
  }

  /* Une fenêtre inversée est presque toujours une saisie à l'envers. La laisser
     passer produirait une campagne dont la durée calculée est négative. */
  if (typeof data.starts_at === 'string' && typeof data.ends_at === 'string'
    && data.ends_at < data.starts_at) {
    errors.push('ends_before_starts');
  }

  if (input.budget_eur !== undefined) {
    if (input.budget_eur === null) data.budget_eur = null;
    else {
      const n = Number(input.budget_eur);
      /* Un budget négatif n'existe pas ; NaN n'est pas un budget. */
      if (!Number.isFinite(n) || n < 0) errors.push('budget_eur_invalid');
      else data.budget_eur = n;
    }
  }

  if (errors.length) return { data: null, errors };
  return { data, errors: [] };
}

/* -------------------------------------------------------------------------- */
/* Promotion lead → entreprise (§14)                                          */
/* -------------------------------------------------------------------------- */

export interface PromotableLead {
  id: string;
  company_name: string;
  website?: string | null;
  country_code?: string | null;
  city?: string | null;
  sector?: string | null;
  campaign_id?: string | null;
  source?: string | null;
  source_detail?: string | null;
  collected_at?: string | null;
  notes?: string | null;
  status?: LeadStatus | string;
  converted_company_id?: string | null;
}

export interface PromotionPlan {
  company: Record<string, unknown>;
  lead: Record<string, unknown>;
  errors: string[];
}

/**
 * Prépare la promotion d'un lead en entreprise.
 *
 * Le lead n'est PAS supprimé : il passe à `converted` et reçoit l'identifiant de
 * l'entreprise créée. Sa provenance et sa date de collecte restent lisibles —
 * c'est la seule trace de l'origine du client (§14).
 *
 * La provenance est RECOPYÉE telle quelle sur l'entreprise. Elle n'est ni
 * recalculée ni « améliorée » : une source réécrite au passage n'est plus une
 * source.
 */
export function planPromotion(lead: PromotableLead, companyId: string): PromotionPlan {
  const errors: string[] = [];

  if (!text(companyId) || !UUID_RE.test(companyId)) errors.push('company_id_must_be_uuid');
  if (!text(lead?.company_name)) errors.push('lead_company_name_required');

  /* Déjà promu : refuser plutôt que créer un second client pour le même lead.
     Sans cette garde, deux clics produiraient deux entreprises et la campagne
     compterait deux conversions pour une seule réalité. */
  if (lead?.converted_company_id) errors.push('lead_already_converted');
  if (lead?.status === 'converted') errors.push('lead_already_converted');

  /* Écarter puis promouvoir serait contradictoire : un lead écarté est une
     décision, la contourner silencieusement la rendrait illisible. */
  if (lead?.status === 'discarded') errors.push('lead_discarded_not_promotable');

  if (errors.length) return { company: {}, lead: {}, errors };

  const company: Record<string, unknown> = {
    id: companyId,
    name: lead.company_name,
    stage: 'new',
  };
  for (const key of ['website', 'country_code', 'city', 'campaign_id',
    'source', 'source_detail', 'collected_at', 'notes'] as const) {
    /* Seul un champ réellement présent est repris : écrire `null` partout
       écraserait ce qu'un opérateur aurait déjà renseigné. */
    const v = lead[key];
    if (v !== undefined && v !== null && v !== '') company[key] = v;
  }
  /* `sector` devient `industry` : c'est le nom du champ côté entreprise. Le
     renommer est une traduction de schéma, pas une modification de donnée. */
  if (text(lead.sector)) company.industry = lead.sector;

  return {
    company,
    lead: {
      status: 'converted',
      converted_company_id: companyId,
      converted_at: new Date().toISOString(),
    },
    errors: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Mesure d'une campagne                                                      */
/* -------------------------------------------------------------------------- */

export interface CampaignLeadRow {
  status: string;
  converted_company_id?: string | null;
}

export interface CampaignCompanyRow {
  stage: string;
}

export interface CampaignMetrics {
  leads: number;
  byStatus: Record<string, number>;
  promoted: number;
  discarded: number;
  decided: number;
  customers: number;
  /** `null` quand rien n'est décidé : un taux sur un échantillon vide n'existe pas. */
  promotionRate: number | null;
  /** `null` pour la même raison. */
  customerRate: number | null;
}

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

/**
 * Mesure une campagne à partir de ses leads et des entreprises qui en sont
 * issues. Rien n'est stocké : un compteur enregistré divergerait dès le premier
 * lead supprimé, et personne ne saurait lequel croire.
 *
 * `promoted` compte les leads portant réellement une entreprise, pas ceux dont
 * le statut dit « converted ». Le statut est une déclaration ; l'identifiant
 * est un fait.
 */
export function measureCampaign(
  leads: CampaignLeadRow[] | null | undefined,
  companies: CampaignCompanyRow[] | null | undefined,
): CampaignMetrics {
  const rows = Array.isArray(leads) ? leads : [];
  const byStatus: Record<string, number> = {};
  let promoted = 0;
  let discarded = 0;
  for (const l of rows) {
    const st = typeof l?.status === 'string' ? l.status : 'unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (typeof l?.converted_company_id === 'string' && l.converted_company_id.length) promoted += 1;
    if (st === 'discarded') discarded += 1;
  }
  const decided = promoted + discarded;
  const customers = (Array.isArray(companies) ? companies : [])
    .filter((c) => c?.stage === 'customer').length;

  return {
    leads: rows.length,
    byStatus,
    promoted,
    discarded,
    decided,
    customers,
    promotionRate: pct(promoted, decided),
    customerRate: pct(customers, promoted),
  };
}

/**
 * Résume un portefeuille de campagnes. Les taux globaux sont calculés sur les
 * sommes, jamais en moyennant des taux : la moyenne de 100 % (1/1) et 0 % (0/9)
 * est 50 %, alors que la réalité est 1 promotion sur 10, soit 10 %.
 */
export function summarizeCampaigns(metrics: CampaignMetrics[] | null | undefined): {
  campaigns: number;
  leads: number;
  promoted: number;
  customers: number;
  promotionRate: number | null;
  customerRate: number | null;
} {
  const rows = Array.isArray(metrics) ? metrics : [];
  let leads = 0; let promoted = 0; let discarded = 0; let customers = 0;
  for (const m of rows) {
    leads += m?.leads || 0;
    promoted += m?.promoted || 0;
    discarded += m?.discarded || 0;
    customers += m?.customers || 0;
  }
  return {
    campaigns: rows.length,
    leads,
    promoted,
    customers,
    promotionRate: pct(promoted, promoted + discarded),
    customerRate: pct(customers, promoted),
  };
}
