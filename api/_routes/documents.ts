import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../_lib/tenant.js';
import { DOCUMENT_SELECT, serializeDocument } from '../_lib/documents.js';

/**
 * GET /api/documents — registre des documents de la marque active.
 *
 * POURQUOI CETTE ROUTE EXISTE
 *
 * Les barrieres DPP `traceability.documented` et `evidence.product_data`
 * exigent un DOCUMENT rattache (noeud de chaine, point de donnee). L'API
 * acceptait deja `sourceDocumentId` a l'ecriture, mais aucune route ne
 * listait les documents : l'interface ne pouvait donc proposer que des
 * champs libres, et les deux barrieres restaient hors d'atteinte.
 *
 * PORTEE — volontairement etroite
 *
 * Seuls les documents dont la marque active est PROPRIETAIRE sont listes.
 * Un document fournisseur n'apparait pas ici : il arrive par la collecte
 * (reponse + document, pont SQL vers `data_points`), pas en le piochant dans
 * le registre d'une autre organisation. Cette asymmetrie est deliberée : la
 * liste ne doit pas devenir un moyen de decouvrir l'existence de pieces
 * appartenant a un tiers.
 *
 * Lecture seule : aucun ecrit, aucun televersement. Le depot passe par
 * `POST /api/documents/upload-intent` puis le scan antivirus.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      const documents = await tx.documents.findMany({
        where: {
          owner_organization_id: tenant.organizationId,
          deleted_at: null,
        },
        select: DOCUMENT_SELECT,
        orderBy: { created_at: 'desc' },
        take: 200,
      });
      return { documents };
    }, requestedTenantId(req));

    return json(res, 200, { documents: result.documents.map(serializeDocument) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    console.error('GET /api/documents failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
