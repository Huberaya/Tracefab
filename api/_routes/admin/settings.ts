import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { ADMIN_ROLES } from '../../_lib/crm-access.js';
import { PIPELINE_STAGES } from '../../_lib/crm.js';
import { verifyAuditChainIntegrity } from '../../_lib/audit-vault.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/settings — état de la console (§1)
 *
 * Qui a accès, sur quoi porte le pipeline, et si le journal d'audit est intact.
 * Lecture seule : l'accès Admin se donne dans `organization_memberships`, pas
 * ici. Exposer une écriture ici créerait une seconde porte vers le rôle.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);
    const orgId = admin.platformOrganizationId;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const [members, counts, chain] = await Promise.all([
        tx.organization_memberships.findMany({
          where: {
            organization_id: orgId,
            status: 'active',
            role: { in: [...ADMIN_ROLES] },
          },
          select: { user_id: true, role: true, status: true, created_at: true },
          orderBy: { created_at: 'asc' },
        }),
        Promise.all([
          tx.crm_companies.count({ where: { platform_organization_id: orgId } }),
          tx.crm_contacts.count({ where: { platform_organization_id: orgId } }),
          tx.crm_tasks.count({ where: { platform_organization_id: orgId } }),
          tx.crm_meetings.count({ where: { platform_organization_id: orgId } }),
          tx.crm_pilots.count({ where: { platform_organization_id: orgId } }),
          tx.crm_saved_views.count({ where: { platform_organization_id: orgId } }),
          tx.crm_activities.count({ where: { platform_organization_id: orgId } }),
          tx.audit_logs.count({ where: { organization_id: orgId } }),
        ]),
        verifyAuditChainIntegrity(tx as never, orgId),
      ]);

      const [companies, contacts, tasks, meetings, pilots, lists, activities, auditEntries] = counts;

      return {
        organization: { id: orgId, name: admin.organizationName, type: 'platform' },
        access: {
          roles: ADMIN_ROLES,
          admins: members,
          /* Un seul Admin restant est un risque opérationnel, pas une erreur :
             on le signale sans bloquer. */
          singlePointOfFailure: members.length <= 1,
        },
        pipeline: { stages: PIPELINE_STAGES, lostStage: 'lost' },
        counts: { companies, contacts, tasks, meetings, pilots, lists, activities, auditEntries },
        audit: { chain, appendOnlyActivities: true },
      };
    })) as unknown;

    return json(res, 200, { settings: result });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/settings failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
