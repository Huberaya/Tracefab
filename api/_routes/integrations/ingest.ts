import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { isTenantError, resolveActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

import { ingestPlmErpData } from '../../_lib/plm-erp/ingestor.js';
import { isPlmErpSystemType, PLM_ERP_SYSTEM_TYPES } from '../../_lib/plm-erp/types.js';

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
    // Le tenant doit être explicite : aucun repli sur la première organisation du compte.
    const requestedOrgId = requestedTenantId(req) ?? organizationId ?? null;
    return await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await resolveActiveTenant(tx, user.id, requestedOrgId, {
        types: ['brand'], roles: ['owner', 'admin', 'manager'],
      });
      const targetOrgId = tenant.organizationId;

      if (!systemType || !payload) {
        return json(res, 400, { error: 'systemType and payload are required' });
      }

      if (!isPlmErpSystemType(systemType)) {
        return json(res, 400, { error: `Invalid systemType. Supported: ${PLM_ERP_SYSTEM_TYPES.join(', ')}` });
      }

      // `tx` est la transaction ouverte par `withTracefabUserContext` : c'est elle
      // qui porte `tracefab.user_id`. Passer le client global ferait partir la
      // requete sur une connexion anonyme (voir ingestor.ts).
      const result = await ingestPlmErpData(tx, targetOrgId, systemType, payload, integrationId);

      return json(res, 200, result);
    });
  } catch (error: unknown) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) {
      return json(res, businessError.status, { error: businessError.error });
    }
    console.error('POST /api/integrations/ingest failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
