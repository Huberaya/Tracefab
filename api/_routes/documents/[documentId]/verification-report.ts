import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

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
      // 1. Verify access to document
      const docRows = await tx.$queryRaw<Array<{
        id: string;
        owner_organization_id: string;
        original_filename: string;
        content_type: string;
        status: string;
        metadata: Record<string, unknown> | null;
        created_at: string;
        available_at: string | null;
        expires_at: string | null;
      }>>`
        SELECT id, owner_organization_id, original_filename, content_type, status, metadata,
               created_at::text, available_at::text, expires_at::text
        FROM documents
        WHERE id = ${documentId}::uuid
          AND status <> 'deleted'
          AND tracefab_can_access_document(${documentId}::uuid);
      `;

      if (!docRows[0]) return null;
      const doc = docRows[0];

      // 2. Fetch verification records history
      const verifications = await tx.$queryRaw<Array<{
        id: string;
        method: string;
        status: string;
        notes: string | null;
        verified_at: string | null;
        created_at: string;
      }>>`
        SELECT id, method, status, notes, verified_at::text, created_at::text
        FROM verification_records
        WHERE document_id = ${documentId}::uuid
        ORDER BY created_at DESC;
      `;

      // 3. Fetch linked certifications
      const certifications = await tx.$queryRaw<Array<{
        id: string;
        standard_name: string;
        standard_code: string | null;
        issuer_name: string | null;
        certificate_number: string | null;
        issued_at: string | null;
        expires_at: string | null;
        status: string;
      }>>`
        SELECT id, standard_name, standard_code, issuer_name, certificate_number,
               issued_at::text, expires_at::text, status
        FROM certifications
        WHERE document_id = ${documentId}::uuid;
      `;

      return {
        document: {
          id: doc.id,
          ownerOrganizationId: doc.owner_organization_id,
          originalFilename: doc.original_filename,
          contentType: doc.content_type,
          status: doc.status,
          createdAt: doc.created_at,
          availableAt: doc.available_at,
          expiresAt: doc.expires_at,
          aiVerification: doc.metadata?.ai_verification || null,
        },
        verifications,
        certifications,
        latestAiStatus: (doc.metadata?.ai_status as string) || (verifications[0]?.status ?? 'unverified'),
      };
    });

    if (!report) return json(res, 404, { error: 'document_not_found' });

    return json(res, 200, { report });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/documents/:documentId/verification-report failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
