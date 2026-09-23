import type { VercelResponse } from '@vercel/node';

export function json(res: VercelResponse, status: number, payload: unknown) {
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
