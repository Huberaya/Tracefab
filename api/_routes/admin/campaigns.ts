import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { auditAdmin } from '../../_lib/crm-audit-write.js';
import { CAMPAIGN_CHANNELS, CAMPAIGN_STATUSES, parseCampaignInput } from '../../_lib/crm-funnel.js';
import { emptyCampaignMetrics, loadCampaignMetrics } from '../../_lib/crm-funnel-load.js';

/**
 * GET  /api/admin/campaigns   — liste, avec les métriques MESURÉES de chacune
 * POST /api/admin/campaigns   — création
 *
 * Aucun compteur n'est lu en base : ils ne sont pas stockés. Les chiffres
 * viennent de `loadCampaignMetrics`, le même chargeur que le détail d'une
 * campagne, pour que les deux vues ne puissent jamais diverger.
 *
 * Une campagne sans lead renvoie des zéros et des taux `null`. « 0 % de
 * promotion » est une mesure ; « rien à mesurer » est une absence.
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
    const orgId = admin.platformOrganizationId;

    const where: Record<string, unknown> = { platform_organization_id: orgId };
    const status = first(req.query.status);
    if (typeof status === 'string' && status) {
      if (!CAMPAIGN_STATUSES.includes(status as (typeof CAMPAIGN_STATUSES)[number])) {
        return json(res, 400, { error: 'status_unknown' });
      }
      where.status = status;
    }
    const channel = first(req.query.channel);
    if (typeof channel === 'string' && channel) {
      if (!CAMPAIGN_CHANNELS.includes(channel as (typeof CAMPAIGN_CHANNELS)[number])) {
        return json(res, 400, { error: 'channel_unknown' });
      }
      where.channel = channel;
    }
    const search = first(req.query.q);
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { objective: { contains: term, mode: 'insensitive' } },
        { target_audience: { contains: term, mode: 'insensitive' } },
      ];
    }

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const rows = (await tx.crm_campaigns.findMany({
        where,
        orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
        take: limit,
      })) as unknown as Record<string, unknown>[];
      const ids = rows.map((r) => String(r.id));
      const metrics = await loadCampaignMetrics(tx as never, orgId, ids);
      return { rows, metrics };
    })) as unknown as { rows: Record<string, unknown>[]; metrics: Map<string, unknown> };

    const campaigns = result.rows.map((row) => ({
      ...row,
      metrics: result.metrics.get(String(row.id)) || emptyCampaignMetrics(),
    }));
    return json(res, 200, {
      campaigns,
      scope: 'platform_acquisition',
      /* Les métriques sont calculées, pas stockées : le dire évite qu'un lecteur
         les prenne pour des compteurs tenus à jour par ailleurs. */
      metricsSource: 'computed',
    });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/campaigns');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const body = { ...((req.body || {}) as Record<string, unknown>) };
    const parsed = parseCampaignInput(body);
    if (parsed.errors.length) {
      return json(res, 422, { error: 'invalid_campaign', details: parsed.errors });
    }
    if (!parsed.data || typeof parsed.data.name !== 'string' || !parsed.data.name) {
      return json(res, 422, { error: 'invalid_campaign', details: ['name_required'] });
    }

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const campaign = await tx.crm_campaigns.create({
        data: {
          ...(parsed.data as Record<string, unknown>),
          platform_organization_id: admin.platformOrganizationId,
        } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_campaign', action: 'created', entityId: campaign.id,
        before: null, after: campaign as unknown as Record<string, unknown>,
      });
      return campaign;
    })) as unknown;

    return json(res, 201, { campaign: created });
  } catch (error) {
    /* Le nom est unique par organisation. Le dire explicitement évite un 500
       illisible sur une collision pourtant parfaitement normale. */
    if ((error as { code?: string })?.code === 'P2002') {
      return json(res, 409, { error: 'crm_campaign_name_exists' });
    }
    return fail(res, error, 'POST /api/admin/campaigns');
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
