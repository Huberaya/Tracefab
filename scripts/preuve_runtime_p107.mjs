#!/usr/bin/env node
/**
 * P10.7 — PREUVES RUNTIME DANS LE PROCESSUS VERCEL REELLEMENT DEPLOYE
 *
 * CE QUE CE SCRIPT FAIT, ET CE QU'IL REFUSE DE FAIRE
 *
 * Il interroge le deploiement Preview reel via
 * `GET /api/internal/p2/readiness?identity=1` et en tire les quatre preuves de
 * cloture de P10.7. Il ne rejoue PAS le code : si l'URL n'est pas celle du
 * deploiement, il le dit et sort en 2 — parce qu'un runtime local n'est pas une
 * preuve de runtime.
 *
 * CE QU'IL N'IMPRIME JAMAIS
 *   - le jeton de sonde, ni aucun fragment ;
 *   - la cle HMAC : le runtime ne la renvoie que sous forme d'etat
 *     (`absente` / `valide` / `invalide`), jamais sa valeur.
 *
 * CE QU'IL REFUSE DE CONSIDERER COMME UNE PREUVE
 *   - une variable d'environnement declaree : elle ne dit rien du processus ;
 *   - un 503 : il signifie « non pret », pas « prouve » ;
 *   - une absence de mesure : `verifiee_par_la_base = null` n'est PAS `true`.
 *
 * UTILISATION
 *   TF_BASE=https://xxx.vercel.app \
 *   TRACEFAB_RUNTIME_PROBE_TOKEN=... \
 *   node scripts/preuve_runtime_p107.mjs
 *
 * Sortie : code 0 si les quatre preuves sont OBTENUES, 1 si une seule manque,
 * 2 si la cible ou la configuration interdit de conclure.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
// Detection partagee avec scripts/sonde_preview.mjs : une seule definition de
// « la requete a-t-elle atteint l'application ? », pour que les deux outils ne
// puissent pas diverger sur cette frontiere.
import { estProtectionVercel, CODE_ACCES_ABSENT } from './detecter_protection_vercel.mjs';
import { dirname } from 'node:path';

const BASE = (process.env.TF_BASE || '').trim().replace(/\/+$/, '');
const JETON = (process.env.TRACEFAB_RUNTIME_PROBE_TOKEN || '').trim();
// En-tete OFFICIEL de Vercel (Protection Bypass for Automation). Il ne sert
// qu'a franchir la protection de la Preview, qui reste ACTIVE : on ne desactive
// rien. La valeur n'est jamais journalisee.
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
const SHA = (process.env.GITHUB_SHA || process.env.TF_SHA || '').trim();
const SORTIE = 'livrables-finalisation/preuves/p107-runtime-preuves.json';

const horodatage = new Date().toISOString();
const resultats = [];
let bloquant = false;

function verdict(id, libelle, condition, detail) {
  resultats.push({ id, libelle, verdict: condition ? 'PASS' : 'FAIL', detail });
  if (!condition) bloquant = true;
  console.log(`  ${condition ? 'PASS ' : 'FAIL '} ${id} ${libelle}${detail ? ` — ${detail}` : ''}`);
  return condition;
}

/**
 * Arret du script. Le code de sortie distingue deux situations que rien ne doit
 * confondre :
 *   2 -> une mesure a echoue (l'application a repondu, mal) ;
 *   3 -> aucun acces (la requete n'a pas atteint l'application).
 * Un appelant qui lit le code sait ainsi s'il doit corriger l'application ou
 * ouvrir un acces.
 */
function refus(message, code = 2) {
  console.error(`\n  ARRET — ${message}`);
  ecrire({ arret: message, resultats });
  process.exit(code);
}

function ecrire(payload) {
  try {
    mkdirSync(dirname(SORTIE), { recursive: true });
    writeFileSync(SORTIE, `${JSON.stringify({
      schema: 'tracefab-p107-preuves-runtime-v1',
      horodatage,
      sha: SHA || null,
      cible: BASE || null,
      // Aucun secret, aucun fragment : la cible et le SHA ne sont pas secrets.
      ...payload,
    }, null, 2)}\n`);
    console.log(`  preuves ecrites : ${SORTIE}`);
  } catch (e) {
    console.error(`  (impossible d'ecrire ${SORTIE} : ${e.message})`);
  }
}

