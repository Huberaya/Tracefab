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
 * Les controles A a J :
 *
 *   A. aucune lecture de `secrets` dans un workflow non declare ;
 *   B. aucune connexion de base venant d'un secret, ni en variable
 *      d'environnement, ni en ligne de commande ;
 *   C. toute action tierce epinglee par SHA complet, avec sa version lisible ;
 *   D. tout workflow demandant `contents: write` declare, avec justification ;
 *   E. aucun declencheur qui execute du code de branche avec les privileges
 *      de la branche de base ;
 *   F. les environnements privilegies sont declares au registre ;
 *   G. les suites de base passent par la garde de cible ;
 *   H. un jeton d'ecriture ne cohabite pas avec l'execution de code du depot ;
 *   I. aucun job ne peut afficher vert sans executer le test qu'il annonce ;
 *   J. permissions minimales explicites et checkout sans credentials persistants ;
 *   K. T1.8 — liste blanche. Seul chemin CI autorise pour une migrate :
 *      `npm run db:deploy:throwaway` (flags npm optionnels) ou
 *      `node scripts/db-deploy-throwaway.mjs`, et le corps npm EST le wrapper.
 *      Tout autre chemin (script local, 2e saut, concat, node -e, uses hors
 *      liste, fichier introuvable, 2e job) est refuse. Ce n'est PAS un
 *      parseur shell ni JS.
 *   L. L lit TOUJOURS le package.json du depot. TRACEFAB_PACKAGE_JSON n'est
 *      lu que si TRACEFAB_POLICY_WITNESS=1. Hors drapeau, sa presence echoue.
 *
 * Le YAML est analyse par la bibliotheque `yaml`, pas par des expressions
 * regulieres : une politique qui se trompe sur l'indentation se croit verte.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  THROWAWAY_NPM_SCRIPT,
  THROWAWAY_WRAPPER_REL,
  throwawayNpmBodyIsWrapper,
} from './lib/throwaway-deploy-binding.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Le dossier analyse est surchargeable pour que les temoins de detection
// (scripts/test_workflow_policy_detection.mjs) fassent tourner CE script, et
// non une copie de sa logique, sur des workflows volontairement fautifs.
const WORKFLOWS = process.env.TRACEFAB_WORKFLOW_DIR || join(ROOT, '.github', 'workflows');
// Surchargeable comme le dossier analyse : c'est ce qui permet a un temoin de
// declarer legitimement ses secrets, afin que le controle qu'il eprouve soit le
// seul a le refuser.
const REGISTRY = process.env.TRACEFAB_WORKFLOW_REGISTRY
  || join(ROOT, 'docs', 'security', 'workflow-privileged-allowlist.json');
const WRAPPER = 'scripts/run-db-suite.mjs';

const ROOT_PACKAGE_JSON = join(ROOT, 'package.json');
const WITNESS_MODE = process.env.TRACEFAB_POLICY_WITNESS === '1';
const PACKAGE_JSON_OVERRIDE = (WITNESS_MODE && process.env.TRACEFAB_PACKAGE_JSON) || '';

