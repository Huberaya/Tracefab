import { createHmac, createHash } from 'node:crypto';
import type { VercelRequest as VReq, VercelResponse as VRes } from './vercel-types.js';

/**
 * Limitation de debit.
 *
 * Avant ce module, aucune route n'avait de plafond. `/api/dpp/:gtin` est
 * publique par construction — un passeport doit pouvoir etre lu par n'importe
 * quel telephone qui scanne un QR — et `/api/passport/:token/request-access`
 * est un POST anonyme qui ecrit en base. Il n'y avait rien entre un script et
 * la facture Neon.
 *
 * DEUX ETAGES, PARCE QU'AUCUN DES DEUX NE SUFFIT SEUL
 *
 * L1, en memoire du processus. Gratuit, instantane, mais une fonction
 * serverless est ephemere et replique : un compteur en memoire est multiplie
 * par le nombre d'instances chaudes. L1 n'est donc pas un plafond, c'est un
 * ralentisseur — il arrete la rafale qui tape une instance chaude sans jamais
 * toucher la base.
 *
 * L2, dans Postgres. Un compteur a fenetre fixe, incremente atomiquement.
 * C'est le seul etage qui soit un vrai plafond, parce qu'il est partage par
 * toutes les instances. Il coute un aller-retour base par requete — largement
 * moins cher que la requete qu'il empeche : resoudre un passeport DPP joint
 * une dizaine de tables.
 *
 * CE QUI N'EST PLUS VRAI, ET POURQUOI
 *
 * 1. Un en-tete `Authorization` non vide classait la requete « credentialed »
 *    (600/min) sans rien verifier : ajouter `Authorization: n'importe quoi`
 *    decuplait le budget d'un attaquant, y compris sur les routes Wallet
 *    (20/min) et sur la demande d'accès anonyme (10/5 min). Desormais, un
 *    justificatif PRESENTE n'ouvre aucun droit budgetaire : seule une
 *    authentification VERIFIEE — signature du jeton contre la cle Clerk —
 *    reclasse la requete. Un faux jeton reste dans le budget anonyme de la
 *    route, jamais au-dessus.
 * 2. « En cas de panne, on laisse passer » est trop grossier. Le comportement
 *    depend desormais de la criticite de la classe (voir evaluate()) :
 *    - `public-write` (ecriture anonyme en base) et `wallet` (signature
 *      cryptographique couteuse) : FAIL-CLOSED. Une panne du compteur ne
 *      doit pas devenir un accelerateur d'abus ; et ces routes ont de toute
 *      facon besoin de la base pour servir — l'elargir ne sauverait aucune
 *      disponibilite honnete.
 *    - `public-read` (lecture d'un passeport public) et `credentialed`
 *      (authentification verifiee) : FAIL-OPEN sur le seul etage memoire,
 *      comme avant. Un passeport public doit rester lisible pendant une
 *      panne du compteur, et un utilisateur reel ne doit pas etre puni pour
 *      un incident d'infrastructure. Les rafales restent freinees par L1.
 *    Ce choix est teste (scripts/test_rate_limit.mjs) et reflete le fait que
 *    la panne du compteur peut etre locale (table rate_limit_counters
 *    indisponible pendant que le reste de la base fonctionne).
 */

export type RateLimitClass = 'exempt' | 'public-read' | 'public-write' | 'wallet' | 'credentialed';

export type RateLimitBudget = { limit: number; windowSeconds: number };

export type RateLimitDecision = {
  allowed: boolean;
  klass: RateLimitClass;
  limit: number;
  remaining: number;
  resetSeconds: number;
  /** 'memoire' quand L2 n'a pas pu etre consulte. Sert au diagnostic. */
  enforcedBy: 'exempt' | 'memoire' | 'base';
  /**
   * Present quand la requete est refusee :
   * - 'over_budget' : le plafond est atteint (reponse 429) ;
   * - 'counter_unavailable' : le compteur partage est injoignable et la
   *   classe est en fail-closed (reponse 503).
   */
  reason?: 'over_budget' | 'counter_unavailable';
};

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Les budgets sont par empreinte client ET par classe. Un client qui repartit
 * sa charge sur plusieurs classes cumule donc les budgets : le plafond reel
 * par client est la somme des classes, pas le plus grand des budgets. C'est
 * volontaire — separer les classes evite qu'une rafale de lectures publiques
 * ne consomme le budget d'ecriture, qui est le plus sensible.
 */
