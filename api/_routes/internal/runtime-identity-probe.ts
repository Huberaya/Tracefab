import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { prisma } from '../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

/**
 * Temporary, read-only runtime identity probe.
 * It returns role identity and RLS-bypass flags only; no connection data or secrets.
 * Remove this route immediately after the production HTTP check.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const rows = await prisma.$queryRaw<Array<{
      currentUser: string;
      sessionUser: string;
      isSuperuser: boolean;
      bypassRls: boolean;
    }>>`
      SELECT
        current_user AS "currentUser",
        session_user AS "sessionUser",
        role.rolsuper AS "isSuperuser",
        role.rolbypassrls AS "bypassRls"
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `;

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    if (rows.length !== 1) {
      return json(res, 503, { ok: false, error: 'runtime_identity_unavailable' });
    }

    return json(res, 200, { ok: true, identity: rows[0] });
  } catch {
    return json(res, 503, { ok: false, error: 'runtime_identity_unavailable' });
  }
}
