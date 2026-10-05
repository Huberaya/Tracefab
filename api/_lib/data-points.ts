import type { Prisma } from '@prisma/client';

export const DATA_POINT_SELECT = {
  id: true,
  owner_organization_id: true,
  supplier_id: true,
  supplier_site_id: true,
  product_id: true,
  material_id: true,
  data_key: true,
  value: true,
  data_type: true,
  status: true,
  source_document_id: true,
  declared_by: true,
  valid_from: true,
  valid_until: true,
  version: true,
  supersedes_id: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.data_pointsSelect;

export type DataPointRecord = Prisma.data_pointsGetPayload<{ select: typeof DATA_POINT_SELECT }>;

export const SUPPLIER_DATA_TYPES = new Set(['text', 'number', 'boolean', 'date', 'country', 'percentage', 'json']);

export function serializeDataPoint(point: DataPointRecord) {
  return {
    id: point.id,
    ownerOrganizationId: point.owner_organization_id,
    supplierId: point.supplier_id,
    supplierSiteId: point.supplier_site_id,
    productId: point.product_id,
    materialId: point.material_id,
    dataKey: point.data_key,
    value: point.value,
    dataType: point.data_type,
    status: point.status,
    sourceDocumentId: point.source_document_id,
    declaredBy: point.declared_by,
    validFrom: point.valid_from,
    validUntil: point.valid_until,
    version: point.version,
    supersedesId: point.supersedes_id,
    createdAt: point.created_at,
    updatedAt: point.updated_at,
  };
}

export function dataPointDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`invalid_${field}`);
  return new Date(`${value}T00:00:00Z`);
}

export function validateDataPointValue(dataType: string, value: unknown) {
  if (!SUPPLIER_DATA_TYPES.has(dataType)) throw new Error('invalid_data_type');
  if (dataType === 'text' && (typeof value !== 'string' || value.length > 10000)) throw new Error('invalid_data_point_value');
  if (dataType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('invalid_data_point_value');
  if (dataType === 'boolean' && typeof value !== 'boolean') throw new Error('invalid_data_point_value');
  if (dataType === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) throw new Error('invalid_data_point_value');
  if (dataType === 'country' && (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value))) throw new Error('invalid_data_point_value');
  if (dataType === 'percentage' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)) throw new Error('invalid_data_point_value');
  if (dataType === 'json' && (typeof value !== 'object' || value === null || JSON.stringify(value).length > 50000)) throw new Error('invalid_data_point_value');
  return dataType === 'country' && typeof value === 'string' ? value.toUpperCase() : value;
}

export function dataPointMutation(body: Record<string, unknown>) {
  const allowedKeys = new Set(['dataKey', 'dataType', 'value', 'subjectType', 'subjectId', 'sourceDocumentId', 'validFrom', 'validUntil']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_data_point_fields');
  if (typeof body.dataKey !== 'string' || body.dataKey.trim().length === 0 || body.dataKey.trim().length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(body.dataKey.trim())) throw new Error('invalid_data_key');
  if (typeof body.dataType !== 'string' || !SUPPLIER_DATA_TYPES.has(body.dataType)) throw new Error('invalid_data_type');
  if (!Object.prototype.hasOwnProperty.call(body, 'value')) throw new Error('data_point_value_required');
  const value = validateDataPointValue(body.dataType, body.value);
  if (body.subjectType !== 'supplier' && body.subjectType !== 'site') throw new Error('invalid_data_point_subject');
  if (body.subjectType === 'site' && (typeof body.subjectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.subjectId))) throw new Error('invalid_supplier_site_id');
  if (body.subjectType === 'supplier' && body.subjectId !== undefined && body.subjectId !== null && body.subjectId !== '') throw new Error('invalid_data_point_subject');
  const sourceDocumentId: string | null = body.sourceDocumentId === undefined || body.sourceDocumentId === null || body.sourceDocumentId === '' ? null : typeof body.sourceDocumentId === 'string' ? body.sourceDocumentId : null;
  if (body.sourceDocumentId !== undefined && body.sourceDocumentId !== null && body.sourceDocumentId !== '' && (sourceDocumentId === null || !/^[0-9a-f-]{36}$/i.test(sourceDocumentId))) throw new Error('invalid_source_document_id');
  const validFrom = dataPointDate(body.validFrom, 'valid_from');
  const validUntil = dataPointDate(body.validUntil, 'valid_until');
  if (validFrom && validUntil && validUntil < validFrom) throw new Error('invalid_data_point_date_range');
  return { dataKey: body.dataKey.trim(), dataType: body.dataType, value, subjectType: body.subjectType, subjectId: body.subjectType === 'site' ? body.subjectId as string : null, sourceDocumentId, validFrom, validUntil };
}
