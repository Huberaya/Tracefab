import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabRequestContext } from '../_lib/context.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { DOCUMENT_SELECT, serializeDocument } from '../_lib/documents.js';
import { isUuid } from '../_lib/products.js';
import { isTenantError, requireActiveTenant, tenantFilter } from '../_lib/tenant.js';

/**
 * Liste des preuves documentaires de la MARQUE.
 *
 * Le portail fournisseur a sa propre route (`/api/supplier/documents`) ; la
 * console marque n'en avait aucune : `state.documents` restait `null` et
 * l'Evidence Centre affichait « non calculé » en permanence, avec des boutons
 * de depot desactives. Cette route ne cree AUCUN second systeme de stockage :
 * elle relit la table `documents` via le client Prisma du depot, bornee au
 * locataire actif (RLS + filtre explicite), et rattache la derniere decision
 * de validation pour afficher un etat honnete.
 *
 * Filtre optionnel `?productId=<uuid>` : les preuves liees a un dossier
 * produit par `metadata.productId` (pose par l'upload-intent). Le filtrage
 * est fait cote serveur, apres lecture ; aucun parametre client ne peut
 * elargir le perimetre du locataire.
 */
function firstValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

type ValidationRow = {
  id: string; document_id: string | null; method: string; status: string;
  notes: string | null; verified_at: Date | null; created_at: Date;
};

/** Projette une ligne documentaire avec sa derniere decision de validation. */
function withValidation(document: ReturnType<typeof serializeDocument>, validation: ValidationRow | undefined) {
  return {
    ...document,
    validation: validation ? {
      id: validation.id,
      method: validation.method,
      status: validation.status,
      reason: validation.notes,
      verifiedAt: validation.verified_at,
      createdAt: validation.created_at,
    } : null,
  };
}

/** Filtre serveur : ne garder que les preuves liees au dossier demande. */
function belongsToProduct(document: ReturnType<typeof withValidation>, productId: string | null): boolean {
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
    const result = await withTracefabRequestContext(req, user, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      const documents = await tx.documents.findMany({
        where: {
          owner_organization_id: tenantFilter(tenant),
          status: { not: 'deleted' },
        },
        select: DOCUMENT_SELECT,
        orderBy: { created_at: 'desc' },
        take: 200,
      });
      const ids = documents.map((document) => document.id);
      const verifications = ids.length
        ? await tx.verification_records.findMany({
            where: { document_id: { in: ids } },
            select: {
              id: true, document_id: true, method: true, status: true,
              notes: true, verified_at: true, created_at: true,
            },
            orderBy: { created_at: 'desc' },
            take: 500,
          })
        : [];
      return { documents, verifications };
    });

    const latest = new Map<string, (typeof result.verifications)[number]>();
    for (const record of result.verifications) {
      if (record.document_id && !latest.has(record.document_id)) latest.set(record.document_id, record);
    }

    const documents = result.documents
      .map((document) => withValidation(serializeDocument(document), latest.get(document.id)))
      .filter((document) => belongsToProduct(document, productId));

    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { documents });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/documents failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
