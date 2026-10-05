import type { Prisma } from '@prisma/client';

export const SUPPLIER_CERTIFICATION_SELECT = {
  id: true,
  owner_organization_id: true,
  supplier_id: true,
  supplier_site_id: true,
  standard_name: true,
  standard_code: true,
  issuer_name: true,
  certificate_number: true,
  issued_at: true,
  expires_at: true,
  document_id: true,
  status: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  last_verified_at: true,
  last_verified_by: true,
} satisfies Prisma.certificationsSelect;

export type SupplierCertificationRecord = Prisma.certificationsGetPayload<{ select: typeof SUPPLIER_CERTIFICATION_SELECT }>;

export function serializeSupplierCertification(certification: SupplierCertificationRecord) {
  return {
    id: certification.id,
    ownerOrganizationId: certification.owner_organization_id,
    supplierId: certification.supplier_id,
    supplierSiteId: certification.supplier_site_id,
    standardName: certification.standard_name,
    standardCode: certification.standard_code,
    issuerName: certification.issuer_name,
    certificateNumber: certification.certificate_number,
    issuedAt: certification.issued_at,
    expiresAt: certification.expires_at,
    documentId: certification.document_id,
    status: certification.status,
    createdBy: certification.created_by,
    createdAt: certification.created_at,
    updatedAt: certification.updated_at,
    lastVerifiedAt: certification.last_verified_at,
    lastVerifiedBy: certification.last_verified_by,
  };
}

export function certificationString(value: unknown, field: string, maxLength: number, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`invalid_${field}`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > maxLength || (required && value.trim().length === 0)) throw new Error(`invalid_${field}`);
  return value.trim() || null;
}

export function certificationDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`invalid_${field}`);
  return value;
}

export function certificationValues(body: Record<string, unknown>, current?: SupplierCertificationRecord) {
  const allowedKeys = new Set(['supplierSiteId', 'documentId', 'standardName', 'standardCode', 'issuerName', 'certificateNumber', 'issuedAt', 'expiresAt']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_certification_fields');
  const supplierSiteId = Object.prototype.hasOwnProperty.call(body, 'supplierSiteId') ? body.supplierSiteId : current?.supplier_site_id ?? null;
  if (supplierSiteId !== null && supplierSiteId !== undefined && (typeof supplierSiteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(supplierSiteId))) throw new Error('invalid_supplier_site_id');
  const documentId = Object.prototype.hasOwnProperty.call(body, 'documentId') ? body.documentId : current?.document_id ?? null;
  if (documentId !== null && documentId !== undefined && (typeof documentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(documentId))) throw new Error('invalid_document_id');
  const standardName = Object.prototype.hasOwnProperty.call(body, 'standardName') ? certificationString(body.standardName, 'certification_standard_name', 240, true) : current?.standard_name;
  const standardCode = Object.prototype.hasOwnProperty.call(body, 'standardCode') ? certificationString(body.standardCode, 'certification_standard_code', 120) : current?.standard_code ?? null;
  const issuerName = Object.prototype.hasOwnProperty.call(body, 'issuerName') ? certificationString(body.issuerName, 'certification_issuer_name', 240) : current?.issuer_name ?? null;
  const certificateNumber = Object.prototype.hasOwnProperty.call(body, 'certificateNumber') ? certificationString(body.certificateNumber, 'certificate_number', 180) : current?.certificate_number ?? null;
  const issuedAt = Object.prototype.hasOwnProperty.call(body, 'issuedAt') ? certificationDate(body.issuedAt, 'certification_issued_at') : current?.issued_at ? current.issued_at.toISOString().slice(0, 10) : null;
  const expiresAt = Object.prototype.hasOwnProperty.call(body, 'expiresAt') ? certificationDate(body.expiresAt, 'certification_expires_at') : current?.expires_at ? current.expires_at.toISOString().slice(0, 10) : null;
  if (issuedAt && expiresAt && expiresAt < issuedAt) throw new Error('invalid_certification_date_range');
  return { supplierSiteId: supplierSiteId || null, documentId: documentId || null, standardName, standardCode, issuerName, certificateNumber, issuedAt, expiresAt };
}