function lireScripts(chemin) {
  try {
    return JSON.parse(readFileSync(chemin, 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

const scriptsNpmRoot = lireScripts(ROOT_PACKAGE_JSON);
const scriptsNpm = PACKAGE_JSON_OVERRIDE ? lireScripts(PACKAGE_JSON_OVERRIDE) : scriptsNpmRoot;

const USES_SANS_MIGRATE = new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
]);

function texteSansCommentaireShell(run) {
  return String(run).split('\n').map((ligne) => ligne.replace(/(^|\s)#.*$/, '$1')).join('\n');
}

function fragmentsExecutables(run) {
  const fragments = [];
  for (const ligne of texteSansCommentaireShell(run).split('\n')) {
    for (const etape of ligne.split(/\s*(?:&&|\|\||;)\s*/)) {
      for (const tube of etape.split('|')) {
        const frag = tube.trim();
        if (frag) fragments.push(frag);
      }
    }
  }
  return fragments;
}

function sansPrefixeShell(frag) {
  let s = frag.trim();
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, '');
  s = s.replace(/^(?:command|time|exec|builtin|nice|nohup|sudo)\s+/, '');
  return s.trim();
}

function estFormeMigrateAutorisee(frag) {
  const t = sansPrefixeShell(frag);
  const npmThrowaway = /(?:npm\s+run(?:-script)?|yarn(?:\s+run)?|pnpm(?:\s+run)?)\b[\s\S]*\bdb:deploy:throwaway(?:\s|$)/.test(t);
  const nodeWrapper = /^node\s+scripts\/db-deploy-throwaway\.mjs(?:\s|$)/.test(t);
  if (!npmThrowaway && !nodeWrapper) return false;
  return throwawayNpmBodyIsWrapper(scriptsNpm[THROWAWAY_NPM_SCRIPT]);
}

function estEchoInoffensif(frag) {
  return /^(echo|printf)\b/.test(sansPrefixeShell(frag));
}

function pipeVersInterpreteur(run) {
  return /\|[ \t]*(?:sudo\s+)?(?:bash|sh|zsh|python3?|perl|ruby|node)\b/.test(texteSansCommentaireShell(run));
}

function estConcatDangereuse(t) {
  if (/\beval\b/.test(t) && /prisma|db:deploy|migrate/.test(t)) return true;
  if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(t) && /migrate|db:deploy|prisma/.test(t)) return true;
  if (/\+\s*['"]/.test(t) && /pris|migra|deploy/.test(t)) return true;
  return false;
}

function estInterpreteurOpaque(t) {
  if (/\bnode\s+-[ep]\b/.test(t)) return true;
  if (/(?:^|\s)(?:bash|sh|zsh|python3?)\s+-c\b/.test(t)) return true;
  if (/\beval\b/.test(t)) return true;
  return false;
}

function extraireFichiersInvoques(run) {
  const text = texteSansCommentaireShell(run);
  const found = [];
  const re = /\b(?:node|nodejs|tsx|python3?|bash|sh|zsh|source)\s+([\w./-]+\.(?:mjs|js|cjs|ts|sh|bash))/g;
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  const reExec = /(?:^|[\s;|&])(\.\/[\w./-]+\.(?:mjs|js|cjs|ts|sh|bash))/g;
  while ((m = reExec.exec(text)) !== null) found.push(m[1]);
  const reDot = /(?:^|[\s;|&])\.\s+([\w./-]+\.(?:sh|bash))/g;
  while ((m = reDot.exec(text)) !== null) found.push(m[1]);
  return [...new Set(found)];
}

function estWrapperConnu(rel) {
  const n = String(rel || '').replace(/^\.\//, '').replace(/\\/g, '/');
  return n === THROWAWAY_WRAPPER_REL || n.endsWith(`/${THROWAWAY_WRAPPER_REL}`);
}

function dansPerimetre(chemin) {
  const abs = resolve(chemin);
  const racines = [ROOT, WORKFLOWS].map((d) => resolve(d));
  return racines.some((r) => abs === r || abs.startsWith(`${r}/`)) ? abs : null;
}

function resoudreFichierLocal(rel) {
  if (!rel || rel.includes('..') || rel.includes('node_modules')) return null;
  const clean = rel.replace(/^\.\//, '');
  for (const base of [ROOT, WORKFLOWS]) {
    const abs = dansPerimetre(join(base, clean));
    if (abs && existsSync(abs)) return abs;
  }
  return null;
}

function lireTexteBorne(chemin) {
  try {
    const buf = readFileSync(chemin);
    if (buf.length > 256 * 1024) return '';
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function contenuFichierMigrateNUE(chemin) {
  const texte = lireTexteBorne(chemin);
  if (!texte) return false;
  const sansCom = texte.split('\n').map((ligne) => ligne
    .replace(/(^|\s)#.*$/, '$1')
    .replace(/\/\/.*$/, '')).join('\n');
  if (/prisma\s+migrate\s+deploy/.test(sansCom)) return true;
  if (/(?:npm\s+run(?:-script)?|npx|yarn|pnpm)\s+[^\n]*\bdb:deploy(?!:throwaway)/.test(sansCom)) return true;
  return false;
}

function fichierOuSautsMigrateNUE(rel, vus = new Set(), profondeur = 0) {
  if (profondeur > 2 || estWrapperConnu(rel)) return false;
  const chemin = resoudreFichierLocal(rel);
  if (!chemin) return 'introuvable';
  if (vus.has(chemin)) return false;
  vus.add(chemin);
  if (contenuFichierMigrateNUE(chemin)) return true;
  const texte = lireTexteBorne(chemin);
  if (!texte) return false;
  for (const enfant of extraireFichiersInvoques(texte)) {
    const r = fichierOuSautsMigrateNUE(enfant, vus, profondeur + 1);
    if (r) return r;
  }
  return false;
}

function usesHorsListe(uses) {
  const action = String(uses).split('@')[0].toLowerCase();
  if (action.startsWith('./') || action.startsWith('docker://')) return true;
  return !USES_SANS_MIGRATE.has(action);
}

function estMigrateNUE(frag) {
  if (estEchoInoffensif(frag) || estFormeMigrateAutorisee(frag)) return false;
  const t = sansPrefixeShell(frag);
  if (estConcatDangereuse(t) || estConcatDangereuse(frag)) return true;
  if (estInterpreteurOpaque(t) && /prisma|migrate|db:deploy/.test(t)) return true;
  if (/prisma\s+migrate\s+deploy/.test(t)) return true;
  if (/(?:npm\s+run(?:-script)?|npm\s+exec|npx|yarn(?:\s+run)?|pnpm(?:\s+(?:run|exec))?)\b[\s\S]*\bdb:deploy(?!:throwaway)/.test(t)) {
    return true;
  }
  if (/(?:^|[\s$`(])db:deploy(?!:throwaway)/.test(t) && /npm|npx|yarn|pnpm|run-script/.test(t)) {
    return true;
  }
  const appel = t.match(/(?:npm\s+run(?:-script)?|yarn(?:\s+run)?|pnpm(?:\s+run)?)\s+([A-Za-z0-9:_-]+)/);
  if (appel && scriptsNpm[appel[1]] && /prisma\s+migrate\s+deploy/.test(scriptsNpm[appel[1]])) {
    return true;
  }
  if (estFormeMigrateAutorisee(frag) === false
    && /db:deploy:throwaway/.test(t)
    && !throwawayNpmBodyIsWrapper(scriptsNpm[THROWAWAY_NPM_SCRIPT])) {
    return true;
  }
  return false;
}

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

function workflowInvoqueThrowaway(text) {
  const code = String(text).split('\n').map((line) => line.replace(/\s#.*$/, '')).join('\n');
  return /\bdb:deploy:throwaway\b/.test(code) || /db-deploy-throwaway\.mjs/.test(code);
}

let invoqueThrowaway = false;
for (const file of files) {
  try {
    if (workflowInvoqueThrowaway(readFileSync(join(WORKFLOWS, file), 'utf8'))) invoqueThrowaway = true;
  } catch { /* parse plus bas */ }
}

function controlerLiaison(scripts, source) {
  const aCle = Object.prototype.hasOwnProperty.call(scripts, THROWAWAY_NPM_SCRIPT);
  const liaisonOk = throwawayNpmBodyIsWrapper(scripts[THROWAWAY_NPM_SCRIPT]);
  const prefixe = source === 'depot' ? 'L. package.json du depot' : 'L. package.json';
  if (invoqueThrowaway && !aCle) {
    ko(source === 'depot'
      ? `L. workflow appelle ${THROWAWAY_NPM_SCRIPT} mais la cle npm est absente du depot`
      : `L. workflow appelle ${THROWAWAY_NPM_SCRIPT} mais la cle npm est absente`);
  } else if (aCle && !liaisonOk) {
    ko(`${prefixe} : ${THROWAWAY_NPM_SCRIPT} n est pas relie au wrapper`);
  } else if (aCle && liaisonOk) {
    ok(`${prefixe} : ${THROWAWAY_NPM_SCRIPT} est relie au wrapper`);
  } else {
    ok(`${prefixe} : pas de script ${THROWAWAY_NPM_SCRIPT} (aucun workflow ne l appelle)`);
  }
}

if (!WITNESS_MODE && process.env.TRACEFAB_PACKAGE_JSON) {
  ko('L. TRACEFAB_PACKAGE_JSON interdit hors TRACEFAB_POLICY_WITNESS=1 — le controle d integration lit le package.json du depot');
}
controlerLiaison(scriptsNpmRoot, 'depot');
if (PACKAGE_JSON_OVERRIDE) controlerLiaison(scriptsNpm, 'temoin');
existsSync(join(ROOT, THROWAWAY_WRAPPER_REL))
  ? ok(`L. wrapper ${THROWAWAY_WRAPPER_REL} present dans le depot`)
  : ko(`L. wrapper ${THROWAWAY_WRAPPER_REL} absent du depot`);

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

  // ------------------------------ F2. confinement du workflow a secret Vercel
  // Le workflow_dispatch peut être lancé depuis une branche choisie par le
  // contributeur. L'environnement avec approbation reste obligatoire, mais le
  // job doit aussi refuser les branches non protégées AVANT d'accéder au secret.
  if (file === 'vercel-log-search.yml') {
    const recherche = doc.jobs?.recherche;
    if (recherche?.if === "${{ github.ref == 'refs/heads/main' }}") {
      ok('F2. le job Vercel est limité à refs/heads/main avant accès au secret');
    } else {
      ko('F2. le job Vercel doit refuser toute référence autre que refs/heads/main');
    }
    if (triggerNames.length === 1 && triggerNames[0] === 'workflow_dispatch') {
      ok('F2. le workflow Vercel reste manuel uniquement');
    } else {
      ko('F2. le workflow Vercel doit rester workflow_dispatch uniquement');
    }
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


  // ---------------------------------- I. un job peut-il etre vert sans rien executer ?
  // Le defaut corrige ici a ete observe sur cinq branches `experience/*` : un job
  // nomme « Base — isolation RLS executee » dont TOUTES les etapes de base sont
  // conditionnees a la presence d'un secret. Sans le secret, chaque etape est
  // sautee et le job affiche vert, sous un nom qui affirme le contraire.
  //
  // Un nom de job est une affirmation : il doit correspondre a ce qui s'execute.
  const SUITE_DB = /npm\s+run\s+(?:test:neon|db:seed-rls)|run-db-suite\.mjs|seed_rls_fixture\.mjs|test_rls_isolation\.mjs/;
  const annonceExecution = (nom) => /RLS|isolation|base de donnees|database/i.test(nom) && /execut|executee|prouve|reelle|reel/i.test(nom);

  for (const [nomJob, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;
    // C'est le nom AFFICHE qui porte l'affirmation, pas la cle YAML.
    const nomAffiche = typeof job.name === 'string' && job.name.trim() ? job.name.trim() : nomJob;
    const etapes = Array.isArray(job.steps) ? job.steps : [];
    const etapesBase = etapes.filter((e) => e && typeof e.run === 'string' && SUITE_DB.test(e.run));

    if (etapesBase.length === 0) {
      if (annonceExecution(nomAffiche)) {
        ko(`I. le job « ${nomAffiche} » annonce une execution de base de donnees, et n en contient aucune`);
        console.error('          Le nom du job affirme un fait que le job ne produit pas.');
      }
      continue;
    }

    const clesEnvSecret = new Set(
      Object.entries(job.env && typeof job.env === 'object' ? job.env : {})
        .filter(([, valeur]) => typeof valeur === 'string' && valeur.includes('secrets.'))
        .map(([cle]) => cle),
    );
    const idsEtapesSecret = new Set(
      etapes.filter((e) => e && typeof e.run === 'string' && e.run.includes('secrets.')).map((e) => e.id).filter(Boolean),
    );
    const conditionneeParSecret = (condition) => {
      if (typeof condition !== 'string' || condition.trim() === '') return false;
      if (condition.includes('secrets.')) return true;
      if ([...clesEnvSecret].some((cle) => new RegExp(`env\\.${cle}\\b`).test(condition))) return true;
      if ([...idsEtapesSecret].some((id) => new RegExp(`steps\\.${id}\\.`).test(condition))) return true;
      return false;
    };

    const conditionnees = etapesBase.filter((e) => conditionneeParSecret(e.if));
    if (conditionnees.length > 0) {
      ko(`I. le job « ${nomAffiche} » conditionne ${conditionnees.length} etape(s) de base a un secret : vert possible sans rien executer`);
      for (const e of conditionnees) console.error(`          ${e.name || '(sans nom)'} — if: ${e.if}`);
      console.error('          Une etape de base ne doit pas dependre de la presence d un secret :');
      console.error('          soit la base est jetable et montee par le job, soit le job echoue.');
    } else {
      ok(`I. le job « ${nomAffiche} » execute ${etapesBase.length} etape(s) de base sans les conditionner a un secret`);
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

  // ------------------------------------------------- J. permissions et checkout
  // Chaque workflow doit déclarer ses permissions minimales. Les identifiants
  // du checkout ne doivent pas rester dans la configuration Git pour les
  // commandes suivantes.
  const permissionsWorkflowExplicites = doc.permissions
    && typeof doc.permissions === 'object'
    && !Array.isArray(doc.permissions);
  if (!permissionsWorkflowExplicites) {
    ko('J. permissions explicites absentes au niveau du workflow');
  } else {
    const scopes = [{ label: 'workflow', permissions: doc.permissions }];
    for (const [jobName, job] of Object.entries(jobs)) {
      if (job && typeof job === 'object' && job.permissions !== undefined) {
        scopes.push({ label: `job ${jobName}`, permissions: job.permissions });
      }
    }
    for (const scope of scopes) {
      if (!scope.permissions || typeof scope.permissions !== 'object' || Array.isArray(scope.permissions)) {
        ko(`J. permissions invalides dans ${scope.label}`);
        continue;
      }
      for (const [permission, value] of Object.entries(scope.permissions)) {
        const registeredContentsWrite = permission === 'contents'
          && value === 'write'
          && entryFor('writePermissionWorkflows', file);
        if (value !== 'read' && value !== 'none' && !registeredContentsWrite) {
          ko(`J. permission ${permission}: ${value} non minimale dans ${scope.label}`);
        }
      }
    }
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!step || typeof step !== 'object' || typeof step.uses !== 'string') continue;
      if (!/^actions\/checkout@/.test(step.uses)) continue;
      if (!step.with || step.with['persist-credentials'] !== false) {
        ko(`J. ${file} / job ${jobName} : checkout sans persist-credentials: false`);
      }
    }
  }

  // ------------------------------------------------- K. liste blanche migrate (T1.8)
  // Pas un parseur shell. Refuse par defaut tout chemin qui n'est pas
  // exactement le wrapper autorise. Fichiers locaux suivis sur 2 sauts.
  // uses: hors {checkout, setup-node, upload-artifact} = non autorise.
  const nues = [];
  for (const [nomJob, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!step || typeof step !== 'object') continue;
      if (typeof step.uses === 'string' && usesHorsListe(step.uses)) {
        nues.push({ job: nomJob, frag: `uses: ${step.uses}` });
      }
      if (typeof step.run !== 'string') continue;
      for (const frag of fragmentsExecutables(step.run)) {
        if (estMigrateNUE(frag)) nues.push({ job: nomJob, frag });
      }
      if (pipeVersInterpreteur(step.run) && /prisma|migrate|db:deploy/.test(texteSansCommentaireShell(step.run))) {
        nues.push({ job: nomJob, frag: step.run });
      }
      for (const rel of extraireFichiersInvoques(step.run)) {
        const r = fichierOuSautsMigrateNUE(rel);
        if (r === 'introuvable') nues.push({ job: nomJob, frag: `script introuvable ${rel}` });
        else if (r) nues.push({ job: nomJob, frag: `script ${rel}` });
      }
    }
  }
  if (nues.length > 0) {
    ko(`K. ${file} : ${nues.length} migration(s) prisma sans garde`);
    for (const n of nues.slice(0, 6)) {
      console.error(`          job ${n.job} : ${String(n.frag).slice(0, 100)}`);
    }
  } else {
    ok(`K. ${file} : aucune migrate prisma nue dans les etapes run`);
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Politique des workflows : OK.' : `Politique des workflows : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
