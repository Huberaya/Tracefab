import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../_lib/products.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * Mandats de vérification tierce accordés par une marque.
 *
 * Un organisme `verifier` ne peut attester `third_party_verified` que s'il
 * détient un mandat ACTIF de la marque. Ce mandat est explicite, daté, et sa
 * révocation reste conservée : elle bloque les nouvelles revues sans effacer
 * les attestations passées.
 *
 * La route ne fait que valider la forme. Les autorisations (rôle de marque,
 * type d'organisme, doublon actif) sont dans les fonctions SQL
 * `tracefab_grant_dpp_verification_mandate` et
 * `tracefab_revoke_dpp_verification_mandate`, sous RLS.
 */

const text = (value: unknown, max: number) => (
  typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null
);
const queryValue = (req: VercelRequest, key: string) => {
  const raw = req.query[key];
  return Array.isArray(raw) ? raw[0] : raw;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!['GET', 'POST'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    const body = req.method === 'POST' ? await readJsonBody<Record<string, unknown>>(req) : {};
    const rawOrganizationId = req.method === 'GET'
      ? queryValue(req, 'organizationId')
      : body.organizationId;
    const requestedOrganizationId = typeof rawOrganizationId === 'string' && rawOrganizationId.trim()
      ? rawOrganizationId.trim()
      : null;
    if (rawOrganizationId != null && !isUuid(requestedOrganizationId)) {
      return json(res, 400, { error: 'invalid_organization_id' });
    }
    if (req.method === 'POST' && !isUuid(requestedOrganizationId)) {
      return json(res, 400, { error: 'invalid_organization_id' });
    }

    const verifierOrganizationId = req.method === 'POST' ? text(body.verifierOrganizationId, 36) : null;
    const notes = req.method === 'POST' && body.notes != null ? text(body.notes, 500) : null;
    if (req.method === 'POST' && (!verifierOrganizationId || !isUuid(verifierOrganizationId))) {
      return json(res, 400, { error: 'invalid_verifier_organization_id' });
    }
    if (req.method === 'POST' && body.notes != null && notes === null) {
      return json(res, 400, { error: 'invalid_mandate_notes' });
    }

    const payload = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      const organizationId = requestedOrganizationId || (brandIds.length === 1 ? brandIds[0] : null);
      if (!organizationId || !brandIds.includes(organizationId)) return { kind: 'forbidden' as const };

      if (req.method === 'GET') {
        const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
          SELECT m.id, m.brand_organization_id, m.verifier_organization_id, m.scope, m.status,
                 m.granted_at, m.revoked_at, m.revoked_reason, m.notes,
                 tracefab_public_verifier_name(m.verifier_organization_id) AS verifier_display_name
          FROM dpp_verification_mandates m
          WHERE m.brand_organization_id = ${organizationId}::uuid
          ORDER BY m.granted_at DESC, m.id DESC
          LIMIT 200`;
        return { kind: 'ok' as const, mandates: rows };
      }

      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM tracefab_grant_dpp_verification_mandate(
          ${organizationId}::uuid,
          ${verifierOrganizationId}::uuid,
          ${notes}
        )`;
      return { kind: 'ok' as const, mandate: rows[0] };
    });

    if (payload.kind === 'forbidden') return json(res, 403, { error: 'organization_forbidden' });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, req.method === 'POST' ? 201 : 200,
      req.method === 'POST' ? { mandate: payload.mandate } : { mandates: payload.mandates });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, { error: business.error });
    if (error instanceof Error && error.message.startsWith('invalid_')) {
      return json(res, 400, { error: error.message });
    }
    console.error('DPP verification mandates failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
