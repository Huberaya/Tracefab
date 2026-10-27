#!/usr/bin/env node
/**
 * VALIDATION NEON — UNE SEULE COMMANDE, DANS L'ORDRE, AVEC ARRET AU PREMIER ECHEC.
 *
 * POURQUOI CE SCRIPT
 *   La procedure `07-PROCEDURE-VALIDATION-NEON.md` decrit huit etapes. Tant
 *   qu'elles sont recopiees a la main, une etape sautee ne se voit pas. Ce
 *   script les enchaine, imprime chaque commande et son code de retour, et
 *   s'arrete a la premiere qui echoue.
 *
 * CE QU'IL FAIT
 *   1. verifie le SHA du depot et l'arbre Git ;
 *   2. verifie l'identite de la cible (lecture seule) ;
 *   3. `npx prisma migrate status` ;
 *   4. `npm run db:deploy` — SAUF si `--sans-deploy` est passe ;
 *   5. re-verifie l'identite apres migration ;
 *   6. les quatre controles du §9 et les sept scenarios ;
 *   7. la non-regression revue/publication ;
 *   8. la simulation du parc, en lecture seule, avec rollback verifie.
 *
 * CE QU'IL N'EST PAS
 *   Il ne remplace pas `prisma migrate deploy` par du SQL maison : il APPELLE
 *   la commande officielle. S'il ne peut pas l'executer (moteur de schema
 *   indisponible, reseau ferme), il le dit et s'arrete.
 *
 * USAGE (la cible doit etre nommee ; rien n'est devine)
 *   DATABASE_URL='…'                       # par canal de secrets, jamais un fichier
 *   TF_ATTENDU_HOTE='<hote exact de la branche>'
 *   TF_ATTENDU_BASE='neondb'
 *   TF_ATTENDU_MIGRATIONS='<nombre attendu AVANT migration>'
 *     node scripts/validation_neon_complete.mjs [--sans-deploy] [--rapport <fichier>]
 *
 * VARIABLES OPTIONNELLES
 *   TF_RLS_APP_URL, TF_PRODUIT_TEST, TF_ORG_TEST, TF_ACTEUR_TEST,
 *   TF_AUTRE_ACTEUR_TEST : activent le banc sous role applicatif.
 *
 * Aucun secret n'est imprime ni ecrit : seul l'hote est affiche.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sansDeploy = process.argv.includes('--sans-deploy');
const iRapport = process.argv.indexOf('--rapport');
const cheminRapport = iRapport > -1 ? process.argv[iRapport + 1] : null;

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

const url = process.env.DATABASE_URL;
if (!url) { console.error('NON EXECUTE — DATABASE_URL obligatoire.'); process.exit(2); }
let hote;
try { hote = new URL(url).hostname; } catch { console.error('NON EXECUTE — DATABASE_URL illisible.'); process.exit(2); }
if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error('REFUS — la cible est la production.');
  process.exit(3);
}
if (!process.env.TF_ATTENDU_HOTE || !process.env.TF_ATTENDU_BASE) {
  console.error('REFUS — TF_ATTENDU_HOTE et TF_ATTENDU_BASE doivent nommer la cible.');
  console.error(`         hote de la connexion : ${hote}`);
  process.exit(3);
}

const journal = [];
const etapes = [];

function executer(titre, commande, args, options = {}) {
  console.log(`\n=== ${titre}`);
  console.log(`    ${commande} ${args.join(' ')}`);
  const debut = Date.now();
  const r = spawnSync(commande, args, {
    cwd: ROOT, encoding: 'utf8', env: process.env, timeout: options.timeout || 900000,
  });
  const sortie = `${r.stdout || ''}${r.stderr || ''}`;
  const code = r.status === null ? 128 : r.status;
  console.log(sortie.trim().split('\n').slice(-25).map((l) => `    ${l}`).join('\n'));
  console.log(`    -> code ${code} (${((Date.now() - debut) / 1000).toFixed(1)} s)`);
  etapes.push({ titre, commande: `${commande} ${args.join(' ')}`, code, secondes: (Date.now() - debut) / 1000 });
  journal.push(`## ${titre}\n$ ${commande} ${args.join(' ')}\n${sortie.trim()}\n(exit ${code})`);
  return { code, sortie };
}

function arreter(titre, code, conseil) {
  console.error(`\nARRET — ${titre} (code ${code}).`);
  console.error(`  ${conseil}`);
  ecrireRapport();
  process.exit(code === 0 ? 1 : code);
}

function ecrireRapport() {
  if (!cheminRapport) return;
  mkdirSync(dirname(resolve(ROOT, cheminRapport)), { recursive: true });
  const entete = [
    '# Validation Neon — journal d\'exécution',
    '',
    `- date : ${new Date().toISOString()}`,
    `- hôte (sans identifiants) : ${hote}`,
    `- base déclarée : ${process.env.TF_ATTENDU_BASE}`,
    `- SHA : ${shaDepot}`,
    `- mode : ${sansDeploy ? 'sans deploy' : 'avec deploy'}`,
    '',
    '| étape | code | durée |',
    '|---|---|---|',
    ...etapes.map((e) => `| ${e.titre} | ${e.code} | ${e.secondes.toFixed(1)} s |`),
    '',
  ].join('\n');
  writeFileSync(resolve(ROOT, cheminRapport), `${entete}\n${journal.join('\n\n')}\n`);
  console.log(`\njournal ecrit : ${cheminRapport}`);
}

// 1. Depot.
let shaDepot = 'inconnu';
{
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  shaDepot = (r.stdout || '').trim();
  const s = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const propre = (s.stdout || '').trim() === '';
  console.log(`\n=== Depot\n    SHA ${shaDepot}\n    arbre ${propre ? 'propre' : 'MODIFIE'}`);
  if (!propre) {
    console.error('  ATTENTION — arbre modifie : le SHA ne decrit pas exactement ce qui va etre execute.');
  }
}

// 2. Identite avant toute ecriture.
{
  const r = executer('identite de la cible (lecture seule)', 'node',
    ['scripts/verifier_identite_branche.mjs']);
  if (r.code !== 0) {
    arreter('identite non prouvee', r.code,
      'Rien n\'a ete ecrit. Corriger la cible ou la declaration avant de reprendre.');
  }
}

// 3. Etat Prisma.
{
  const r = executer('prisma migrate status', 'npx', ['prisma', 'migrate', 'status'], { timeout: 300000 });
  if (r.code !== 0) {
    arreter('prisma migrate status a echoue', r.code,
      'Aucune migration n\'a ete tentee. Un moteur de schema indisponible ou un reseau ferme '
      + 'signifie que CET environnement ne peut pas executer Prisma : utiliser un poste ou un '
      + 'runner qui atteint Neon et dispose du moteur.');
  }
}

// 4. Deploy officiel.
if (sansDeploy) {
  console.log('\n=== db:deploy — SAUTE (--sans-deploy)');
  etapes.push({ titre: 'db:deploy (saute)', commande: '—', code: 0, secondes: 0 });
} else {
  const r = executer('db:deploy (prisma migrate deploy)', 'npm', ['run', 'db:deploy'], { timeout: 1800000 });
  if (r.code !== 0) {
    arreter('db:deploy a echoue', r.code,
      'Ne pas relancer a l\'aveugle, ne pas corriger le registre a la main : lire le message, '
      + 'l\'etat du schema et `_prisma_migrations`, puis restaurer la branche si necessaire.');
  }
}

// 5. Identite apres migration.
{
  const r = executer('identite apres migration', 'node', ['scripts/verifier_identite_branche.mjs']);
  if (r.code !== 0) {
    arreter('etat incoherent apres migration', r.code,
      'Collecter la sortie et s\'arreter : la suite de tests ne doit pas masquer une incoherence de registre.');
  }
}

// 6. Controles §9 + scenarios.
{
  const r = executer('controles §9 et sept scenarios DPP', 'node', ['scripts/valider_branche_dpp.mjs']);
  if (r.code !== 0) arreter('controles §9 en echec', r.code, 'Comparer avec les valeurs attendues de la procedure.');
}

// 7. Non-regression revue et publication.
{
  const r = executer('non-regression revue et publication', 'node',
    ['scripts/test_dpp_review_and_publication.mjs']);
  if (r.code !== 0) arreter('non-regression en echec', r.code, 'Un cas A1/A2/A3 est casse : ne pas publier.');
}

// 8. Banc sous role applicatif, si les identifiants sont fournis.
if (process.env.TF_RLS_APP_URL && process.env.TF_PRODUIT_TEST
  && process.env.TF_ORG_TEST && process.env.TF_ACTEUR_TEST) {
  const r = executer('banc sous role applicatif (RLS)', 'node', ['scripts/test_dpp_role_applicatif.mjs']);
  if (r.code !== 0) arreter('banc sous role applicatif en echec', r.code,
    'Le parcours ne passe pas avec le role de l\'application : ne pas publier.');
} else {
  console.log('\n=== banc sous role applicatif — SAUTE (TF_RLS_APP_URL / TF_PRODUIT_TEST / TF_ORG_TEST / TF_ACTEUR_TEST incomplets)');
}

// 9. Simulation du parc, lecture seule.
{
  process.env.TF_SIMULATION_CIBLE = hote;
  const r = executer('simulation du recalcul (rollback verifie)', 'node',
    ['scripts/simuler_recalcul_dpp.mjs', '--sortie', '/tmp/simulation-validation.json']);
  if (r.code !== 0) arreter('simulation non concluante', r.code,
    'La base n\'a pas ete restauree, ou le moteur a echoue : ne pas recalculer pour de vrai.');
}

ecrireRapport();
console.log('\n=== Termine — aucune ecriture metier conservee, aucun recalcul reel, aucune publication.');
console.log('    Prochaine etape : lire le tableau de simulation, puis decider explicitement.');
process.exit(0);
