#!/usr/bin/env node
/**
 * Regression du harnais Preview — gardes fail-closed et expurgation.
 *
 * Ce test NE contacte AUCUN service. Il verifie que le harnais de Preview
 * refuse de demarrer sans autorisation explicite, refuse une cle de
 * production, refuse une cible qui n'est pas une Preview, refuse de tourner
 * sans ses variables de test, et expurge correctement ses preuves.
 *
 * Il est executable en CI sans aucun secret : c'est la garantie que le
 * harnais ne deviendra jamais un faux vert.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNAIS = join(HERE, 'test_preview_http_journeys.mjs');
const FAUX_SECRET = 'sk_live_DUMMY_NE_JAMAIS_AFFICHER_123456';

let echecs = 0;
const verifier = (condition, message, detail) => {
  if (condition) console.log(`  ok    ${message}`);
  else { echecs += 1; console.log(`  ECHEC ${message}${detail ? ` — ${detail}` : ''}`); }
};

function lancer(envSuppl, { retirer = [] } = {}) {
  const env = { ...process.env };
  for (const cle of ['TF_PREVIEW_HARNESS', 'CLERK_SECRET_KEY', 'TRACEFAB_STAGING_URL',
    'TF_PREVIEW_USER_ALPHA', 'TF_PREVIEW_USER_BETA', 'TF_VERCEL_BYPASS',
    'TF_PREVIEW_SELFTEST', 'TF_PREVIEW_ALLOWED_HOST', 'NODE_ENV', 'VERCEL_ENV']) delete env[cle];
  for (const cle of retirer) delete env[cle];
  const resultat = spawnSync(process.execPath, [HARNAIS], {
    env: { ...env, ...envSuppl },
    encoding: 'utf8',
    timeout: 20000,
  });
  if (resultat.error) throw resultat.error;
  return { code: resultat.status, sortie: `${resultat.stdout || ''}${resultat.stderr || ''}` };
}

/* 1. Aucun drapeau : aucun appel reseau, refus explicite. */
{
  const r = lancer({});
  verifier(r.code === 3 && /REFUS/.test(r.sortie),
    'sans TF_PREVIEW_HARNESS : REFUS (code 3), aucun parcours lance', `code=${r.code}`);
}

/* 2. Contexte de production : refuse meme avec le drapeau. */
{
  const r = lancer({ TF_PREVIEW_HARNESS: '1', NODE_ENV: 'production' });
  verifier(r.code === 3 && /production/.test(r.sortie),
    'contexte de production refuse (code 3)', `code=${r.code}`);
}

/* 3. Cle sk_live_ : refus sans que la valeur soit journalisee. */
{
  const r = lancer({ TF_PREVIEW_HARNESS: '1', CLERK_SECRET_KEY: FAUX_SECRET });
  verifier(r.code === 3 && /sk_live_/.test(r.sortie) && !r.sortie.includes(FAUX_SECRET),
    'cle de production refusee, valeur JAMAIS journalisee', `code=${r.code}`);
}

/* 4. Auto-verification de l expurgation : 5/5. */
{
  const r = lancer({ TF_PREVIEW_SELFTEST: '1' });
  verifier(r.code === 0 && /SELFTEST : PASS \(5\/5\)/.test(r.sortie),
    'expurgation jeton/cle/URL/UUID + gabarits de chemin (5/5)', `code=${r.code}`);
}

/* 5. Variables de test manquantes : BLOCKED code 2, noms uniquement. */
{
  const r = lancer({ TF_PREVIEW_HARNESS: '1', CLERK_SECRET_KEY: 'sk_test_dummy' });
  const noms = ['TRACEFAB_STAGING_URL', 'TF_PREVIEW_USER_ALPHA', 'TF_PREVIEW_USER_BETA'];
  verifier(r.code === 2 && noms.every((n) => r.sortie.includes(n)) && !r.sortie.includes('sk_test_dummy'),
    'variables manquantes : BLOCKED (code 2), noms sans valeurs', `code=${r.code}`);
}

/* 6. Cible qui n est pas une Preview : refus avant tout appel reseau. */
{
  const r = lancer({
    TF_PREVIEW_HARNESS: '1',
    CLERK_SECRET_KEY: 'sk_test_dummy',
    TRACEFAB_STAGING_URL: 'https://app.tracefab.example',
    TF_PREVIEW_USER_ALPHA: 'alpha@tracefab.test',
    TF_PREVIEW_USER_BETA: 'beta@tracefab.test',
  });
  verifier(r.code === 3 && /hote non autorise/.test(r.sortie),
    'URL non-Preview refusee avant tout appel reseau (code 3)', `code=${r.code}`);
}

/* 7. URL HTTP (non TLS) refusee. */
{
  const r = lancer({
    TF_PREVIEW_HARNESS: '1',
    CLERK_SECRET_KEY: 'sk_test_dummy',
    TRACEFAB_STAGING_URL: 'http://preview.vercel.app',
    TF_PREVIEW_USER_ALPHA: 'alpha@tracefab.test',
    TF_PREVIEW_USER_BETA: 'beta@tracefab.test',
  });
  verifier(r.code === 3 && /HTTPS/.test(r.sortie),
    'cible non HTTPS refusee (code 3)', `code=${r.code}`);
}

console.log(`\n  Gardes du harnais Preview : ${echecs === 0 ? 'TOUTES LES PREUVES REUSSIES' : `${echecs} ECHEC(S)`}`);
process.exit(echecs === 0 ? 0 : 1);
