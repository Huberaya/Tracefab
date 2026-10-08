import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';
import { parseCampaignInput } from '../../../_lib/crm-funnel.js';
import { emptyCampaignMetrics, loadCampaignMetrics } from '../../../_lib/crm-funnel-load.js';

/**
 * GET   /api/admin/campaigns/:campaignId — campagne, métriques mesurées, leads
 * PATCH /api/admin/campaigns/:campaignId — mise à jour
 *
 * Pas de DELETE. Supprimer une campagne orpheline ferait disparaître la
 * provenance de tous les clients qu'elle a produits : les leads portent son
 * identifiant, et §9 impose de conserver la source.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return patch(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const campaignId = String(req.query.campaignId);
    const orgId = admin.platformOrganizationId;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const campaign = await tx.crm_campaigns.findFirst({
        where: { id: campaignId, platform_organization_id: orgId },
      });
      if (!campaign) return null;
      const [leads, companies, metrics] = await Promise.all([
        tx.crm_leads.findMany({
          where: { platform_organization_id: orgId, campaign_id: campaignId },
          orderBy: { created_at: 'desc' },
          take: 200,
        }),
        tx.crm_companies.findMany({
          where: { platform_organization_id: orgId, campaign_id: campaignId },
          select: { id: true, name: true, stage: true, country_code: true, estimated_value_eur: true },
          orderBy: { created_at: 'desc' },
          take: 200,
        }),
        loadCampaignMetrics(tx as never, orgId, [campaignId]),
      ]);
      return { campaign, leads, companies, metric: metrics.get(campaignId) || emptyCampaignMetrics() };
    })) as unknown as null | {
      campaign: Record<string, unknown>;
      leads: unknown[];
      companies: unknown[];
      metric: unknown;
    };

    if (!result) return json(res, 404, { error: 'crm_campaign_not_found' });
    return json(res, 200, {
      campaign: result.campaign,
      leads: result.leads,
      companies: result.companies,
      metrics: result.metric,
      metricsSource: 'computed',
    });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/campaigns/:id');
  }
}

async function patch(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const campaignId = String(req.query.campaignId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };
    const parsed = parseCampaignInput(body);
    if (parsed.errors.length) {
      return json(res, 422, { error: 'invalid_campaign', details: parsed.errors });
    }
    if (!parsed.data || !Object.keys(parsed.data).length) {
      return json(res, 422, { error: 'no_updatable_field' });
    }

    const outcome = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const before = await tx.crm_campaigns.findFirst({
        where: { id: campaignId, platform_organization_id: admin.platformOrganizationId },
      });
      if (!before) return { missing: true as const };
      const campaign = await tx.crm_campaigns.update({
        where: { id: campaignId },
        data: { ...(parsed.data as Record<string, unknown>), updated_at: new Date() } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_campaign', action: 'updated', entityId: campaignId,
        before: before as unknown as Record<string, unknown>,
        after: campaign as unknown as Record<string, unknown>,
      });
      return { campaign };
    })) as unknown as { missing: true } | { campaign: unknown };

    if ('missing' in outcome) return json(res, 404, { error: 'crm_campaign_not_found' });
    return json(res, 200, { campaign: (outcome as { campaign: unknown }).campaign });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      return json(res, 409, { error: 'crm_campaign_name_exists' });
    }
    return fail(res, error, 'PATCH /api/admin/campaigns/:id');
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
