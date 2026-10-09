import { prisma } from './prisma.js';
import { headObject, storageConfig } from './storage.js';
import { redact } from './error-reporting.js';

/**
 * Sondes de disponibilite reelles.
 *
 * L'endpoint de readiness existant verifie que les variables d'environnement
 * sont *definies*. C'est utile, mais une cle presente n'est pas une cle valide,
 * et un bucket nomme n'est pas un bucket joignable. Le jour de la mise en
 * production, la difference est tout.
 *
 * Ces sondes exercent reellement chaque service. Elles sont volontairement
 * separees du controle de configuration : on ne veut pas appeler quatre
 * services externes a chaque passage d'une sonde de supervision.
 *
 * Regles :
 *   - aucune sonde ne jette : un service en panne est un resultat, pas un bug.
 *   - aucune sonde n'a d'effet de bord. On ne poste pas un vrai e-mail pour
 *     verifier que l'envoi marche.
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

async function timed(fn: () => Promise<Omit<ProbeResult, 'latencyMs'>>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, latencyMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, latencyMs: Date.now() - started, detail: redact(message).slice(0, 160) };
  }
}

/** Une reponse HTTP, meme 405 ou 404, prouve que l'hote repond. Seules une
 *  panne reseau et un depassement de delai signifient injoignable. */
async function reachableByHttp(url: string, method: 'HEAD' | 'GET', headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probeTimeout());
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal });
    return { reachable: true, detail: `reponse HTTP ${response.status}`, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Base de donnees : la sonde qui compte le plus. Une requete triviale prouve
 *  la resolution DNS, le TLS, l'authentification et le pooler. */
export function probeDatabase(): Promise<ProbeResult> {
  return timed(async () => {
    if (!process.env.DATABASE_URL?.trim()) return { reachable: false, detail: 'DATABASE_URL absent' };
    await prisma.$queryRaw`SELECT 1`;
    return { reachable: true, detail: 'requete SELECT 1 honoree' };
  });
}

/** Stockage prive : on interroge une cle qui n'existe pas. Un 404 est un
 *  succes — il prouve que le bucket repond et que la signature est acceptee.
 *  Un 403 signifierait des identifiants refuses. */
export function probeStorage(): Promise<ProbeResult> {
  return timed(async () => {
    storageConfig(); // jette si la configuration est invalide
    try {
      await headObject('tracefab-readiness-probe/.keep');
      return { reachable: true, detail: 'objet sonde present, bucket joignable' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'document_object_not_found') {
        return { reachable: true, detail: 'bucket joignable, signature acceptee (404 attendu)' };
      }
      // private_storage_head_failed couvre 403 : identifiants refuses.
      return { reachable: false, detail: redact(message).slice(0, 160) };
    }
  });
}

/** Antivirus : l'analyseur n'accepte que POST avec un corps. On se contente
 *  donc de prouver que l'hote repond, sans lui soumettre de fichier. */
export function probeAntivirus(): Promise<ProbeResult> {
  return timed(async () => {
    const url = process.env.PRIVATE_STORAGE_ANTIVIRUS_URL?.trim();
    if (!url) return { reachable: false, detail: 'PRIVATE_STORAGE_ANTIVIRUS_URL absent' };
    const { detail } = await reachableByHttp(url, 'HEAD');
    return { reachable: true, detail: `${detail} (joignabilite seule, aucun fichier soumis)` };
  });
}

/** Resend : GET /domains valide la cle d'API sans envoyer le moindre message.
 *  Un 401 prouve que l'hote repond mais que la cle est refusee. */
export function probeEmail(): Promise<ProbeResult> {
  return timed(async () => {
    const key = process.env.RESEND_API_KEY?.trim();
    if (!key) return { reachable: false, detail: 'RESEND_API_KEY absent' };
    const { status } = await reachableByHttp('https://api.resend.com/domains', 'GET', {
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
  return timed(async () => {
    const url = process.env.TRACEFAB_NOTIFICATION_ALERT_URL?.trim();
    if (!url) return { reachable: false, detail: 'TRACEFAB_NOTIFICATION_ALERT_URL absent' };
    const { detail } = await reachableByHttp(url, 'HEAD');
    return { reachable: true, detail: `${detail} (joignabilite seule, aucune alerte emise)` };
  });
}

/** Collecteur d'erreurs : optionnel. Son absence ne bloque pas la mise en
 *  production, mais elle doit etre visible. */
export function probeErrorSink(): Promise<ProbeResult> {
  return timed(async () => {
    const url = process.env.TRACEFAB_ERROR_WEBHOOK_URL?.trim();
    if (!url) return { reachable: false, detail: 'TRACEFAB_ERROR_WEBHOOK_URL absent (journal stderr seul)' };
    const { detail } = await reachableByHttp(url, 'HEAD');
    return { reachable: true, detail };
  });
}

export async function runLiveProbes() {
  const [database, privateStorage, antivirus, email, alerting, errorSink] = await Promise.all([
    probeDatabase(), probeStorage(), probeAntivirus(), probeEmail(), probeAlerting(), probeErrorSink(),
  ]);
  return { database, privateStorage, antivirus, email, alerting, errorSink };
}
