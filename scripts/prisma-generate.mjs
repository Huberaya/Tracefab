#!/usr/bin/env node
/**
 * Generation du client Prisma — deterministe et bloquante.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * L'incident de production du 2026-10-12 a produit
 * `{"error":"internal_error","correlationId":"..."}` sur toute route touchant
 * la base. La forme de la reponse designe un seul emetteur possible :
 * la barriere d'erreur centrale de `api/index.ts`. Un seul mode de defaillance
 * est global a toutes les routes : le client Prisma non initialise. Il a ete
 * reproduit : `new PrismaClient()` leve
 * « @prisma/client did not initialize yet », le chargement du module de route
 * echoue, et la reponse est exactement celle observee.
 *
 * Restait a savoir si le client est genere dans le paquet deploye. Or :
 *
 *   — `vercel.json` porte un tableau `builds`, ce qui fait ignorer les
 *     reglages de build du projet ;
 *   — aucun script `build` du projet n'est branche a ce tableau `builds` ;
 *   — `package.json` n'avait aucun `postinstall` ;
 *   — un `postinstall` est le seul point d'ancrage que Vercel execute
 *     toujours, quelle que soit la configuration de build.
 *
 * CE QUE FAIT CE SCRIPT
 *
 *   1. localise le CLI Prisma local (jamais un homonyme du registre) ;
 *   2. refuse de demarrer si la generation est explicitement desactivee dans
 *      un contexte de deploiement — le contournement ne doit pas pouvoir
 *      s'appliquer la ou il ferait taire l'incident ;
 *   3. execute la generation et ECHOUE si elle echoue.
 *
 * Une generation qui echoue doit faire echouer l'installation, pas produire
 * un paquet qui demarrera sans client. Un deploiement rouge remonte en cinq
 * minutes ; un paquet sans client tombe en production.
 *
 * LE CONTOURNEMENT, ET SA LIMITE
 *
 * `PRISMA_SKIP_POSTINSTALL_GENERATE=true` existe pour les environnements
 * contraints (pas de reseau vers les binaires, pas de binaire de plateforme).
 * Il est refuse en contexte de deploiement, et il ne dispense de rien : le
 * build execute `npm run verify:prisma-client`, qui refuse un client factice.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const deployment = (process.env.VERCEL_ENV || '').toLowerCase();
// `VERCEL=1` est pose dans TOUS les environnements Vercel, y compris quand
// VERCEL_ENV vaut « development » ou n'est pas renseigne. S'en tenir a VERCEL_ENV
// laissait passer le contournement dans un contexte de build distant — mesure
// faite le 2026-10-12 : `PRISMA_SKIP_POSTINSTALL_GENERATE=true VERCEL=1` sortait
// en 0 en sautant la generation. Un paquet sans client part alors en production.
const contexte = deployment || (process.env.VERCEL ? 'VERCEL=1' : '');
const isDeployment = contexte !== '';
const skipRequested = process.env.PRISMA_SKIP_POSTINSTALL_GENERATE === 'true';

if (skipRequested) {
  if (isDeployment) {
    console.error(
      '\n  REFUS — PRISMA_SKIP_POSTINSTALL_GENERATE est interdit dans un deploiement.\n' +
      `  Contexte detecte : ${contexte}\n` +
      '  La generation du client est la condition de demarrage de toute route de donnees.\n' +
      '  La desactiver ici produirait exactement l incident du 2026-10-12.\n',
    );
    process.exit(1);
  }
  console.log('  generation Prisma ignoree (PRISMA_SKIP_POSTINSTALL_GENERATE=true, hors deploiement)');
  console.log('  rappel : npm run verify:prisma-client refuse un client factice.');
  process.exit(0);
}

const cliCandidates = [
  join(ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
  join(ROOT, 'node_modules', 'prisma', 'build', 'index.mjs'),
];

const cli = cliCandidates.find((path) => existsSync(path));
if (!cli) {
  console.error(
    '\n  ECHEC — CLI Prisma local introuvable dans node_modules.\n' +
    '  Le client ne sera pas genere. Installer les dependances (npm ci) avant de poursuivre.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 0. Preflight reseau — dependance externe identifiee par le chantier 2C.34
// ---------------------------------------------------------------------------
// `prisma generate` (CLI 6.19.3) verifie la version du moteur au demarrage et
// telecharge, si necessaire, le binaire schema-engine depuis
// https://binaries.prisma.sh/.../schema-engine.gz.sha256. Sans acces a cet
// hote, la generation est impossible : ce n'est pas un bug du depot, c'est une
// dependance externe. On le dit explicitement plutot que de laisser le CLI
// echouer avec un message opaque.
//
// Hote requis : binaries.prisma.sh (HTTPS/443)
// Fichiers requis : schema-engine.gz.sha256 puis schema-engine.gz
//                  (pour la plateforme courante : debian-openssl-3.0.x)
// Cache local possible : definir PRISMA_ENGINES_CACHE_DIR vers un dossier
// deja rempli (voir https://www.prisma.io/docs/orm/prisma-client/...).
const PRISMA_BINARIES_HOST = 'binaries.prisma.sh';
const PRISMA_BINARIES_PATH =
  '/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz.sha256';

async function checkNetwork() {
  const https = await import('node:https');
  return new Promise((resolve) => {
    const req = https.request(
      { host: PRISMA_BINARIES_HOST, port: 443, path: PRISMA_BINARIES_PATH, method: 'HEAD', timeout: 8000 },
      (res) => {
        resolve(Boolean(res.statusCode && res.statusCode < 500));
        res.resume();
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const networkAvailable = await checkNetwork();
if (!networkAvailable) {
  console.error(
    '\n  BLOCAGE RESEAU — la generation du client Prisma est impossible ici.\n' +
    `  Hote requis : https://${PRISMA_BINARIES_HOST} (HTTPS/443)\n` +
    '  Fichier requis : schema-engine.gz.sha256 (puis schema-engine.gz)\n' +
    '  Le CLI Prisma 6.19.3 verifie la version du moteur au demarrage et\n' +
    '  telecharge ce binaire s\'il n\'est pas deja en cache local.\n' +
    '  Contournements possibles :\n' +
    '    - executer ce script dans un environnement avec acces reseau vers\n' +
    '      binaries.prisma.sh (CI GitHub Actions, Vercel, poste developpeur) ;\n' +
    '    - definir PRISMA_ENGINES_CACHE_DIR vers un cache deja rempli ;\n' +
    '    - definir PRISMA_SKIP_POSTINSTALL_GENERATE=true hors deploiement\n' +
    '      (le client restera le stub factice ; verify:prisma-client echouera).\n' +
    '  Ce script ne simule pas un succes : le client n\'est pas genere.\n',
  );
  process.exit(2);
}

console.log(`  generation Prisma — ${process.env.VERCEL_ENV || process.env.NODE_ENV || 'local'}`);
const result = spawnSync(process.execPath, [cli, 'generate'], { stdio: 'inherit', cwd: ROOT });

if (result.error) {
  console.error(`\n  ECHEC — la generation n a pas pu demarrer : ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(
    `\n  ECHEC — prisma generate a retourne ${result.status}.\n` +
    '  Le client n est pas genere. L installation doit echouer ici plutot que produire\n' +
    '  un paquet qui demarrera sans client et repondra internal_error en production.\n',
  );
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// 4. Verifier ce qui vient d'etre genere, ici et maintenant
// ---------------------------------------------------------------------------
// Generer ne suffit pas : `@prisma/client` s'installe avec un repli factice, et
// une generation qui ne produit rien d'exploitable laisserait un paquet vert.
// La verification est donc exécutée DANS le même processus de build, pas dans
// un script que quelqu'un pensera peut-être à lancer.
//
// Ce point est décisif : sur Vercel, avec `builds` dans vercel.json, les
// réglages de build du projet sont ignorés et `npm run build` n'est pas
// exécuté. L'installation est le seul passage obligé. Une vérification placée
// dans `npm run build` ne protège pas le déploiement ; placée ici, elle le
// protège.
const verification = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'verify_prisma_client.mjs')],
  { stdio: 'inherit', cwd: ROOT },
);

if (verification.status !== 0) {
  console.error(
    '\n  ECHEC — le client genere ne passe pas la verification.\n' +
    '  Un client factice ou incomplet ne doit pas pouvoir etre deploye :\n' +
    '  c est l etat qui a produit internal_error sur toute route de donnees.\n',
  );
  process.exit(verification.status ?? 1);
}

console.log('  client Prisma genere et verifie.');

// Vercel utilise un tableau `builds` dans vercel.json : sa Build Command
// configuree dans le tableau de bord et le script npm `build` ne sont pas
// executes. Les controles TypeScript doivent donc etre rattaches au seul
// point de passage obligatoire observe dans le build : postinstall.
// Hors Vercel, ces controles restent dans la CI et ne ralentissent pas npm
// install des developpeurs.
if (isDeployment) {
  for (const scriptName of ['typecheck', 'api:typecheck', 'test:router-load']) {
    console.log(`\\n  verification statique obligatoire — npm run ${scriptName}`);
    const check = spawnSync('npm', ['run', scriptName], {
      stdio: 'inherit',
      cwd: ROOT,
      shell: process.platform === 'win32',
    });
    if (check.error || check.status !== 0) {
      console.error(
        `\\n  ECHEC — ${scriptName} n'a pas reussi dans le build Vercel.\\n` +
        '  Le deploiement doit rester rouge tant que les erreurs de types ne sont pas corrigees.\\n',
      );
      process.exit(check.status ?? 1);
    }
  }
  console.log('  controles TypeScript Vercel : tous verts.');
}
