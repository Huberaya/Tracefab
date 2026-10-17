import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId } from '../../../../_lib/supplier-profile.js';
import { runDocumentScanFlow } from '../../../../_lib/document-scan-flow.js';

function routeDocumentId(req: VercelRequest) { const value = req.query.documentId; return Array.isArray(value) ? value[0] : value; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });
    const { user } = await requireClerkUser(req);
    const supplier = await withTracefabUserContext(user.id, user.email, (tx) =>
      currentSupplier(tx, user.id, requestedOrganizationId(req)),
    );
    if (!supplier) return json(res, 404, { error: 'document_not_found' });

    const result = await runDocumentScanFlow(user, documentId, supplier.organization_id);
    if (result.kind === 'not_found') return json(res, 404, { error: 'document_not_found' });
    if (result.kind === 'retryable') {
      // Fail-closed : le document reste `scanning`, l'appel peut etre rejoue.
      return json(res, 503, { error: 'document_scan_unavailable', retryable: true });
    }
    return json(res, 200, result.body);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'document_conflict' });
    if (error instanceof Error && /^document_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && /^private_storage_/.test(error.message)) return json(res, 503, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/supplier/documents/:documentId/scan failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
