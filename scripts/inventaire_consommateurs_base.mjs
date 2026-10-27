#!/usr/bin/env node
/**
 * INVENTAIRE DES CONSOMMATEURS D'UNE BASE — analyse STATIQUE, aucune connexion.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Le 27/10/2026, un mot de passe de production s'est revele encore valide apres
 * rotation sur une autre branche. Avant de tourner une cle, il faut savoir QUI
 * la presente. Une reponse obtenue par `grep` dans une conversation n'est ni
 * reproductible ni verifiable : ce script la refait, a chaque execution, et
 * echoue si l'inventaire change de forme sans qu'on l'ait voulu.
 *
 * CE QU'IL ETABLIT — par lecture du depot seulement
 *   1. les variables d'environnement par lesquelles le code applicatif peut
 *      atteindre une base (recherche `process.env.*` sur DATABASE/POSTGRES/
 *      NEON/PG) ;
 *   2. le nombre de clients Prisma instancies dans `api/` (un seul attendu :
 *      plusieurs clients, ce sont plusieurs identites possibles) ;
 *   3. les crons declares dans `vercel.json` — ils s'executent sur le runtime,
 *      donc avec la meme variable de base que les routes ;
 *   4. les secrets GitHub Actions REFERENCES par les workflows, et la presence
 *      d'URL de base non locales dans ces workflows ;
 *   5. les scripts du depot qui ouvrent une connexion, et ceux qui refusent
 *      explicitement la production.
 *
 * CE QU'IL N'ETABLIT PAS — et le dit dans son rapport
 *   - la valeur des variables Vercel (secrets) ;
 *   - les secrets GitHub reellement stockes (leur liste demande un droit
 *     d'administration que cette session n'a pas) ;
 *   - l'identite du role utilise en production : seule la sonde de runtime
 *     `GET /api/internal/p2/readiness?identity=1` la mesure.
 *
 * INVARIANTS (sortie 1 si violes) : une seule variable de base dans le code
 * applicatif, un seul client Prisma, aucun secret de base dans les workflows.
 *
 * USAGE
 *   node scripts/inventaire_consommateurs_base.mjs [--json rapport.json]
 *   sortie 0 : inventaire conforme aux invariants ; 1 : invariant viole.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Retire les commentaires avant analyse.
 *
 * Defaut reproduit le 27/10/2026 : le script comptait deux clients Prisma et un
 * secret de base dans les workflows. Les deux « violations » etaient des
 * COMMENTAIRES — l'un expliquant que le client Prisma est unique, l'autre
 * racontant un secret supprime. Un inventaire qui lit les commentaires invente
 * des consommateurs. On retire donc :
 *   - les commentaires de ligne et les blocs de commentaire des sources ;
 *   - les lignes de commentaire des fichiers YAML.
 * Limite assumee : une chaine de caractere contenant `//` (une URL, par
 * exemple) est tronquee. Cela ne peut que RETIRER du texte analyse, jamais en
 * ajouter : le sens de l'erreur reste du cote qui n'invente pas de consommateur.
 */
function sansCommentaires(texte, { yaml = false } = {}) {
  if (yaml) {
    return texte.split('\n').map((l) => (l.trimStart().startsWith('#') ? '' : l)).join('\n');
  }
  return texte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const argJson = process.argv.indexOf('--json');
const cheminJson = argJson > -1 ? process.argv[argJson + 1] : null;

const violations = [];
const note = (titre, detail) => console.log(`  ${titre}${detail ? ` — ${detail}` : ''}`);
const section = (titre) => console.log(`\n${titre}\n${'-'.repeat(titre.length)}`);

/** Parcourt recursivement un dossier en ne gardant que certaines extensions. */
function fichiers(dossier, extensions = ['.ts', '.tsx', '.mjs', '.js']) {
  const base = join(ROOT, dossier);
  if (!existsSync(base)) return [];
  const sortie = [];
  const visiter = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const complet = join(dir, e.name);
      if (e.isDirectory()) visiter(complet);
      else if (extensions.includes(e.name.slice(e.name.lastIndexOf('.')))) sortie.push(complet);
    }
  };
  visiter(base);
  return sortie;
}

// 1. Variables d'environnement donnant acces a une base ---------------------
section("Variables d'environnement de base, dans le code applicatif");
const MOTIF_ENV = /process\.env\.([A-Z0-9_]*(?:DATABASE|POSTGRES|NEON|_PG_|PG[A-Z0-9_]*)[A-Z0-9_]*)/g;
const variablesBase = new Map();
for (const dossier of ['api', 'src']) {
  for (const f of fichiers(dossier)) {
    const texte = sansCommentaires(readFileSync(f, 'utf8'));
    MOTIF_ENV.lastIndex = 0;
    let m;
    while ((m = MOTIF_ENV.exec(texte)) !== null) {
      const nom = m[1];
      variablesBase.set(nom, (variablesBase.get(nom) || 0) + 1);
    }
  }
}
const variablesConnues = [...variablesBase.entries()].sort((a, b) => b[1] - a[1]);
for (const [nom, n] of variablesConnues) note(`${nom}`, `${n} occurrence(s)`);
const variablesDeConnexion = variablesConnues.map(([n]) => n).filter((n) => /DATABASE_URL|POSTGRES_URL/.test(n));
if (variablesDeConnexion.length > 1) {
  violations.push(`${variablesDeConnexion.length} variables de connexion distinctes dans le code applicatif `
    + `(${variablesDeConnexion.join(', ')}) : chaque variable est une identite de base possible`);
}
note(variablesDeConnexion.length === 1 ? 'ok   un seul point d\'entree de connexion' : 'ECHEC',
  variablesDeConnexion.join(', ') || 'aucune');