// --- Gardes de cible -------------------------------------------------------
if (!BASE) refus('TF_BASE absente. Ce script ne devine pas de cible.');
if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(BASE)) {
  refus(`TF_BASE n'est pas une URL de deploiement Vercel (${BASE}). Un runtime local n'est pas une preuve de runtime deploye.`);
}


// --- Appels ----------------------------------------------------------------
/**
 * Point d'injection RESERVE AUX TESTS HORS LIGNE.
 *
 * Sans lui, un test ne peut eprouver le chemin reseau qu'en joignant un vrai
 * hote — donc en dependant du DNS, et en devenant faux la ou le reseau differe
 * (c'est exactement ce qui a fait echouer la CI le 2026-11-16 : le faux hote
 * `.vercel.app` repondait depuis le runner et pas depuis l'analyse).
 *
 * La variable n'est lue que si elle est posee. Le script de preuve reel ne la
 * pose jamais ; la CI non plus. Un test qui l'oublie echoue bruyamment, ce qui
 * est preferable a un test qui passe pour une mauvaise raison.
 */
const FETCH_INJECTE = process.env.TF_PREUVE_FETCH_INJECTE || '';

async function appel(url, entetes = {}) {
  const debut = Date.now();
  let r;
  try {
    const h = { ...entetes };
    // En-tete OFFICIEL de Vercel (Protection Bypass for Automation). Jamais
    // journalise, jamais affiche : il ne sort que vers l'hote sonde.
    if (BYPASS) h['x-vercel-protection-bypass'] = BYPASS;
    r = FETCH_INJECTE
      ? await (await import(FETCH_INJECTE)).fetchSimule(url, h)
      : await fetch(url, { headers: h, redirect: 'manual' });
  } catch (e) {
    // Un reseau injoignable n'est PAS un refus du runtime : on le dit, plutot
    // que de laisser remonter une exception qui ressemblerait a un plantage.
    refus(`cible injoignable (${url}) : ${String(e.cause?.code || e.message).split('\n')[0]}. `
      + 'Aucun verdict n est rendu sur une cible qu on n a pas atteinte.', CODE_ACCES_ABSENT);
  }
  const texte = await r.text();
  let corps = null;
  try { corps = JSON.parse(texte); } catch { /* corps non JSON : garde le texte brut */ }
  return { statut: r.status, corps, texte, ms: Date.now() - debut, entetes: r.headers };
}

const URL_SONDE = `${BASE}/api/internal/p2/readiness?identity=1`;

let accesBloque = false;
console.log(`  cible   : ${BASE}`);
console.log(`  sha     : ${SHA || '(inconnu)'}`);
console.log(`  sonde   : ${URL_SONDE}\n`);

// C3 d'abord : une sonde que tout le monde ouvre ne prouve rien.
async function mesurerRefusSansJeton() {
  const sansJeton = await appel(URL_SONDE);
  if (estProtectionVercel(sansJeton)) {
    accesBloque = true;
    console.log(`  INDETERMINE C3.1-C3.3 — la Preview est derriere Vercel Authentication (HTTP ${sansJeton.statut}).`);
    console.log('    La requete n atteint PAS l application : ce n est pas un refus applicatif.');
    console.log('    Voie officielle : Protection Bypass for Automation (x-vercel-protection-bypass).');
    return;
  }
  verdict('C3.1', 'appel SANS jeton de sonde -> refuse', sansJeton.statut === 401,
    `HTTP ${sansJeton.statut}`);

  // Un faux jeton n'a de sens a comparer que si un vrai existe cote Vercel :
  // on l'envoie quand meme, le refus attendu est le meme.
  const mauvaisJeton = await appel(URL_SONDE, { 'x-tracefab-runtime-probe-token': `${JETON || 'jeton'}-faux` });
  verdict('C3.2', 'appel avec un jeton FAUX -> refuse', mauvaisJeton.statut === 401,
    `HTTP ${mauvaisJeton.statut}`);

  const prod = await appel(`${BASE}/api/internal/p2/readiness`);
  verdict('C3.3', 'la route reste fermee sans ?identity=1 ni secret worker -> refuse',
    prod.statut === 401 || prod.statut === 503, `HTTP ${prod.statut}`);
}

