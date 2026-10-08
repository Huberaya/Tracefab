import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { auditAdmin } from '../../_lib/crm-audit-write.js';
import { LEAD_STATUSES, leadDuplicateKey, parseLeadInput } from '../../_lib/crm-funnel.js';

/**
 * GET  /api/admin/leads   — file d'acquisition (filtre campagne, statut, texte)
 * POST /api/admin/leads   — création d'un lead, avec évitement de doublon
 *
 * Un lead n'est PAS une entreprise. C'est une acquisition brute : non
 * qualifiée, souvent incomplète. Elle devient une entreprise par promotion
 * (`POST /api/admin/leads/:id/promote`), et jamais par cette route.
 *
 * Rien n'est inventé : `collected_at` reste absent si l'appelant ne le donne
 * pas. Le remplir avec la date du jour ferait croire à une fraîcheur qui n'a
 * pas été observée (§9).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const where: Record<string, unknown> = { platform_organization_id: admin.platformOrganizationId };

    const campaignId = first(req.query.campaign_id);
    if (typeof campaignId === 'string' && campaignId) where.campaign_id = campaignId;

    const status = first(req.query.status);
    if (typeof status === 'string' && status) {
      if (!LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) {
        return json(res, 400, { error: 'status_unknown' });
      }
      where.status = status;
    }

    const search = first(req.query.q);
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { company_name: { contains: term, mode: 'insensitive' } },
        { contact_name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { website: { contains: term, mode: 'insensitive' } },
      ];
    }

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const leads = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_leads.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
      }))) as unknown;

    return json(res, 200, { leads });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/leads');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const body = { ...((req.body || {}) as Record<string, unknown>) };
    const parsed = parseLeadInput(body);
    if (parsed.errors.length) {
      return json(res, 422, { error: 'invalid_lead', details: parsed.errors });
    }
    if (!parsed.data) return json(res, 422, { error: 'invalid_lead', details: ['company_name_required'] });

    /* L'empreinte porte l'évitement de doublon (§8). Si la ligne ne contient
       rien d'identifiant, on refuse plutôt que de créer une entrée
       indistinguable de la suivante. */
    const duplicateKey = leadDuplicateKey(body as { email?: unknown; website?: unknown; company_name?: unknown });
    if (!duplicateKey) {
      return json(res, 422, { error: 'lead_not_identifiable' });
    }

    /* Une campagne inexistante ou invisible est refusée : sans clé étrangère,
       c'est la seule protection contre un lead rattaché au vide. */
    const campaignId = typeof parsed.data.campaign_id === 'string' ? parsed.data.campaign_id : null;

    const outcome = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      if (campaignId) {
        const campaign = await tx.crm_campaigns.findFirst({
          where: { id: campaignId, platform_organization_id: admin.platformOrganizationId },
          select: { id: true },
        });
        if (!campaign) return { campaignMissing: true as const };
      }
      const existing = await tx.crm_leads.findFirst({
        where: { platform_organization_id: admin.platformOrganizationId, duplicate_key: duplicateKey },
        select: { id: true, company_name: true, status: true, campaign_id: true },
      });
      if (existing) return { duplicate: existing };
      const lead = await tx.crm_leads.create({
        data: {
          ...(parsed.data as Record<string, unknown>),
          duplicate_key: duplicateKey,
          platform_organization_id: admin.platformOrganizationId,
        } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_lead', action: 'created', entityId: lead.id,
        before: null, after: lead as unknown as Record<string, unknown>,
      });
      return { lead };
    })) as unknown as
      | { campaignMissing: true }
      | { duplicate: Record<string, unknown> }
      | { lead: unknown };

    if ('campaignMissing' in outcome) {
      return json(res, 422, { error: 'crm_campaign_not_linkable' });
    }
    if ('duplicate' in outcome) {
      /* Le doublon existant est renvoyé : sans lui, l'opérateur ne peut pas
         savoir s'il s'agit du même prospect ou d'une homonymie. */
      return json(res, 409, { error: 'crm_lead_duplicate', existing: outcome.duplicate });
    }
    return json(res, 201, { lead: (outcome as { lead: unknown }).lead });
  } catch (error) {
    /* Filet de sécurité : deux créations concurrentes peuvent passer le test
       ci-dessus. La contrainte unique tranche, et il faut le dire en 409. */
    if ((error as { code?: string })?.code === 'P2002') {
      return json(res, 409, { error: 'crm_lead_duplicate' });
    }
    return fail(res, error, 'POST /api/admin/leads');
  }
}

function fail(res: VercelResponse, error: unknown, label: string) {
  if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
  if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
  const business = sqlBusinessError(error);
  if (business) return json(res, business.status, business);
  console.error(`${label} failed`, error);
  return json(res, 500, { error: 'internal_server_error' });
}
