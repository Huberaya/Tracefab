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
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { construireEntetes, creerExpurgateur, gabarit, classifierProtection,
  validerOriginePreview, validerUrlStockage, eicarTestBytes, attendreExpirationMs } from './lib/preview_harness_safety.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNAIS = join(HERE, 'test_preview_http_journeys.mjs');
const SONDE = join(HERE, 'probe_preview_protection.mjs');
const FAUX_SECRET = 'sk_live_DUMMY_NE_JAMAIS_AFFICHER_123456';
// Fixtures purement locales : jamais envoyees sur le reseau.
const TEST_ORIGIN = 'https://tracefab-git-arena-fixture-example.vercel.app';
const TEST_SHA = 'a'.repeat(40);
const ENV_TEST = {
  TF_PREVIEW_HARNESS: '1', CLERK_SECRET_KEY: 'sk_test_dummy',
  TRACEFAB_STAGING_URL: TEST_ORIGIN, TF_PREVIEW_EXPECTED_ORIGIN: TEST_ORIGIN,
  TF_PREVIEW_STORAGE_HOST: 'storage.example.test', TF_PREVIEW_TEST_ENV_CONFIRMED: '1',
  TF_PREVIEW_DEPLOYED_SHA: TEST_SHA, TF_PREVIEW_CODE_SHA: TEST_SHA,
  TF_VERCEL_BYPASS: 'bypass-fixture', TF_PREVIEW_USER_ALPHA: 'alpha@tracefab.test',
  TF_PREVIEW_USER_BETA: 'beta@tracefab.test',
  TF_PREVIEW_ORG_ALPHA: '123e4567-e89b-12d3-a456-426614174000',
  TF_PREVIEW_ORG_BETA: '123e4567-e89b-12d3-a456-426614174001',
};

let echecs = 0;
const verifier = (condition, message, detail) => {
  if (condition) console.log(`  ok    ${message}`);
  else { echecs += 1; console.log(`  ECHEC ${message}${detail ? ` — ${detail}` : ''}`); }
};

function lancer(envSuppl, { retirer = [] } = {}) {
  const env = { ...process.env };
  for (const cle of ['TF_PREVIEW_HARNESS', 'CLERK_SECRET_KEY', 'TRACEFAB_STAGING_URL',
    'TF_PREVIEW_USER_ALPHA', 'TF_PREVIEW_USER_BETA', 'TF_VERCEL_BYPASS',
    'TF_PREVIEW_SELFTEST', 'TF_PREVIEW_ALLOWED_HOST', 'TF_PREVIEW_EXPECTED_ORIGIN',
    'TF_PREVIEW_STORAGE_HOST', 'TF_PREVIEW_TEST_ENV_CONFIRMED', 'TF_PREVIEW_DEPLOYED_SHA',
    'TF_PREVIEW_CODE_SHA', 'TF_PREVIEW_ORG_ALPHA', 'TF_PREVIEW_ORG_BETA',
    'TF_PREVIEW_EVIDENCE', 'GITHUB_SHA', 'NODE_ENV', 'VERCEL_ENV']) delete env[cle];
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
  verifier(r.code === 0 && /SELFTEST : PASS \(6\/6\)/.test(r.sortie),
    'expurgation jeton/cle/URL/UUID/bypass + gabarits (6/6)', `code=${r.code}`);
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
  const r = lancer({ ...ENV_TEST, TRACEFAB_STAGING_URL: 'https://app.tracefab.example',
    TF_PREVIEW_EXPECTED_ORIGIN: 'https://app.tracefab.example' });
  verifier(r.code === 3 && /preview_origin_not_branch_alias/.test(r.sortie),
    'URL non-Preview refusee avant tout appel reseau (code 3)', `code=${r.code}`);
}

/* 7. URL HTTP (non TLS) refusee. */
{
  const r = lancer({ ...ENV_TEST, TRACEFAB_STAGING_URL: 'http://preview.vercel.app' });
  verifier(r.code === 3 && /HTTPS/.test(r.sortie),
    'cible non HTTPS refusee (code 3)', `code=${r.code}`);
}