// 2. Clients Prisma --------------------------------------------------------
section('Clients Prisma instancies dans api/');
const clients = [];
for (const f of fichiers('api')) {
  const texte = sansCommentaires(readFileSync(f, 'utf8'));
  if (/new PrismaClient\s*\(/.test(texte)) clients.push(f.replace(ROOT + '/', ''));
}
for (const c of clients) note('new PrismaClient', c);
if (clients.length !== 1) violations.push(`${clients.length} clients Prisma dans api/ : autant d'identites de base possibles`);
note(clients.length === 1 ? 'ok   un seul client Prisma' : 'ECHEC', `${clients.length}`);

// 3. Crons Vercel ----------------------------------------------------------
section('Crons Vercel (s\'executent sur le runtime, donc avec la meme variable de base)');
const vercel = JSON.parse(lire('vercel.json'));
const crons = Array.isArray(vercel.crons) ? vercel.crons : [];
for (const c of crons) note('cron', `${c.path} — « ${c.schedule} »`);
if (!crons.length) note('aucun cron', '');
else note('ok', `${crons.length} tache(s) planifiee(s) dependent de la variable de base du runtime`);

// 4. Workflows GitHub ------------------------------------------------------
section('Workflows GitHub Actions');
const dossierWf = join(ROOT, '.github', 'workflows');
const workflows = existsSync(dossierWf) ? readdirSync(dossierWf).filter((f) => f.endsWith('.yml')) : [];
const secretsReferences = new Set();
const urlsNonLocales = [];
for (const w of workflows) {
  const texte = sansCommentaires(readFileSync(join(dossierWf, w), 'utf8'), { yaml: true });
  for (const m of texte.matchAll(/secrets\.([A-Z0-9_]+)/g)) secretsReferences.add(m[1]);
  for (const m of texte.matchAll(/(postgres(?:ql)?:\/\/[^\s"'`]+)/g)) {
    const url = m[1];
    if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) urlsNonLocales.push(`${w} : ${url.replace(/:\/\/[^@]*@/, '://…@')}`);
  }
}
note('secrets references', [...secretsReferences].sort().join(', ') || 'aucun');
note('URL de base non locale', urlsNonLocales.length ? String(urlsNonLocales.length) : 'aucune');
for (const u of urlsNonLocales) note('  a examiner', u);
const secretsBase = [...secretsReferences].filter((s) => /DATABASE|POSTGRES|NEON/.test(s));
if (secretsBase.length) violations.push(`workflow(s) referencant un secret de base : ${secretsBase.join(', ')}`);
if (urlsNonLocales.length) violations.push('une URL de base non locale figure dans un workflow');
note(secretsBase.length === 0 ? 'ok   aucun workflow ne lit de secret de base' : 'ECHEC', secretsBase.join(', '));
note('limite', 'la liste des secrets RELLEMENT stockes demande un droit d\'administration : non verifiable ici');

// 5. Scripts qui ouvrent une connexion ------------------------------------
section('Scripts du depot ouvrant une connexion');
const scripts = fichiers('scripts', ['.mjs', '.js', '.ts']);
const connectes = [];
const refusentProd = [];
for (const f of scripts) {
  const texte = sansCommentaires(readFileSync(f, 'utf8'));
  const seConnecte = /new pg\.Client|new Client\(|PrismaClient|connectionString/.test(texte);
  if (!seConnecte) continue;
  const rel = f.replace(ROOT + '/', '');
  connectes.push(rel);
  if (/HOTE_PRODUCTION|ep-polished-night/.test(texte)) refusentProd.push(rel);
}
note('scripts connectes', String(connectes.length));
note('  dont refusant la production', String(refusentProd.length));
const sansGarde = connectes.filter((c) => !refusentProd.includes(c));
for (const s of sansGarde.slice(0, 12)) note('  sans refus de production', s);
note('lecture', 'un script qui accepte la production est un consommateur potentiel de la cle '
  + 'selon l\'URL qu\'on lui donne : la garde dit ce qu\'il REFUSE, pas ce qu\'il utilise');

// Rapport ------------------------------------------------------------------
if (violations.length) {
  section('Invariants violes');
  for (const v of violations) console.error(`  ECHEC ${v}`);
} else {
  section('Invariants');
  console.log('  ok    un point d\'entree, un client, aucun secret de base dans les workflows.');
}

const rapport = {
  genere_le: new Date().toISOString(),
  variables_base: Object.fromEntries(variablesConnues),
  clients_prisma: clients,
  crons_vercel: crons,
  secrets_workflows: [...secretsReferences].sort(),
  urls_non_locales: urlsNonLocales,
  scripts_connectes: connectes,
  scripts_refusant_production: refusentProd,
  violations,
  non_verifiable: [
    'valeur des variables Vercel (secrets)',
    'liste des secrets GitHub reellement stockes (droit d\'administration absent)',
    'identite du role PostgreSQL utilisee par le runtime de production '
      + '(se mesure par GET /api/internal/p2/readiness?identity=1)',
  ],
};
if (cheminJson) {
  mkdirSync(dirname(resolve(ROOT, cheminJson)), { recursive: true });
  writeFileSync(resolve(ROOT, cheminJson), JSON.stringify(rapport, null, 2));
  console.log(`\n  rapport JSON : ${cheminJson}`);
}
console.log(`\n${violations.length ? 'ECHEC' : 'OK'} — ${violations.length} invariant(s) viole(s).`);
process.exit(violations.length ? 1 : 0);
