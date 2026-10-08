import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { EMAIL_SENDING_REFUSED } from '../../_lib/crm-log.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET /api/admin/emails — §12, le journal des e-mails de prospection.
 *
 * Un JOURNAL, pas une boîte d'envoi. La réponse porte explicitement
 * `sending: EMAIL_SENDING_REFUSED` pour que l'interface puisse dire pourquoi il
 * n'y a pas de bouton « envoyer » au lieu de laisser croire à un oubli.
 *
 * `api/_lib/email.ts` sait envoyer (Resend). Ce qui bloque n'est pas technique :
 * `crm_contacts` ne porte aucun champ de consentement et le schéma ne contient ni
 * consent, ni opt_in, ni gdpr. Envoyer un e-mail commercial sans base licite
 * enregistrée serait indéfendable pour un produit dont le positionnement est la
 * confiance. Un test épingle ce refus.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);
    const where: Record<string, unknown> = {
      platform_organization_id: admin.platformOrganizationId,
      type: 'email',
    };

    const companyId = first(req.query.company_id);
    if (typeof companyId === 'string' && companyId) where.company_id = companyId;

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const items = await tx.crm_activities.findMany({
        where,
        orderBy: { occurred_at: 'desc' },
        take: limit,
        include: { crm_companies: { select: { id: true, name: true, stage: true } } },
      });
      const total = await tx.crm_activities.count({ where });
      return { items, total };
    })) as unknown as { items: unknown; total: number };

    return json(res, 200, {
      items: result.items,
      total: result.total,
      limit,
      sending: EMAIL_SENDING_REFUSED,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/emails failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
