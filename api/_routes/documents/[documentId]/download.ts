import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { DOCUMENT_SELECT, serializeDocument } from '../../../_lib/documents.js';
import { presignedDownload } from '../../../_lib/storage.js';

function routeDocumentId(req: VercelRequest) { const value = req.query.documentId; return Array.isArray(value) ? value[0] : value; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
        SELECT tracefab_can_access_document(${documentId}::uuid) AS can_access
      `;
      if (!accessRows[0]?.can_access) return null;

      const document = await tx.documents.findFirst({
        where: { id: documentId, status: 'available' },
        select: DOCUMENT_SELECT,
      });
      if (!document) return null;
      return { document, download: presignedDownload(document.storage_path) };
    });
    if (!result) return json(res, 404, { error: 'document_not_available' });
    return json(res, 200, { document: serializeDocument(result.document), download: { url: result.download.url, expiresInSeconds: Number(process.env.PRIVATE_STORAGE_PRESIGN_SECONDS || 600) } });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^private_storage_/.test(error.message)) return json(res, 503, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/documents/:documentId/download failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
