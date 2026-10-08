import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseContactInput } from '../../../_lib/crm.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';

/**
 * GET   /api/admin/contacts/:contactId
 * PATCH /api/admin/contacts/:contactId
 *
 * `company_id` n'est pas modifiable : déplacer un contact d'une entreprise à
 * l'autre fausserait l'historique des deux. On supprime et on recrée, ce qui
 * laisse une trace.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return update(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const contactId = String(req.query.contactId);

    const contact = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_contacts.findFirst({
        where: { id: contactId, platform_organization_id: admin.platformOrganizationId },
        include: { crm_companies: { select: { id: true, name: true, stage: true, priority: true, country_code: true } } },
      }),
    )) as unknown;

    if (!contact) return json(res, 404, { error: 'crm_contact_not_found' });
    return json(res, 200, { contact });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/contacts/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const contactId = String(req.query.contactId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };
    delete body.company_id;

    const parsed = parseContactInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_contact', details: parsed.errors });
    if (!parsed.data || Object.keys(parsed.data).length === 0) return json(res, 422, { error: 'no_updatable_field' });

    const updated = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_contacts.findFirst({
        where: { id: contactId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      const contact = await tx.crm_contacts.update({ where: { id: contactId }, data: parsed.data as never });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_contact', action: 'updated', entityId: contactId,
        after: contact as unknown as Record<string, unknown>,
      });
      return contact;
    })) as unknown;

    if (!updated) return json(res, 404, { error: 'crm_contact_not_found' });
    return json(res, 200, { contact: updated });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/contacts/:id');
  }
}

function fail(res: VercelResponse, error: unknown, label: string) {
  if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
  if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
  const business = sqlBusinessError(error);
  if (business) return json(res, business.status, business);
  console.error(`${label} failed`, error);
  return json(res, 500, { error: 'internal_server_error' });
}
