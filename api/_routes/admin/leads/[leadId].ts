import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';
import { parseLeadInput } from '../../../_lib/crm-funnel.js';

/**
 * GET   /api/admin/leads/:leadId — un lead et sa provenance
 * PATCH /api/admin/leads/:leadId — mise à jour
 *
 * `status` ne peut pas être mis à `converted` ici : c'est la promotion qui
 * l'écrit, avec l'entreprise créée. L'accepter produirait des leads dits
 * « convertis » sans aucun client derrière.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return patch(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const leadId = String(req.query.leadId);

    const lead = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_leads.findFirst({
        where: { id: leadId, platform_organization_id: admin.platformOrganizationId },
      }))) as unknown;

    if (!lead) return json(res, 404, { error: 'crm_lead_not_found' });
    return json(res, 200, { lead });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/leads/:id');
  }
}

async function patch(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const leadId = String(req.query.leadId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    /* Changer l'empreinte d'identité ouvrirait la porte aux doublons : une
       ligne dont l'email est corrigé redeviendait insérable une seconde fois.
       L'empreinte est donc figée après création. */
    for (const frozen of ['email', 'website', 'company_name']) {
      if (body[frozen] !== undefined) {
        return json(res, 422, { error: 'lead_identity_immutable', field: frozen });
      }
    }

    const parsed = parseLeadInput(body);
    if (parsed.errors.length) {
      return json(res, 422, { error: 'invalid_lead', details: parsed.errors });
    }
    if (!parsed.data || !Object.keys(parsed.data).length) {
      return json(res, 422, { error: 'no_updatable_field' });
    }

    const outcome = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const before = await tx.crm_leads.findFirst({
        where: { id: leadId, platform_organization_id: admin.platformOrganizationId },
      });
      if (!before) return { missing: true as const };

      const campaignId = typeof parsed.data!.campaign_id === 'string' ? parsed.data!.campaign_id : null;
      if (campaignId) {
        const campaign = await tx.crm_campaigns.findFirst({
          where: { id: campaignId, platform_organization_id: admin.platformOrganizationId },
          select: { id: true },
        });
        if (!campaign) return { campaignMissing: true as const };
      }

      const lead = await tx.crm_leads.update({
        where: { id: leadId },
        data: { ...(parsed.data as Record<string, unknown>), updated_at: new Date() } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_lead', action: 'updated', entityId: leadId,
        before: before as unknown as Record<string, unknown>,
        after: lead as unknown as Record<string, unknown>,
      });
      return { lead };
    })) as unknown as
      | { missing: true }
      | { campaignMissing: true }
      | { lead: unknown };

    if ('missing' in outcome) return json(res, 404, { error: 'crm_lead_not_found' });
    if ('campaignMissing' in outcome) {
      return json(res, 422, { error: 'crm_campaign_not_linkable' });
    }
    return json(res, 200, { lead: (outcome as { lead: unknown }).lead });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/leads/:id');
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
