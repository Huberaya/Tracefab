import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { currentSupplier, requireSupplierMutationRole, requestedOrganizationId } from '../../../../_lib/supplier-profile.js';
import { DOCUMENT_SELECT, finalizeDocumentUpload, markDocumentScanning, scanDocumentStorage, serializeDocument } from '../../../../_lib/documents.js';
import { logStorageFailure } from '../../../../_lib/storage.js';

function routeDocumentId(req: VercelRequest) { const value = req.query.documentId; return Array.isArray(value) ? value[0] : value; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });
    const { user } = await requireClerkUser(req);
    const claim = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      await requireSupplierMutationRole(tx, user.id, supplier.organization_id);
      const current = await tx.documents.findFirst({ where: { id: documentId, owner_organization_id: supplier.organization_id, status: { in: ['uploaded', 'scanning'] } }, select: DOCUMENT_SELECT });
      if (!current) return null;
      if (!await markDocumentScanning(tx, current.id)) return { conflict: true as const };
      return { document: current };
    });
    if (!claim) return json(res, 404, { error: 'document_not_found' });
    if ('conflict' in claim) return json(res, 409, { error: 'document_not_in_scannable_state' });

    // Do not hold a Prisma transaction open during potentially slow S3 and
    // antivirus calls; authorization is rechecked by the SQL finalizer below.
    const outcome = await scanDocumentStorage(claim.document);
    const document = await withTracefabUserContext(user.id, user.email, (tx) =>
      finalizeDocumentUpload(tx, claim.document.id, outcome),
    );
    return json(res, 200, { document: serializeDocument(document), scan: { status: document.status === 'available' ? 'clean' : 'rejected' } });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'document_conflict' });
    if (error instanceof Error && error.message === 'document_object_not_found') return json(res, 409, { error: 'document_upload_incomplete' });
    if (error instanceof Error && /^document_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && /^private_storage_/.test(error.message)) {
      logStorageFailure('scan', error);
      return json(res, 503, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    logStorageFailure('scan', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
