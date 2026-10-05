import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Prisma } from '@prisma/client';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { currentSupplier, requestedOrganizationId } from '../../_lib/supplier-profile';
import { certificationValues, serializeSupplierCertification, SUPPLIER_CERTIFICATION_SELECT, type SupplierCertificationRecord } from '../../_lib/supplier-certifications';

function routeCertificationId(req: VercelRequest) {
  const value = req.query.certificationId;
  return Array.isArray(value) ? value[0] : value;
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);
  try {
    const certificationId = routeCertificationId(req);
    if (!isUuid(certificationId)) return json(res, 400, { error: 'invalid_certification_id' });
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      const current = await tx.certifications.findFirst({ where: { id: certificationId, owner_organization_id: supplier.organization_id, supplier_id: supplier.id }, select: SUPPLIER_CERTIFICATION_SELECT });
      if (!current) return null;
      const values = certificationValues(await readJsonBody<Record<string, unknown>>(req), current);
      if (values.supplierSiteId) {
        const site = await tx.supplier_sites.findFirst({ where: { id: values.supplierSiteId, supplier_id: supplier.id }, select: { id: true } });
        if (!site) throw new Error('invalid_supplier_site_id');
      }
      if (values.documentId) {
        const document = await tx.documents.findFirst({ where: { id: values.documentId, owner_organization_id: supplier.organization_id, status: 'available' }, select: { id: true } });
        if (!document) throw new Error('invalid_document_id');
      }
      const rows = await tx.$queryRaw<SupplierCertificationRecord[]>`
        SELECT * FROM tracefab_update_certification(
          ${certificationId}::uuid,
          ${values.standardName},
          ${values.standardCode},
          ${values.issuerName},
          ${values.certificateNumber},
          ${values.issuedAt}::date,
          ${values.expiresAt}::date,
          ${values.documentId}::uuid
        )
      `;
      return rows[0] ?? null;
    });
    if (!result) return json(res, 404, { error: 'certification_not_found' });
    return json(res, 200, { certification: serializeSupplierCertification(result) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'certification_already_exists' });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('PATCH /api/supplier/certifications/:certificationId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
