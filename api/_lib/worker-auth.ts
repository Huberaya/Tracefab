import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';

export function workerSecretConfigured() {
  return Boolean(process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET?.trim());
}

export function workerAuthorized(req: VercelRequest) {
  const expected = process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET?.trim();
  const value = req.headers['x-tracefab-worker-secret'];
  const actual = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!expected || !actual) return false;

  const expectedBytes = Uint8Array.from(Buffer.from(expected));
  const actualBytes = Uint8Array.from(Buffer.from(actual));
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function queryInteger(
  req: VercelRequest,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}
