import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../_lib/products.js';
import { DOCUMENT_SELECT, serializeDocument } from '../_lib/documents.js';

/* Chantier 08 — Evidence Center : liste des preuves appartenant aux
   organisations marque actives de l'utilisateur. Isolation tenant par
   activeBrandOrganizationIds (comme les autres routes produit), documents
   soft-delete exclus, liaisons reelles comptees depuis les relations de la
   table documents (certifications, reponses, graphe, green claims,
   enregistrements de verification). Aucun champ invente. */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);
    const documents = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      if (!brandIds.length) return [];
      return tx.documents.findMany({
        where: { owner_organization_id: { in: brandIds }, status: { not: 'deleted' } },
        select: {
          ...DOCUMENT_SELECT,
          _count: {
            select: {
              certifications: true,
              data_points: true,
              data_responses: true,
              supply_chain_nodes: true,
              supply_chain_links: true,
              product_green_claims: true,
              transaction_certificates: true,
              verification_records: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: 500,
      });
    });
    return json(res, 200, {
      documents: documents.map((document) => ({
        ...serializeDocument(document),
        links: {
          certifications: document._count.certifications,
          dataPoints: document._count.data_points,
          dataResponses: document._count.data_responses,
          supplyChainNodes: document._count.supply_chain_nodes,
          supplyChainLinks: document._count.supply_chain_links,
          greenClaims: document._count.product_green_claims,
          transactionCertificates: document._count.transaction_certificates,
        },
        verifications: document._count.verification_records,
      })),
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/documents failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
