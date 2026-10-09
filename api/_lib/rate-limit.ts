import { createHmac } from 'node:crypto';
import type { VercelRequest, VercelResponse } from './vercel-types.js';

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
 * EN CAS DE PANNE, ON LAISSE PASSER
 *
 * Si la base est injoignable, L2 est ignore et seul L1 s'applique. Un
 * limiteur casse ne doit pas rendre le service indisponible : ce serait
 * transformer un incident de base en panne totale. C'est un choix assume, et
 * c'est la limite la plus importante a connaitre de ce module.
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
      // Un tableau de bord emet beaucoup d'appels par minute. Trop serrer ici
      // casserait l'application pour des utilisateurs legitimes.
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

/**
 * Chemins servis sans authentification : passeport public, lien numerique GS1,
 * passeport fournisseur et sa demande d'acces anonyme, table de facteurs PEF.
 *
 * Ces routes ne sont JAMAIS appelees avec des justificatifs par nos propres
 * surfaces. Un justificatif presente dessus ne peut donc venir que d'un client
 * qui cherche a changer de classe.
 */
const CHEMINS_PUBLICS: RegExp[] = [
  /^dpp\/[^/]+$/,
  /^gs1\/digital-link\/[^/]+$/,
  /^passport\/[^/]+$/,
  /^passport\/[^/]+\/request-access$/,
  /^pef\/factors$/,
];

const CHEMINS_WALLET: RegExp[] = [
  /\/(apple|google)-wallet$/,
  /\/wallet\/(apple|google)$/,
];

const estWallet = (path: string) => CHEMINS_WALLET.some((r) => r.test(path));
const estPublic = (path: string) => CHEMINS_PUBLICS.some((r) => r.test(path));

/**
 * Un justificatif STRUCTURELLEMENT plausible.
 *
 * CE QUI NE VA PAS AVEC « l'en-tete est non vide ».
 *
 * La version precedente se contentait de constater la presence de l'en-tete,
 * en assumant que « la route rejettera de toute facon ». Le raisonnement
 * oublie que le budget est consomme AVANT la route : `Authorization: Bearer x`
 * faisait passer une ecriture anonyme de 10 par 5 minutes a 600 par minute,
 * soit un facteur 300, et un laissez-passer Wallet de 20 a 600 par minute.
 * Le rejet par la route ne repare rien : il arrive apres la depense, et pour
 * une route authentifiee cette depense inclut un appel reseau a Clerk.
 *
 * On ne verifie toujours pas la signature — ce serait payer Clerk sur chaque
 * requete, y compris celles qu'on s'apprete a rejeter. Mais on exige la forme
 * d'un JWT : trois segments base64url, une charge utile decodable portant
 * `sub`, et une expiration non depassee. C'est gratuit, et cela suffit a ce
 * qu'aucun budget ne s'obtienne « par simple ajout d'un en-tete ».
 */
function jetonPlausible(valeur: string): boolean {
  const parts = valeur.split('.');
  if (parts.length !== 3) return false;
  if (!parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p))) return false;
  try {
    const charge = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof charge.sub !== 'string' || charge.sub.length === 0) return false;
    if (typeof charge.exp === 'number' && charge.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function carriesCredentials(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    if (jetonPlausible(auth.replace(/^Bearer\s+/i, '').trim())) return true;
  }
  const cookie = req.headers.cookie;
  const session = typeof cookie === 'string' ? /(^|;\s*)__session=([^;]+)/.exec(cookie) : null;
  if (session && jetonPlausible(decodeURIComponent(session[2]).trim())) return true;
  return false;
}

/**
 * La nature de la ROUTE prime sur ce que le client declare.
 *
 * L'ordre precedent interrogeait d'abord les justificatifs : un en-tete, choisi
 * par le client, decidait donc de la classe avant le chemin, qui lui ne l'est
 * pas. Les routes publiques et Wallet conservent desormais leur budget quoi
 * que presente l'appelant.
 */
export function classify(path: string, req: VercelRequest): RateLimitClass {
  if (isExempt(path)) return 'exempt';
  const ecriture = WRITE_METHODS.has((req.method || 'GET').toUpperCase());
  if (estWallet(path)) return 'wallet';
  if (estPublic(path)) return ecriture ? 'public-write' : 'public-read';
  if (carriesCredentials(req)) return 'credentialed';
  return ecriture ? 'public-write' : 'public-read';
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
export function clientAddress(req: VercelRequest): string {
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

/* ------------------------------------------------------------- decision */

export async function evaluate(
  path: string,
  req: VercelRequest,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const klass = classify(path, req);
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
    return { allowed: false, klass, limit: budget.limit, remaining: 0, resetSeconds, enforcedBy: 'memoire' };
  }

  const databaseHits = key ? await touchDatabase(key, budget, now) : null;
  if (databaseHits === null) {
    // PANNE DU COMPTEUR DURABLE — la reponse depend de la criticite.
    //
    // L'etage memoire survit, mais une fonction serverless est repliquee :
    // le plafond effectif devient `limite x nombre d'instances`, c'est-a-dire
    // un plafond qu'un attaquant releve en ouvrant des connexions. Accorder
    // cela a toutes les classes etait un fail-open deguise.
    //
    // Les classes `wallet` et `public-write` refusent desormais. Ce n'est pas
    // une perte de disponibilite : le compteur vit dans le MEME PostgreSQL que
    // les donnees metier. S'il est injoignable, la signature d'un laissez-
    // passer et l'ecriture d'une demande d'acces echoueraient de toute facon —
    // on refuse simplement plus tot, et sans avoir paye le travail.
    //
    // `public-read` et `credentialed` continuent sous le seul etage memoire :
    // leur cout unitaire est faible, et couper la lecture publique d'un
    // passeport ou l'usage d'une console authentifiee pendant un incident de
    // base serait une punition disproportionnee.
    const refuseEnPanne = klass === 'wallet' || klass === 'public-write';
    return {
      allowed: !refuseEnPanne,
      klass,
      limit: budget.limit,
      remaining: refuseEnPanne ? 0 : Math.max(0, budget.limit - memoryHits),
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
  };
}

/**
 * En-tetes de compte rendu. Les noms suivent le brouillon IETF
 * `draft-ietf-httpapi-ratelimit-headers` : un client qui sait les lire peut
 * ralentir de lui-meme au lieu d'attendre d'etre rejete.
 */
export function applyHeaders(res: VercelResponse, decision: RateLimitDecision): void {
  if (decision.klass === 'exempt') return;
  res.setHeader('RateLimit-Limit', String(decision.limit));
  res.setHeader('RateLimit-Remaining', String(decision.remaining));
  res.setHeader('RateLimit-Reset', String(decision.resetSeconds));
  res.setHeader('RateLimit-Policy', `${decision.limit};w=${budgetFor(decision.klass).windowSeconds}`);
  if (!decision.allowed) res.setHeader('Retry-After', String(decision.resetSeconds));
}
