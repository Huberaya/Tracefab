import { antivirusConfig, headObject, scanWithAntivirus, storageConfig } from './storage.js';
import { redact } from './error-reporting.js';

/**
 * Sondes de disponibilite reelles.
 *
 * L'endpoint de readiness existant verifie que les variables d'environnement
 * sont *definies*. C'est utile, mais une cle presente n'est pas une cle valide,
 * et un bucket nomme n'est pas un bucket joignable. Le jour de la mise en
 * production, la difference est tout.
 *
 *  Ces sondes exercent reellement chaque service. Elles sont volontairement
 *  separees du controle de configuration : on ne veut pas appeler les
 *  dependances externes a chaque passage d'une sonde de supervision.
 *
 * Regles :
 *   - aucune sonde ne jette : un service en panne est un resultat, pas un bug.
 *   - aucune sonde ne modifie les donnees metier et aucun email n'est envoye ;
 *     le scanner reçoit uniquement un petit PDF synthetique non sensible.
 *   - aucun secret ne sort, les messages sont caviardes.
 */

export type ProbeResult = {
  reachable: boolean;
  latencyMs: number;
  detail: string;
};

const DEFAULT_TIMEOUT_MS = 4000;

function probeTimeout() {
  const value = Number(process.env.TRACEFAB_READINESS_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 15000 ? value : DEFAULT_TIMEOUT_MS;
}

async function timed(fn: (signal: AbortSignal) => Promise<Omit<ProbeResult, 'latencyMs'>>): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('readiness_probe_timeout'));
    }, probeTimeout());
  });
  try {
    const operation = Promise.resolve().then(() => fn(controller.signal));
    const result = await Promise.race([operation, timeout]);
    return { ...result, latencyMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, latencyMs: Date.now() - started, detail: redact(message).slice(0, 160) };
  } finally {
    clearTimeout(timer!);
  }
}

/** Une reponse HTTP, meme 405 ou 404, prouve que l'hote repond. Seules une
 *  panne reseau et un depassement de delai signifient injoignable. */
async function reachableByHttp(
  url: string,
  method: 'HEAD' | 'GET',
  signal: AbortSignal,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, { method, headers, signal, redirect: 'error' });
  return { reachable: true, detail: `reponse HTTP ${response.status}`, status: response.status };
}

/** Base de donnees : la sonde qui compte le plus. Une requete triviale prouve
 *  la resolution DNS, le TLS, l'authentification et le pooler. */
export function probeDatabase(): Promise<ProbeResult> {
  return timed(async (_signal) => {
    if (!process.env.DATABASE_URL?.trim()) return { reachable: false, detail: 'DATABASE_URL absent' };
    const { prisma } = await import('./prisma.js');
    await prisma.$queryRaw`SELECT 1`;
    return { reachable: true, detail: 'requete SELECT 1 honoree' };
  });
}

/** Stockage prive : le deploiement doit provisionner une sentinelle vide,
 *  privee, sous `tracefab-readiness-probe/.keep`. Un 200 prouve que HEAD signe
 *  fonctionne sans exiger s3:ListBucket ; un 403/404 est un echec. */
export function probeStorage(): Promise<ProbeResult> {
  return timed(async (signal) => {
    storageConfig(); // jette si la configuration est invalide
    try {
      const marker = await headObject('tracefab-readiness-probe/.keep', signal);
      if (marker.byteSize !== 0) return { reachable: false, detail: 'sentinelle de stockage invalide (taille non nulle)' };
      return { reachable: true, detail: 'sentinelle privee presente, HEAD signe honore' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { reachable: false, detail: redact(message).slice(0, 160) };
    }
  });
}

/** Antivirus : exerce le vrai contrat POST tracefab-v1 avec un PDF synthétique
 *  non sensible. Une réponse HTTP seule ne prouve pas que le scanner accepte
 *  le protocole ni qu'il renvoie un verdict exploitable. */
export function probeAntivirus(): Promise<ProbeResult> {
  return timed(async (signal) => {
    antivirusConfig(); // exige URL HTTPS en production et le bearer token
    const sample = Buffer.from('%PDF-1.7\n% Tracefab readiness probe\n%%EOF', 'utf8');
    const bytes = sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) as ArrayBuffer;
    const result = await scanWithAntivirus(bytes, 'tracefab-readiness-probe.pdf', 'application/pdf', signal);
    if (!result.clean || result.mimeType !== 'application/pdf') {
      return { reachable: false, detail: 'POST tracefab-v1 honore, mais le scanner n a pas valide le PDF sonde' };
    }
    return { reachable: true, detail: 'POST tracefab-v1 honore, PDF sonde valide' };
  });
}

/** Resend : GET /domains valide la cle d'API sans envoyer le moindre message.
 *  Un 401 prouve que l'hote repond mais que la cle est refusee. */
export function probeEmail(): Promise<ProbeResult> {
  return timed(async (signal) => {
    const key = process.env.RESEND_API_KEY?.trim();
    if (!key) return { reachable: false, detail: 'RESEND_API_KEY absent' };
    const { status } = await reachableByHttp('https://api.resend.com/domains', 'GET', signal, {
      Authorization: `Bearer ${key}`,
    });
    // Seul un 2xx prouve que la cle est acceptee. Resend repond 400 sur une
    // cle malformee et 401 sur une cle revoquee : les deux sont des echecs.
    if (status >= 200 && status < 300) return { reachable: true, detail: `cle Resend acceptee (HTTP ${status})` };
    return { reachable: false, detail: `cle Resend refusee (HTTP ${status})` };
  });
}

/** Collecteur d'alertes : joignabilite seule, on n'emet pas de fausse alerte. */
export function probeAlerting(): Promise<ProbeResult> {
  return timed(async (signal) => {
    const url = process.env.TRACEFAB_NOTIFICATION_ALERT_URL?.trim();
    if (!url) return { reachable: false, detail: 'TRACEFAB_NOTIFICATION_ALERT_URL absent' };
    const { detail } = await reachableByHttp(url, 'HEAD', signal);
    return { reachable: true, detail: `${detail} (joignabilite seule, aucune alerte emise)` };
  });
}

/** Collecteur d'erreurs : optionnel. Son absence ne bloque pas la mise en
 *  production, mais elle doit etre visible. */
export function probeErrorSink(): Promise<ProbeResult> {
  return timed(async (signal) => {
    const url = process.env.TRACEFAB_ERROR_WEBHOOK_URL?.trim();
    if (!url) return { reachable: false, detail: 'TRACEFAB_ERROR_WEBHOOK_URL absent (journal stderr seul)' };
    const { detail } = await reachableByHttp(url, 'HEAD', signal);
    return { reachable: true, detail };
  });
}

export async function runLiveProbes() {
  const [database, privateStorage, antivirus, email, alerting, errorSink] = await Promise.all([
    probeDatabase(), probeStorage(), probeAntivirus(), probeEmail(), probeAlerting(), probeErrorSink(),
  ]);
  return { database, privateStorage, antivirus, email, alerting, errorSink };
}
