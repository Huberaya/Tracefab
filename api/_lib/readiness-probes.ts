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

/**
 * Identite reelle de la connexion applicative.
 *
 * Pourquoi cette sonde existe. Toute la securite du runtime repose sur la RLS,
 * et la RLS ne s'applique pas a un role qui porte BYPASSRLS. Or l'identite
 * effectivement utilisee ne se deduit ni du code ni de la configuration
 * attendue : `DATABASE_URL` peut pointer n'importe quel role, et un role
 * proprietaire ou superutilisateur contourne silencieusement toutes les
 * politiques. Seul un `current_user` lu sur la connexion reelle le dit.
 *
 * Cette sonde passe par le MEME client Prisma que les routes
 * (api/_lib/prisma.ts, unique `new PrismaClient()` de api/). C'est la condition
 * pour qu'elle mesure l'identite du runtime et pas celle d'une connexion
 * ouverte a cote : un `psql` branche sur la meme URL ne prouverait rien.
 *
 * Regles respectees :
 *   - lecture seule. Trois fonctions du catalogue, aucune ecriture, aucune
 *     modification de role, aucun `SET ROLE` ;
 *   - aucun secret. Ni URL de connexion, ni hote, ni mot de passe : le resultat
 *     ne contient que des noms de role et deux booleens. Les messages d'erreur
 *     passent par `redact()`, comme toutes les autres sondes ;
 *   - la sonde ne jette pas : un echec est un resultat.
 *
 * Le resultat ne doit etre expose que derriere l'authentification deja en place
 * sur la route interne. Un nom de role n'est pas un secret en soi, mais le
 * publier sans authentification revelerait a quel point l'application est
 * proche — ou non — d'un contournement de RLS.
 */
export type DatabaseIdentity = {
  measured: boolean;
  currentUser: string | null;
  sessionUser: string | null;
  database: string | null;
  bypassesRls: boolean | null;
  isSuperuser: boolean | null;
  detail: string;
};

type IdentityRow = {
  current_user: string;
  session_user: string;
  database: string;
  bypasses_rls: boolean | null;
  is_superuser: boolean | null;
};

const IDENTITY_UNAVAILABLE: DatabaseIdentity = {
  measured: false,
  currentUser: null,
  sessionUser: null,
  database: null,
  bypassesRls: null,
  isSuperuser: null,
  detail: 'indisponible',
};

export async function probeDatabaseIdentity(): Promise<DatabaseIdentity> {
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      return { ...IDENTITY_UNAVAILABLE, detail: 'DATABASE_URL absent' };
    }
    const rows = await prisma.$queryRaw<IdentityRow[]>`
      SELECT current_user                                       AS current_user,
             session_user                                       AS session_user,
             current_database()                                 AS database,
             (SELECT rolbypassrls FROM pg_roles
               WHERE rolname = current_user)                    AS bypasses_rls,
             (SELECT rolsuper     FROM pg_roles
               WHERE rolname = current_user)                    AS is_superuser
    `;
    const row = rows?.[0];
    if (!row) return { ...IDENTITY_UNAVAILABLE, detail: 'requete honoree, aucune ligne' };
    return {
      measured: true,
      currentUser: row.current_user,
      sessionUser: row.session_user,
      database: row.database,
      bypassesRls: row.bypasses_rls,
      isSuperuser: row.is_superuser,
      detail: 'identite lue sur la connexion applicative',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...IDENTITY_UNAVAILABLE, detail: redact(message).slice(0, 160) };
  }
}

/**
 * Contrat de securite de l'identite runtime. La comparaison vit dans ce module
 * pour que la route ne publie pas de champs d'identite par defaut.
 */
export function databaseIdentityIsSafe(identity: DatabaseIdentity | undefined): boolean {
  return Boolean(
    identity?.measured &&
    identity.currentUser === 'tracefab_app' &&
    identity.sessionUser === 'tracefab_app' &&
    identity.bypassesRls === false &&
    identity.isSuperuser === false,
  );
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
