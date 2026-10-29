#!/usr/bin/env node
/**
 * GARDE-FOUS DE `scripts/validation_neon_complete.mjs` — testes par execution.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Une commande de validation qui rend 0 pour une raison partielle est pire
 *   qu'aucune commande : elle eteint la vigilance. Ce banc eprouve chaque
 *   chemin d'arret du verrou et exige un code NON NUL et un message precis.
 *
 * CE QUI EST EPROUVE
 *   1. DATABASE_URL absente            -> 2
 *   2. cible de production             -> 3
 *   3. cible non nommee                -> 3
 *   4. revision absente                -> 4
 *   5. revision differente de HEAD     -> 4
 *   6. arbre Git modifie               -> 5
 *   7. banc applicatif incomplet        -> 6
 *   8. `db:deploy` en echec            -> 7   (via des doublures `npm`/`npx`)
 *   9. migration exigee non appliquee  -> 5   (verificateur d'identite)
 *
 * CE QU'IL NE FAIT PAS
 *   Aucune migration : les scenarios qui atteignent l'etape Prisma emploient
 *   des doublures placees en tete de PATH, qui n'ouvrent aucune connexion.
 *   La base locale n'est lue que par le verificateur d'identite (SELECT).
 *
 * USAGE
 *   DATABASE_URL=<base de test locale> node scripts/test_garde_fous_validation_neon.mjs
 *
 * Sans DATABASE_URL locale, les scenarios 7 a 9 sont declares NON JOUES, et le
 * script sort en code 2 : un banc qui ne s'execute pas ne vaut pas un banc qui
 * passe.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIMS = '/tmp/tracefab-shims-gardefous';
const TEMOIN = join(ROOT, '.garde-fou-arbre-modifie.tmp');

let echecs = 0;
const resultats = [];

function eprouver(numero, libelle, attenduCode, attenduTexte, options = {}) {
  const r = spawnSync('node', options.script
    ? [options.script, ...(options.args || [])]
    : ['scripts/validation_neon_complete.mjs', ...(options.args || [])], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const sortie = `${r.stdout || ''}${r.stderr || ''}`;
  const code = r.status === null ? 128 : r.status;
  const codeOk = code === attenduCode;
  const texteOk = sortie.includes(attenduTexte);
  // Invariant central : aucun chemin d'arret ne doit rendre 0.
  const pasDeFauxSucces = attenduCode === 0 ? true : code !== 0;
  const bon = codeOk && texteOk && pasDeFauxSucces;
  if (!bon) echecs += 1;
  resultats.push({ numero, libelle, code, attenduCode, codeOk, texteOk, bon });
  console.log(`  ${bon ? 'ok   ' : 'ECHEC'} ${String(numero).padStart(2)}. ${libelle} — attendu ${attenduCode}, obtenu ${code}`
    + `${texteOk ? '' : ' (message attendu absent)'}`);
  if (!bon) {
    console.log(sortie.trim().split('\n').slice(-6).map((l) => `        ${l}`).join('\n'));
  }
  return { code, sortie };
}

// La cible locale est deduite de DATABASE_URL : le banc doit tourner aussi bien
// sur la base de test locale que sur le Postgres jetable de la CI.
const urlLocale = new URL(process.env.DATABASE_URL || 'postgresql://x@127.0.0.1:1/x');
const base = {
  TF_ATTENDU_HOTE: urlLocale.hostname,
  TF_ATTENDU_BASE: urlLocale.pathname.replace(/^\//, ''),
  TF_ATTENDU_SHA: '0000000',
  TF_RLS_APP_URL: process.env.DATABASE_URL || '',
  TF_PRODUIT_TEST: '00000000-0000-4000-8000-000000000001',
  TF_ORG_TEST: '00000000-0000-4000-8000-000000000002',
  TF_ACTEUR_TEST: '00000000-0000-4000-8000-000000000003',
};

console.log('\nGarde-fous de la commande de validation\n' + '-'.repeat(48));

// Trois scenarios (4, 5, 8) exigent un arbre propre : le verrou refuse un arbre
// modifie AVANT de regarder la revision, ce qui est son role. Sur un arbre
// modifie, ils ne peuvent pas etre joues — et un banc qui ferait semblant de
// les jouer mentirait. Ils sont donc declares non joues, et le script sort en 2.
const arbrePropre = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .stdout.trim() === '';
if (!arbrePropre) {
  console.log('  (arbre Git modifie : scenarios 4, 5 et 8 NON JOUES — ils exigent une revision commitee)');
}

// 1. pas de DATABASE_URL du tout.
{
  const env = { ...base, DATABASE_URL: undefined };
  const r = spawnSync('node', ['scripts/validation_neon_complete.mjs'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env, DATABASE_URL: '' },
  });
  const code = r.status === null ? 128 : r.status;
  const ok = code !== 0 && `${r.stdout}${r.stderr}`.includes('DATABASE_URL');
  if (!ok) echecs += 1;
  resultats.push({ numero: 1, libelle: 'DATABASE_URL absente', code, attenduCode: 2, bon: ok });
  console.log(`  ${ok ? 'ok   ' : 'ECHEC'}  1. DATABASE_URL absente — obtenu ${code}`);
}

const urlTest = process.env.DATABASE_URL;
if (!urlTest) {
  console.error('\n  NON JOUÉ — DATABASE_URL absente : les scenarios 2 a 9 exigent une base de test locale.');
  console.error('  Ce banc ne peut pas prouver les garde-fous sans cible ; il sort en code 2.');
  process.exit(2);
}

// 2. cible de production.
eprouver(2, 'cible de production refusee', 3, 'production', {
  env: { ...base, DATABASE_URL: 'postgresql://u:p@ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech/neondb' },
});

// 3. cible non nommee.
eprouver(3, 'cible non nommee refusee', 3, 'TF_ATTENDU_HOTE', {
  env: { ...base, DATABASE_URL: urlTest, TF_ATTENDU_HOTE: '' },
});

// 4 et 5. revision : exige un arbre propre.
if (arbrePropre) {
  eprouver(4, 'revision non declaree', 4, 'TF_ATTENDU_SHA', {
    env: { ...base, DATABASE_URL: urlTest, TF_ATTENDU_SHA: '' },
  });
  eprouver(5, 'revision differente de HEAD', 4, 'revision inattendue', {
    env: { ...base, DATABASE_URL: urlTest, TF_ATTENDU_SHA: 'deadbeefdeadbeef' },
  });
}

// 6. arbre Git modifie.
{
  writeFileSync(TEMOIN, 'temoin de garde-fou\n');
  try {
    eprouver(6, 'arbre Git modifie', 5, 'arbre Git modifie', {
      env: { ...base, DATABASE_URL: urlTest, TF_ATTENDU_SHA: '0000000' },
    });
  } finally {
    rmSync(TEMOIN, { force: true });
  }
}

// 7. banc applicatif incomplet.
eprouver(7, 'banc applicatif incomplet', 6, 'banc sous role applicatif incomplet', {
  env: { ...base, DATABASE_URL: urlTest, TF_ATTENDU_SHA: '0000000', TF_ORG_TEST: '' },
});

// 8. `db:deploy` en echec — doublures en tete de PATH, aucune connexion ouverte.
{
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  rmSync(SHIMS, { recursive: true, force: true });
  mkdirSync(SHIMS, { recursive: true });
  // `npx prisma migrate status` : succes simule (l'etape suivante doit etre atteinte).
  writeFileSync(join(SHIMS, 'npx'), '#!/bin/sh\necho "doublure npx : statut simule"\nexit 0\n');
  // `npm run db:deploy` : echec simule.
  writeFileSync(join(SHIMS, 'npm'), '#!/bin/sh\necho "doublure npm : echec simule du deploiement" >&2\nexit 1\n');
  chmodSync(join(SHIMS, 'npx'), 0o755);
  chmodSync(join(SHIMS, 'npm'), 0o755);
  try {
    if (arbrePropre) eprouver(8, 'db:deploy en echec', 7, 'db:deploy a echoue', {
      env: {
        ...base, DATABASE_URL: urlTest, TF_ATTENDU_SHA: sha,
        PATH: `${SHIMS}:${process.env.PATH}`,
      },
    });
  } finally {
    rmSync(SHIMS, { recursive: true, force: true });
  }
}

// 9. migration exigee non appliquee — verificateur d'identite seul.
eprouver(9, 'migration exigee non appliquee', 5, 'migration exigee appliquee', {
  script: 'scripts/verifier_identite_branche.mjs',
  env: {
    ...base, DATABASE_URL: urlTest,
    TF_EXIGER_MIGRATIONS: '20261231000000_migration_qui_n_existe_pas',
  },
});

// Aucun residu.
if (existsSync(TEMOIN)) { rmSync(TEMOIN, { force: true }); echecs += 1; console.error('  ECHEC temoin non nettoye'); }

console.log('\n' + '-'.repeat(48));
if (echecs) {
  console.error(`Garde-fous : ${echecs} echec(s) sur ${resultats.length} scenario(s).`);
  process.exit(1);
}
const attendus = arbrePropre ? 9 : 6;
if (resultats.length !== attendus) {
  console.error(`Garde-fous : ${resultats.length} scenario(s) joues sur ${attendus} attendus.`);
  process.exit(1);
}
if (!arbrePropre) {
  console.error(`Garde-fous : ${resultats.length} scenarios OK, mais 3 NON JOUES (arbre modifie).`);
  console.error('  Committer puis relancer pour eprouver la revision et l\'echec de deploiement.');
  process.exit(2);
}
console.log(`Garde-fous : OK — ${resultats.length} scenario(s), aucun faux succes.`);
process.exit(0);
