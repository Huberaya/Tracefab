import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabTenantContext } from '../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';


interface IntegrationBody {
  organizationId?: string;
  systemType?: string;
  name?: string;
  endpointUrl?: string;
  authType?: string;
  config?: Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    const body = req.method === 'POST'
      ? (await readJsonBody<IntegrationBody>(req).catch(() => ({}))) as IntegrationBody
      : {};
    const scope = req.method === 'POST'
      ? { types: ['brand'] as Array<'brand'>, roles: ['owner', 'admin', 'manager'] as Array<'owner' | 'admin' | 'manager'> }
      : { types: ['brand'] as Array<'brand'> };

    return await withTracefabTenantContext(req, user, scope, async (tx, tenant) => {
      const activeOrgId = tenant.organizationId;

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
        if (body.organizationId && body.organizationId !== activeOrgId) throw new Error('organization_context_mismatch');
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
  } catch (error: unknown) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    console.error('GET/POST /api/integrations failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
