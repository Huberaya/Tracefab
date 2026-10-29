#!/usr/bin/env node
/**
 * Non-régression CI — aucun chemin vers la base de production.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le job « Base — isolation RLS executee » branchait autrefois les suites
 * test:neon sur `secrets.DATABASE_URL` : chaque CI exécutait des scénarios
 * contre la base de production, avec ses identifiants exposés à tout
 * workflow, y compris depuis un fork. La correction a supprimé ce chemin —
 * Postgres jetable monté par le job, suites de sécurité locales. Ce test
 * statique empêche de le réintroduire par inadvertance : il lit le workflow
 * tel qu'il serait exécuté et refuse tout retour du secret de production.
 *
 * Aucune base n'est requise : c'est un contrôle structurel du YAML, rapide,
 * qui tourne dans le socle comme sur un poste sans Docker.
 *
 * CE QU'IL VÉRIFIE — 11 assertions
 *
 *    1. Le workflow CI existe et est lisible.
 *    2. Aucune expression `${{ secrets.* }}` n'apparaît dans le workflow.
 *    3. `TF_SECRET_PRODUCTION` est absent (l'ancien passeur du secret).
 *    4. Aucune étape ne cible la « base de production ».
 *    5. Les suites neon historiquement branchées sur la production ne sont
 *       invoquées QUE dans le job à base jetable, et ce job pointe la base
 *       locale tracefab_test (assertion 5 bis).
 *       (security, supplier, product, quality, collection) ne sont pas
 *       invoquées par le workflow.
 *    6. Le job base-de-donnees monte un service Postgres jetable.
 *    7. Son DATABASE_URL pointe la base jetable locale, pas un secret.
 *    8. L'étape test:neon:rls est présente (isolation prouvée par exécution).
 *    9. L'étape test:neon:privileges est présente.
 *   10. L'étape test:neon:cross-tenant est présente.
 *
 * Note d'implémentation : l'assertion 2 cible l'expression GitHub
 * `${{ secrets.` et non la simple mention `secrets.DATABASE_URL`, qu'un
 * commentaire historique du workflow cite à titre d'archéologie. Ce qui est
 * interdit, c'est d'EXÉCUTER le secret, pas d'en raconter l'histoire.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const chemin = join(racine, '.github', 'workflows', 'ci.yml');

/* --- 1. le workflow existe ------------------------------------------------ */
let wf = null;
try {
  wf = readFileSync(chemin, 'utf8');
} catch {
  ko(`workflow CI introuvable ou illisible : ${chemin}`);
  console.log(`\n  ${11 - echecs}/11 assertions`);
  process.exit(1);
}
if (wf.trim().length > 0) ok('workflow CI présent et lisible');
else ko('workflow CI vide');

/* --- 2-4. le chemin production a disparu ------------------------------------ */
if (!/\$\{\{\s*secrets\./.test(wf)) ok('aucune expression ${{ secrets.* }} dans le workflow');
else ko('une expression ${{ secrets.* }} est présente : le workflow consomme un secret');

if (!wf.includes('TF_SECRET_PRODUCTION')) ok('TF_SECRET_PRODUCTION absent');
else ko('TF_SECRET_PRODUCTION est présent : l’ancien passeur du secret de production est de retour');

if (!/contre la base de production/i.test(wf)) ok('aucune étape ne cible la base de production');
else ko('une étape cible la base de production');

/* --- 5. les suites historique « production » ne tournent QUE sur la jetable --- */
// Ces cinq suites ont ete ecrites quand la CI pointait vers la base de
// production. L'interdiction pure et simple a tenu tant qu'elles ne tournaient
// nulle part — c'est-a-dire tant qu'elles ne prouvaient rien. Elles sont
// desormais executees, sur le Postgres 17 jetable du job `base-de-donnees`.
// Le controle n'est donc pas retire, il est RESSERRE : ces suites ne doivent
// apparaitre nulle part ailleurs dans le workflow. Une invocation ajoutee dans
// un job qui lit un secret, ou vers une cible distante, echoue toujours ici.
const SEQ = ['security', 'supplier', 'product', 'quality', 'collection', 'storage:chantier10'];
const lignes = wf.split('\n');
const debut = lignes.findIndex((l) => /^  base-de-donnees:\s*$/.test(l));
let fin = lignes.length;
if (debut !== -1) {
  for (let i = debut + 1; i < lignes.length; i += 1) {
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(lignes[i])) { fin = i; break; }
  }
}
const blocBase = debut === -1 ? '' : lignes.slice(debut, fin).join('\n');
const horsBloc = SEQ.filter(
  (s) => new RegExp(`test:neon:${s}(?![\\w:-])`).test(wf.replace(blocBase, '')),
);
if (horsBloc.length === 0) {
  ok('les suites neon ne sont invoquees que dans le job a base jetable');
} else {
  ko(`suites neon invoquees hors du job a base jetable : ${horsBloc.map((s) => `test:neon:${s}`).join(', ')}`);
}
// Et, dans ce job, la cible doit rester la base locale jetable.
const cibleLocale = /DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/tracefab_test/.test(blocBase);
if (cibleLocale) ok('le job qui execute ces suites pointe une base locale jetable');
else ko('le job qui execute ces suites ne pointe pas la base locale jetable');

/* --- 6-7. la base du job est jetable, locale, sans secret ---------------------- */
if (/postgres:17/.test(wf) && /services:/.test(wf)) ok('le job base-de-donnees monte un Postgres jetable (service postgres:17)');
else ko('aucun service Postgres jetable détecté dans le workflow');

if (/DATABASE_URL:\s*postgresql:\/\/postgres:postgres@localhost:5432\/tracefab_test/.test(wf)) {
  ok('DATABASE_URL du job = base jetable locale tracefab_test');
} else {
  ko('DATABASE_URL du job ne pointe pas la base jetable locale tracefab_test');
}

/* --- 8-10. les épreuves de sécurité locales sont branchées ---------------------- */
for (const [etape, nom] of [
  ['test:neon:rls', 'isolation RLS prouvée par exécution'],
  ['test:neon:privileges', 'privilèges SECURITY DEFINER'],
  ['test:neon:cross-tenant', 'isolation inter-organisations'],
]) {
  if (wf.includes(`npm run ${etape}`)) ok(`étape ${etape} présente (${nom})`);
  else ko(`étape ${etape} absente (${nom})`);
}

console.log(`\n  ${11 - echecs}/11 assertions — aucun chemin CI vers la production.`);
process.exit(echecs ? 1 : 0);
