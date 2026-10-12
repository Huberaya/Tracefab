/**
 * Garde de cible — refus par défaut avant toute suite destructive.
 *
 * POURQUOI CETTE GARDE EXISTE
 *
 * Le depot contient quinze suites `test_neon_*.mjs`. La plupart ECRIVENT :
 * `CREATE ROLE`, `DROP ROLE`, `GRANT`, `REVOKE ALL PRIVILEGES ON ALL TABLES`,
 * `DELETE`, `UPDATE`, creation de fournisseurs et de documents. Aucune ne
 * verifiait sa cible. Le 2026-10-10, les cinq suites branchees dans la CI
 * s'executaient contre la base referencee par `secrets.DATABASE_URL` — la
 * production — des qu'un contributeur ayant le droit d'ecriture modifiait le
 * workflow sur sa branche.
 *
 * Le correctif de circonstance consistait a retirer ces lignes du workflow.
 * C'est necessaire, mais ce n'est pas suffisant : retirer une etape ne
 * protege pas de la suivante. La cause racine est qu'une suite destructive
 * pouvait s'executer sans avoir prouve ce qu'elle allait modifier.
 *
 * Cette garde deplace la decision du workflow vers la suite elle-meme. Elle
 * est donc a l'epreuve de tout nouveau chemin d'execution — un workflow
 * ajoute, une commande manuelle, un script d'exploitation, un futur agent.
 *
 * PRINCIPE : REFUS PAR DEFAUT
 *
 * Une cible n'est acceptee que si elle est localement jetable, ou si elle est
 * explicitement declaree comme telle par trois variables concordantes. Tout
 * le reste est refuse, y compris ce qui n'a pas ete reconnu.
 *
 * CE QUI EST TOUJOURS REFUSE
 *
 *   — un contexte de deploiement de production (`VERCEL_ENV`, `NODE_ENV`) ;
 *   — un hote de base managee connu (`*.neon.tech`, `*.supabase.*`,
 *     `*.rds.amazonaws.com`, …), SANS EXCEPTION : un hote manage n'est jamais
 *     jetable par nature, une liste blanche ne le rend pas jetable, et le
 *     declarer reviendrait a declarer la plateforme qui heberge la production ;
 *   — un nom de base evoquant la production ;
 *   — une cible illisible ou non parsable.
 *
 * TOUS LES CAS PRECEDENTS SONT JUGES SUR L'HOTE REELLEMENT JOINT
 *
 * Un parametre `host=` dans la chaine de connexion l'emporte sur l'hote
 * present dans l'URL (c'est ce que fait `pg-connection-string`, donc ce que
 * fait le pilote au moment de se connecter). Une chaine ecrite
 * `postgresql://…@localhost/…?host=<hote distant>` joint donc l'hote distant
 * tout en paraissant locale. La classification porte sur l'hote effectif,
 * jamais sur celui que l'URL affiche.
 *
 * CE QUI N'EST JAMAIS AFFICHE
 *
 * Ni URL, ni hote, ni identifiant, ni mot de passe. La garde publie une
 * classification et une empreinte SHA-256 tronquee : assez pour correler un
 * journal, insuffisant pour reconstituer un secret.
 */
import { createHash } from 'node:crypto';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Un hote de base managee : jamais jetable par nature. */
const MANAGED_HOST_PATTERNS = [
  /\.neon\.tech$/i,
  /\.neon\.build$/i,
  /^neon\.tech$/i,
  /\.supabase\.co$/i,
  /\.supabase\.in$/i,
  /\.rds\.amazonaws\.com$/i,
  /\.database\.windows\.net$/i,
  /\.azure\.com$/i,
];

const PRODUCTION_HINTS = /(^|[-_.])(prod|production|live|main)([-_.]|$)/i;

export const EXIT_NOT_CONFIGURED = 2;
export const EXIT_REFUSED = 3;

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function splitList(name) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Classe une cible sans jamais la divulguer.
 * Levee d'exception volontairement absente : cette fonction ne doit pas
 * pouvoir etre transformee en « autorisation par accident » via un try/catch.
 */
