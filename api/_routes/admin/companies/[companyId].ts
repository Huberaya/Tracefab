import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseCompanyInput } from '../../../_lib/crm.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';
import { assessOpportunity } from '../../../_lib/crm-opportunity.js';

/**
 * GET   /api/admin/companies/:companyId — fiche complète (entreprise, contacts, activité)
 * PATCH /api/admin/companies/:companyId — mise à jour
 *
 * `stage` n'est pas modifiable ici : passer par /stage garantit qu'un mouvement
 * de pipeline est toujours journalisé. Un PATCH silencieux sur `stage` rendrait
 * l'historique commercial faux.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return update(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        include: {
          crm_contacts: { orderBy: { created_at: 'asc' } },
          crm_activities: { orderBy: { occurred_at: 'desc' }, take: 100 },
        },
      });
      return company;
    })) as unknown;

    if (!result) return json(res, 404, { error: 'crm_company_not_found' });

    const company = result as Record<string, unknown> & {
      crm_contacts: unknown[];
      crm_activities: unknown[];
    };
    /*
     * §4 : l'opportunité TRACEFAB est DÉRIVÉE côté serveur, à partir des champs
     * réellement saisis. Chaque conclusion porte le champ qui l'a produite, et
     * une absence de donnée ne produit aucune conclusion.
     */
    const opportunity = assessOpportunity(company);

    return json(res, 200, {
      company,
      contacts: company.crm_contacts,
      activities: company.crm_activities,
      opportunity,
    });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/companies/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    // Le pipeline a sa propre route : la journalisation n'est pas optionnelle.
    delete body.stage;
    delete body.lost_reason;

    const parsed = parseCompanyInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_company', details: parsed.errors });
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return json(res, 422, { error: 'no_updatable_field' });
    }

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        /* Les champs journalisés sont sélectionnés explicitement : sans eux,
           `before` serait vide et chaque modification ressemblerait à une création. */
        select: {
          id: true, name: true, stage: true, priority: true, country_code: true,
          company_type: true, maturity: true, product_count: true, supplier_count: true,
          estimated_value_eur: true, owner_name: true, dpp_interest: true,
          traceability_interest: true,
        },
      });
      if (!existing) return null;

      /*
       * Existence du lien — Chantier Admin 06.
       *
       * La colonne n'a pas de clé étrangère (voir la migration), donc c'est ici
       * que se joue la seule protection contre un lien qui pointerait dans le vide.
       *
       * La sonde passe par RLS : une organisation que l'admin ne peut pas voir
       * n'est pas liable. Ce n'est pas une limitation accidentelle — lier suppose
       * accéder, et permettre de lier une organisation invisible créerait un lien
       * dont personne ne pourrait rien lire.
       */
      const link = parsed.data.organization_id;
      if (typeof link === 'string') {
        const target = await tx.organizations.findFirst({
          where: { id: link },
          select: { id: true, type: true },
        });
        if (!target) return { linkError: true as const };
      }

      const company = await tx.crm_companies.update({
        where: { id: companyId },
        data: parsed.data as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_company', action: 'updated', entityId: companyId,
        before: existing as unknown as Record<string, unknown>,
        after: company as unknown as Record<string, unknown>,
      });
      return company;
    })) as unknown as Record<string, unknown> | { linkError: true } | null;

    if (result && 'linkError' in result) {
      return json(res, 422, { error: 'crm_organization_not_linkable' });
    }
    const updated = result as Record<string, unknown> | null;
    if (!updated) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 200, { company: updated });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/companies/:id');
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