export function budgetFor(klass: RateLimitClass): RateLimitBudget {
  switch (klass) {
    case 'public-read':
      return {
        limit: envInteger('TRACEFAB_RATE_LIMIT_PUBLIC_READ', 120, 10, 100000),
        windowSeconds: 60,
      };
    case 'wallet':
      // Signature cryptographique d'un laissez-passer : cher en CPU.
      return {
        limit: envInteger('TRACEFAB_RATE_LIMIT_WALLET', 20, 2, 10000),
        windowSeconds: 60,
      };
    case 'public-write':
      // Ecriture anonyme. Le budget est volontairement petit.
      return {
        limit: envInteger('TRACEFAB_RATE_LIMIT_PUBLIC_WRITE', 10, 1, 10000),
        windowSeconds: 300,
      };
    case 'credentialed':
      // Un tableau de bord emet beaucoup d'appels par minute. Trop serré ici
      // casserait l'application pour des utilisateurs legitimes. Ce budget
      // n'est atteint qu'avec une authentification VERIFIEE.
      return {
        limit: envInteger('TRACEFAB_RATE_LIMIT_CREDENTIALED', 600, 60, 1000000),
        windowSeconds: 60,
      };
    default:
      return { limit: 0, windowSeconds: 0 };
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes dispensees de plafond. La liste est courte et chaque entree se
 * justifie, parce qu'une dispense est un trou.
 *
 * - `health` est interroge en continu par la supervision ; le plafonner
 *   reviendrait a declarer le service en panne un jour de forte charge.
 * - `internal/*` est authentifie par un secret partage et appele par le
 *   planificateur : son debit est deja borne par le cron.
 * - `webhooks/clerk` est signe ; rejeter un webhook pour cause de debit le
 *   ferait rejouer en boucle par l'emetteur, ce qui aggrave la charge.
 */
function isExempt(path: string): boolean {
  return path === 'health' || path.startsWith('internal/') || path.startsWith('webhooks/');
}

/** Routes de generation de laissez-passer. Couteuses par construction. */
function isWalletPath(path: string): boolean {
  return /\/(apple|google)-wallet$/.test(path) || /\/wallet\/(apple|google)$/.test(path);
}

/* ------------------------------------------------- verification des jetons */

/**
 * Verificateur de justificatifs.
 *
 * La classe `credentialed` n'est accordee qu'apres verification
 * cryptographique du jeton. Rien de presentable par un client sans la cle
 * privee ne peut y acceder : c'est la reponse a « un faux jeton ne doit pas
 * permettre d'obtenir un budget plus permissif ».
 *
 * Par defaut, la verification utilise le secret Clerk du deploiement. Quand
 * il n'est pas configure (CI, tests sans reseau), AUCUNE requete n'est
 * consideree comme authentifiee : les budgets restent ceux des routes
 * publiques. C'est le sens de securite correct — un deploiement qui ne peut
 * pas verifier ne doit pas faire confiance.
 */
export type CredentialVerifier = (token: string) => Promise<boolean>;

let credentialVerifier: CredentialVerifier | null = null;

/** Reservee aux tests et aux deploiements specifiques. */
export function setCredentialVerifier(verifier: CredentialVerifier | null): void {
  credentialVerifier = verifier;
  verificationCache.clear();
}

/**
 * Memoire de verification : evite de re-verifier le meme jeton sur chaque
 * requete d'un tableau de bord. Le jeton n'est jamais stocke en clair —
 * seule son empreinte SHA-256 sert de cle, avec le resultat booleen.
 */
const verificationCache = new Map<string, { verified: boolean; expiresAt: number }>();
const VERIFICATION_TTL_MS = 60_000;

async function verifyWithClerk(token: string): Promise<boolean> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return false;
  try {
    const { verifyToken } = await import('@clerk/backend');
    const authorizedParties = (process.env.TRACEFAB_AUTHORIZED_PARTIES || '')
      .split(',')
      .map((party) => party.trim())
      .filter(Boolean);
    const claims = authorizedParties.length > 0
      ? await verifyToken(token, { secretKey, authorizedParties })
      : await verifyToken(token, { secretKey });
    return Boolean(claims?.sub);
  } catch {
    return false;
  }
}

/** Verification avec memoisation. Ne jette jamais : un echec = non verifie. */
export async function credentialIsVerified(token: string | null, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const cacheKey = createHash('sha256').update(token).digest('hex');
  const cached = verificationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.verified;
  const verifier = credentialVerifier ?? verifyWithClerk;
  let verified = false;
  try {
    verified = await verifier(token);
  } catch {
    verified = false;
  }
  if (verificationCache.size >= 10000) verificationCache.clear();
  verificationCache.set(cacheKey, { verified, expiresAt: now + VERIFICATION_TTL_MS });
  return verified;
}

/** Extrait le jeton presente (en-tete Bearer ou cookie de session). */
export function presentedToken(req: VReq): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) return token;
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    const match = /(^|;\s*)__session=([^;]+)/.exec(cookie);
    if (match && match[2]) return decodeURIComponent(match[2]);
  }
  return null;
}

