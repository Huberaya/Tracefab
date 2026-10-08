import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { loadConnectedCompanies } from '../../_lib/crm-connection.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/product-usage — §1, l'usage réel de la plateforme.
 *
 * Lecture seule, et même chargement que /api/admin/suppliers : les deux vues
 * lisent les mêmes faits, et deux copies de cette logique finiraient par afficher
 * des chiffres différents pour la même entreprise.
 *
 * PÉRIMÈTRE ASSUMÉ : « usage » signifie ici l'engagement des fournisseurs du
 * client sur la plateforme — combien sont embarqués, quel taux de profil, quelle
 * dernière soumission. Ce n'est PAS de la télémétrie applicative : le produit
 * n'en produit aucune, et en afficher une serait inventer.
 *
 * Sans lien vers une organisation dont l'admin est membre, cette vue est vide et
 * le dit. Elle ne complète pas avec des estimations.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      loadConnectedCompanies(tx as never, admin.platformOrganizationId),
    )) as unknown as { views: unknown; summary: unknown };

    return json(res, 200, {
      views: result.views,
      summary: result.summary,
      /* Le périmètre est renvoyé avec les données : une vue « usage » qui ne dit
         pas ce qu'elle mesure sera lue comme de la télémétrie. */
      scope: 'supplier_engagement',
      telemetry: false,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/product-usage failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
