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

export const DATA_POINT_DEFINITIONS: Record<string, { dataType: string; description: string }> = {
  country_of_manufacture: { dataType: 'country', description: 'ISO 3166-1 alpha-2 country code.' },
  country_of_origin: { dataType: 'country', description: 'ISO 3166-1 alpha-2 country code.' },
  annual_production_capacity: { dataType: 'number', description: 'Annual production capacity in the declared unit.' },
  employee_count: { dataType: 'number', description: 'Number of employees at the subject.' },
  main_material_percentage: { dataType: 'percentage', description: 'Share by mass of the main material.' },
  activity_types: { dataType: 'json', description: 'Array of controlled activity keys.' },
  material_composition: { dataType: 'json', description: 'Array of material keys and percentages.' },
};

function validateKnownJsonShape(dataKey: string, value: unknown) {
  if (dataKey === 'activity_types') {
    if (!Array.isArray(value) || value.length > 64 || value.some((entry) => typeof entry !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(entry))) throw new Error('invalid_data_point_value');
  }
  if (dataKey === 'material_composition') {
    if (!Array.isArray(value) || value.length > 100) throw new Error('invalid_data_point_value');
    let total = 0;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_data_point_value');
      const materialKey = (entry as Record<string, unknown>).materialKey;
      const percentage = (entry as Record<string, unknown>).percentage;
      if (typeof materialKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(materialKey) || typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error('invalid_data_point_value');
      total += percentage;
    }
    if (total > 100.0001) throw new Error('invalid_data_point_value');
  }
}

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

function parseIsoDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

export function dataPointDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`invalid_${field}`);
  return parsed;
}

export function validateDataPointValue(dataType: string, value: unknown, dataKey?: string) {
  if (!SUPPLIER_DATA_TYPES.has(dataType)) throw new Error('invalid_data_type');
  const definition = dataKey ? DATA_POINT_DEFINITIONS[dataKey] : undefined;
  if (definition && definition.dataType !== dataType) throw new Error('data_point_type_mismatch');
  if (dataType === 'text' && (typeof value !== 'string' || value.length > 10000)) throw new Error('invalid_data_point_value');
  if (dataType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('invalid_data_point_value');
  if (dataType === 'boolean' && typeof value !== 'boolean') throw new Error('invalid_data_point_value');
  if (dataType === 'date' && !parseIsoDate(value)) throw new Error('invalid_data_point_value');
  if (dataType === 'country' && (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value))) throw new Error('invalid_data_point_value');
  if (dataType === 'percentage' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)) throw new Error('invalid_data_point_value');
  if (dataType === 'json' && (typeof value !== 'object' || value === null || JSON.stringify(value).length > 50000)) throw new Error('invalid_data_point_value');
  if (dataType === 'json' && dataKey) validateKnownJsonShape(dataKey, value);
  return dataType === 'country' && typeof value === 'string' ? value.toUpperCase() : value;
}

export function dataPointMutation(body: Record<string, unknown>) {
  const allowedKeys = new Set(['dataKey', 'dataType', 'value', 'subjectType', 'subjectId', 'sourceDocumentId', 'validFrom', 'validUntil']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_data_point_fields');
  if (typeof body.dataKey !== 'string' || body.dataKey.trim().length === 0 || body.dataKey.trim().length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(body.dataKey.trim())) throw new Error('invalid_data_key');
  if (typeof body.dataType !== 'string' || !SUPPLIER_DATA_TYPES.has(body.dataType)) throw new Error('invalid_data_type');
  if (!Object.prototype.hasOwnProperty.call(body, 'value')) throw new Error('data_point_value_required');
  const value = validateDataPointValue(body.dataType, body.value, body.dataKey.trim());
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
