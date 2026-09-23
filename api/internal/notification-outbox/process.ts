import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, methodNotAllowed } from '../../_lib/http';
import { processNotificationOutbox } from '../../_lib/notification-outbox';

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function workerAuthorized(req: VercelRequest) {
  const expected = process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET?.trim();
  const actual = headerValue(req, 'x-tracefab-worker-secret')?.trim();
  if (!expected || !actual) return false;
  const expectedBytes = Uint8Array.from(Buffer.from(expected));
  const actualBytes = Uint8Array.from(Buffer.from(actual));
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function processLimit(req: VercelRequest) {
  const raw = req.query.limit;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 10;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) return null;
  return parsed;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET?.trim()) {
    return json(res, 503, { error: 'notification_worker_not_configured' });
  }
  if (!workerAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  const limit = processLimit(req);
  if (limit === null) return json(res, 400, { error: 'invalid_limit' });

  try {
    const summary = await processNotificationOutbox(limit);
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { summary });
  } catch (error) {
    console.error('POST /api/internal/notification-outbox/process failed', error);
    return json(res, 500, { error: 'notification_worker_failed' });
  }
}
