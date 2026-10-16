#!/usr/bin/env node
/**
 * Posture de tous les workflows, sur toutes les branches.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * `npm run test:workflow-policy` analyse l'arbre courant. C'est ce qu'il faut
 * pour bloquer une regression avant fusion. Ce n'est pas suffisant pour
 * repondre a une autre question : quels workflows existent ailleurs dans le
 * depot, sur des branches non fusionnees, et que portent-ils ?
 *
 * Un fichier de workflow absent de `main` n'est pas inoffensif : il s'active
 * des qu'il atteint la branche par defaut, et il peut deja tourner sur sa
 * propre branche. Celui qui porte `contents: write` sur une branche de travail
 * cree deja des commits aujourd'hui.
 *
 * Ce script lit chaque workflow de chaque reference distante, SANS extraire ni
 * executer quoi que ce soit, et rapporte une posture par fichier. Il ne
 * modifie rien, n'ecrit rien, ne se connecte nulle part.
 *
 * Usage :
 *   node scripts/audit_workflows_all_refs.mjs              (toutes les refs distantes)
 *   node scripts/audit_workflows_all_refs.mjs origin/main  (une ref precise)
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const refsVoulues = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let refs;
try {
  if (refsVoulues.length > 0) {
    refs = refsVoulues;
  } else {
    refs = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
      .split('\n')
      .filter((r) => r && !r.endsWith('/HEAD'));
  }
} catch (error) {
  console.error(`  ECHEC — lecture des references impossible : ${error.message}`);
  process.exit(1);
}

const ACTIONS_PRIVILEGIEES = ['pull_request_target', 'workflow_run'];

const lignes = [];
let fichiersAnalyses = 0;
const alertes = [];

for (const ref of refs) {
  let liste;
  try {
    liste = git(['ls-tree', '-r', '--name-only', ref, '.github/workflows/']);
  } catch {
    continue;
  }
  if (!liste) continue;

  for (const chemin of liste.split('\n').filter((f) => /\.ya?ml$/.test(f))) {
    fichiersAnalyses += 1;
    let texte;
    try {
      texte = git(['show', `${ref}:${chemin}`]);
    } catch {
      continue;
    }

    // Les commentaires sont retires : une explication qui cite un motif n'est
    // pas un usage. En YAML, un commentaire suit « # » precede d'une espace.
    const code = texte.split('\n').map((l) => l.replace(/\s#.*$/, '')).join('\n');

    let doc = null;
    let yamlValide = true;
    try { doc = parse(texte); } catch { yamlValide = false; }

    const secrets = [...new Set([...code.matchAll(/secrets\.[A-Za-z0-9_]+/g)].map((m) => m[0]))];
    const uses = code.split('\n').map((l) => l.trim())
      .filter((l) => l.startsWith('- uses:') || l.startsWith('uses:'))
      .map((l) => l.replace(/^-\s*/, '').replace(/^uses:\s*/, '').split('#')[0].trim());
    const externes = uses.filter((u) => !u.startsWith('./') && !u.startsWith('docker://'));
    const nonEpinglees = externes.filter((u) => !/@[0-9a-f]{40}$/.test(u));

    const jobs = (doc && doc.jobs) || {};
    const jobsEcrivains = [];
    for (const [nom, job] of Object.entries(jobs)) {
      if (job && job.permissions && typeof job.permissions === 'object' && job.permissions.contents === 'write') {
        const commandes = (job.steps || [])
          .filter((s) => s && typeof s.run === 'string')
          .flatMap((s) => s.run.split('\n'))
          .map((l) => l.trim())
          .filter((l) => /^(npm|npx|node|yarn|pnpm|tsx)\b/.test(l));
        jobsEcrivains.push({ nom, commandes });
      }
    }
    const permsWorkflowEcrit = doc && doc.permissions
      && typeof doc.permissions === 'object' && doc.permissions.contents === 'write';

    const triggersBruts = doc ? (doc.on ?? doc.true) : null;
    const triggers = typeof triggersBruts === 'string' ? [triggersBruts]
      : Array.isArray(triggersBruts) ? triggersBruts
      : triggersBruts && typeof triggersBruts === 'object' ? Object.keys(triggersBruts) : [];
    const privilegies = ACTIONS_PRIVILEGIEES.filter((t) => triggers.includes(t));

    // Ce qui est destructif, et ce qui ne l'est pas.
    //
    // `test:neon:rls` et `test:neon:privileges` sont en LECTURE SEULE : les
    // signaler ferait crier le controle a tort sur une etape legitime, et un
    // controle qui crie a tort finit par etre ignore. Les suites qui ecrivent
    // sont nommees explicitement, et l'appel direct a un script d'amorcage en
    // fait partie : `scripts/seed_rls_fixture.mjs` cree un role, accorde des
    // privileges et ecrit des lignes.
    const SUITES_LECTURE_SEULE = ['test:neon:rls', 'test:neon:privileges'];
    const invocations = [...code.matchAll(/npm\s+run\s+(test:neon[\w:-]*)/g)].map((m) => m[1]);
    const suitesEcrivantes = invocations.filter((s) => !SUITES_LECTURE_SEULE.includes(s));
    const amorcagesDirects = [...code.matchAll(/node\s+(scripts\/seed_[\w.-]+)/g)].map((m) => m[1]);
    const passeParLanceur = /run-db-suite/.test(code);

    const raisons = [];
    if (suitesEcrivantes.length > 0) raisons.push(suitesEcrivantes.join(', '));
    if (amorcagesDirects.length > 0) raisons.push(`appel direct ${amorcagesDirects.join(', ')}`);
    const lanceDestructif = raisons.length > 0;

    let niveau = 'ok';
    const motifs = [];
    if (!yamlValide) { motifs.push('YAML illisible'); niveau = 'critique'; }
    if (secrets.length > 0) { motifs.push(`lit ${secrets.join(', ')}`); niveau = 'critique'; }
    if (permsWorkflowEcrit) { motifs.push('contents: write au niveau du WORKFLOW'); niveau = 'critique'; }
    for (const j of jobsEcrivains) {
      if (j.commandes.length > 0) {
        motifs.push(`job « ${j.nom} » ecrit ET execute du code du depot`);
        niveau = 'critique';
      } else {
        motifs.push(`job « ${j.nom} » ecrit sans executer de code`);
        if (niveau === 'ok') niveau = 'a_surveiller';
      }
    }
    if (nonEpinglees.length > 0) { motifs.push(`${nonEpinglees.length} action(s) non epinglee(s)`); if (niveau === 'ok') niveau = 'a_surveiller'; }
    if (privilegies.length > 0) { motifs.push(`declencheur privilegie : ${privilegies.join(', ')}`); niveau = 'critique'; }
    if (lanceDestructif && !passeParLanceur) {
      motifs.push(`ecriture en base SANS la garde : ${raisons.join(', ')}`);
      niveau = 'critique';
    }

    lignes.push({
      ref: ref.replace('refs/remotes/', ''),
      fichier: chemin,
      niveau,
      motifs: motifs.join(' ; ') || '—',
    });
    if (niveau === 'critique') {
      alertes.push({ ref: ref.replace('refs/remotes/', ''), fichier: chemin, motifs: motifs.join(' ; ') });
    }
  }
}

console.log(`\n  ${fichiersAnalyses} fichier(s) de workflow analyse(s) sur ${refs.length} reference(s)\n`);
console.log('  REFERENCE'.padEnd(52) + 'FICHIER'.padEnd(42) + 'NIVEAU');
console.log('  ' + '-'.repeat(120));
for (const l of lignes.sort((a, b) => a.niveau.localeCompare(b.niveau))) {
  const marque = l.niveau === 'critique' ? 'CRITIQUE' : l.niveau === 'a_surveiller' ? 'a surveiller' : 'ok';
  console.log(`  ${l.ref.padEnd(50)}${l.fichier.replace('.github/workflows/', '').padEnd(42)}${marque}`);
  if (l.niveau !== 'ok') console.log(`  ${' '.repeat(50)}  -> ${l.motifs}`);
}

console.log(`\n  ${alertes.length} alerte(s) critique(s)\n`);
if (alertes.length > 0) {
  console.log('  Aucune correction n est appliquee par ce script : il constate.');
  console.log('  Le fichier `figer-reference-visuelle.yml` vit sur une branche non');
  console.log('  fusionnee ; sa version durcie est preparee dans docs/security/patches/.\n');
}
