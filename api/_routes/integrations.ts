import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';
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

        if (!systemType || !name) {
          return json(res, 400, { error: 'systemType and name are required' });
        }

        const integration = await tx.plm_erp_integrations.upsert({
          where: {
            organization_id_system_type_name: {
              organization_id: activeOrgId,
              system_type: systemType,
              name: name.trim(),
            },
          },
          update: {
            endpoint_url: endpointUrl || null,
            auth_type: authType || 'api_key',
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
  } catch (error: any) {
    const err = sqlBusinessError(error);
    return json(res, err.status, { error: err.error });
  }
}
