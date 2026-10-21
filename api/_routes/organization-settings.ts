import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../_lib/tenant.js';

const ACTION = 'organization_settings_updated';

function normalize(body: Record<string, unknown>) {
  const dppIdentifierFormat = typeof body.dppIdentifierFormat === 'string'
    ? body.dppIdentifierFormat.trim().slice(0, 160) : '';
  const qualityThreshold = Number(body.qualityThreshold);
  if (!dppIdentifierFormat) throw new Error('dpp_identifier_format_required');
  if (!/^urn:epc:id:sgtin:[A-Za-z0-9.-]+$/.test(dppIdentifierFormat)) {
    throw new Error('invalid_dpp_identifier_format');
  }
  if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 100) {
    throw new Error('quality_threshold_must_be_between_0_and_100');
  }
  return { dppIdentifierFormat, qualityThreshold };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT') return methodNotAllowed(res, ['GET', 'PUT']);
  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id,
        req.method === 'PUT' ? { roles: ['owner', 'admin'] } : undefined);
      const latest = await tx.audit_logs.findFirst({
        where: { organization_id: tenant.organizationId, action: ACTION, entity_type: 'organization_settings' },
        orderBy: { created_at: 'desc' },
      });
      if (req.method === 'GET') {
        const history = await tx.audit_logs.findMany({
          where: { organization_id: tenant.organizationId, action: ACTION, entity_type: 'organization_settings' },
          orderBy: { created_at: 'desc' }, take: 20,
        });
        return { settings: latest?.after_state || null, history: history.map((entry) => ({ id: entry.id, at: entry.created_at, before: entry.before_state, after: entry.after_state })) };
      }
      const settings = normalize(await readJsonBody<Record<string, unknown>>(req));
      await tx.audit_logs.create({ data: {
        organization_id: tenant.organizationId,
        action: ACTION,
        entity_type: 'organization_settings',
        before_state: latest?.after_state || undefined,
        after_state: settings,
        metadata: { source: 'brand_console', trust: 'organization_configuration' },
      } });
      return { settings };
    }, requestedTenantId(req));
    return json(res, 200, result);
  } catch (error: unknown) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const message = error instanceof Error ? error.message : 'internal_error';
    if (message === 'dpp_identifier_format_required' || message === 'invalid_dpp_identifier_format' || message === 'quality_threshold_must_be_between_0_and_100') {
      return json(res, 400, { error: message });
    }
    console.error('Organization settings route error:', error);
    return json(res, 500, { error: 'internal_error' });
  }
}
