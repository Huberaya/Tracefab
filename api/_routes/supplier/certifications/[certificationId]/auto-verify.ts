import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId } from '../../../../_lib/supplier-profile.js';
import { extractDocumentAi, verifyDocumentWithAi } from '../../../../_lib/document-ai.js';
import {
  serializeSupplierCertification,
  SUPPLIER_CERTIFICATION_SELECT,
  type SupplierCertificationRecord,
} from '../../../../_lib/supplier-certifications.js';

function routeCertificationId(req: VercelRequest) {
  const value = req.query.certificationId;
  return Array.isArray(value) ? value[0] : value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const certificationId = routeCertificationId(req);
    if (!isUuid(certificationId)) return json(res, 400, { error: 'invalid_certification_id' });

    const { user } = await requireClerkUser(req);
    const body: { referenceDate?: string } = await readJsonBody<{ referenceDate?: string }>(req).catch(() => ({}));

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;

      const cert = await tx.certifications.findFirst({
        where: { id: certificationId, owner_organization_id: supplier.organization_id },
        select: SUPPLIER_CERTIFICATION_SELECT,
      });

      if (!cert) return { certNotFound: true };
      if (!cert.document_id) return { noDocument: true };

      const docRows = await tx.$queryRaw<Array<{
        id: string;
        original_filename: string;
        metadata: Record<string, unknown> | null;
        expires_at: string | null;
        status: string;
      }>>`
        SELECT id, original_filename, metadata, expires_at::text, status
        FROM documents
        WHERE id = ${cert.document_id}::uuid;
      `;

      if (!docRows[0] || docRows[0].status !== 'available') {
        return { documentNotAvailable: true };
      }

      const doc = docRows[0];
      const text = `${doc.original_filename} ${cert.standard_name} ${cert.standard_code || ''} ${cert.issuer_name || ''} ${cert.certificate_number || ''}`;
      const extracted = extractDocumentAi(text, doc.original_filename, {
        issuedAt: cert.issued_at,
        expiresAt: cert.expires_at || doc.expires_at,
      });

      const decision = verifyDocumentWithAi(extracted, {
        referenceDate: body.referenceDate || '2026-10-06',
      });

      await tx.$executeRaw`
        SELECT tracefab_apply_document_ai_verification(
          ${cert.document_id}::uuid,
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
        );
      `;

      const updatedCert = await tx.certifications.findUnique({
        where: { id: certificationId },
        select: SUPPLIER_CERTIFICATION_SELECT,
      });

      return {
        success: true,
        certification: updatedCert,
        decision,
      };
    });

    if (!result) return json(res, 404, { error: 'supplier_profile_not_found' });
    if ('certNotFound' in result) return json(res, 404, { error: 'certification_not_found' });
    if ('noDocument' in result) return json(res, 400, { error: 'certification_has_no_document' });
    if ('documentNotAvailable' in result) return json(res, 409, { error: 'document_not_available' });

    return json(res, 200, {
      certification: serializeSupplierCertification(result.certification!),
      decision: result.decision,
      verified: result.decision.status === 'passed',
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/supplier/certifications/:id/auto-verify failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