/**
 * Classification d'une requete.
 *
 * Ordre deliberement fixe, du plus contraignant au plus large :
 *   1. dispensees (courte liste explicite) ;
 *   2. routes Wallet : la classe suit le COUT de la route, jamais les
 *      en-tetes — un faux jeton ne doit pas diluer le budget de signature ;
 *   3. authentification VERIFIEE : budget `credentialed` ;
 *   4. methode d'ecriture : `public-write` (les demandes d'accès anonymes
 *      gardent leur budget restrictif, jeton presente ou non) ;
 *   5. lecture : `public-read`.
 *
 * Un en-tete `Authorization` non vide ne change donc JAMAIS la classe.
 */
export function classify(path: string, req: VReq, authVerified = false): RateLimitClass {
  if (isExempt(path)) return 'exempt';
  if (isWalletPath(path)) return 'wallet';
  if (authVerified) return 'credentialed';
  if (WRITE_METHODS.has((req.method || 'GET').toUpperCase())) return 'public-write';
  return 'public-read';
}

/**
 * Adresse du client.
 *
 * `x-forwarded-for` est falsifiable par le client quand rien ne le reecrit :
 * un limiteur qui lui fait confiance distribue un budget infini a qui pense a
 * changer l'en-tete. On prefere donc, dans l'ordre, les en-tetes que la
 * plateforme ecrit elle-meme, et on ne retient de `x-forwarded-for` que le
 * DERNIER saut, celui qu'un client ne peut pas choisir.
 */
export function clientAddress(req: VReq): string {
  const first = (value: string | string[] | undefined): string | undefined => {
    if (Array.isArray(value)) return value[0];
    return value;
  };
  const vercel = first(req.headers['x-vercel-forwarded-for'] as string | string[] | undefined);
  if (vercel) return vercel.split(',')[0].trim();
  const real = first(req.headers['x-real-ip'] as string | string[] | undefined);
  if (real) return real.trim();
  const forwarded = first(req.headers['x-forwarded-for'] as string | string[] | undefined);
  if (forwarded) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'inconnu';
}

/**
 * La table ne doit contenir aucune donnee personnelle. Une adresse IPv4
 * hachee sans sel se retrouve par force brute en quelques secondes — il n'y a
 * que quatre milliards de valeurs possibles. On utilise donc un HMAC.
 *
 * Le sel est derive d'un secret que le deploiement possede deja, pour qu'il
 * n'y ait aucune variable supplementaire a configurer et donc aucune chance
 * qu'on oublie de la poser. `TRACEFAB_RATE_LIMIT_SALT` permet de le fixer
 * explicitement si on veut le faire tourner.
 */
function hmacKey(): string | null {
  const explicit = process.env.TRACEFAB_RATE_LIMIT_SALT;
  if (explicit) return explicit;
  const derived = process.env.CLERK_SECRET_KEY || process.env.DATABASE_URL;
  return derived || null;
}

