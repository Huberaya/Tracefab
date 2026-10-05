import { data_type, data_value_status, Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { dataPointMutation, DATA_POINT_DEFINITIONS, DATA_POINT_SELECT, serializeDataPoint } from '../../_lib/data-points.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId, requireSupplierMutationRole } from '../../_lib/supplier-profile.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      if (req.method === 'GET') {
        const dataKey = Array.isArray(req.query.dataKey) ? req.query.dataKey[0] : req.query.dataKey;
        const points = await tx.data_points.findMany({
          where: {
            owner_organization_id: supplier.organization_id,
            ...(dataKey ? { data_key: dataKey } : {}),
            OR: [{ supplier_id: supplier.id }, { supplier_sites: { supplier_id: supplier.id } }],
          },
          select: DATA_POINT_SELECT,
          orderBy: [{ data_key: 'asc' }, { version: 'desc' }],
        });
        return { points };
      }

      await requireSupplierMutationRole(tx, user.id, supplier.organization_id);
      const values = dataPointMutation(await readJsonBody<Record<string, unknown>>(req));
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
          version: 1,
        },
        select: DATA_POINT_SELECT,
      });
      return { point };
    });
    if (!result) return json(res, 404, { error: 'supplier_organization_not_found' });
    if ('points' in result) return json(res, 200, { dataPoints: result.points!.map(serializeDataPoint), definitions: DATA_POINT_DEFINITIONS });
    return json(res, 201, { dataPoint: serializeDataPoint(result.point) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'data_point_conflict' });
    if (error instanceof Error && (/^invalid_|^data_point_/.test(error.message))) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/data-points failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
