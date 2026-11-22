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
 * CE QUE « REUSSITE » VEUT DIRE (code 0)
 *   Le code 0 n'est rendu que si TOUT ce qui suit a ete execute : depot propre
 *   au SHA autorise, identite prouvee, `prisma migrate status`, `db:deploy`,
 *   identite post-migration EXIGEANT nommement les trois migrations, §9,
 *   sept scenarios, non-regression, banc sous `tracefab_app`, simulation avec
 *   rollback verifie. Un controle non joue n'est pas un controle reussi : si
 *   les variables du banc applicatif manquent, la commande echoue avant toute
 *   ecriture au lieu de poursuivre.
 *
 * CODES DE SORTIE
 *   0 tout est prouve ; 2 usage (DATABASE_URL absente) ;
 *   3 cible refusee (production, ou cible non nommee) ;
 *   4 revision inattendue (TF_ATTENDU_SHA absent ou different de HEAD) ;
 *   5 arbre Git modifie ; 6 banc applicatif incomplet (variables manquantes) ;
 *   7 une etape a echoue (le code de l'etape est imprime avec elle).
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

// Sans ces quatre variables, le banc sous role applicatif ne peut pas tourner.
// Or c'est lui qui prouve que le parcours DPP fonctionne avec le role REEL de
// l'application, sous RLS. Le rendre optionnel reviendrait a rendre 0 pour une
// validation partielle : refuse avant la premiere ecriture.
const VARIABLES_BANC = ['TF_RLS_APP_URL', 'TF_PRODUIT_TEST', 'TF_ORG_TEST', 'TF_ACTEUR_TEST'];
const manquantes = VARIABLES_BANC.filter((v) => !(process.env[v] || '').trim());
if (manquantes.length) {
  console.error('REFUS — banc sous role applicatif incomplet : ' + manquantes.join(', ') + ' manquant(s).');
  console.error('  Ce banc est obligatoire : sans lui, le parcours DPP sous tracefab_app n\'est pas prouve,');
  console.error('  et un succes partiel serait un faux succes. Rien n\'a ete ecrit.');
  process.exit(6);
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

// Les trois migrations que la validation doit avoir appliquees. Exiger leur
// nom, et non un simple compteur, evite qu'un registre avance par une autre
// migration passe pour la validation attendue.
const MIGRATIONS_EXIGEES = [
  '20261021170000_dpp_readiness_truthful_gates',
  '20261027100000_dpp_quality_gate_requires_assessment',
  '20261027130000_dpp_review_preservation_and_publication_coherence',
].join(',');

function arreter(titre, code, conseil) {
  console.error(`\nARRET — ${titre} (code de l'etape : ${code}).`);
  console.error(`  ${conseil}`);
  ecrireRapport();
  // 7 : une etape a echoue. On ne propage pas le code de l'enfant pour que
  // « 0 » ne puisse jamais venir d'ailleurs que de la fin du parcours.
  process.exit(7);
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

// 1. Depot : revision autorisee, arbre propre. Ni l'un ni l'autre ne se presume.
let shaDepot = 'inconnu';
{
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  shaDepot = (r.stdout || '').trim();
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const modifs = (st.stdout || '').trim();
  console.log(`\n=== Depot\n    SHA ${shaDepot}`);
  console.log(`    arbre ${modifs === '' ? 'propre' : 'MODIFIE'}`);

  if (modifs !== '') {
    console.error('  ARRET — arbre Git modifie : ce qui serait execute n\'est pas la revision autorisee.');
    for (const ligne of modifs.split('\n').slice(0, 10)) console.error(`    ${ligne}`);
    ecrireRapport();
    process.exit(5);
  }

  const attendu = (process.env.TF_ATTENDU_SHA || '').trim();
  if (!attendu) {
    console.error('  ARRET — TF_ATTENDU_SHA est obligatoire : une revision non declaree n\'est pas autorisee.');
    ecrireRapport();
    process.exit(4);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(attendu)) {
    console.error('  ARRET — TF_ATTENDU_SHA n\'est pas un SHA (7 a 40 caracteres hexadecimaux).');
    ecrireRapport();
    process.exit(4);
  }
  if (!shaDepot.toLowerCase().startsWith(attendu.toLowerCase())) {
    console.error(`  ARRET — revision inattendue : attendu ${attendu}, HEAD ${shaDepot}.`);
    ecrireRapport();
    process.exit(4);
  }
  console.log(`    revision autorisee : ${attendu} — conforme`);
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

// 5. Identite apres migration : les trois migrations sont exigees NOMINATIVEMENT,
//    aucune en echec ou inachevee, et l'ecart avec le depot doit etre nul.
{
  process.env.TF_EXIGER_MIGRATIONS = MIGRATIONS_EXIGEES;
  const r = executer('identite apres migration (trois migrations exigees, ecart depot nul)', 'node',
    ['scripts/verifier_identite_branche.mjs']);
  if (r.code !== 0) {
    arreter('etat incoherent apres migration', r.code,
      'Les trois migrations attendues ne sont pas toutes enregistrees comme terminees, ou une '
      + 'migration est en echec, ou le registre ne correspond pas au depot. Ne pas poursuivre.');
  }
  const ecart = /en attente dans le depot : (\d+)/.exec(r.sortie);
  if (!ecart || Number(ecart[1]) !== 0) {
    arreter('ecart entre le registre et le depot', 7,
      `migrations encore en attente : ${ecart ? ecart[1] : 'illisible'} — la migration n'est pas complete.`);
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

// 8. Banc sous role applicatif — OBLIGATOIRE (deja verifie en tete de script).
{
  const r = executer('banc sous role applicatif (RLS)', 'node', ['scripts/test_dpp_role_applicatif.mjs']);
  if (r.code !== 0) arreter('banc sous role applicatif en echec', r.code,
    'Le parcours ne passe pas avec le role de l\'application : ne pas publier.');
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
