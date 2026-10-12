#!/usr/bin/env node
/**
 * Temoins de detection de la politique des workflows.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * `test:workflow-policy` affiche vert sur l'arbre actuel. Un vert peut vouloir
 * dire deux choses : que l'arbre est propre, ou que le detecteur ne detecte
 * rien. Les deux se ressemblent exactement.
 *
 * Ce fichier tranche : il fabrique des workflows volontairement fautifs, dans
 * un dossier temporaire, et fait tourner LE SCRIPT DE PRODUCTION dessus
 * (`scripts/test_workflow_policy.mjs`, par le biais de TRACEFAB_WORKFLOW_DIR).
 * Chaque faute attendue doit produire la bonne ligne d'echec, et le temoin
 * propre doit passer sans un seul echec.
 *
 * Aucun fichier du depot n'est modifie : les fautes vivent dans /tmp et
 * disparaissent avec le dossier.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'test_workflow_policy.mjs');

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const EPINGLE = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0';

/** Chaque temoin : un fichier, l'attendu en code de sortie, un fragment de diagnostic. */
const TEMOINS = [
  {
    nom: 'secrets.yml',
    faute: 'lecture du contexte secrets pour alimenter une connexion',
    contenu: `name: Temoin\non:\n  push:\n    branches: ['**']\njobs:\n  t:\n    runs-on: ubuntu-latest\n    env:\n      DATABASE_URL: \${{ secrets.DATABASE_URL }}\n    steps:\n      - uses: ${EPINGLE}\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'secrets',
  },
  {
    nom: 'branche-libre.yml',
    faute: 'connectivite de base possible depuis toute branche, sans garde',
    contenu: `name: Temoin\non:\n  push:\n    branches: ['**']\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - run: npm run test:neon:security\n`,
    attenduCode: 1,
    attendu: 'contournant la garde',
  },
  {
    nom: 'action-flottante.yml',
    faute: 'action tierce non epinglee par SHA',
    contenu: `name: Temoin\non:\n  push:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'non epinglee',
  },
  {
    nom: 'ecriture-job.yml',
    faute: 'jeton d ecriture detenu par un job qui execute du code du depot',
    contenu: `name: Temoin\non:\n  workflow_dispatch:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - uses: ${EPINGLE}\n      - run: npm ci\n      - run: node scripts/serve_preview.mjs\n`,
    attenduCode: 1,
    attendu: 'detient contents: write ET execute du code du depot',
  },
  {
    nom: 'ecriture-workflow.yml',
    faute: 'contents: write au niveau du workflow, herite par tous les jobs',
    contenu: `name: Temoin\non:\n  workflow_dispatch:\npermissions:\n  contents: write\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'au niveau du workflow',
  },
  {
    nom: 'declencheur-privilegie.yml',
    faute: 'pull_request_target non declare',
    contenu: `name: Temoin\non:\n  pull_request_target:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'declencheur privilegie non declare',
  },
  {
    nom: 'environnement.yml',
    faute: 'job rattache a un environnement sans declaration',
    contenu: `name: Temoin\non:\n  workflow_dispatch:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    environment: Production\n    steps:\n      - uses: ${EPINGLE}\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'sans declaration au registre',
  },
  {
    nom: 'propre.yml',
    faute: 'aucune — temoin negatif : le detecteur ne doit pas crier au loup',
    contenu: `name: Propre\non:\n  push:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - run: npm ci\n      - run: npm test\n`,
    attenduCode: 0,
    attendu: 'Politique des workflows : OK',
  },
];

console.log('\n  LA POLITIQUE DOIT REFUSER CE QUI EST FAUTIF — ET SE TAIRE SINON\n');

const dossier = mkdtempSync(join(tmpdir(), 'tracefab-workflows-temoins-'));
try {
  for (const temoin of TEMOINS) {
    writeFileSync(join(dossier, temoin.nom), temoin.contenu);
    const resultat = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, TRACEFAB_WORKFLOW_DIR: dossier },
    });
    const sortie = `${resultat.stdout || ''}${resultat.stderr || ''}`;
    const code = resultat.status;
    const codeOk = code === temoin.attenduCode;
    const messageOk = sortie.includes(temoin.attendu);

    if (codeOk && messageOk) {
      temoin.attenduCode === 0
        ? ok(`${temoin.nom} — ${temoin.faute} → accepte, aucun echec signale`)
        : ok(`${temoin.nom} — ${temoin.faute} → refuse par le diagnostic attendu`);
    }
    else if (!codeOk) ko(`${temoin.nom} — ${temoin.faute} → sortie ${code}, attendue ${temoin.attenduCode}`);
    else ko(`${temoin.nom} — sortie ${code} correcte mais diagnostic sans « ${temoin.attendu} »`);

    // Un temoin fautif doit nommer la faute ; on garde la trace au rapport.
    if (temoin.attenduCode === 1 && code === 1) {
      const ligneFautive = sortie.split('\n').find((l) => l.includes('ECHEC'));
      if (ligneFautive) console.log(`          ${ligneFautive.trim().slice(0, 120)}`);
    }

    rmSync(join(dossier, temoin.nom), { force: true });
  }
} finally {
  rmSync(dossier, { recursive: true, force: true });
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Temoins de detection : OK.' : `Temoins de detection : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
