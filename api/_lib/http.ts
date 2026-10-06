import type { VercelResponse } from '@vercel/node';

export function json(res: VercelResponse, status: number, payload: unknown) {
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return res.status(status).setHeader('Content-Type', 'application/json').json(payload);
}

export function methodNotAllowed(res: VercelResponse, allowed: string[]) {
  res.setHeader('Allow', allowed.join(', '));
  return json(res, 405, { error: 'method_not_allowed' });
}

export async function readJsonBody<T>(req: { body?: unknown }): Promise<T> {
  if (typeof req.body === 'string') return JSON.parse(req.body) as T;
  return (req.body ?? {}) as T;
}