export function fingerprint(address: string, klass: RateLimitClass): string {
  const key = hmacKey();
  if (!key) return '';
  return createHmac('sha256', key).update(`${klass}:${address}`).digest('hex').slice(0, 48);
}

/* ------------------------------------------------------------ etage memoire */

type MemoryBucket = { windowStart: number; hits: number };

/**
 * Le dictionnaire est borne. Sans borne, un attaquant qui fait tourner son
 * adresse source cree une entree par requete et epuise la memoire de
 * l'instance : le limiteur deviendrait lui-meme le vecteur de deni de service.
 */
const MEMORY_MAX_ENTRIES = 10000;
const memory = new Map<string, MemoryBucket>();

function pruneMemory(now: number, windowMs: number): void {
  if (memory.size <= MEMORY_MAX_ENTRIES) return;
  for (const [key, bucket] of memory) {
    if (now - bucket.windowStart >= windowMs) memory.delete(key);
  }
  // Si tout est encore dans la fenetre courante, on sacrifie les plus
  // anciennes entrees. Perdre un compteur est moins grave que perdre
  // l'instance.
  if (memory.size > MEMORY_MAX_ENTRIES) {
    const excess = memory.size - MEMORY_MAX_ENTRIES;
    let removed = 0;
    for (const key of memory.keys()) {
      memory.delete(key);
      if (++removed >= excess) break;
    }
  }
}

export function touchMemory(key: string, budget: RateLimitBudget, now = Date.now()): number {
  const windowMs = budget.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const existing = memory.get(key);
  if (!existing || existing.windowStart !== windowStart) {
    memory.set(key, { windowStart, hits: 1 });
    pruneMemory(now, windowMs);
    return 1;
  }
  existing.hits += 1;
  return existing.hits;
}

/** Reservee aux tests : remet l'etage memoire a zero. */
export function resetMemory(): void {
  memory.clear();
}

/* ------------------------------------------------------------- etage base */

let databaseDisabledUntil = 0;

/**
 * Compteur partage. Rend le nombre de hits dans la fenetre, ou `null` si
 * l'etage partage n'a pas pu etre consulte (panne, table absente, coupure
 * reseau). C'est ce `null` qui declenche la politique de panne par classe.
 */
export type DatabaseCounter = (
  key: string,
  budget: RateLimitBudget,
  now: number,
) => Promise<number | null>;

let databaseCounter: DatabaseCounter | null = null;

/**
 * Reservee aux tests : injecte un compteur partage (reussite ou panne
 * simulee) sans dependre de la disponibilite reelle de PostgreSQL.
 */
export function setDatabaseCounter(counter: DatabaseCounter | null): void {
  databaseCounter = counter;
  resetDatabaseBackoff();
}

/**
 * Incrementation atomique d'une fenetre fixe. `ON CONFLICT ... DO UPDATE ...
 * RETURNING` fait l'increment et la lecture en une seule instruction : deux
 * instances qui tapent la meme fenetre au meme instant ne peuvent pas lire la
 * meme valeur.
 */
export async function touchDatabase(
  key: string,
  budget: RateLimitBudget,
  now = Date.now(),
): Promise<number | null> {
  if (databaseCounter) return databaseCounter(key, budget, now);
  if (now < databaseDisabledUntil) return null;
  if (!process.env.DATABASE_URL) return null;
  const windowMs = budget.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs * 2);
  try {
    // Import tardif : la majorite des requetes ne doit pas payer le cout
    // d'initialisation du client Prisma au demarrage a froid.
    const { prisma } = await import('./prisma.js');
    const rows = await prisma.$queryRaw<Array<{ hits: number }>>`
      INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
      VALUES (${key}, ${windowStart}, 1, ${expiresAt})
      ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET hits = rate_limit_counters.hits + 1
      RETURNING hits
    `;
    const hits = rows?.[0]?.hits;
    if (typeof hits !== 'number') return null;
    // Nettoyage opportuniste : une fenetre sur cinquante environ purge les
    // fenetres expirees. Un balayage planifie serait une piece mobile de plus
    // a surveiller pour une table qui tient dans une poignee de pages.
    if (hits === 1 && Math.random() < 0.02) {
      await prisma.$executeRaw`DELETE FROM rate_limit_counters WHERE expires_at < NOW()`;
    }
    return hits;
  } catch {
    // On n'insiste pas pendant trente secondes. Si la base refuse, chaque
    // requete suivante paierait le delai d'expiration de la connexion : le
    // limiteur ralentirait le service qu'il protege.
    databaseDisabledUntil = now + 30000;
    return null;
  }
}

