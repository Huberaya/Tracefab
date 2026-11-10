import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabTenantContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

import { ingestPlmErpData } from '../../_lib/plm-erp/ingestor.js';
import type { PlmErpSystemType } from '../../_lib/plm-erp/types.js';

interface IngestBody {
  systemType?: string;
  payload?: any;
  organizationId?: string;
  integrationId?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const { user } = await requireClerkUser(req);

    const body = (await readJsonBody<IngestBody>(req).catch(() => ({}))) as IngestBody;
    const { systemType, payload, organizationId, integrationId } = body || {};
    return await withTracefabTenantContext(
      req,
      user,
      { types: ['brand'], roles: ['owner', 'admin', 'manager'] },
      async (tx, tenant) => {
      if (organizationId && organizationId !== tenant.organizationId) throw new Error('organization_context_mismatch');
      const targetOrgId = tenant.organizationId;

      if (!systemType || !payload) {
        return json(res, 400, { error: 'systemType and payload are required' });
      }

      const validSystems: PlmErpSystemType[] = [
        'centric_plm',
        'lectra_kubix',
        'sap_s4hana',
        'infor_fashion',
        'gs1_epcis',
        'generic_csv',
      ];

      if (!validSystems.includes(systemType as PlmErpSystemType)) {
        return json(res, 400, { error: `Invalid systemType. Supported: ${validSystems.join(', ')}` });
      }

      // `tx` est la transaction ouverte par `withTracefabUserContext` : c'est elle
      // qui porte `tracefab.user_id`. Passer le client global ferait partir la
      // requete sur une connexion anonyme (voir ingestor.ts).
      const result = await ingestPlmErpData(tx, targetOrgId, systemType as PlmErpSystemType, payload, integrationId);

      return json(res, 200, result);
    });
  } catch (error: unknown) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) {
      return json(res, businessError.status, { error: businessError.error });
    }
    console.error('POST /api/integrations/ingest failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
