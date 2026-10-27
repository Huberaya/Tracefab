import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { DOCUMENT_SELECT, serializeDocument } from '../../../_lib/documents.js';
import { unavailableSecurityAttestations } from '../../../_lib/document-security-report.js';

function routeDocumentId(req: VercelRequest) {
  const value = req.query.documentId;
  return Array.isArray(value) ? value[0] : value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });
    const { user } = await requireClerkUser(req);

    const report = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
        SELECT tracefab_can_access_document(${documentId}::uuid) AS can_access
      `;
      if (!accessRows[0]?.can_access) return null;

      const doc = await tx.documents.findFirst({
        where: { id: documentId },
        select: {
          ...DOCUMENT_SELECT,
          organizations: { select: { legal_name: true, type: true } },
        },
      });
      if (!doc) return null;

      // La metadata est fournie par le client et ne constitue jamais une
      // attestation antivirus. L'etat du document ne prouve pas non plus
      // quel moteur ni quel chiffrement ont effectivement ete utilises.
      const attestations = unavailableSecurityAttestations();

      return {
        document: serializeDocument(doc),
        organization: doc.organizations,
        integrity: {
          sha256: doc.sha256,
          byteSize: Number(doc.byte_size),
          isEncryptedAtRest: attestations.isEncryptedAtRest,
          storageBucket: doc.storage_bucket,
        },
        antivirus: attestations.antivirus,
        compliance: {
          isAvailable: doc.status === 'available',
          isQuarantined: doc.status === 'rejected',
          isExpired: doc.expires_at ? new Date(doc.expires_at) < new Date() : false,
        },
      };
    });

    if (!report) return json(res, 404, { error: 'document_not_found' });
    return json(res, 200, { securityReport: report });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/documents/:documentId/security-report failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
