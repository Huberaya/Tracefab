#!/usr/bin/env node
/**
 * Lanceur commun des suites qui ecrivent en base.
 *
 * POURQUOI UN LANCEUR PLUTOT QU'UN APPEL DIRECT
 *
 * Retirer une ligne d'un workflow protege ce workflow-la, pas les suivants.
 * En branchant chaque suite destructive derriere ce lanceur, la garde de
 * cible s'applique a TOUS les chemins d'execution : CI, poste de
 * developpement, commande manuelle, script d'exploitation, futur workflow.
 *
 * Usage :
 *   node scripts/run-db-suite.mjs [--verrou-cluster] <chemin-du-script> [args...]
 *   node scripts/run-db-suite.mjs scripts/test_neon_security.mjs
 *   node scripts/run-db-suite.mjs --verrou-cluster scripts/prepare_ci_db_role.mjs
 *
 * `--verrou-cluster` : le lanceur prend le verrou consultatif de CLUSTER
 * (scripts/lib/ephemeral-db.mjs, cle 738241901) pour toute la duree du processus
 * enfant. Sert aux APPELANTS ISOLES du provisioning — aujourd'hui les deux
 * scripts shell d'integration — qui ne tiennent aucun verrou par eux-memes :
 * deux executions paralleles y modifiaient la meme ligne de `pg_authid`
 * (`XX000 tuple concurrently updated`, mesure du 30/10 sur PG 17.10).
 *
 * Le verrou est pris ICI et non dans `prepare_ci_db_role.mjs` : un appelant qui
 * le detient deja (db-deploy-throwaway.mjs, migrer_fidelement.mjs) lancerait
 * sinon un enfant qui attendrait indefiniment — un verrou consultatif n'est pas
 * reentrant entre deux sessions.
 *
 * Variables lues par la garde : voir scripts/lib/require-throwaway-db.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { chooseSuiteLoader } from './lib/choose-suite-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const demanderVerrou = args[0] === '--verrou-cluster';
if (demanderVerrou) args.shift();
const [target, ...rest] = args;

if (!target) {
  console.error('usage: node scripts/run-db-suite.mjs <script> [args...]');
  process.exit(2);
}

const absolute = resolve(ROOT, target);
if (!existsSync(absolute)) {
  console.error(`  REFUS — cible introuvable : ${target}`);
  process.exit(3);
}

// Toutes les variables de connexion PRESENTES sont verifiees, pas seulement
// DATABASE_URL : une suite peut se connecter avec TF_RLS_APP_URL, et cette
// seconde cible ne doit pas pouvoir viser une autre base que la premiere.
// Exiger les deux en permanence ferait echouer les suites qui n'en posent
// qu'une ; elles sont donc verifiees selon ce qui est fourni.
const variablesPresentes = ['DATABASE_URL', 'TF_RLS_APP_URL']
  .filter((variable) => (process.env[variable] || '').trim());
const result = requireThrowawayDb({
  purpose: target,
  variables: variablesPresentes.length > 0 ? variablesPresentes : ['DATABASE_URL'],
});
for (const line of result.summary) console.log(`  garde cible : ${line}`);
console.log('');

// Le chargeur suit le CONTENU de la suite, pas seulement son extension : un
// .mjs qui importe des modules TypeScript du depot a besoin de tsx, sinon il
// meurt sur un ERR_MODULE_NOT_FOUND etrangera a la base et a la garde.
const chargeur = chooseSuiteLoader(absolute, readFileSync(absolute, 'utf8'));
const tsxBin = join(ROOT, 'node_modules', '.bin', 'tsx');

if (chargeur === 'tsx' && !existsSync(tsxBin)) {
  console.error('  NON EXECUTE — tsx absent : npm ci avant de lancer une suite qui importe du TypeScript.');
  process.exit(2);
}

console.log(`  chargeur : ${chargeur}${chargeur === 'tsx' ? ' (la suite importe du TypeScript)' : ''}`);

// Verrou de CLUSTER tenu par CE processus pendant toute la duree de l'enfant.
//
// FAIL-CLOSED (30/10). Avant : si le verrou ne pouvait pas etre pris, le lanceur
// imprimait un AVERTISSEMENT et executait quand meme l'enfant. Un verrou
// « demande » mais facultatif n'est pas un verrou : deux suites pouvaient
// modifier `pg_authid` en parallele, exactement ce que le verrou existe pour
// empecher. Desormais :
//
//   — le verrou est demande AVANT le `spawn` (aucun enfant ne demarre sans lui) ;
//   — l'attente est BORNEE (`TF_VERROU_ATTENTE_MS`, 30 s par defaut) : un verrou
//     deja detenu par une autre session fait ECHOUER le lanceur au lieu de le
//     faire attendre sans limite ;
//   — toute erreur d'acquisition (connexion impossible, identifiant refuse,
//     import indisponible) arrete le processus avec le code 3 ;
//   — une interruption (SIGINT/SIGTERM) arrete l'enfant PUIS libere le verrou.
const EXIT_VERROU = 3;
const ATTENTE_VERROU_MS = (() => {
  const brut = Number.parseInt(process.env.TF_VERROU_ATTENTE_MS || '', 10);
  return Number.isFinite(brut) && brut >= 0 ? brut : 30000;
})();

let verrou = { relacher: async () => {} };
let enfant = null;
if (demanderVerrou) {
  try {
    // Import dynamique, comme db-deploy-throwaway.mjs : ce lanceur est copie dans
    // des harnais isoles ou `lib/ephemeral-db.mjs` n'existe pas — et dans ce cas
    // le verrou ne peut pas etre pris, donc le lanceur REFUSE de continuer.
    const { verrouillerCluster } = await import('./lib/ephemeral-db.mjs');
    verrou = await verrouillerCluster(
      { urlProprietaire: process.env.DATABASE_URL },
      738241901,
      { attenteMs: ATTENTE_VERROU_MS },
    );
    console.log('  verrou de cluster : pris');
  } catch (e) {
    console.error(`  REFUS — --verrou-cluster demande, verrou NON ACQUIS `
      + `(${e.code ?? String(e.message).split('\n')[0]}).`);
    console.error('  Aucune suite n a ete lancee : un verrou demande ne se contourne pas.');
    process.exit(EXIT_VERROU);
  }

  // Interruption : on arrete l'enfant, puis on libere. Le verrou serait de toute
  // facon rendu avec la session, mais l'enfant, lui, survivrait sans cela.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      if (enfant && enfant.exitCode === null) enfant.kill('SIGTERM');
      verrou.relacher().finally(() => process.exit(code));
    });
  }
}

const child = spawn(
  chargeur === 'tsx' ? tsxBin : process.execPath,
  [absolute, ...rest],
  {
    stdio: 'inherit',
    cwd: ROOT,
    // R9 (30/10) : l'enfant doit pouvoir prouver qu'un ancetre tient le verrou
    // avant de detruire une base. Le PID est verifie dans `pg_locks` par
    // `avecVerrouDeCluster` ; ce n'est pas une declaration de confiance.
    env: verrou.pid ? { ...process.env, TF_VERROU_CLUSTER_DETENEUR: String(verrou.pid) } : process.env,
  },
);
enfant = child;

child.on('exit', (code, signal) => {
  verrou.relacher().finally(() => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
});
child.on('error', (error) => {
  console.error(`  ECHEC du lancement : ${error.message}`);
  verrou.relacher().finally(() => process.exit(1));
});
