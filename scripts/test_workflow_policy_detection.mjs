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
    contenu: `name: Propre\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n        with:\n          persist-credentials: false\n      - run: npm ci\n      - run: npm test\n`,
    attenduCode: 0,
    attendu: 'Politique des workflows : OK',
  },
  {
    nom: 'job-vert-sans-execution.yml',
    faute: 'job de base vert possible sans executer un seul test',
    // Le secret est declare au registre du temoin, et la suite est lancee par la
    // garde : le SEUL motif de refus qui reste est le controle I.
    registre: { secretUsingWorkflows: { 'job-vert-sans-execution.yml': { justification: 'temoin de detection' } } },
    contenu: `name: Temoin\non:\n  push:\njobs:\n  base:\n    name: Base — isolation RLS executee\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - name: Verifier la presence du secret\n        id: secret\n        run: |\n          if [ -n "\${{ secrets.DATABASE_URL }}" ]; then\n            echo "present=true" >> "$GITHUB_OUTPUT"\n          fi\n      - name: Scenarios croises\n        if: steps.secret.outputs.present == 'true'\n        env:\n          DATABASE_URL: \${{ secrets.DATABASE_URL }}\n        run: node scripts/run-db-suite.mjs scripts/test_neon_security.mjs\n`,
    attenduCode: 1,
    attendu: 'conditionne',
  },
  {
    nom: 'job-qui-annonce-sans-executer.yml',
    faute: 'nom de job qui annonce une execution de base sans aucun test de base',
    contenu: `name: Temoin\non:\n  push:\njobs:\n  base:\n    name: Base — isolation RLS executee\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'aucune',
  },
  {
    nom: 'permissions-absentes.yml',
    faute: 'permissions minimales non declarees',
    contenu: `name: Temoin\non:\n  workflow_dispatch:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n        with:\n          persist-credentials: false\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'permissions explicites absentes',
  },
  {
    nom: 'checkout-credentials.yml',
    faute: 'identifiants du checkout conserves par defaut',
    contenu: `name: Temoin\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${EPINGLE}\n      - run: echo ok\n`,
    attenduCode: 1,
    attendu: 'checkout sans persist-credentials: false',
  },
  {
    nom: 'job-base-jetable.yml',
    faute: 'aucune — temoin : base jetable montee par le job, aucun secret',
    contenu: `name: Temoin\non:\n  push:\npermissions:\n  contents: read\njobs:\n  base:\n    name: Base — isolation RLS executee\n    runs-on: ubuntu-latest\n    services:\n      postgres:\n        image: postgres:17\n        env:\n          POSTGRES_DB: tracefab_test\n    env:\n      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/tracefab_test\n    steps:\n      - uses: ${EPINGLE}\n        with:\n          persist-credentials: false\n      - run: npm run test:neon:rls\n`,
    attenduCode: 0,
    attendu: 'Politique des workflows : OK',
  },
  {
    nom: 'k-direct.yml',
    faute: 'migration directe npm run db:deploy dans le job',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  base-de-donnees:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-apres-throwaway.yml',
    faute: 'throwaway puis migrate nue dans la meme etape',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy:throwaway && npm run db:deploy
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-npx-yes.yml',
    faute: 'npx --yes prisma migrate deploy',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npx --yes prisma migrate deploy
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-autre-job.yml',
    faute: 'migrate nue dans un autre job',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  base-de-donnees:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy:throwaway
  autre:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-throwaway-corps-prisma.yml',
    faute: 'corps npm db:deploy:throwaway remplace par prisma migrate deploy',
    scriptsNpm: {
      'db:deploy': 'prisma migrate deploy',
      'db:deploy:throwaway': 'prisma migrate deploy',
    },
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy:throwaway
`,
    attenduCode: 1,
    attendu: 'n est pas relie au wrapper',
  },
  {
    nom: 'k-throwaway-cle-absente.yml',
    faute: 'cle npm absente alors que le workflow l appelle',
    scriptsNpm: { 'db:deploy': 'prisma migrate deploy' },
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy:throwaway
`,
    attenduCode: 1,
    attendu: 'cle npm est absente',
  },
  {
    nom: 'k-eval.yml',
    faute: 'eval npm run db:deploy',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: eval npm run db:deploy
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-var-npm.yml',
    faute: 'substitution $NPM run db:deploy',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: $NPM run db:deploy
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-npm-silent-throwaway.yml',
    faute: 'aucune — npm run --silent db:deploy:throwaway avec liaison valide',
    scriptsNpm: {
      'db:deploy': 'prisma migrate deploy',
      'db:deploy:throwaway': 'node scripts/db-deploy-throwaway.mjs',
    },
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run --silent db:deploy:throwaway
`,
    attenduCode: 0,
    attendu: 'Politique des workflows : OK',
  },
  {
    nom: 'k-comment-inoffensif.yml',
    faute: 'aucune — commentaire contenant prisma migrate deploy',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: |
          # prisma migrate deploy
          echo ok
`,
    attenduCode: 0,
    attendu: 'Politique des workflows : OK',
  },
  {
    nom: 'k-throwaway-seul.yml',
    faute: 'aucune — uniquement db:deploy:throwaway',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: npm run db:deploy:throwaway
`,
    attenduCode: 0,
    attendu: 'Politique des workflows : OK',
  },
  {
    nom: 'k-echo-pipe-bash.yml',
    faute: 'echo prisma migrate deploy | bash',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: echo 'prisma migrate deploy' | bash
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-script-externe.yml',
    faute: 'bash migrate-ci.sh sans mot-cle migrate dans le YAML',
    fichiers: { 'migrate-ci.sh': '#!/bin/sh\nprisma migrate deploy\n' },
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: bash migrate-ci.sh
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-script-2sauts.yml',
    faute: 'script autorise-en-apparence qui appelle un second script migrate',
    fichiers: {
      'hop.sh': '#!/bin/sh\nbash inner.sh\n',
      'inner.sh': '#!/bin/sh\nprisma migrate deploy\n',
    },
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: bash hop.sh
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-source.yml',
    faute: 'source migrate-ci.sh',
    fichiers: { 'migrate-ci.sh': '#!/bin/sh\nprisma migrate deploy\n' },
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: source migrate-ci.sh
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-uses-prisma-migrate.yml',
    faute: 'uses: action tierce prisma-migrate',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - uses: example/prisma-migrate@11d5960a326750d5838078e36cf38b85af677262 # v1.0.0
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-node-e-migrate.yml',
    faute: 'node -e spawn prisma migrate',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: node -e "require('child_process').spawn('prisma',['migrate','deploy'])"
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-concat.yml',
    faute: 'commande construite par concatenation',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: node -e "require('child_process').spawn('pris'+'ma',['migrate','deploy'])"
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
  {
    nom: 'k-script-introuvable.yml',
    faute: 'fichier appele impossible a verifier',
    contenu: `name: Temoin
on:
  push:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${EPINGLE}
        with:
          persist-credentials: false
      - run: bash absent-ci.sh
`,
    attenduCode: 1,
    attendu: 'migration(s) prisma sans garde',
  },
];

console.log('\n  LA POLITIQUE DOIT REFUSER CE QUI EST FAUTIF — ET SE TAIRE SINON\n');

const dossier = mkdtempSync(join(tmpdir(), 'tracefab-workflows-temoins-'));
try {
  for (const temoin of TEMOINS) {
    writeFileSync(join(dossier, temoin.nom), temoin.contenu);
    if (temoin.fichiers) {
      for (const [nomFichier, corps] of Object.entries(temoin.fichiers)) {
        writeFileSync(join(dossier, nomFichier), corps);
      }
    }
    const env = { ...process.env, TRACEFAB_WORKFLOW_DIR: dossier, TRACEFAB_POLICY_WITNESS: '1' };
    delete env.TRACEFAB_PACKAGE_JSON;
    if (temoin.scriptsNpm) {
      const cheminPkg = join(dossier, `pkg-${temoin.nom}.json`);
      writeFileSync(cheminPkg, JSON.stringify({ private: true, scripts: temoin.scriptsNpm }));
      env.TRACEFAB_PACKAGE_JSON = cheminPkg;
    }
    if (temoin.registre) {
      const cheminRegistre = join(dossier, 'registre-temoin.json');
      writeFileSync(cheminRegistre, JSON.stringify(temoin.registre));
      env.TRACEFAB_WORKFLOW_REGISTRY = cheminRegistre;
    } else {
      delete env.TRACEFAB_WORKFLOW_REGISTRY;
    }
    const resultat = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', env });
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
    if (temoin.fichiers) {
      for (const nomFichier of Object.keys(temoin.fichiers)) {
        rmSync(join(dossier, nomFichier), { force: true });
      }
    }
  }
} finally {
  rmSync(dossier, { recursive: true, force: true });
}

console.log('\n  MODE INTEGRATION : le package.json du depot, pas un substitut\n');

{
  const isol = mkdtempSync(join(tmpdir(), 'tracefab-pkg-inject-'));
  try {
    const poison = join(isol, 'package-poison.json');
    const sain = join(isol, 'package-sain.json');
    writeFileSync(poison, JSON.stringify({
      private: true,
      scripts: {
        'db:deploy': 'prisma migrate deploy',
        'db:deploy:throwaway': 'prisma migrate deploy',
      },
    }));
    writeFileSync(sain, JSON.stringify({
      private: true,
      scripts: {
        'db:deploy': 'prisma migrate deploy',
        'db:deploy:throwaway': 'node scripts/db-deploy-throwaway.mjs',
      },
    }));
    const workflowsReels = join(ROOT, '.github', 'workflows');

    function lancer(envExtra) {
      const env = { ...process.env, ...envExtra };
      delete env.TRACEFAB_POLICY_WITNESS;
      if (!('TRACEFAB_WORKFLOW_DIR' in envExtra)) delete env.TRACEFAB_WORKFLOW_DIR;
      if (!('TRACEFAB_PACKAGE_JSON' in envExtra)) delete env.TRACEFAB_PACKAGE_JSON;
      if (envExtra.TRACEFAB_POLICY_WITNESS) env.TRACEFAB_POLICY_WITNESS = envExtra.TRACEFAB_POLICY_WITNESS;
      const resultat = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', env });
      return { status: resultat.status, sortie: `${resultat.stdout || ''}${resultat.stderr || ''}` };
    }

    {
      const r = lancer({});
      r.status === 0 && r.sortie.includes('package.json du depot') && r.sortie.includes('est relie au wrapper')
        ? ok('integration sans substitut : package.json du depot, sortie 0')
        : ko(`integration sans substitut status=${r.status}`);
    }
    {
      const r = lancer({ TRACEFAB_PACKAGE_JSON: poison });
      r.status === 1 && r.sortie.includes('interdit hors TRACEFAB_POLICY_WITNESS=1')
        ? ok('PACKAGE_JSON seul : integration refusee, depot non remplace')
        : ko(`PACKAGE_JSON seul status=${r.status}`);
    }
    {
      const r = lancer({ TRACEFAB_WORKFLOW_DIR: workflowsReels });
      r.status === 0 && r.sortie.includes('package.json du depot')
        ? ok('WORKFLOW_DIR seul : integration controle toujours le depot')
        : ko(`WORKFLOW_DIR seul status=${r.status}`);
    }
    {
      const r = lancer({ TRACEFAB_WORKFLOW_DIR: workflowsReels, TRACEFAB_PACKAGE_JSON: poison });
      r.status === 1 && r.sortie.includes('interdit hors TRACEFAB_POLICY_WITNESS=1')
        ? ok('les deux variables + faux non conforme : integration refusee')
        : ko(`combinaison poison status=${r.status}`);
    }
    {
      const r = lancer({ TRACEFAB_WORKFLOW_DIR: workflowsReels, TRACEFAB_PACKAGE_JSON: sain });
      r.status === 1 && r.sortie.includes('interdit hors TRACEFAB_POLICY_WITNESS=1')
        ? ok('les deux variables + faux conforme : ne rend pas l integration verte')
        : ko(`combinaison sain status=${r.status}`);
    }
  } finally {
    rmSync(isol, { recursive: true, force: true });
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Temoins de detection : OK.' : `Temoins de detection : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
