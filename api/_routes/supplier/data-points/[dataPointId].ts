import { data_type, data_value_status, Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { dataPointMutation, DATA_POINT_SELECT, serializeDataPoint } from '../../../_lib/data-points.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId, requireSupplierMutationRole } from '../../../_lib/supplier-profile.js';

function routeDataPointId(req: VercelRequest) { const value = req.query.dataPointId; return Array.isArray(value) ? value[0] : value; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);
  try {
    const dataPointId = routeDataPointId(req);
    if (!isUuid(dataPointId)) return json(res, 400, { error: 'invalid_data_point_id' });
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      const current = await tx.data_points.findFirst({
        where: { id: dataPointId, owner_organization_id: supplier.organization_id, OR: [{ supplier_id: supplier.id }, { supplier_sites: { supplier_id: supplier.id } }] },
        select: DATA_POINT_SELECT,
      });
      if (!current) return null;
      await requireSupplierMutationRole(tx, user.id, supplier.organization_id);
      const body = await readJsonBody<Record<string, unknown>>(req);
      const allowedKeys = new Set(['dataKey', 'dataType', 'value', 'subjectType', 'subjectId', 'sourceDocumentId', 'validFrom', 'validUntil']);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_data_point_fields');
      const normalized = {
        dataKey: body.dataKey ?? current.data_key,
        dataType: body.dataType ?? current.data_type,
        value: body.value,
        subjectType: body.subjectType ?? (current.supplier_site_id ? 'site' : 'supplier'),
        subjectId: body.subjectId ?? current.supplier_site_id ?? null,
        sourceDocumentId: Object.prototype.hasOwnProperty.call(body, 'sourceDocumentId') ? body.sourceDocumentId : current.source_document_id,
        validFrom: Object.prototype.hasOwnProperty.call(body, 'validFrom') ? body.validFrom : current.valid_from?.toISOString().slice(0, 10),
        validUntil: Object.prototype.hasOwnProperty.call(body, 'validUntil') ? body.validUntil : current.valid_until?.toISOString().slice(0, 10),
      };
      if (!Object.prototype.hasOwnProperty.call(body, 'value')) normalized.value = current.value;
      const values = dataPointMutation(normalized);
      let supplierSiteId: string | null = null;
      if (values.subjectType === 'site') {
        const site = await tx.supplier_sites.findFirst({ where: { id: values.subjectId as string, supplier_id: supplier.id, is_active: true }, select: { id: true } });
        if (!site) throw new Error('invalid_supplier_site_id');
        supplierSiteId = site.id;
      }
      if (values.sourceDocumentId) {
        const document = await tx.documents.findFirst({ where: { id: values.sourceDocumentId, owner_organization_id: supplier.organization_id, status: 'available' }, select: { id: true } });
        if (!document) throw new Error('invalid_source_document_id');
      }
      const point = await tx.data_points.create({
        data: {
          owner_organization_id: supplier.organization_id,
          supplier_id: values.subjectType === 'supplier' ? supplier.id : null,
          supplier_site_id: supplierSiteId,
          data_key: values.dataKey,
          value: values.value as Prisma.InputJsonValue,
          data_type: values.dataType as data_type,
          status: values.sourceDocumentId ? data_value_status.documented : data_value_status.declared,
          source_document_id: values.sourceDocumentId,
          declared_by: user.id,
          valid_from: values.validFrom,
          valid_until: values.validUntil,
          version: current.version + 1,
          supersedes_id: current.id,
        },
        select: DATA_POINT_SELECT,
      });
      return point;
    });
    if (!result) return json(res, 404, { error: 'data_point_not_found' });
    return json(res, 200, { dataPoint: serializeDataPoint(result) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'data_point_conflict' });
    if (error instanceof Error && (/^invalid_|^data_point_/.test(error.message))) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('PATCH /api/supplier/data-points/:dataPointId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