/* ---------------------------------------------------------------------------
 * Regression du defaut de securite corrige : le harnais envoyait le secret de
 * bypass Vercel (et potentiellement le jeton Clerk) aux URL presignees S3/R2.
 * Une origine tierce ne doit recevoir NI bypass, NI jeton, NI locataire.
 * ------------------------------------------------------------------------- */
{
  const BYPASS_TEST = 'BYPASS_TEST_VALUE_987654321';
  const internes = construireEntetes({
    jeton: 'jwt.test.value', organisation: 'org-test', bypass: BYPASS_TEST,
  });
  verifier(internes['x-vercel-protection-bypass'] === BYPASS_TEST
    && internes.Authorization === 'Bearer jwt.test.value'
    && internes['X-Tracefab-Organization-Id'] === 'org-test',
  'requete interne : bypass, jeton et locataire sont bien portes');

  const externes = construireEntetes({
    externe: true,
    bypass: BYPASS_TEST,
    entetes: {
      'Content-Type': 'text/plain',
      'x-vercel-protection-bypass': BYPASS_TEST,
      Authorization: 'Bearer jwt.test.value',
      'X-Tracefab-Organization-Id': 'org-test',
    },
  });
  const valeursExternes = JSON.stringify(externes);
  verifier(externes['Content-Type'] === 'text/plain'
    && !valeursExternes.includes(BYPASS_TEST)
    && !valeursExternes.includes('Bearer')
    && !valeursExternes.includes('org-test')
    && !('x-vercel-protection-bypass' in externes)
    && !('x-vercel-set-bypass-cookie' in externes),
  'URL presignee : NI secret de bypass NI jeton NI locataire (fuite corrigee)');

  let refuse = false;
  try { construireEntetes({ externe: true, jeton: 'jwt.test.value' }); } catch { refuse = true; }
  verifier(refuse, 'URL presignee + jeton explicite : refuse par construction');

  const expurgerTest = creerExpurgateur([BYPASS_TEST]);
  verifier(!expurgerTest(`x-vercel-protection-bypass: ${BYPASS_TEST}`).includes(BYPASS_TEST),
    'expurgateur : valeur de bypass du process retiree litteralement');
  verifier(gabarit('/api/documents/123e4567-e89b-12d3-a456-426614174000/download?X-Amz=abc')
    === '/api/documents/:id/download',
  'gabarit : UUID et query presignee jamais journalises');

  const source = readFileSync(HARNAIS, 'utf8');
  verifier(source.includes('validerUrlStockage(chemin, STORAGE_HOST)')
    && source.includes('externe, jeton: token, organisation: org, entetes, bypass: BYPASS')
    && !source.includes('...entetesCommuns'),
  'harnais : constructeur segrege utilise, aucun spread d en-tetes communs');
}


/* ---------------------------------------------------------------------------
 * Sonde de protection : logique de classification et gardes d'URL.
 * Ce sont des tests UNITAIRES de la sonde, PAS des preuves de Preview.
 * ------------------------------------------------------------------------- */
{
  const protection = classifierProtection({
    statut: 307, lieu: 'vercel.com', typeContenu: 'text/html',
    corps: '<title>Protected Deployment – Vercel</title>',
  });
  verifier(protection.verdict === 'PASS' && protection.pageProtection,
    'classification : redirection Vercel -> protection active (PASS)');

  const application = classifierProtection({
    statut: 200, lieu: '', typeContenu: 'application/json',
    corps: '{"ok":true,"service":"tracefab-api"}',
  });
  verifier(application.verdict === 'FAIL' && application.reponseApplicative,
    'classification : 200 applicatif sans bypass -> FAIL (protection absente)');

  const inclassable = classifierProtection({ statut: 502, lieu: '', typeContenu: 'text/plain', corps: '' });
  verifier(inclassable.verdict === 'BLOCKED',
    'classification : reponse inclassable -> BLOCKED, jamais un faux PASS');

  const sansUrl = spawnSync(process.execPath, [SONDE], {
    env: { ...process.env, TF_PREVIEW_URL: '' }, encoding: 'utf8', timeout: 10000,
  });
  verifier(sansUrl.status === 2, 'sonde sans URL -> BLOCKED (code 2)');

  const mauvaiseUrl = spawnSync(process.execPath, [SONDE], {
    env: { ...process.env, TF_PREVIEW_URL: 'http://exemple.test' }, encoding: 'utf8', timeout: 10000,
  });
  verifier(mauvaiseUrl.status === 3, 'sonde sur cible non-Preview -> REFUS (code 3)');
}


