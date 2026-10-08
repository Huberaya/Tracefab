import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../../../_lib/products.js';
import {
  SUPPLIER_CERTIFICATION_SELECT,
  serializeSupplierCertification,
  type SupplierCertificationRecord,
} from '../../../_lib/supplier-certifications.js';

/* Chantier 09 — Certification Intelligence : revue humaine d'un certificat.
   La confirmation est toujours humaine (jamais de promotion automatique) :
   tracefab_review_certification insere un verification_record et derive le
   statut (verified_by_reviewer / needs_review / expired). Limitee aux
   certificats appartenant aux organisations marque actives de l'utilisateur
   — la revue des certificats fournisseurs reste dans le portail fournisseur
   (la fonction SQL exige un role dans l'organisation proprietaire). */

const VERIFICATION_STATUSES = ['passed', 'failed', 'needs_review', 'expired'] as const;

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
    const body = await readJsonBody<{ verificationStatus?: unknown; method?: unknown; notes?: unknown }>(req);

    const verificationStatus = typeof body.verificationStatus === 'string' ? body.verificationStatus : '';
    if (!VERIFICATION_STATUSES.includes(verificationStatus as (typeof VERIFICATION_STATUSES)[number])) {
      return json(res, 400, { error: 'unsupported_certification_verification_status' });
    }
    const method = typeof body.method === 'string' ? body.method.trim() : '';
    if (!method || method.length > 240) return json(res, 400, { error: 'verification_method_required' });
    const notes = typeof body.notes === 'string' && body.notes.trim().length <= 2000 ? body.notes.trim() : null;

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      if (!brandIds.length) return null;
      const existing = await tx.certifications.findFirst({
        where: { id: certificationId, owner_organization_id: { in: brandIds } },
        select: { id: true },
      });
      if (!existing) return { notFound: true as const };
      const rows = await tx.$queryRaw<SupplierCertificationRecord[]>`
        SELECT * FROM tracefab_review_certification(
          ${certificationId}::uuid,
          ${verificationStatus}::verification_status,
          ${method}::text,
          ${notes}::text,
          NULL::uuid
        )
      `;
      return { certification: rows[0] ?? null };
    });

    if (!result) return json(res, 404, { error: 'brand_profile_not_found' });
    if ('notFound' in result) return json(res, 404, { error: 'certification_not_found' });
    if (!result.certification) return json(res, 500, { error: 'certification_review_failed' });
    return json(res, 200, { certification: serializeSupplierCertification(result.certification) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/certifications/:certificationId/review failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