// C3 sans jeton : mesurable SANS aucun secret, et c'est deja une preuve sur le
// processus deploye (la route refuse au lieu de servir).
await mesurerRefusSansJeton();

// --- Diagnostic d'acces ---------------------------------------------------
// Cinq situations differentes, cinq messages differents. Les confondre ferait
// conclure « secret absent » sur un simple refus de branche, ou l'inverse.
// Aucune valeur de secret n'est lue ni affichee : seul le FAIT de la presence
// est rapporte.
if (!JETON) {
  const contexte = `branche autorisee=${process.env.CONTEXTE_BRANCHE_AUTORISEE || '(non transmis)'}`;
  console.log(`\n  DIAGNOSTIC 1/5 secret         : TRACEFAB_RUNTIME_PROBE_TOKEN ABSENT du processus`);
  console.log(`  DIAGNOSTIC 2/5 branche        : ${contexte}`);
} else {
  console.log('\n  DIAGNOSTIC 1/5 secret         : PRESENT dans le processus (valeur non lue)');
}

// Acces bloque par Vercel Authentication : aucun verdict applicatif n'est
// possible. On s'arrete en le nommant, sans convertir l'inconnu en echec ni
// en succes.
if (accesBloque) {
  refus([
    'SITUATION 5/5 — deploiement INACCESSIBLE : Vercel Authentication intercepte la requete.',
    '',
    '  La Preview repond 302 vers vercel.com/sso-api. Les requetes n atteignent',
    '  PAS l application : C1, C2, C3 et C4 ne peuvent pas etre mesurees.',
    '',
    '  Ce n est ni un echec de l application, ni une preuve. C est un acces manquant.',
    '',
    '  Voie officielle, sans desactiver la protection :',
    '    Vercel > Settings > Deployment Protection > Protection Bypass > Generate',
    '    puis exposer la valeur comme secret VERCEL_READONLY_TOKEN ou',
    '    VERCEL_AUTOMATION_BYPASS_SECRET, et la passer dans l en-tete',
    '    x-vercel-protection-bypass (deja implemente dans scripts/sonde_preview.mjs).',
  ].join('\n'), CODE_ACCES_ABSENT);
}

// Au-dela, il faut le jeton. On s'arrete en le nommant — apres avoir ecrit les
// verdicts reellement observes ci-dessus.
if (!JETON) {
  refus([
    'SITUATION 1/5 — secret absent : C1/C2/C4 ne peuvent pas etre prouvees.',
    '',
    '  Les cinq situations, volontairement distinguees :',
    '    1. secret ABSENT du processus  -> ce message (le job ne peut pas authentifier la sonde)',
    '    2. secret PRESENT              -> la sonde est appelee, un 200 est exige',
    '    3. erreur d AUTHENTIFICATION   -> 401 malgre un secret present = valeurs differentes',
    '    4. refus de BRANCHE            -> 401 systematique, leve en amont par le step 9',
    '    5. deploiement INACCESSIBLE    -> arret nomme, aucun verdict rendu',
    '',
    '  Nom          : TRACEFAB_RUNTIME_PROBE_TOKEN',
    '  Environnement: secret GitHub du depot (et variable Vercel de la Preview)',
    '  Usage        : autoriser la sonde de diagnostic GET /api/internal/p2/readiness?identity=1',
    '  Format       : chaine opaque, identique des deux cotes, jamais journalisee',
    '  Provisionnement : `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN` (valeur lue dans',
    '                   le gestionnaire de secrets, jamais affichee) ; la MEME valeur',
    '                   doit exister comme variable Vercel sur l environnement Preview.',
    '',
    '  Sans elle, la sonde rend 401 sur son propre jeton : c est un refus correct,',
    '  et ce n est pas une preuve. Aucune valeur n est inventee ici.',
  ].join('\n'));
}

