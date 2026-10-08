import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../../../_lib/products.js';
import { DOCUMENT_SELECT, scanAndFinalizeDocument, serializeDocument } from '../../../_lib/documents.js';

/* Chantier 08 — Evidence Center : analyse antivirus + finalisation d'une
   preuve appartenant a une organisation marque de l'utilisateur. Meme
   garde-fou tenant que la liste (activeBrandOrganizationIds), meme moteur
   de scan que le portail fournisseur (scanAndFinalizeDocument). */

function routeDocumentId(req: VercelRequest) { const value = req.query.documentId; return Array.isArray(value) ? value[0] : value; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });
    const { user } = await requireClerkUser(req);
    const document = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      if (!brandIds.length) return null;
      const current = await tx.documents.findFirst({
        where: { id: documentId, owner_organization_id: { in: brandIds }, status: { in: ['uploaded', 'scanning'] } },
        select: DOCUMENT_SELECT,
      });
      if (!current) return null;
      return scanAndFinalizeDocument(tx, current);
    });
    if (!document) return json(res, 404, { error: 'document_not_found' });
    return json(res, 200, { document: serializeDocument(document), scan: { status: document.status === 'available' ? 'clean' : 'rejected' } });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'document_conflict' });
    if (error instanceof Error && /^document_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && /^private_storage_/.test(error.message)) return json(res, 503, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/documents/:documentId/scan failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
