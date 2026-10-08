#!/usr/bin/env node
/**
 * CHANTIER ADMIN 10 — la chaîne de migrations, exécutée pour de vrai.
 *
 * Ce test démarre un VRAI serveur PostgreSQL (embedded-postgres, installé depuis
 * PyPI), applique les 36 migrations sur une base vierge, puis vérifie que
 * `prisma/schema.prisma` décrit bien la base obtenue : clés étrangères,
 * contraintes nommées, index, RLS forcée.
 *
 * POURQUOI
 *   Jusqu'ici aucune migration n'avait jamais été exécutée nulle part. Deux
 *   affirmations en dépendaient et étaient fausses — « le bloc CRM n'a aucune
 *   clé étrangère » (il en a 15 dès A01/A02) et « organization_id est une
 *   colonne nouvelle » (elle doublonnait linked_organization_id). Aucune des
 *   deux n'était détectable en lisant du SQL.
 *
 * SI LE SERVEUR NE PEUT PAS ÊTRE INSTALLÉ
 *   Le test affiche POSTGRES_SERVER_UNAVAILABLE et sort en erreur : le runner
 *   classe ce cas en SKIP, jamais en PASS. Une vérification non effectuée ne
 *   doit pas ressembler à une vérification réussie.
 *
 *   npm run test:migrations
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const venv = join(root, '.cache', 'pgvenv');
const py = join(venv, 'bin', 'python');
const pip = join(venv, 'bin', 'pip');

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => reject(new Error(`${label} : ${e.message}`)));
    child.on('close', (code) => (code === 0
      ? resolve(out)
      : reject(new Error(`${label} (code ${code})\n${out.slice(-800)}`))));
  });
}

/* Le venv vit dans .cache, qui ne survit pas entre deux sessions : il est
   recréé à la demande. Sans réseau, on le dit et on sort — pas de PASS. */
try {
  if (!existsSync(py)) {
    console.log('Préparation de l’environnement PostgreSQL (première fois)…');
    await run('python3', ['-m', 'venv', venv], 'création du venv');
    await run(pip, ['install', '--quiet', 'pglast', 'embedded-postgres'],
      'installation de pglast et embedded-postgres');
  }
} catch (e) {
  console.error('POSTGRES_SERVER_UNAVAILABLE: impossible de préparer le serveur PostgreSQL');
  console.error(String(e.message).slice(-400));
  console.error('  à faire : installer pglast et embedded-postgres dans .cache/pgvenv (réseau requis)');
  process.exit(1);
}

const child = spawn(py, [join(root, 'scripts', 'migrations_check.py')], {
  cwd: root, stdio: 'inherit',
});
child.on('close', (code) => process.exit(code ?? 1));
child.on('error', (e) => {
  console.error('POSTGRES_SERVER_UNAVAILABLE:', e.message);
  process.exit(1);
});
