import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { CLERK_PROXY_URL } from '../_lib/clerk-proxy.js';
import { json, methodNotAllowed } from '../_lib/http.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) return json(res, 503, { error: 'clerk_not_configured' });

  const productionKey = publishableKey.startsWith('pk_live_');
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  // A production publishable key must be paired with the server-side secret:
  // the proxy cannot function without it. Return only public configuration.
  if (productionKey && !secretKey?.startsWith('sk_live_')) {
    return json(res, 503, { error: 'clerk_not_configured' });
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  return json(res, 200, {
    publishableKey,
    ...(productionKey ? { proxyUrl: CLERK_PROXY_URL } : {}),
  });
}