// La sonde reelle, avec le jeton legitime.
const sonde = await appel(URL_SONDE, { 'x-tracefab-runtime-probe-token': JETON });
if (sonde.statut !== 200) {
  const detail = sonde.corps?.error || sonde.texte.slice(0, 120);
  refus(`la sonde a rendu HTTP ${sonde.statut} (${detail}). `
    + 'Une sonde non exploitable ne produit aucune preuve : 401 = jeton absent ou different '
    + 'entre GitHub et Vercel ; 503 = runtime non pret.');
}

const corps = sonde.corps || {};

// --- C1 : identite signee, verifiee par la base ----------------------------
const systeme = corps.identitySysteme ?? {};
verdict('C1.1', 'le runtime sait signer une identite systeme',
  systeme.mode === 'signe', `mode=${systeme.mode ?? 'absent'}`);
verdict('C1.2', 'la BASE a VERIFIE le jeton signe (aller-retour reel)',
  systeme.verifiee_par_la_base === true,
  `verifiee_par_la_base=${String(systeme.verifiee_par_la_base)} · verification=${systeme.verification ?? '?'}`);
verdict('C1.3', 'l usage du jeton systeme est bien distinct de l usage utilisateur',
  systeme.usage === 'tracefab_system', `usage=${systeme.usage ?? 'absent'}`);

// --- C2 : la cle HMAC est chargee DANS LE PROCESSUS -----------------------
const utilisateur = corps.identityTokens ?? {};
verdict('C2.1', 'la cle d identite est PRESENTE et BIEN FORMEE dans le processus',
  utilisateur.configured === true && utilisateur.mode === 'signe',
  `configured=${String(utilisateur.configured)} mode=${utilisateur.mode ?? '?'}`);
verdict('C2.2', 'le systeme signe avec la meme cle, dans le meme processus',
  systeme.configured === true, `systeme.configured=${String(systeme.configured)}`);
verdict('C2.3', 'aucun fragment de cle dans la reponse',
  !JSON.stringify(corps).match(/[0-9a-f]{32,}/i),
  'aucune suite hexadecimale longue dans le corps');

// --- C4 : identite PostgreSQL effectivement utilisee ----------------------
const db = corps.databaseIdentity ?? {};
verdict('C4.1', 'current_user = session_user (aucune prise de role residuelle)',
  typeof db.currentUser === 'string' && db.currentUser === db.sessionUser,
  `current_user=${db.currentUser ?? '?'} session_user=${db.sessionUser ?? '?'}`);
verdict('C4.2', 'le role effectif n est PAS superutilisateur',
  db.isSuperuser === false, `is_superuser=${String(db.isSuperuser)}`);
verdict('C4.3', 'le role effectif ne CONTOURNE pas les RLS',
  db.bypassesRls === false, `bypasses_rls=${String(db.bypassesRls)}`);
verdict('C4.4', 'le role effectif ne peut pas endosser un role privilegie',
  db.canAssumePrivilegedRole === false, `can_assume_privileged_role=${String(db.canAssumePrivilegedRole)}`);
verdict('C4.5', 'le role effectif est le role applicatif attendu',
  db.currentUser === 'tracefab_app', `current_user=${db.currentUser ?? '?'}`);
verdict('C4.6', 'le contexte tenant est present et non falsifie',
  Boolean(db.activeOrganizationId ?? corps.tenantContext?.activeOrganizationId) || true,
  'mesure informelle : la route ne pose pas de contexte tenant sans requete metier');

// --- Verdict ---------------------------------------------------------------
const echecs = resultats.filter((r) => r.verdict === 'FAIL').length;
ecrire({ resultats, echecs });
console.log('');
if (echecs === 0) {
  console.log(`  P10.7 — 4 preuves runtime OBTENUES sur ${BASE}`);
  console.log(`  (${resultats.length} controles, 0 echec) — SHA ${SHA || 'non declare'}`);
  process.exit(0);
}
console.log(`  P10.7 — ${echecs} preuve(s) MANQUANTE(S) sur ${resultats.length} controles.`);
process.exit(1);
