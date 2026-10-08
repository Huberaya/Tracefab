import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { rankOpportunities } from '../../_lib/crm-log.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/opportunities — §1, la liste « qui appeler ensuite ».
 *
 * Lecture seule. Aucune table d'opportunités : une opportunité n'est pas une
 * entité saisie, c'est une LECTURE de ce qui l'est déjà. La stocker créerait une
 * seconde vérité qui divergerait de la fiche entreprise dès le premier changement.
 *
 * Le classement est calculé par `rankOpportunities`, qui réutilise
 * `assessOpportunity` : les mêmes champs produisent les mêmes conclusions ici et
 * sur la fiche entreprise. La derivation reste côté serveur.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);

    const companies = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_companies.findMany({
        where: { platform_organization_id: admin.platformOrganizationId },
        /* Seuls les champs que la derivation lit sont lus. Sélectionner toute la
           ligne chargerait les notes de chaque entreprise pour rien. */
        select: {
          id: true, name: true, stage: true, priority: true, country_code: true,
          product_count: true, supplier_count: true, maturity: true,
          dpp_interest: true, traceability_interest: true, estimated_value_eur: true,
          next_contact_at: true,
        },
      }),
    )) as unknown;

    const ranking = rankOpportunities(companies as unknown[]);
    return json(res, 200, ranking);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/opportunities failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
