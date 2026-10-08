import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { isUnauthorized } from '../../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../../_lib/crm-audit-write.js';
import { planPromotion } from '../../../../_lib/crm-funnel.js';

/**
 * POST /api/admin/leads/:leadId/promote — promeut un lead en entreprise (§14)
 *
 * DEUX ÉCRITURES, UNE TRANSACTION. L'entreprise est créée et le lead est marqué
 * `converted` avec son identifiant : si l'une des deux échoue, aucune ne subsiste.
 * Un lead « converti » sans entreprise ferait croire à un client inexistant, et
 * une entreprise sans lead ferait perdre l'origine du client.
 *
 * L'IDENTIFIANT EST TIRÉ AVANT TOUTE ÉCRITURE. `planPromotion` valide ainsi les
 * préconditions — déjà promu, écarté — AVANT qu'aucune ligne ne soit écrite, au
 * lieu d'écrire puis d'annuler. Une validation après coup repose sur un rollback
 * qui, lui, peut échouer.
 *
 * LE LEAD N'EST PAS SUPPRIMÉ. Il reste, avec sa provenance et sa date de
 * collecte : c'est la seule trace de l'origine du client (§9, §14).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const admin = await requirePlatformAdmin(req);
    const leadId = String(req.query.leadId);
    const orgId = admin.platformOrganizationId;

    const existing = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_leads.findFirst({
        where: { id: leadId, platform_organization_id: orgId },
      }))) as unknown as Record<string, unknown> | null;

    if (!existing) return json(res, 404, { error: 'crm_lead_not_found' });

    const companyId = randomUUID();
    const plan = planPromotion(existing as never, companyId);
    if (plan.errors.length) {
      return json(res, 422, { error: 'lead_not_promotable', details: plan.errors });
    }

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.create({
        data: {
          ...(plan.company as Record<string, unknown>),
          platform_organization_id: orgId,
        } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_company', action: 'created', entityId: company.id,
        before: null, after: company as unknown as Record<string, unknown>,
      });

      /* Relecture dans la transaction : entre la première lecture et celle-ci,
         un second opérateur peut avoir promu le même lead. Sans cette garde,
         deux clics produiraient deux entreprises pour un seul prospect. */
      const fresh = await tx.crm_leads.findFirst({
        where: { id: leadId, platform_organization_id: orgId },
      });
      if (fresh?.converted_company_id) return { race: true as const };

      const lead = await tx.crm_leads.update({
        where: { id: leadId },
        data: { ...(plan.lead as Record<string, unknown>), updated_at: new Date() } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_lead', action: 'converted', entityId: leadId,
        before: fresh as unknown as Record<string, unknown>,
        after: lead as unknown as Record<string, unknown>,
      });
      return { company, lead };
    })) as unknown as { race: true } | { company: unknown; lead: unknown };

    if ('race' in result) {
      return json(res, 409, { error: 'lead_already_converted' });
    }
    const ok = result as { company: unknown; lead: unknown };
    return json(res, 201, { company: ok.company, lead: ok.lead, promoted: true });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/leads/:id/promote');
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
