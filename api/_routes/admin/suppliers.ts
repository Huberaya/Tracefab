import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { loadConnectedCompanies } from '../../_lib/crm-connection.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/suppliers — §1, les fournisseurs des comptes connectés.
 *
 * Lecture seule. Trois populations distinctes dans la réponse :
 *
 *   measured        l'organisation est liée ET l'admin en est membre : les
 *                   chiffres viennent de la table `suppliers`. Un zéro ici est un
 *                   zéro réel.
 *   declared        pas de lien : seul le `supplier_count` saisi par l'équipe.
 *   not_accessible  lié, mais RLS a refusé — `suppliers_select_authorized` exige
 *                   d'être membre de l'organisation. AUCUN chiffre mesuré n'est
 *                   renvoyé, pas même zéro : zéro est une mesure, et une mesure
 *                   inventée est pire qu'un vide.
 *
 * Cette route ne contourne pas RLS. Elle constate ce qu'il permet.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      loadConnectedCompanies(tx as never, admin.platformOrganizationId),
    )) as unknown;

    return json(res, 200, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/suppliers failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
