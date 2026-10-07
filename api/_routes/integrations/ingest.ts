import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../../_lib/products.js';
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

    return await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const body = (await readJsonBody<IngestBody>(req).catch(() => ({}))) as IngestBody;
      const { systemType, payload, organizationId, integrationId } = body || {};

      const targetOrgId = organizationId || brandOrgIds[0];
      if (!targetOrgId || !brandOrgIds.includes(targetOrgId)) {
        return json(res, 403, { error: 'brand_product_role_required' });
      }

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

      const result = await ingestPlmErpData(targetOrgId, systemType as PlmErpSystemType, payload, integrationId);

      return json(res, 200, result);
    });
  } catch (error: any) {
    const err = sqlBusinessError(error);
    return json(res, err.status, { error: err.error });
  }
}
