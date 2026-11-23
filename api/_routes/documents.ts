import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../_lib/tenant.js';
import { DOCUMENT_SELECT, serializeDocument } from '../_lib/documents.js';
import { isUuid } from '../_lib/products.js';

/**
 * GET /api/documents — registre des documents de la marque active, avec la
 * derniere decision de validation de chacun.
 *
 * POURQUOI CETTE ROUTE EXISTE
 *
 * Les barrieres DPP `traceability.documented` et `evidence.product_data`
 * exigent un DOCUMENT rattache (noeud de chaine, point de donnee). L'API
 * acceptait deja `sourceDocumentId` a l'ecriture, mais aucune route ne
 * listait les documents : l'interface ne pouvait donc proposer que des
 * champs libres, et les deux barrieres restaient hors d'atteinte. La console
 * marque n'avait par ailleurs aucun moyen d'afficher l'etat reel des preuves
 * deposees : l'Evidence Centre restait sur « non calcule », avec des boutons
 * de depot desactives.
 *
 * PORTEE — volontairement etroite
 *
 * Seuls les documents dont la marque active est PROPRIETAIRE sont listes. Un
 * document fournisseur n'apparait pas ici : il arrive par la collecte
 * (reponse + document, pont SQL vers `data_points`), pas en le piochant dans
 * le registre d'une autre organisation. Cette asymetrie est deliberee : la
 * liste ne doit pas devenir un moyen de decouvrir l'existence de pieces
 * appartenant a un tiers.
 *
 * Cette route ne cree AUCUN second systeme de stockage : elle relit la table
 * `documents` via le client Prisma du depot, bornee au locataire actif, et
 * rattache la derniere decision de validation pour afficher un etat honnete.
 * Elle n'ecrit rien, ne televerse rien et ne declenche aucune analyse. Le
 * depot passe par `POST /api/documents/upload-intent` puis le scan antivirus.
 *
 * FILTRE `?productId=<uuid>`
 *
 * Les preuves liees a un dossier produit par `metadata.productId` (pose par
 * l'upload-intent). Le filtrage est fait cote serveur, apres lecture ; aucun
 * parametre client ne peut elargir le perimetre du locataire.
 *
 * CONTEXTE — `withTracefabUserContext`, pas `withTracefabRequestContext`
 *
 * `withTracefabRequestContext(req, user, cb)` n'est qu'une enveloppe de
 * `withTracefabUserContext(user.id, user.email, cb, requestedTenantId(req))` :
 * les deux posent exactement les memes GUC. L'enveloppe a une valeur
 * d'expressivite quand le handler ne transmet rien d'autre, mais elle cache le
 * locataire actif — precisement la valeur dont cette route depend pour ne pas
 * fuiter. On garde donc la forme explicite, comme le faisait deja cette route,
 * et `requestedTenantId(req)` est lu une seule fois.
 */
function firstValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

type ValidationRow = {
  id: string;
  document_id: string | null;
  method: string;
  status: string;
  notes: string | null;
  verified_at: Date | null;
  created_at: Date;
};

/** Projette une ligne documentaire avec sa derniere decision de validation. */
function withValidation(
  document: ReturnType<typeof serializeDocument>,
  validation: ValidationRow | undefined,
) {
  return {
    ...document,
    validation: validation
      ? {
          id: validation.id,
          method: validation.method,
          status: validation.status,
          reason: validation.notes,
          verifiedAt: validation.verified_at,
          createdAt: validation.created_at,
        }
      : null,
  };
}

/** Filtre serveur : ne garder que les preuves liees au dossier demande. */
function belongsToProduct(document: { metadata: unknown }, productId: string | null): boolean {
  if (!productId) return true;
  const metadata = document.metadata as Record<string, unknown> | null;
  return Boolean(metadata && typeof metadata === 'object' && metadata.productId === productId);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const productId = firstValue(req.query.productId);
    if (productId && !isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });

    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(
      user.id,
      user.email,
      async (tx) => {
        const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
        // Suppression logique : la fonction SQL `tracefab_delete_document` pose
        // `status = 'deleted'` ET `deleted_at`. Les deux filtres sont donc
        // equivalents aujourd'hui. On garde les DEUX : le jour ou un chemin
        // poserait l'un sans l'autre, la liste ne fuira pas pour autant. Le
        // filtre `status` est aussi celui de la route fournisseur
        // (`api/_routes/supplier/documents.ts`) et de `serializeDocument`.
        const documents = await tx.documents.findMany({
          where: {
            owner_organization_id: tenant.organizationId,
            deleted_at: null,
            status: { not: 'deleted' },
          },
          select: DOCUMENT_SELECT,
          orderBy: { created_at: 'desc' },
          take: 200,
        });
        // Une seule requete pour toutes les validations, bornee aux documents
        // de CE locataire : pas de N+1, et pas de jointure qui ramenerait la
        // ligne d'un tiers.
        const ids = documents.map((document) => document.id);
        const verifications = ids.length
          ? await tx.verification_records.findMany({
              where: { document_id: { in: ids } },
              select: {
                id: true,
                document_id: true,
                method: true,
                status: true,
                notes: true,
                verified_at: true,
                created_at: true,
              },
              orderBy: { created_at: 'desc' },
              take: 500,
            })
          : [];
        return { documents, verifications };
      },
      requestedTenantId(req),
    );

    // `orderBy` descend : la PREMIERE ligne rencontree pour un document est la
    // plus recente. `take: 500` peut tronquer l'historique d'un tres gros
    // compte ; dans ce cas la decision affichee reste la plus recente des 500,
    // jamais une decision plus ancienne presentee comme actuelle.
    const latest = new Map<string, ValidationRow>();
    for (const record of result.verifications) {
      if (record.document_id && !latest.has(record.document_id)) {
        latest.set(record.document_id, record);
      }
    }

    const documents = result.documents
      .map((document) => withValidation(serializeDocument(document), latest.get(document.id)))
      .filter((document) => belongsToProduct(document, productId));

    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { documents });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    console.error('GET /api/documents failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
