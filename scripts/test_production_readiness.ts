#!/usr/bin/env node
/**
 * TRACEFAB — garde-fous de mise en production (chantier 18).
 *
 * Trois invariants, choisis parce que chacun correspond a une panne reelle
 * deja vue ailleurs :
 *
 *   1. Toute route passe par la barriere d'erreur centrale. Sans elle, une
 *      exception non rattrapee devient un 500 opaque que personne ne voit.
 *   2. Le caviardage neutralise vraiment les secrets. Une cle d'API archivee
 *      dans un collecteur de logs est une fuite permanente.
 *   3. Toute variable d'environnement lue par api/ est documentee. Une
 *      variable oubliee est une panne de deploiement qui attend son tour.
 *
 * Usage : npx tsx scripts/test_production_readiness.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const failures = [];
const checks = [];

const check = (label: string, cond: unknown, why = '') => {
  checks.push({ label, pass: Boolean(cond) });
  if (!cond) failures.push(`${label}${why ? ` — ${why}` : ''}`);
};

/* ------------------------------------------- 1. barriere d'erreur centrale */

const index = read('api/index.ts');
check('api/index.ts importe la remontee d erreurs', index.includes('error-reporting.js'));
check('la repartition est enveloppee dans un try', /try\s*\{[\s\S]*route\.load\(\)/.test(index));
check('les exceptions sont rattrapees', /catch\s*\(\s*error\s*\)/.test(index));
check('les erreurs sont remontees', index.includes('reportError('));
check('un identifiant de correlation est rendu au client', index.includes('correlationId'));
check('une reponse deja commencee n est pas ecrasee',
  index.includes('headersSent') && index.includes('writableEnded'));
check('le client ne recoit jamais le detail de l exception',
  index.includes("error: 'internal_error'") && !/catch[\s\S]{0,400}error\.message/.test(index));

/* --------------------------------------------------- 2. caviardage reel */

const reporting = read('api/_lib/error-reporting.ts');
// On vise les dependances reelles, pas les mentions : le fichier cite Sentry
// et Datadog en exemple de collecteurs compatibles, ce qui est voulu.
check('la remontee ne depend d aucun fournisseur',
  !/^\s*import[^\n]*(@sentry|datadog|bugsnag|rollbar)/im.test(reporting));
check('le journal stderr est inconditionnel', reporting.includes('console.error(JSON.stringify(payload))'));

// Le caviardage est execute, pas suppose : on lui soumet de vrais motifs.
// Ce script tourne sous tsx, il peut donc importer le module TypeScript et
// appeler la vraie fonction au lieu de constater que des motifs existent.
const { redact } = await import('../api/_lib/error-reporting.js');

const SECRETS: Array<[string, string, string]> = [
  ['chaine Postgres', 'echec sur postgres://tracefab:m0tDeP4sse@ep-x.neon.tech/db', 'm0tDeP4sse'],
  ['cle Clerk', 'refus avec sk_live_AbCdEf0123456789XY', 'sk_live_AbCdEf0123456789XY'],
  ['cle Resend', 'envoi avec re_AbCdEf0123456789', 're_AbCdEf0123456789'],
  ['cle AWS', 'signature AKIAIOSFODNN7EXAMPLE refusee', 'AKIAIOSFODNN7EXAMPLE'],
  ['en-tete Bearer', 'Authorization: Bearer abcdef0123456789XYZ', 'abcdef0123456789XYZ'],
  ['jeton JWT', 'jeton eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
  ['parametre signe', 'url?x-amz-credential=AKIA123/20260101/eu', 'AKIA123'],
];

for (const [nom, entree, secret] of SECRETS) {
  check(`caviardage execute : ${nom}`, !redact(entree).includes(secret),
    `"${secret}" survit au caviardage`);
}

/* ------------------------------------- 3. contrat de variables respecte */

const CONTRACT = 'docs/operations/variables-environnement.md';
const contract = read(CONTRACT);
const documented = new Set((contract.match(/`([A-Z][A-Z0-9_]{3,})`/g) || []).map((s) => s.slice(1, -1)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const used = new Set();
for (const file of walk('api')) {
  const src = read(file);
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
  for (const m of src.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) used.add(m[1]);
  // Les lectures indirectes comptent autant : configuredInteger('X', ...) et
  // les tableaux de variables requises echappent au motif process.env.X.
  // Un nom cite ailleurs comme simple valeur n'est pas une variable.
  for (const m of src.matchAll(/configured(?:Integer)?\(\s*'([A-Z][A-Z0-9_]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/const required = \[([^\]]+)\]/g)) {
    for (const n of m[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)) used.add(n[1]);
  }
}

const undocumented = [...used].filter((v) => !documented.has(v)).sort();
check(`les ${used.size} variables lues par api/ sont documentees`,
  undocumented.length === 0,
  undocumented.length ? `absentes de ${CONTRACT} : ${undocumented.join(', ')}` : '');

/* ------------------------------------- 4. sondes et documents d exploitation */

const readiness = read('api/_routes/internal/p2-readiness.ts');
check('la readiness distingue configuration et disponibilite',
  readiness.includes("probe === 'live'") && readiness.includes('runLiveProbes'));
check('le mode par defaut reste compatible', readiness.includes('configurationOnly: true'));

const probes = read('api/_lib/readiness-probes.ts');
check('aucune sonde n a d effet de bord',
  !/sendOrganizationMemberInvitationEmail|sendSupplierInvitationEmail|emitNotificationAlert/.test(probes));
check('la sonde e-mail n accepte que 2xx', probes.includes('status >= 200 && status < 300'));

for (const doc of [
  'docs/operations/variables-environnement.md',
  'docs/operations/runbook-sauvegarde-restauration.md',
  'docs/operations/checklist-mise-en-production.md',
  'docs/commercial/demo-scriptee.md',
  'docs/commercial/dossier-securite.md',
]) {
  let present = true;
  try { read(doc); } catch { present = false; }
  check(`document d exploitation present : ${doc.split('/').pop()}`, present);
}

/* ----------------------------------- 5. le dossier securite ne surpromet pas */

// Un dossier sécurité qui perdrait sa section de limites deviendrait un
// engagement qu'on ne tient pas. On verrouille donc sa presence.
const securite = read('docs/commercial/dossier-securite.md');
check('le dossier securite declare ce qui manque',
  /##\s*Ce que nous n'avons pas encore/.test(securite));
check('l absence de limitation de debit y est ecrite',
  /limitation de d[ée]bit/i.test(securite) && /absente/i.test(securite));
check('le dossier securite ne revendique aucune certification obtenue',
  !/nous sommes certifi|certification obtenue|conforme ESPR/i.test(securite));

const demo = read('docs/commercial/demo-scriptee.md');
check('la demo rappelle que la maturite DPP n est pas une certification',
  /pas une certification/i.test(demo));

/* ------------------------------ 6. securite et performance (chantier 16) */

// La limitation de debit est le seul manque du lot qui soit exploitable par
// un tiers : /api/dpp/:gtin est public par construction. On verrouille donc
// sa presence, et surtout ses deux etages — un limiteur en memoire seul est
// multiplie par le nombre d'instances serverless, ce n'est pas un plafond.
const routeur = read('api/index.ts');
check('le routeur central evalue la limitation de debit',
  /evaluate\(path, req\)/.test(routeur) && /from '\.\/_lib\/rate-limit\.js'/.test(routeur));
check('le routeur repond 429 quand le plafond est atteint',
  /json\(res, 429, \{ error: 'rate_limited'/.test(routeur));
check('le plafond est evalue avant le chargement du module de route',
  routeur.indexOf('evaluate(path, req)') < routeur.indexOf('await route.load()'));

const limiteur = read('api/_lib/rate-limit.ts');
check('le limiteur a un etage partage en base, pas seulement en memoire',
  /ON CONFLICT \(bucket_key, window_start\)/.test(limiteur) && /rate_limit_counters/.test(limiteur));
check('le limiteur laisse passer quand la base est injoignable',
  /databaseDisabledUntil/.test(limiteur));
check('l adresse du client est reduite par HMAC, jamais stockee en clair',
  /createHmac\('sha256'/.test(limiteur));
check('le limiteur ignore x-forwarded-for comme premiere source',
  /x-vercel-forwarded-for/.test(limiteur) && /hops\[hops\.length - 1\]/.test(limiteur));
check('l etage memoire est borne contre l epuisement',
  /MEMORY_MAX_ENTRIES/.test(limiteur));

const migrationLimite = read('prisma/migrations/20261008100000_rate_limit_counters/migration.sql');
check('la table de compteurs porte RLS, comme toutes les autres',
  /ENABLE ROW LEVEL SECURITY/.test(migrationLimite) && /FORCE ROW LEVEL SECURITY/.test(migrationLimite));

// 36 findMany n'avaient aucun take. Le plafond est pose sur le client pour
// couvrir aussi les requetes qui ne sont pas encore ecrites.
const client = read('api/_lib/prisma.ts');
// Ancre sur la structure, pas sur la presence du mot : `$allModelsInactif`
// contiendrait encore `$allModels` et laisserait passer un plafond debranche.
check('le client Prisma plafonne tout findMany sans take',
  /\$allModels\s*:\s*\{/.test(client)
  && /async findMany\(\{\s*args,\s*query/.test(client)
  && /take:\s*ROW_CEILING/.test(client));
check('une troncature reelle est journalisee, jamais silencieuse',
  /tracefab-row-ceiling-v1/.test(client));

// CSP : retirer 'unsafe-inline' de script-src n'a de valeur que si plus
// aucun script inline ni aucun attribut on*= ne subsiste. Verifier la seule
// directive laisserait une politique que la page viole a chaque chargement.
const vercel = read('vercel.json');
const csp = (vercel.match(/"Content-Security-Policy"[\s\S]{0,80}?"value":\s*"([^"]+)"/) || [])[1] || '';
const scriptSrc = (csp.match(/script-src([^;]*)/) || [])[1] || '';
check('script-src n autorise plus unsafe-inline', !/unsafe-inline/.test(scriptSrc));
check('script-src n autorise pas unsafe-eval', !/unsafe-eval/.test(scriptSrc));

const pages = execSync('git ls-files "*.html"', { encoding: 'utf8' }).trim().split('\n');
const inlineBlocks: string[] = [];
const inlineHandlers: string[] = [];
for (const page of pages) {
  const src = read(page);
  for (const m of src.matchAll(/<script([^>]*)>/g)) {
    const attrs = m[1] || '';
    if (!/\bsrc=/.test(attrs) && !/ld\+json/.test(attrs)) inlineBlocks.push(page);
  }
  for (const m of src.matchAll(/\son(?:click|change|submit|load|error|input|focus|blur)\s*=\s*"/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (before.includes('//') || before.includes('<!--')) continue;
    inlineHandlers.push(`${page}`);
  }
}
check('aucun bloc <script> executable ne reste dans le HTML',
  inlineBlocks.length === 0, inlineBlocks.join(', '));
check('aucun attribut on*= ne reste dans le HTML',
  inlineHandlers.length === 0, inlineHandlers.join(', '));
check('la delegation d evenements existe et est partagee',
  existsSync(join(ROOT, 'assets/js/tf-actions.js')));

/* ------------------------------------------------------------------ verdict */

const line = '-'.repeat(78);
console.log(`\n=== TRACEFAB — GARDE-FOUS DE MISE EN PRODUCTION ===\n${line}`);
for (const c of checks) console.log(`${c.pass ? 'OK   ' : 'ECHEC'} ${c.label}`);
console.log(line);
if (failures.length) {
  console.log(`${failures.length} probleme(s) :\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(line);
  process.exit(1);
}
console.log(`${checks.length}/${checks.length} garde-fous verts.`);
console.log(line);
