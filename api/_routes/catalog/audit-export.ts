import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
import { csvCell } from '../../_lib/catalog-importer.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

type ExportRow = Record<string, unknown>;

const HEADERS = ['recordType', 'organizationId', 'productId', 'productReference', 'productName', 'productVersion', 'dataKey', 'dataValue', 'dataStatus', 'sourceDocumentId', 'action', 'entityType', 'entityId', 'recordedAt'];

function row(values: ExportRow) {
  return HEADERS.map((header) => csvCell(values[header])).join(',');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // Locataire actif obligatoire, et role verifie dans ce locataire.
      // L'export d'audit est la sortie de donnees la plus sensible de la
      // console : le repli precedent exportait produits, points de donnee et
      // journal d'audit de TOUTES les organisations du compte.
      const tenant = await requireActiveTenant(tx, req, user.id, {
        types: ['brand'],
        roles: ['owner', 'admin', 'manager', 'auditor'],
      });
      const organizationIds = [tenant.organizationId];
      const products = await tx.$queryRaw<Array<{ id: string; organization_id: string; reference: string; name: string; version: number; created_at: Date }>>`
        SELECT id, brand_organization_id AS organization_id, reference, name, version, updated_at AS created_at
        FROM tracefab_products
        WHERE brand_organization_id = ANY(${organizationIds}::uuid[])
        ORDER BY updated_at DESC
      `;
      const productIds = products.map((product) => product.id);
      const dataPoints = productIds.length ? await tx.$queryRaw<Array<{ product_id: string; data_key: string; value: unknown; status: string; source_document_id: string | null; updated_at: Date }>>`
        SELECT product_id, data_key, value, status, source_document_id, updated_at
        FROM data_points
        WHERE product_id = ANY(${productIds}::uuid[])
        ORDER BY updated_at DESC
      ` : [];
      const auditLogs = await tx.$queryRaw<Array<{ organization_id: string; action: string; entity_type: string; entity_id: string | null; created_at: Date }>>`
        SELECT organization_id, action, entity_type, entity_id, created_at
        FROM audit_logs
        WHERE organization_id = ANY(${organizationIds}::uuid[])
        ORDER BY created_at DESC
        LIMIT 5000
      `;
      const productById = new Map(products.map((product) => [product.id, product]));
      const rows: ExportRow[] = products.map((product) => ({ recordType: 'PRODUCT', organizationId: product.organization_id, productId: product.id, productReference: product.reference, productName: product.name, productVersion: product.version, recordedAt: product.created_at }));
      rows.push(...dataPoints.map((point) => { const product = productById.get(point.product_id); return { recordType: 'DATA_POINT', organizationId: product?.organization_id, productId: point.product_id, productReference: product?.reference, productName: product?.name, productVersion: product?.version, dataKey: point.data_key, dataValue: point.value, dataStatus: point.status, sourceDocumentId: point.source_document_id, recordedAt: point.updated_at }; }));
      rows.push(...auditLogs.map((log) => ({ recordType: 'AUDIT_EVENT', organizationId: log.organization_id, action: log.action, entityType: log.entity_type, entityId: log.entity_id, recordedAt: log.created_at })));
      return { rows };
    }, requestedTenantId(req));
    const content = [HEADERS.join(','), ...result.rows.map(row)].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracefab-audit-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`\uFEFF${content}\r\n`);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/catalog/audit-export failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
