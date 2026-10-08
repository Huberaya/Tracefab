/**
 * Boucle commerciale quotidienne — Chantier Admin 05 (§12 Notes, §12 Emails, §1 Opportunities).
 *
 * Module pur. Aucune requête, aucun client Prisma.
 *
 * Trois règles traversent tout le module :
 *
 * 1. Une note et un journal d'e-mail sont des `crm_activities`, pas de nouvelles
 *    tables. La timeline existe déjà, elle est append-only (`REVOKE UPDATE,
 *    DELETE`) et elle est scellée dans le journal d'audit depuis Admin 04.
 *
 * 2. TRACEFAB N'ENVOIE PAS d'e-mail de prospection. Voir EMAIL_SENDING_REFUSED.
 *
 * 3. Le classement des opportunités est déterministe et n'invente rien : il
 *    réutilise `assessOpportunity`, qui ne conclut que sur des champs saisis.
 */

import { assessOpportunity } from './crm-opportunity.js';

/** Bornes d'écriture. Les mêmes que celles imposées par la route d'activités. */
export const LOG_LIMITS = {
  summaryMax: 300,
  detailMax: 4000,
} as const;

/**
 * Refus d'envoi — documenté, pas silencieux.
 *
 * `api/_lib/email.ts` sait réellement envoyer (Resend). Rien n'empêcherait donc
 * techniquement d'ajouter un bouton « envoyer ». Ce qui l'empêche est ailleurs :
 * `crm_contacts` ne porte AUCUN champ de consentement, et `consent` / `opt_in` /
 * `gdpr` n'apparaissent nulle part dans le schéma. Envoyer un e-mail commercial à
 * une adresse dont la plateforme ne conserve aucune base licite serait indéfendable
 * pour un produit dont tout le positionnement est la confiance.
 *
 * Ce refus est épinglé par un test : le jour où un champ de consentement existe,
 * le test échouera et forcera la décision au lieu de la laisser passer.
 */
export const EMAIL_SENDING_REFUSED = {
  refused: true,
  reason: 'no_consent_record',
  detail:
    'crm_contacts ne porte aucun champ de consentement et le schéma ne contient '
    + 'ni consent, ni opt_in, ni gdpr. TRACEFAB journalise les e-mails de prospection, '
    + 'il ne les envoie pas.',
} as const;

export interface ParsedLog {
  ok: true;
  type: 'note' | 'email';
  summary: string;
  detail: string | null;
}

export interface RejectedLog {
  ok: false;
  error: string;
}

/**
 * Une note ou un journal d'e-mail.
 *
 * `summary` est la première ligne (ou l'objet, pour un e-mail) ; `detail` est le
 * reste. Ce sont les deux seules colonnes textuelles de `crm_activities` : y
 * encoder du JSON produirait un contenu non interrogeable et illisible dans la
 * timeline, donc rien de structuré n'est demandé ici.
 */
export function parseLogInput(body: unknown, type: 'note' | 'email'): ParsedLog | RejectedLog {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body_required' };
  const input = body as Record<string, unknown>;

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error: type === 'email' ? 'subject_required' : 'summary_required',
    };
  }
  if (summary.length > LOG_LIMITS.summaryMax) {
    return { ok: false, error: 'summary_too_long' };
  }

  let detail: string | null = null;
  if (input.detail !== undefined && input.detail !== null) {
    if (typeof input.detail !== 'string') return { ok: false, error: 'detail_must_be_text' };
    const trimmed = input.detail.trim();
    if (trimmed.length > LOG_LIMITS.detailMax) return { ok: false, error: 'detail_too_long' };
    detail = trimmed || null;
  }

  return { ok: true, type, summary, detail };
}

/**
 * Le destinataire d'un e-mail journalisé.
 *
 * Il est validé, jamais inventé : s'il n'est pas fourni, la réponse ne contient
 * pas de destinataire plutôt qu'une adresse déduite du nom de la société.
 */
export function parseRecipient(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 320) return null;
  /* Un contrôle de forme, pas une vérification d'existence : TRACEFAB ne peut pas
     prouver qu'une boîte existe, et prétendre le faire serait un mensonge. */
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

/* ------------------------------------------------------------------------ */
/* §1 — Opportunities : le classement « qui appeler ensuite »               */
/* ------------------------------------------------------------------------ */

/** Ordre de priorité du pipeline. Plus le rang est bas, plus la priorité est haute. */
const PRIORITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

/** Une étape déjà gagnée ou perdue n'est plus une opportunité à travailler. */
const CLOSED_STAGES = ['customer', 'lost'];

export interface RankedOpportunity {
  company_id: string;
  name: string;
  stage: string;
  priority: string;
  signals: number;
  insufficient: boolean;
  layers: string[];
  problems: { code: string; evidence: string }[];
  features: { code: string; evidence: string }[];
  estimated_value_eur: number | null;
  next_contact_at: string | null;
}

export interface OpportunityRanking {
  items: RankedOpportunity[];
  /** Comptés séparément : les inclure dans le classement serait les compter deux fois. */
  closed: number;
  /** Entreprises sans aucun signal : on ne les classe pas, on les signale. */
  insufficient: number;
}

/**
 * Classe les entreprises ouvertes par force du signal.
 *
 * Le tri est déterministe : signaux décroissants, puis priorité, puis valeur
 * estimée, puis identifiant. Sans ce dernier critère, deux entreprises à égalité
 * changeraient d'ordre d'un appel à l'autre — et une liste de prospection qui
 * bouge toute seule n'est pas exploitable.
 *
 * Les entreprises fermées (client / perdu) et celles sans signal sont retirées du
 * classement et comptées à part. Les mélanger ferait croire qu'il reste du
 * travail là où il n'y en a plus, ou inversement.
 */
export function rankOpportunities(companies: unknown[]): OpportunityRanking {
  const items: RankedOpportunity[] = [];
  let closed = 0;
  let insufficient = 0;

  for (const raw of Array.isArray(companies) ? companies : []) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : null;
    if (!id) continue;

    const stage = typeof c.stage === 'string' ? c.stage : 'new';
    if (CLOSED_STAGES.includes(stage)) { closed += 1; continue; }

    const assessment = assessOpportunity(c);
    if (assessment.insufficient) { insufficient += 1; continue; }

    items.push({
      company_id: id,
      name: typeof c.name === 'string' ? c.name : '',
      stage,
      priority: typeof c.priority === 'string' ? c.priority : 'medium',
      signals: assessment.signals,
      insufficient: false,
      layers: assessment.layers,
      problems: assessment.problems,
      features: assessment.features,
      estimated_value_eur:
        typeof c.estimated_value_eur === 'number' && Number.isFinite(c.estimated_value_eur)
          ? c.estimated_value_eur : null,
      next_contact_at:
        c.next_contact_at instanceof Date ? c.next_contact_at.toISOString()
          : typeof c.next_contact_at === 'string' ? c.next_contact_at : null,
    });
  }

  items.sort((a, b) => {
    if (b.signals !== a.signals) return b.signals - a.signals;
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    const va = a.estimated_value_eur ?? -1;
    const vb = b.estimated_value_eur ?? -1;
    if (va !== vb) return vb - va;
    /* Dernier critère : l'identifiant. Il rend le tri total, donc stable. */
    return a.company_id < b.company_id ? -1 : a.company_id > b.company_id ? 1 : 0;
  });

  return { items, closed, insufficient };
}
