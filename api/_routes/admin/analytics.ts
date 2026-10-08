import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { computeAnalytics } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/analytics
 *
 * Prospects par pays et par secteur, conversion par étape / pays / source,
 * démos, pilotes, clients gagnés et perdus, durée moyenne avant conversion.
 *
 * La durée moyenne vaut `null` quand aucune conversion n'est datée. Afficher 0
 * ferait croire à une conversion instantanée mesurée ; l'interface affiche
 * « non mesuré ».
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);
    const orgId = admin.platformOrganizationId;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const [companies, demos, meetings, pilots, conversions] = await Promise.all([
        tx.crm_companies.findMany({
          where: { platform_organization_id: orgId },
          select: {
            id: true,
            stage: true,
            country_code: true,
            company_type: true,
            industry: true,
            source: true,
            created_at: true,
            converted_at: true,
          },
        }),
        tx.crm_activities.count({
          where: { platform_organization_id: orgId, type: { in: ['demo', 'meeting'] } },
        }),
        tx.crm_meetings.count({ where: { platform_organization_id: orgId } }),
        tx.crm_pilots.count({ where: { platform_organization_id: orgId } }),
        tx.crm_companies.count({ where: { platform_organization_id: orgId, stage: 'customer' } }),
      ]);

      const analytics = computeAnalytics(companies as never);

      /* Démo = une activité de type demo OU une étape du pipeline atteinte.
         Compter seulement l'activité sous-estimerait : une équipe peut avancer
         l'étape sans journaliser. On prend le plus crédible des deux, jamais la
         somme — additionner compterait le même événement deux fois. */
      const demoStage = analytics.byStage.demo || 0;
      const demoActivities = demos;

      return {
        ...analytics,
        counts: {
          companies: companies.length,
          meetings,
          pilots,
          conversions,
          demos: Math.max(demoStage, demoActivities),
          demoStage,
          demoActivities,
        },
      };
    })) as unknown;

    return json(res, 200, { analytics: result });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/analytics failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
