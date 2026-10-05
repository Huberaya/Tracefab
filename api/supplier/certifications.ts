import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import { currentSupplier } from '../_lib/supplier-profile';
import {
  certificationValues,
  serializeSupplierCertification,
  SUPPLIER_CERTIFICATION_SELECT,
  type SupplierCertificationRecord,
} from '../_lib/supplier-certifications';

type CertificationBody = Record<string, unknown>;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id);
      if (!supplier) return null;
      if (req.method === 'GET') {
        const certifications = await tx.certifications.findMany({
          where: { owner_organization_id: supplier.organization_id, supplier_id: supplier.id },
          select: SUPPLIER_CERTIFICATION_SELECT,
          orderBy: { created_at: 'desc' },
        });
        return { certifications };
      }

      const body = await readJsonBody<CertificationBody>(req);
      const values = certificationValues(body);
      if (values.supplierSiteId) {
        const site = await tx.supplier_sites.findFirst({ where: { id: values.supplierSiteId, supplier_id: supplier.id }, select: { id: true } });
        if (!site) throw new Error('invalid_supplier_site_id');
      }
      if (values.documentId) {
        const document = await tx.documents.findFirst({ where: { id: values.documentId, owner_organization_id: supplier.organization_id, status: 'available' }, select: { id: true } });
        if (!document) throw new Error('invalid_document_id');
      }
      const rows = await tx.$queryRaw<SupplierCertificationRecord[]>`
        SELECT * FROM tracefab_register_certification(
          ${supplier.organization_id}::uuid,
          ${supplier.id}::uuid,
          ${values.supplierSiteId}::uuid,
          NULL::uuid,
          ${values.standardName},
          ${values.standardCode},
          ${values.issuerName},
          ${values.certificateNumber},
          ${values.issuedAt}::date,
          ${values.expiresAt}::date,
          ${values.documentId}::uuid
        )
      `;
      return { certification: rows[0] ?? null };
    });
    if (!result) return json(res, 404, { error: 'supplier_profile_not_found' });
    if ('certifications' in result) return json(res, 200, { certifications: result.certifications.map(serializeSupplierCertification) });
    if (!result.certification) return json(res, 500, { error: 'certification_creation_failed' });
    return json(res, 201, { certification: serializeSupplierCertification(result.certification) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'certification_already_exists' });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/certifications failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
