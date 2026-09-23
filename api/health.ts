import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prisma } from './_lib/prisma';
import { json, methodNotAllowed } from './_lib/http';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    await prisma.$queryRaw`SELECT 1`;
    return json(res, 200, { ok: true, service: 'tracefab-api', database: 'neon' });
  } catch (error) {
    console.error('GET /api/health failed', error);
    return json(res, 503, { ok: false, error: 'database_unavailable' });
  }
}
