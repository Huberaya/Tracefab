import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { isUnauthorized } from '../../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { PIPELINE_STAGES, canTransition, stageRank } from '../../../../_lib/crm.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';

/**
 * PATCH /api/admin/companies/:companyId/stage
 *
 * Unique porte d'entrée vers le pipeline. Le mouvement et son écriture dans
 * `crm_activities` sont dans la même transaction : si l'un échoue, l'autre est
 * annulé. Un pipeline dont l'historique peut diverger de l'état réel ne vaut
 * plus rien comme preuve commerciale.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);

  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);
    const body = (req.body || {}) as Record<string, unknown>;

    const to = typeof body.stage === 'string' ? body.stage : '';
    if (![...PIPELINE_STAGES, 'lost'].includes(to)) {
      return json(res, 422, { error: 'stage_unknown' });
    }
    const lostReason = typeof body.lost_reason === 'string' && body.lost_reason.trim()
      ? body.lost_reason.trim().slice(0, 500)
      : null;

    const stage = to as (typeof PIPELINE_STAGES)[number] | 'lost';
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true, name: true, stage: true },
      });
      if (!company) return { status: 404 as const };

      const from = company.stage as (typeof PIPELINE_STAGES)[number] | 'lost';
      const decision = canTransition(from, stage, Boolean(lostReason));
      if (!decision.ok) return { status: 422 as const, error: decision.error };
      if (!decision.activity) return { status: 200 as const, unchanged: true, company };

      const updated = await tx.crm_companies.update({
        where: { id: companyId },
        data: {
          stage,
          lost_reason: stage === 'lost' ? lostReason : null,
          last_contact_at: stage === 'contacted' || stage === 'replied' ? new Date() : undefined,
        } as never,
      });

      const summary = stage === 'lost'
        ? `Perdu : ${company.name}`
        : stage === 'customer'
          ? `Converti en client : ${company.name}`
          : `Pipeline : ${from} → ${stage}`;

      await tx.crm_activities.create({
        data: {
          company_id: companyId,
          platform_organization_id: admin.platformOrganizationId,
          type: decision.activity,
          summary,
          detail: note ?? lostReason,
          from_stage: from as never,
          to_stage: stage as never,
          actor_user_id: admin.userId,
          actor_name: admin.fullName,
        } as never,
      });

      return { status: 200 as const, company: updated, from, to: stage };
    })) as unknown as {
      status: number;
      error?: string;
      company?: unknown;
      unchanged?: boolean;
      from?: string;
      to?: string;
    };

    if (result.status === 404) return json(res, 404, { error: 'crm_company_not_found' });
    if (result.status === 422) return json(res, 422, { error: result.error });

    return json(res, 200, {
      company: result.company,
      changed: !result.unchanged,
      from: result.from ?? null,
      to: result.to ?? null,
      movedForward: result.from !== undefined && result.to !== undefined
        ? stageRank(result.to as never) > stageRank(result.from as never)
        : null,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('PATCH /api/admin/companies/:id/stage failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
