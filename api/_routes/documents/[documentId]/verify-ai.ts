import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { extractDocumentAi, verifyDocumentWithAi } from '../../../_lib/document-ai.js';

function routeDocumentId(req: VercelRequest) {
  const value = req.query.documentId;
  return Array.isArray(value) ? value[0] : value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

interface VerifyAiBody {
  textSample?: string;
  referenceDate?: string;
  hints?: Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const documentId = routeDocumentId(req);
    if (!isUuid(documentId)) return json(res, 400, { error: 'invalid_document_id' });

    const { user } = await requireClerkUser(req);
    const body: VerifyAiBody = await readJsonBody<VerifyAiBody>(req).catch(() => ({}));

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // 1. Verify access to document
      const docRows = await tx.$queryRaw<Array<{
        id: string;
        owner_organization_id: string;
        original_filename: string;
        content_type: string;
        status: string;
        metadata: Record<string, unknown> | null;
        expires_at: string | null;
      }>>`
        SELECT id, owner_organization_id, original_filename, content_type, status, metadata, expires_at::text
        FROM documents
        WHERE id = ${documentId}::uuid
          AND status <> 'deleted'
          AND tracefab_can_access_document(${documentId}::uuid);
      `;

      if (!docRows[0]) return { notFound: true };
      const doc = docRows[0];

      if (doc.status !== 'available') {
        return { notAvailable: true };
      }

      // 2. Prepare text input for AI engine
      const metadata = (doc.metadata || {}) as Record<string, unknown>;
      const text = body.textSample ||
        (typeof metadata.ocrText === 'string' ? metadata.ocrText : '') ||
        `${doc.original_filename} ${JSON.stringify(metadata)}`;

      const hints = {
        ...metadata,
        ...(body.hints || {}),
        expiresAt: body.hints?.expiresAt || doc.expires_at || metadata.expiresAt,
      };

      // 3. Extract metadata using Document AI engine
      const extracted = extractDocumentAi(text, doc.original_filename, hints);

      // 4. Verify evidence against official registry rules and reference date
      const decision = verifyDocumentWithAi(extracted, {
        referenceDate: body.referenceDate || '2026-10-06',
      });

      // 5. Apply verification to database via atomic stored procedure
      const applied = await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>`
        SELECT tracefab_apply_document_ai_verification(
          ${documentId}::uuid,
          ${decision.status}::verification_status,
          'ai_document_forensics_v1'::text,
          ${decision.summary}::text,
          ${decision.extracted.standardKey}::text,
          ${decision.extracted.standardName}::text,
          ${decision.extracted.standardCode}::text,
          ${decision.extracted.certificateNumber}::text,
          ${decision.extracted.issuerName}::text,
          ${decision.extracted.issuedAt}::date,
          ${decision.extracted.expiresAt}::date,
          ${decision.confidenceScore}::numeric,
          ${JSON.stringify(decision)}::jsonb
        ) AS payload;
      `;

      return {
        success: true,
        documentId,
        decision,
        dbPayload: applied[0]?.payload || null,
      };
    });

    if (result.notFound) return json(res, 404, { error: 'document_not_found' });
    if (result.notAvailable) return json(res, 409, { error: 'document_not_available' });

    return json(res, 200, {
      documentId: result.documentId,
      verified: result.decision.status === 'passed',
      status: result.decision.status,
      decision: result.decision,
      summary: result.decision.summary,
      meta: result.dbPayload,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'conflict' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/documents/:documentId/verify-ai failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
