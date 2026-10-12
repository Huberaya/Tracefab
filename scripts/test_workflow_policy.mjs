#!/usr/bin/env node
/**
 * Politique des workflows GitHub Actions.
 *
 * POURQUOI CE CONTROLE EXISTE
 *
 * L'incident 2C n'etait pas un bug : c'etait un workflow qui pouvait lire
 * `secrets.DATABASE_URL` — la production — depuis n'importe quelle branche,
 * avec un declencheur `push` sur `**`. Retirer l'etape fautive a corrige ce
 * jour-la. Ce controle rend la classe entiere impossible a reintroduire :
 * chaque privilege doit etre declare, et une omission echoue.
 *
 * Les cinq controles :
 *
 *   A. aucune lecture de `secrets` dans un workflow non declare ;
 *   B. aucune connexion de base venant d'un secret, ni en variable
 *      d'environnement, ni en ligne de commande ;
 *   C. toute action tierce epinglee par SHA complet, avec sa version lisible ;
 *   D. tout workflow demandant `contents: write` declare, avec justification ;
 *   E. aucun declencheur qui execute du code de branche avec les privileges
 *      de la branche de base.
 *
 * Le YAML est analyse par la bibliotheque `yaml`, pas par des expressions
 * regulieres : une politique qui se trompe sur l'indentation se croit verte.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Le dossier analyse est surchargeable pour que les temoins de detection
// (scripts/test_workflow_policy_detection.mjs) fassent tourner CE script, et
// non une copie de sa logique, sur des workflows volontairement fautifs.
const WORKFLOWS = process.env.TRACEFAB_WORKFLOW_DIR || join(ROOT, '.github', 'workflows');
const REGISTRY = join(ROOT, 'docs', 'security', 'workflow-privileged-allowlist.json');
const WRAPPER = 'scripts/run-db-suite.mjs';

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

if (!existsSync(WORKFLOWS)) {
  console.log('\n  Aucun dossier .github/workflows : rien a controler.');
  process.exit(0);
}

let registry = {};
try {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (error) {
  console.error(`\n  ECHEC — registre illisible (${REGISTRY}) : ${error.message}\n`);
  process.exit(1);
}
const entryFor = (bucket, file) => (registry[bucket] || {})[file] || null;

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
console.log(`\n  ${files.length} workflow(s) analyse(s) : ${files.join(', ')}\n`);

const PRIORITY_TRIGGERS = ['pull_request_target', 'workflow_run'];

for (const file of files) {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    ko(`${file} : YAML invalide — ${String(error.message).split('\n')[0]}`);
    continue;
  }
  if (!doc || typeof doc !== 'object') { ko(`${file} : document vide ou non exploitable`); continue; }

  console.log(`  --- ${file}`);

  // Les commentaires sont retires avant l'analyse des usages : en YAML un
  // commentaire commence par « # » precede d'une espace. Sans ce retrait une
  // explication du type « avant, ce job lisait secrets.DATABASE_URL » serait
  // comptee comme un usage. La detection d'usage reel ne perd rien : un
  // contexte `${{ secrets.X }}` n'est jamais dans un commentaire.
  const code = text.split('\n').map((line) => line.replace(/\s#.*$/, '')).join('\n');

  // ---------------------------------------------------------------- A. secrets
  const secretRefs = [...code.matchAll(/secrets\.[A-Za-z0-9_]+/g)].map((m) => m[0]);
  const uniqueSecrets = [...new Set(secretRefs)];
  if (uniqueSecrets.length === 0) {
    ok('A. aucune lecture du contexte secrets');
  } else if (entryFor('secretUsingWorkflows', file)) {
    ok(`A. secrets declares : ${uniqueSecrets.join(', ')} — justification au registre`);
  } else {
    ko(`A. lit ${uniqueSecrets.join(', ')} sans etre declare au registre`);
  }

  // ------------------------------------------------- B. connexion de base par secret
  const secretDatabase = /DATABASE_URL\s*:\s*\$\{\{\s*secrets\./i.test(code)
    || /NEON_TEST_DATABASE_URL\s*:\s*\$\{\{\s*secrets\./i.test(code)
    || /secrets\.[A-Za-z0-9_]*(?:DATABASE|DB)_[A-Za-z0-9_]*/i.test(code);
  secretDatabase
    ? ko('B. une connexion de base est alimentee par le contexte secrets')
    : ok('B. aucune connexion de base alimentee par un secret');

  const destructiveAgainstSecret = /run\s*:\s*\|?[\s\S]{0,400}?npm\s+run\s+(test:neon|test:neon:)/.test(code)
    && secretRefs.length > 0;
  destructiveAgainstSecret
    ? ko('B. un test de base est lance dans un workflow qui lit aussi des secrets')
    : ok('B. aucun test de base lance dans un workflow lisant des secrets');

  // ------------------------------------------------- C. epinglage par SHA
  const usesLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- uses:') || l.startsWith('uses:'));
  const unpinned = usesLines.filter((line) => {
    const value = line.replace(/^-\s*/, '').replace(/^uses:\s*/, '').split('#')[0].trim();
    if (value.startsWith('./') || value.startsWith('docker://')) return false;
    return !/@[0-9a-f]{40}$/.test(value);
  });
  const withoutVersion = usesLines.filter((line) => !/#\s*v?\d+\.\d+/.test(line));
  if (unpinned.length === 0 && withoutVersion.length === 0) {
    ok(`C. ${usesLines.length} action(s) epinglee(s) par SHA avec version lisible`);
  } else {
    if (unpinned.length > 0) ko(`C. ${unpinned.length} action(s) non epinglee(s) : ${unpinned.slice(0, 3).join(' | ')}`);
    if (withoutVersion.length > 0) ko(`C. ${withoutVersion.length} reference(s) sans commentaire de version`);
  }

  // ------------------------------------------------- D. contents: write
  const docText = JSON.stringify(doc);
  const asksWrite = /"contents"\s*:\s*"write"/.test(docText) || /contents:\s*write/.test(text);
  if (!asksWrite) {
    ok('D. ne demande pas contents: write');
  } else if (entryFor('writePermissionWorkflows', file)) {
    ok('D. contents: write declare et justifie');
  } else {
    ko('D. demande contents: write sans declaration au registre');
  }

  // ------------------------------------------------- E. declencheurs privilegies
  const triggers = doc.on ?? doc.true;
  const triggerNames = typeof triggers === 'string' ? [triggers]
    : Array.isArray(triggers) ? triggers
    : triggers && typeof triggers === 'object' ? Object.keys(triggers) : [];
  const used = PRIORITY_TRIGGERS.filter((name) => triggerNames.includes(name));
  if (used.length === 0) {
    ok(`E. declencheurs sans privilege de branche : ${triggerNames.join(', ') || '(aucun)'}`);
  } else if (entryFor('privilegedTriggers', file)) {
    ok(`E. declencheur privilegie declare : ${used.join(', ')}`);
  } else {
    ko(`E. declencheur privilegie non declare : ${used.join(', ')}`);
  }

  // ------------------------------------------------- F. environnements
  const envBound = [...text.matchAll(/^\s*environment:\s*(\S+)/gm)].map((m) => m[1]);
  if (envBound.length === 0) {
    ok('F. aucun job rattache a un environnement');
  } else if (entryFor('environmentBoundJobs', file)) {
    ok(`F. environnement declare : ${[...new Set(envBound)].join(', ')}`);
  } else {
    ko(`F. job rattache a ${[...new Set(envBound)].join(', ')} sans declaration au registre`);
  }

  // ------------------------------------------- H. ecriture et execution de code
  // Un jeton qui peut ecrire dans le depot ne doit jamais etre detenu par un
  // job qui execute du code du depot. C'est la regle qui empeche un
  // declencheur quelconque de transformer un droit d'ecriture en execution de
  // code arbitraire avec ce droit. Elle s'applique a tous les workflows, y
  // compris ceux qui n'existent pas encore dans cet arbre.
  const jobs = (doc && typeof doc.jobs === 'object' && doc.jobs) || {};
  const jobsEcrivains = [];
  for (const [nom, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;
    const perms = job.permissions;
    const ecrit = perms && typeof perms === 'object' && perms.contents === 'write';
    if (ecrit) jobsEcrivains.push([nom, job]);
  }
  const permissionsWorkflow = doc.permissions;
  const workflowEcrit = permissionsWorkflow && typeof permissionsWorkflow === 'object' && permissionsWorkflow.contents === 'write';

  if (workflowEcrit) {
    ko('H. `permissions: contents: write` au niveau du workflow : tous les jobs heritent du droit');
    console.error('          Le droit doit etre porte par le seul job qui pousse, pas par le workflow.');
  } else if (jobsEcrivains.length === 0) {
    ok('H. aucun job ne detient contents: write');
  } else {
    for (const [nom, job] of jobsEcrivains) {
      const commands = (job.steps || [])
        .filter((step) => step && typeof step.run === 'string')
        .flatMap((step) => step.run.split('\n'))
        .map((line) => line.trim())
        .filter((line) => /^(npm|npx|node|yarn|pnpm)\b/.test(line));
      if (commands.length === 0) {
        ok(`H. le job « ${nom} » detient contents: write et n execute aucun code du depot`);
      } else {
        ko(`H. le job « ${nom} » detient contents: write ET execute du code du depot`);
        for (const c of commands.slice(0, 4)) console.error(`          ${c}`);
        console.error('          Separer : un job genere (lecture seule), un job pousse (sans execution de code).');
      }
    }
  }

  // ------------------------------------------------- G. suites destructives gardees
  const invokesSuites = /npm\s+run\s+test:neon(?!:rls)/.test(code) || /scripts\/test_neon/.test(code);
  if (!invokesSuites) {
    ok('G. ne lance aucune suite Neon par un appel direct');
  } else if (code.includes(WRAPPER) || !/npm\s+run\s+test:neon/.test(code)) {
    ok(`G. suites de base lancees via la garde de cible (${WRAPPER}) ou par script npm garde`);
  } else {
    ko('G. lance une suite de base en contournant la garde de cible');
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Politique des workflows : OK.' : `Politique des workflows : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
