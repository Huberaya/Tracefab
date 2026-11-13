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
 * Branches sur lesquelles la sonde d'identite runtime est ouverte.
 *
 * POURQUOI UNE LISTE, ET POURQUOI CETTE LISTE-LA
 *
 * La premiere version comparait `VERCEL_GIT_COMMIT_REF` a une CONSTANTE, la
 * branche de mise au point d'alors (`fix/tracefab-p11-identity-runtime-
 * 20261109`). Cette branche a ete fusionnee puis abandonnee : plus aucun
 * deploiement ne porte ce nom. Consequence mesuree le 2026-11-13 : sur la
 * branche de la PR #121 — celle qui doit justement etre prouvee — la sonde
 * rendait `401 worker_unauthorized`, et la seule preuve d'identite runtime
 * disponible etait celle d'un code qui n'est plus le candidat.
 *
 * Une sonde qui ne peut s'ouvrir que sur une branche morte ne prouve rien du
 * code qu'on livre. La liste nomme donc la branche de la PR, et elle est
 * explicite : ce n'est PAS un joker, pas un prefixe, pas une expression
 * reguliere. Une branche absente d'ici n'obtient rien, et `VERCEL_ENV` doit
 * valoir `preview` — la Production reste fermee dans tous les cas, y compris
 * si un deploiement de Production portait un jour un nom de branche cite.
 */
export const BRANCHES_SONDE_RUNTIME: readonly string[] = Object.freeze([
  // La branche de la PR #121, celle dont les preuves runtime sont exigees.
  'release/p107-runtime-production-20261110',
  // La branche historique, conservee pour ne pas casser un deploiement encore
  // en ligne qui l'utiliserait.
  'fix/tracefab-p11-identity-runtime-20261109',
]);

/**
 * Acces diagnostique ephemere, strictement borne a la Preview.
 *
 * Le jeton n'est JAMAIS accepte en Production : la premiere condition ferme le
 * chemin avant meme de regarder la branche, donc un deploiement de Production
 * est refuse quoi qu'il arrive. La branche ne peut qu'ajouter une restriction,
 * jamais en lever une.
 */
export function runtimeProbeAuthorized(req: VercelRequest) {
  if (process.env.VERCEL_ENV !== 'preview') return false;
  const branche = process.env.VERCEL_GIT_COMMIT_REF;
  if (typeof branche !== 'string' || !BRANCHES_SONDE_RUNTIME.includes(branche)) return false;
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
