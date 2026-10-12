#!/usr/bin/env node
/**
 * Preuve de la garde de cible.
 *
 * Une garde qui n'a jamais refuse n'a jamais prouve qu'elle refusait quoi que
 * ce soit. Cette suite exerce les deux sens : ce qui doit passer passe, ce qui
 * doit etre refuse est refuse. Elle verifie aussi que rien de sensible ne
 * sort dans les messages.
 *
 * Aucune connexion n'est ouverte : la classification est une fonction pure.
 * Aucun test n'est pointe vers une base reelle, de production ou non.
 */
import { classifyTarget, describeTarget } from './lib/require-throwaway-db.mjs';

let echecs = 0;
let passes = 0;
const ok = (m) => { passes += 1; console.log(`  ok    ${m}`); };
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const SECRET_PASSWORD = 'motdepasse_qui_ne_doit_jamais_sortir';
const SECRET_HOST = 'ep-secret-123456.eu-central-1.aws.neon.tech';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  for (const k of ['TRACEFAB_ALLOW_NONLOCAL_TEST_DB', 'TRACEFAB_TEST_DB_HOST_ALLOWLIST', 'TRACEFAB_TEST_DB_NAME_ALLOWLIST', 'VERCEL_ENV']) {
    if (!(k in vars)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

console.log('\n  A. ce qui doit etre ACCEPTE');

withEnv({}, () => {
  const v = classifyTarget('postgresql://postgres:postgres@localhost:5432/tracefab_test');
  v.allowed && v.code === 'throwaway_local' ? ok('base jetable locale (localhost)') : ko(`localhost refuse (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@127.0.0.1:5432/anything');
  v.allowed ? ok('base jetable locale (127.0.0.1)') : ko(`127.0.0.1 refuse (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql:///tracefab_test?host=/var/run/postgresql');
  v.allowed ? ok('base jetable locale (socket Unix)') : ko(`socket Unix refuse (${v.code})`);
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'test-db.internal.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget('postgresql://u:p@test-db.internal.example:5432/tracefab_test');
  v.allowed && v.code === 'allowlisted_remote' ? ok('cible distante explicitement autorisee (3 declarations)') : ko(`cible distante autorisee refusee (${v.code})`);
});

console.log('\n  B. ce qui doit etre REFUSE');

withEnv({ VERCEL_ENV: 'production' }, () => {
  const v = classifyTarget('postgresql://postgres:postgres@localhost:5432/tracefab_test');
  !v.allowed && v.code === 'production_context' ? ok('refus en contexte de deploiement de production, meme en local') : ko(`contexte production accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget(`postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/neondb`);
  !v.allowed ? ok('refus d un hote de base managee sans opt-in') : ko('hote manage refuse NON — il a ete accepte');
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'autre-hote.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget(`postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/tracefab_test`);
  !v.allowed && v.code === 'managed_host' ? ok('hote manage refuse meme avec opt-in et autre liste blanche') : ko(`hote manage accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@db.entreprise.example:5432/tracefab_production');
  !v.allowed && v.code === 'production_name' ? ok('nom de base evoquant la production refuse') : ko(`nom de production accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@db.entreprise.example:5432/live');
  !v.allowed ? ok('nom de base « live » refuse') : ko(`nom « live » accepte (${v.code})`);
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'db.entreprise.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget('postgresql://u:p@db.entreprise.example:5432/autre_base');
  !v.allowed && v.code === 'name_not_allowlisted' ? ok('nom de base hors liste blanche refuse') : ko(`nom hors liste accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('ceci n est pas une url');
  !v.allowed && v.code === 'unparseable' ? ok('valeur non analysable refusee') : ko('valeur illisible acceptee');
});
withEnv({}, () => {
  const v = classifyTarget('');
  !v.allowed && v.code === 'missing' ? ok('valeur absente refusee') : ko('valeur vide acceptee');
});
withEnv({}, () => {
  const v = classifyTarget(undefined);
  !v.allowed && v.code === 'missing' ? ok('variable non definie refusee') : ko('variable non definie acceptee');
});

console.log('\n  C. ce qui ne doit JAMAIS sortir dans un message');

withEnv({}, () => {
  const raw = `postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/neondb?sslmode=require`;
  const line = describeTarget('DATABASE_URL', classifyTarget(raw));
  const fuites = [
    ['mot de passe', line.includes(SECRET_PASSWORD)],
    ['hote', line.includes(SECRET_HOST)],
    ['chaine complete', line.includes('postgresql://')],
    ['identifiant', line.includes('neondb_owner')],
  ].filter(([, leaked]) => leaked);
  fuites.length === 0 ? ok('aucune fuite dans le rapport de refus') : ko(`fuite detectee : ${fuites.map(([n]) => n).join(', ')}`);
  line.includes('empreinte=') ? ok('le rapport publie une empreinte correable') : ko('pas d empreinte dans le rapport');
});

console.log(`\n  --------------------------------------------`);
console.log(`  ${passes} verifications passees, ${echecs} echec(s).`);
console.log(`  --------------------------------------------\n`);

if (echecs > 0) process.exit(1);
console.log('  La garde accepte ce qui est jetable et refuse tout le reste.\n');