export function classifyTarget(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return { allowed: false, code: 'missing', reason: 'variable de connexion absente' };
  }
  const raw = rawValue.trim();

  let parsed;
  try {
    // `postgres://` et `postgresql://` sont acceptes par pg ; un socket Unix
    // s'ecrit `postgresql:///dbname?host=/var/run/postgresql`.
    parsed = new URL(raw);
  } catch {
    return { allowed: false, code: 'unparseable', reason: 'valeur de connexion non analysable' };
  }

  // Un point final designe le meme hote (nom absolu). Sans normalisation,
  // `ep-xxx.neon.tech.` echappait a la reconnaissance des hotes manages : mesure
  // faite le 2026-10-12, il etait classe « cible distante autorisee » des lors
  // qu'il figurait dans la liste blanche. On retire donc au plus un point final.
  const brut = (parsed.hostname || '').toLowerCase();
  const hostnameUrl = brut.endsWith('.') ? brut.slice(0, -1) : brut;
  const socketHost = (parsed.searchParams.get('host') || '').trim();
  const database = decodeURIComponent((parsed.pathname || '').replace(/^\//, '')).toLowerCase();
  // L'hote EFFECTIF : celui que le pilote joindra reellement. Un `host=/chemin`
  // est une socket Unix locale ; tout autre `host=` est un nom d'hote, et il
  // prend le pas sur celui de l'URL.
  const isSocket = socketHost.startsWith('/');
  const hostBrut = socketHost && !isSocket ? socketHost.toLowerCase() : hostnameUrl;
  const host = hostBrut.endsWith('.') ? hostBrut.slice(0, -1) : hostBrut;
  const isLocal = isSocket || LOCAL_HOSTS.has(host);

  const allowedHosts = splitList('TRACEFAB_TEST_DB_HOST_ALLOWLIST');
  const allowedNames = splitList('TRACEFAB_TEST_DB_NAME_ALLOWLIST');
  const explicitOptIn = process.env.TRACEFAB_ALLOW_NONLOCAL_TEST_DB === 'true';

  const info = {
    fingerprint: fingerprint(raw),
    // Seul le nom de base est publie : il ne porte aucun privilege.
    database: database || '(defaut)',
    local: isLocal,
    explicitOptIn,
  };

  // 1. Refus inconditionnels, quel que soit le reste de la configuration.
  // Le protocole d'abord : ce depot ne parle que PostgreSQL, et un schema
  // inattendu est le signe d'une cible mal ecrite. Refus par defaut.
  const protocole = (parsed.protocol || '').toLowerCase();
  if (protocole !== 'postgres:' && protocole !== 'postgresql:') {
    return { ...info, allowed: false, code: 'scheme_not_supported', reason: `protocole inattendu (${protocole.replace(':', '') || 'aucun'}) — ce depot ne parle que PostgreSQL` };
  }
  const deployment = (process.env.VERCEL_ENV || '').toLowerCase();
  if (deployment === 'production') {
    return { ...info, allowed: false, code: 'production_context', reason: 'contexte de deploiement de production' };
  }
  if (!isLocal && PRODUCTION_HINTS.test(database)) {
    return { ...info, allowed: false, code: 'production_name', reason: 'le nom de base evoque la production' };
  }
  // Un hote manage est refuse ici, avant toute lecture d'opt-in ou de liste
  // blanche : aucune declaration ne le rend jetable.
  if (MANAGED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { ...info, allowed: false, code: 'managed_host', reason: 'hote de base managee — jamais jetable, quelle que soit la declaration' };
  }

  // 2. Cible locale : jetable par construction.
  if (isLocal) {
    return { ...info, allowed: true, code: 'throwaway_local', reason: 'cible locale' };
  }

  // 3. Cible distante : trois declarations concordantes sont exigees.
  if (!explicitOptIn) {
    return { ...info, allowed: false, code: 'remote_not_opted_in', reason: 'cible distante sans opt-in explicite' };
  }
  if (!allowedHosts.includes(host)) {
    return { ...info, allowed: false, code: 'host_not_allowlisted', reason: 'hote absent de la liste blanche' };
  }
  if (!allowedNames.includes(database)) {
    return { ...info, allowed: false, code: 'name_not_allowlisted', reason: 'nom de base absent de la liste blanche' };
  }
  return { ...info, allowed: true, code: 'allowlisted_remote', reason: 'cible distante explicitement autorisee' };
}

/** Rapport d'une ligne, sans valeur sensible. */
export function describeTarget(variable, verdict) {
  const parts = [`${variable} -> ${verdict.allowed ? 'ACCEPTEE' : 'REFUSEE'}`];
  parts.push(`classe=${verdict.code}`);
  if (verdict.database) parts.push(`base=${verdict.database}`);
  if (verdict.fingerprint) parts.push(`empreinte=${verdict.fingerprint}`);
  parts.push(`raison=${verdict.reason}`);
  return parts.join(' | ');
}

/**
 * Verifie une ou plusieurs variables de connexion avant d'executer une suite
 * destructive. Sort du processus si une cible n'est pas autorisee.
 *
 * `exitOnFailure = false` renvoie le verdict au lieu de sortir : c'est ce que
 * la suite de tests de la garde utilise pour prouver les refus.
 */
export function requireThrowawayDb({
  variables = ['DATABASE_URL'],
  purpose = 'suite destructive',
  exitOnFailure = true,
} = {}) {
  const verdicts = variables.map((variable) => ({
    variable,
    present: Boolean((process.env[variable] || '').trim()),
    verdict: classifyTarget(process.env[variable]),
  }));

  const absent = verdicts.filter((entry) => !entry.present);
  const refused = verdicts.filter((entry) => entry.present && !entry.verdict.allowed);

  if (absent.length > 0) {
    // Un test qui ne tourne pas n'est pas un test qui passe : sortie 2.
    // Sans valeur de connexion il n'y a rien a proteger, seulement rien a faire.
    if (exitOnFailure) {
      console.error(`\n  NON EXECUTE — ${absent.map((e) => e.variable).join(', ')} absent(s).`);
      console.error(`  ${purpose} : aucune cible fournie, donc aucune execution.`);
      console.error('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.\n');
      process.exit(EXIT_NOT_CONFIGURED);
    }
    return { ok: false, code: 'missing', verdicts };
  }

  if (refused.length > 0) {
    if (exitOnFailure) {
      console.error(`\n  REFUS — cible non autorisee pour : ${purpose}`);
      for (const entry of refused) console.error(`  ${describeTarget(entry.variable, entry.verdict)}`);
      console.error('  Cette suite touche une base de donnees : elle peut y ecrire des roles,');
      console.error('  des privileges ou des donnees, ou y lire des donnees metier.');
      console.error('  Pour une cible distante, il faut explicitement :');
      console.error('    TRACEFAB_ALLOW_NONLOCAL_TEST_DB=true');
      console.error('    TRACEFAB_TEST_DB_HOST_ALLOWLIST=<hote>');
      console.error('    TRACEFAB_TEST_DB_NAME_ALLOWLIST=<base>');
      console.error('  Aucun secret ni chaine de connexion n a ete affiche : sortie 3.\n');
      process.exit(EXIT_REFUSED);
    }
    return { ok: false, code: 'refused', verdicts };
  }

  const summary = verdicts.map((entry) => describeTarget(entry.variable, entry.verdict));
  return { ok: true, code: 'allowed', verdicts, summary };
}

/**
 * Assertion reutilisable dans une suite : leve si la cible n'est pas autorisee.
 * Un import direct rend la suite impossible a executer sans garde, meme
 * lorsqu'elle est appelee hors du lanceur commun.
 */
export function assertThrowawayDb(options = {}) {
  const result = requireThrowawayDb({ ...options, exitOnFailure: true });
  if (result.summary) for (const line of result.summary) console.log(`  garde cible : ${line}`);
  return result;
}
