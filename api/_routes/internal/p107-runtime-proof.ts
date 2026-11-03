import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { cronAuthorized, cronSecretConfigured } from '../../_lib/worker-auth.js';
import { databaseIdentityIsSafe, probeDatabaseIdentity } from '../../_lib/readiness-probes.js';

/**
 * P10.7 one-shot production proof.
 *
 * Invoked only by Vercel Cron, whose Authorization: Bearer CRON_SECRET header
 * is verified server-side. It performs the same read-only Prisma identity
 * query as the existing readiness probe. No secrets or connection details
 * are returned or logged. This route and its temporary cron are removed by
 * restoring the production deployment immediately after collecting evidence.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!cronSecretConfigured()) return json(res, 503, { error: 'cron_not_configured' });
  if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  const databaseIdentity = await probeDatabaseIdentity();
  const safe = databaseIdentityIsSafe(databaseIdentity);
  const proof = {
    schema: 'tracefab-p107-runtime-proof-v1',
    measuredAt: new Date().toISOString(),
    databaseIdentity,
    safe,
  };

  // The log is the durable evidence source; it contains identity metadata only.
  console.info(JSON.stringify(proof));
  res.setHeader('Cache-Control', 'no-store');
  return json(res, databaseIdentity.measured ? (safe ? 200 : 409) : 503, proof);
}
