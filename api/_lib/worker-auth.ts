import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from './vercel-types.js';

function secretConfigured(name: string) {
  return Boolean(process.env[name]?.trim());
}

function secretMatches(expected: string | undefined, actual: string | undefined) {
  if (!expected || !actual) return false;
  const expectedBytes = Uint8Array.from(Buffer.from(expected));
  const actualBytes = Uint8Array.from(Buffer.from(actual));
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function workerSecretConfigured() {
  return secretConfigured('TRACEFAB_NOTIFICATION_WORKER_SECRET');
}

export function workerAuthorized(req: VercelRequest) {
  const expected = process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET?.trim();
  const value = req.headers['x-tracefab-worker-secret'];
  const actual = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!expected || !actual) return false;

  return secretMatches(expected, actual);
}

/**
 * Acces diagnostique ephemere, strictement borne a la Preview P11.
 * Le jeton n'est jamais accepte en Production ni sur une autre branche.
 */
export function runtimeProbeAuthorized(req: VercelRequest) {
  if (process.env.VERCEL_ENV !== 'preview') return false;
  if (process.env.VERCEL_GIT_COMMIT_REF !== 'fix/tracefab-p11-identity-runtime-20261109') return false;
  const headerValue = req.headers['x-tracefab-runtime-probe-token'];
  const queryValue = req.query?.runtimeProbeToken;
  const value = headerValue ?? queryValue;
  const actual = (Array.isArray(value) ? value[0] : value)?.trim();
  return secretMatches(process.env.TRACEFAB_RUNTIME_PROBE_TOKEN?.trim(), actual);
}

export function cronSecretConfigured() {
  return secretConfigured('CRON_SECRET');
}

export function cronAuthorized(req: VercelRequest) {
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : undefined;
  const header = req.headers['x-tracefab-cron-secret'];
  const actual = bearer || (Array.isArray(header) ? header[0] : header)?.trim();
  return secretMatches(process.env.CRON_SECRET?.trim(), actual);
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