/** Reservee aux tests : leve la mise en quarantaine de l'etage base. */
export function resetDatabaseBackoff(): void {
  databaseDisabledUntil = 0;
}

/**
 * Politique de panne de L2, par criticite de classe.
 *
 * Voir l'en-tete du module pour le raisonnement. Retourne `true` si la
 * requete peut continuer sur le seul etage memoire.
 */
export function failOpenWhenCounterUnavailable(klass: RateLimitClass): boolean {
  return klass === 'public-read' || klass === 'credentialed';
}

/* ------------------------------------------------------------- decision */

export async function evaluate(
  path: string,
  req: VReq,
  now = Date.now(),
): Promise<RateLimitDecision> {
  // La verification ne peut pas etre poussee au gestionnaire de route :
  // c'est ici que le budget est choisi, et un budget choisi sur un simple
  // en-tete serait un budget offert. Le jeton presente est donc verifie —
  // cryptographiquement, avec memoisation — avant tout reclassement.
  const authVerified = await credentialIsVerified(presentedToken(req), now);
  const klass = classify(path, req, authVerified);
  if (klass === 'exempt') {
    return { allowed: true, klass, limit: 0, remaining: 0, resetSeconds: 0, enforcedBy: 'exempt' };
  }

  const budget = budgetFor(klass);
  const windowMs = budget.windowSeconds * 1000;
  const resetSeconds = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  const key = fingerprint(clientAddress(req), klass);

  // Sans secret pour deriver le HMAC on refuse d'ecrire une adresse en base.
  // L'etage memoire, lui, reste actif : il ne persiste rien.
  const memoryHits = touchMemory(key || `clair:${clientAddress(req)}:${klass}`, budget, now);
  if (memoryHits > budget.limit) {
    return {
      allowed: false,
      klass,
      limit: budget.limit,
      remaining: 0,
      resetSeconds,
      enforcedBy: 'memoire',
      reason: 'over_budget',
    };
  }

  const databaseHits = key ? await touchDatabase(key, budget, now) : null;
  if (databaseHits === null) {
    // Panne (ou absence) du compteur partage.
    if (!failOpenWhenCounterUnavailable(klass)) {
      return {
        allowed: false,
        klass,
        limit: budget.limit,
        remaining: 0,
        resetSeconds,
        enforcedBy: 'memoire',
        reason: 'counter_unavailable',
      };
    }
    return {
      allowed: true,
      klass,
      limit: budget.limit,
      remaining: Math.max(0, budget.limit - memoryHits),
      resetSeconds,
      enforcedBy: 'memoire',
    };
  }

  return {
    allowed: databaseHits <= budget.limit,
    klass,
    limit: budget.limit,
    remaining: Math.max(0, budget.limit - databaseHits),
    resetSeconds,
    enforcedBy: 'base',
    ...(databaseHits <= budget.limit ? {} : { reason: 'over_budget' as const }),
  };
}

/**
 * En-tetes de compte rendu. Les noms suivent le brouillon IETF
 * `draft-ietf-httpapi-ratelimit-headers` : un client qui sait les lire peut
 * ralentir de lui-meme au lieu d'attendre d'etre rejete.
 */
export function applyHeaders(res: VRes, decision: RateLimitDecision): void {
  if (decision.klass === 'exempt') return;
  res.setHeader('RateLimit-Limit', String(decision.limit));
  res.setHeader('RateLimit-Remaining', String(decision.remaining));
  res.setHeader('RateLimit-Reset', String(decision.resetSeconds));
  res.setHeader('RateLimit-Policy', `${decision.limit};w=${budgetFor(decision.klass).windowSeconds}`);
  if (!decision.allowed) res.setHeader('Retry-After', String(decision.resetSeconds));
}
