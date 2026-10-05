import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, methodNotAllowed } from '.././_lib/http.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) return json(res, 503, { error: 'clerk_not_configured' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  return json(res, 200, { publishableKey });
}
