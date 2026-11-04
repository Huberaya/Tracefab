import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';
import { isPlmErpSystemType, isPlmErpAuthType, PLM_ERP_SYSTEM_TYPES, PLM_ERP_AUTH_TYPES } from '../_lib/plm-erp/types.js';
import { activeBrandOrganizationIds } from '../_lib/products.js';

interface IntegrationBody {
  systemType?: string;
  name?: string;
  endpointUrl?: string;
  authType?: string;
  config?: Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { user } = await requireClerkUser(req);

    return await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const activeOrgId = (req.query.organizationId as string) || brandOrgIds[0];

      if (!activeOrgId || !brandOrgIds.includes(activeOrgId)) {
        return json(res, 403, { error: 'brand_product_role_required' });
      }

      if (req.method === 'GET') {
        const integrations = await tx.plm_erp_integrations.findMany({
          where: { organization_id: activeOrgId },
          orderBy: { created_at: 'desc' },
        });

        const recentJobs = await tx.plm_erp_sync_jobs.findMany({
          where: { brand_organization_id: activeOrgId },
          orderBy: { created_at: 'desc' },
          take: 10,
        });

        return json(res, 200, {
          integrations,
          recentJobs,
          organizationId: activeOrgId,
        });
      }

      if (req.method === 'POST') {
        const body = (await readJsonBody<IntegrationBody>(req).catch(() => ({}))) as IntegrationBody;
        const { systemType, name, endpointUrl, authType, config } = body || {};
        const normalizedSystemType = typeof systemType === 'string' ? systemType.trim() : '';
        const normalizedName = typeof name === 'string' ? name.trim() : '';
        const normalizedAuthType = typeof authType === 'string' ? authType.trim() : '';
        const resolvedAuthType = normalizedAuthType || 'api_key';

        if (!isPlmErpSystemType(normalizedSystemType)) {
          return json(res, 400, {
            error: 'invalid_system_type',
            supported: PLM_ERP_SYSTEM_TYPES,
          });
        }
        if (!normalizedName) {
          return json(res, 400, { error: 'name_required' });
        }
        if (!isPlmErpAuthType(resolvedAuthType)) {
          return json(res, 400, {
            error: 'invalid_auth_type',
            supported: PLM_ERP_AUTH_TYPES,
          });
        }

        const integration = await tx.plm_erp_integrations.upsert({
          where: {
            organization_id_system_type_name: {
              organization_id: activeOrgId,
              system_type: normalizedSystemType,
              name: normalizedName,
            },
          },
          update: {
            endpoint_url: endpointUrl || null,
            auth_type: resolvedAuthType,
            config: (config as any) || {},
            status: 'active',
            updated_at: new Date(),
          },
          create: {
            organization_id: activeOrgId,
            system_type: systemType,
            name: name.trim(),
            endpoint_url: endpointUrl || null,
            auth_type: authType || 'api_key',
            config: (config as any) || {},
            status: 'active',
          },
        });

        return json(res, 201, { integration });
      }

      return methodNotAllowed(res, ['GET', 'POST']);
    });
  } catch (error: unknown) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) {
      return json(res, businessError.status, { error: businessError.error });
    }
    console.error('GET/POST /api/integrations failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
