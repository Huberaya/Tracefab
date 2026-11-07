import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabTenantContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { ingestPlmProductBom, type PlmProductSyncPayload } from '../../_lib/plm-connector.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (process.env.NODE_ENV === 'production' && process.env.TRACEFAB_PLM_ENABLED !== 'true') {
    return json(res, 404, { error: 'plm_integration_disabled' });
  }

  try {
    const auth = await requireClerkUser(req);
    if (isUnauthorized(auth)) return json(res, 401, { error: 'unauthorized' });

    return await withTracefabTenantContext(req, auth.user, { types: ['brand'] }, async () => {
      if (req.method === 'GET') {
        return json(res, 200, {
          status: 'ok',
          availableConnectors: [
            {
              id: 'conn-centric-01',
              name: 'Centric Software PLM',
              type: 'CENTRIC_PLM',
              status: 'CONNECTED',
              lastSyncedAt: new Date(Date.now() - 3600000).toISOString(),
              syncScope: ['BOM_COMPOSITION', 'SUPPLIER_MASTER'],
            },
            {
              id: 'conn-lectra-01',
              name: 'Lectra Kubix Link',
              type: 'LECTRA_KUBIX',
              status: 'CONNECTED',
              lastSyncedAt: new Date(Date.now() - 7200000).toISOString(),
              syncScope: ['BOM_COMPOSITION'],
            },
            {
              id: 'conn-sap-01',
              name: 'SAP S/4HANA Fashion & Retail',
              type: 'SAP_S4HANA',
              status: 'CONNECTED',
              lastSyncedAt: new Date(Date.now() - 1800000).toISOString(),
              syncScope: ['PURCHASE_ORDERS', 'LOT_RECEIPTS'],
            },
          ],
        });
      }

      const body = await readJsonBody<PlmProductSyncPayload>(req);
      try {
        const syncResult = ingestPlmProductBom(body);
        return json(res, 200, { status: 'ok', syncResult });
      } catch (err: any) {
        console.warn('PLM payload rejected', { errorCode: err instanceof Error ? err.message : 'invalid_payload' });
        return json(res, 400, { error: 'plm_sync_error' });
      }
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    console.error('GET/POST /api/integrations/plm failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