/* Cible, preuve et EICAR : aucune requete ne sort de ce test unitaire. */
{
  verifier(validerOriginePreview(TEST_ORIGIN, TEST_ORIGIN) === TEST_ORIGIN,
    'origine Preview : l alias de branche explicitement approuve est accepte');
  let rejectedProduction = false;
  try { validerOriginePreview('https://tracefab.vercel.app', 'https://tracefab.vercel.app'); }
  catch { rejectedProduction = true; }
  verifier(rejectedProduction, 'origine de production generique refusee meme si elle est approuvee');
  let rejectedMismatch = false;
  try { validerOriginePreview(TEST_ORIGIN, 'https://tracefab-git-arena-other.vercel.app'); }
  catch { rejectedMismatch = true; }
  verifier(rejectedMismatch, 'origine differente de celle approuvee refusee');
  let rejectedQuery = false;
  try { validerOriginePreview(`${TEST_ORIGIN}/?secret=do-not-log`, TEST_ORIGIN); }
  catch { rejectedQuery = true; }
  verifier(rejectedQuery, 'origine avec query refusee (pas de secret dans une URL)');

  const missingAttestation = lancer({ ...ENV_TEST, TF_PREVIEW_TEST_ENV_CONFIRMED: '' });
  verifier(missingAttestation.code === 2 && /TF_PREVIEW_TEST_ENV_CONFIRMED/.test(missingAttestation.sortie),
    'attestation admin manquante -> BLOCKED avant tout reseau');
  const differentSha = lancer({ ...ENV_TEST, TF_PREVIEW_DEPLOYED_SHA: 'b'.repeat(40) });
  verifier(differentSha.code === 3 && /SHA du deploiement/.test(differentSha.sortie),
    'SHA deploye different du code teste -> REFUS avant tout reseau');

  const allowed = validerUrlStockage('https://storage.example.test/bucket/key?signature=fixture', 'storage.example.test');
  verifier(allowed.hostname === 'storage.example.test', 'URL signee HTTPS sur stockage approuve autorisee');
  for (const bad of ['http://storage.example.test/key', 'https://other.example.test/key',
    'https://127.0.0.1/key', 'https://[::1]/key', 'https://user:pass@storage.example.test/key']) {
    let denied = false;
    try { validerUrlStockage(bad, bad.includes('127.0.0.1') ? '127.0.0.1'
      : bad.includes('[::1]') ? '[::1]' : 'storage.example.test'); } catch { denied = true; }
    verifier(denied, 'stockage hors origine approuvee / non HTTPS / local refuse');
  }

  const eicar = eicarTestBytes();
  verifier(eicar.length === 68 && createHash('sha256').update(eicar).digest('hex')
    === '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f',
    'EICAR : 68 octets canoniques et empreinte attendue, aucun contenu affiche');
  const fragment = Buffer.from(['EICAR', '-STANDARD', '-ANTIVIRUS', '-TEST', '-FILE'].join(''));
  verifier(!fragment.equals(eicar), 'le fragment precedemment utilise ne vaut PAS l echantillon EICAR');

  const base64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `x.${base64({ exp: 100 })}.x`;
  verifier(attendreExpirationMs(jwt, 100000) === 7000,
    'expiration JWT : marge de 7 s au-dela de exp');
  let rejectedLongExpiry = false;
  try { attendreExpirationMs(`x.${base64({ exp: 500 })}.x`, 100000); } catch { rejectedLongExpiry = true; }
  verifier(rejectedLongExpiry, 'expiration trop lointaine -> refusee, aucun faux 401');

  const preuvePath = `/tmp/tf-preview-guards-${process.pid}.json`;
  const bloquee = lancer({ TF_PREVIEW_HARNESS: '1', TF_PREVIEW_EVIDENCE: preuvePath });
  let proofOk = false;
  try {
    const preuve = JSON.parse(readFileSync(preuvePath, 'utf8'));
    proofOk = preuve.status === 'BLOCKED' && preuve.exitCode === 2
      && preuve.cas.some((c) => c.cas === 'J8.1' && c.verdict === 'NOT RUN');
    unlinkSync(preuvePath);
  } catch { /* reste en echec */ }
  verifier(bloquee.code === 2 && proofOk,
    'pre-vol bloque : preuve JSON conserve BLOCKED et parcours non executes NOT RUN');
}

/* Un workflow saute ne doit pas acceder a l environnement protege. */
{
  const workflow = parse(readFileSync(join(HERE, '../.github/workflows/preview-http-journeys.yml'), 'utf8'));
  const job = workflow.jobs?.parcours;
  verifier(workflow.on?.push?.branches?.length === 1
    && workflow.on.push.branches[0] === 'arena/647ac97c-tracefab'
    && String(job?.if).includes("github.ref == 'refs/heads/arena/647ac97c-tracefab'")
    && String(job?.if).includes("vars.TF_PREVIEW_PUSH_ENABLED == '1'"),
    'workflow push limite a la branche et desactive sans opt-in admin');
  verifier(job?.environment === 'tracefab-clerk-test'
    && workflow.permissions?.contents === 'read',
    'workflow conserve l environnement protege et permissions minimales');
  verifier(job?.env?.TF_PREVIEW_TEST_ENV_CONFIRMED === '${{ vars.TF_PREVIEW_TEST_ENV_CONFIRMED }}'
    && job?.env?.TF_PREVIEW_DEPLOYED_SHA === '${{ vars.TF_PREVIEW_DEPLOYED_SHA }}',
    'workflow exige attestation test et SHA deploye declares par admin');
  verifier((job?.steps || []).some((step) => String(step.uses || '').startsWith('actions/upload-artifact@')
    && step.with?.path === '/tmp/tf-preview-evidence.json'),
    'workflow conserve uniquement la preuve JSON expurgee');
}

{
  const generic401 = classifierProtection({ statut: 401, typeContenu: 'application/json', corps: '{"error":"unauthorized"}' });
  const thirdPartyRedirect = classifierProtection({ statut: 302, lieu: 'attacker.example', chemin: '/login' });
  const vercelSso = classifierProtection({ statut: 307, lieu: 'vercel.com', chemin: '/sso-api' });
  verifier(generic401.verdict === 'BLOCKED' && thirdPartyRedirect.verdict === 'BLOCKED',
    'un 401 generique ou une redirection tierce ne prouvent pas la protection Vercel');
  verifier(vercelSso.verdict === 'PASS', 'redirection Vercel /sso-api specifique reconnue');
}

console.log(`\n  Gardes du harnais Preview : ${echecs === 0 ? 'TOUTES LES PREUVES REUSSIES' : `${echecs} ECHEC(S)`}`);
process.exit(echecs === 0 ? 0 : 1);
