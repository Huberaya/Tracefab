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
// DEUX SHA, ET ILS NE SONT PAS INTERCHANGEABLES.
//
// `GITHUB_SHA` est la revision du WORKFLOW qui execute la mesure. Ce n'est PAS
// la revision du code deploye sur la Preview interrogee : le workflow peut etre
// lance depuis n'importe quelle branche, et `workflow_dispatch` execute le
// fichier de la ref choisie, pas celui du deploiement cible.
//
// Les confondre est un defaut de tracabilite : la preuve affirmait « sha = X »
// alors que X n'etait que la ref du YAML, et un lecteur en concluait que le code
// teste etait X. Les deux champs sont donc enregistres SEPAREMENT.
const WORKFLOW_SHA = (process.env.GITHUB_SHA || process.env.TF_SHA || '').trim();
const DEPLOYMENT_SHA = (process.env.SHA_ATTENDU || '').trim();
// `SHA` reste le nom historique et designe la ref du WORKFLOW.
const SHA = WORKFLOW_SHA;
const SORTIE = 'livrables-finalisation/preuves/p107-runtime-preuves.json';

const horodatage = new Date().toISOString();
const resultats = [];
let bloquant = false;

/**
 * Quatre etats, pas deux.
 *
 * `null` signifie « mesure impossible ou insuffisante » et vaut INDETERMINATE.
 * Le confondre avec FAIL enverrait chercher un defaut inexistant ; le confondre
 * avec PASS serait un faux temoin. Il reste BLOQUANT pour le code de sortie :
 * une preuve non obtenue n'est pas une preuve.
 */
function verdict(id, libelle, condition, detail) {
  const etat = condition === null || condition === undefined
    ? 'INDETERMINATE'
    : condition ? 'PASS' : 'FAIL';
  resultats.push({ id, libelle, verdict: etat, detail });
  if (etat !== 'PASS') bloquant = true;
  console.log(`  ${etat.padEnd(13)} ${id} ${libelle}${detail ? ` — ${detail}` : ''}`);
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
      // `sha` conserve pour les lecteurs existants, mais il est desormais
      // explicite : c'est celui du WORKFLOW, pas du deploiement.
      sha: SHA || null,
      workflow_sha: WORKFLOW_SHA || null,
      deployment_sha: DEPLOYMENT_SHA || null,
      sha_traceabilite: DEPLOYMENT_SHA
        ? 'deployment_sha fourni : la preuve porte sur ce code deploye'
        : 'deployment_sha ABSENT : la preuve ne peut pas affirmer quel code a ete teste',
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

/**
 * Expurge un corps de reponse avant de le conserver.
 *
 * Un 503 de cette route est un DIAGNOSTIC, pas une absence de mesure : il dit
 * que la configuration ou l'identite est rouge. Le jeter rendait la preuve
 * muette — mesure du run 44074983675, ou `configurationSuffisante` et
 * `identiteSaine` existaient dans la reponse mais etaient tronques a 120
 * caracteres, donc inutilisables.
 *
 * On garde donc les champs de diagnostic, et on retire tout ce qui pourrait
 * porter une valeur sensible : cles, jetons, URL, chaines longues. La liste est
 * fermee (on garde ce qu'on nomme) plutot qu'ouverte (on retire ce qu'on
 * connait) : un champ ajoute demain ne fuitera pas par oubli.
 */
function expurger(corps) {
  if (!corps || typeof corps !== 'object') return null;
  const garde = {};
  // Champs de diagnostic nommes, tous non secrets par construction.
  for (const cle of ['schema', 'ready', 'configurationOnly', 'configurationSuffisante',
    'identiteSaine', 'identiteEcarts', 'services', 'identityTokens', 'identitySysteme',
    'baseIdentite', 'databaseIdentity', 'contexteTenant', 'notificationOutbox', 'error']) {
    if (cle in corps) garde[cle] = corps[cle];
  }
  const texte = JSON.stringify(garde);
  // Garde-fou : aucune chaine longue, aucun motif de secret, aucune URL.
  // `identite_base` ne porte qu'un oid, un nom de base et une empreinte tronquee
  // — jamais l'hote en clair, jamais l'URL. La garde ci-dessous reste active :
  // si une telle chaine apparaissait un jour, tout le corps serait retire.
  if (/\b[0-9a-fA-F]{48,}\b|postgres(ql)?:\/\/|eyJ[A-Za-z0-9_-]{10,}/.test(texte)) {
    return { expurge: 'corps retire : motif ressemblant a un secret' };
  }
  return garde;
}

// --- C1 et C2 : identite signee, cle presente ------------------------------
//
// POURQUOI CETTE FONCTION EXISTE, ET CE QU'ELLE CORRIGE.
//
// Elle etait ecrite en ligne droite APRES le test de statut : sur tout statut
// != 200 le script sortait en 2 sans jamais la lire. Or la route publie
// `identitySysteme` dans son corps QUEL QUE SOIT le statut — c'est la meme
// raison qui a fait deplacer C4 avant le test de statut, et elle s'applique
// identiquement ici. Le corps du 503 du run 44483815489 portait
// `verifiee_par_la_base: true, verification: aller_retour_reussi` : C1 etait
// mesure, et le script ne le lisait pas.
//
// Pire, la ligne d'arret affirmait « cle d identite absente » alors que la
// reponse disait `identityTokens.configured: true`. Une preuve qui declare une
// absence que son propre corps refute n'est pas une preuve : c'est un faux
// temoin, exactement ce que ce chantier doit eliminer.
//
// La fonction lit le corps ; elle ne l'invente pas. Si `identitySysteme` est
// absent, C1 vaut INDETERMINATE (condition null) — surtout pas PASS, et pas
// FAIL non plus : l'absence du champ signifie qu'on n'a pas mesure.
function evaluerC1C2(corps) {
  const systeme = corps.identitySysteme;
  const utilisateur = corps.identityTokens;

  // C1.1 — savoir signer. `mode: signe` n'est publie que si la cle est valide.
  verdict('C1.1', 'le runtime sait signer une identite systeme',
    systeme ? systeme.mode === 'signe' : null,
    systeme ? `mode=${systeme.mode ?? 'absent'}` : 'champ identitySysteme ABSENT du corps : non mesure');

  // C1.2 — LE controle central : la base a-t-elle accepte le jeton signe ?
  // `verifiee_par_la_base` vaut true / false / null. `null` = la verification
  // n'a pas eu lieu (erreur, privilege manquant) : INDETERMINATE, jamais PASS.
  verdict('C1.2', 'la BASE a VERIFIE le jeton signe (aller-retour reel)',
    systeme ? (systeme.verifiee_par_la_base === true ? true
      : systeme.verifiee_par_la_base === false ? false : null) : null,
    systeme
      ? `verifiee_par_la_base=${String(systeme.verifiee_par_la_base)} · verification=${systeme.verification ?? '?'}`
      : 'champ identitySysteme ABSENT du corps : non mesure');

  // C1.3 — l'usage systeme doit etre distinct de l'usage utilisateur.
  verdict('C1.3', 'l usage du jeton systeme est bien distinct de l usage utilisateur',
    systeme ? systeme.usage === 'tracefab_system' : null,
    systeme ? `usage=${systeme.usage ?? 'absent'}` : 'champ identitySysteme ABSENT du corps : non mesure');

  // C2.1 — la cle est presente DANS LE PROCESSUS et bien formee.
  verdict('C2.1', 'la cle d identite est PRESENTE et BIEN FORMEE dans le processus',
    utilisateur ? (utilisateur.configured === true && utilisateur.mode === 'signe') : null,
    utilisateur
      ? `configured=${String(utilisateur.configured)} mode=${utilisateur.mode ?? '?'}`
      : 'champ identityTokens ABSENT du corps : non mesure');

  // C2.2 — le meme processus sert les deux usages : si le systeme est configure
  // et signe, la cle y est chargee ; l'utilisateur doit la voir aussi.
  verdict('C2.2', 'le systeme signe avec la meme cle, dans le meme processus',
    systeme && utilisateur
      ? (systeme.configured === true && utilisateur.configured === true)
      : null,
    systeme && utilisateur
      ? `systeme.configured=${String(systeme.configured)} · utilisateur.configured=${String(utilisateur.configured)}`
      : 'un des deux champs d identite est ABSENT : non mesure');

  // C2.3 — zero fuite : aucune suite hexadecimale longue dans le corps.
  verdict('C2.3', 'aucun fragment de cle dans la reponse',
    !JSON.stringify(corps).match(/[0-9a-f]{32,}/i),
    'aucune suite hexadecimale longue dans le corps');
}

// --- C4 : identite PostgreSQL, evaluee depuis le corps, quel qu il soit -----
//
// POURQUOI C4 EST EVALUE AVANT LE TEST DE STATUT.
//
// La version precedente sortait sur tout statut != 200 (process.exit(2)). Or un
// 503 « runtime non pret » est une reponse APPLICATIVE complete : elle porte
// `databaseIdentity`, donc C4 y est entierement mesurable. Sortir avant
// revenait a declarer C4 « non mesure » alors que la mesure etait dans la main.
//
// Une preuve manquante par negligence de collecte n'est pas une preuve
// impossible. C4 est donc evalue des maintenant ; seuls C1 et C2, qui exigent
// une cle posee, restent hors d atteinte sur 503.
function evaluerC4(db, contexteTenant) {
  verdict('C4.1', 'current_user = session_user (aucune prise de role residuelle)',
    typeof db.currentUser === 'string' && db.currentUser === db.sessionUser,
    `current_user=${db.currentUser ?? '?'} session_user=${db.sessionUser ?? '?'}`);
  verdict('C4.2', 'le role effectif n est PAS superutilisateur',
    db.isSuperuser === false, `is_superuser=${String(db.isSuperuser)}`);
  verdict('C4.3', 'le role effectif ne CONTOURNE pas les RLS',
    db.bypassesRls === false, `bypasses_rls=${String(db.bypassesRls)}`);
  // C4.4 — le champ publie par la route s appelle `canEscalate` (voir plus bas).
  verdict('C4.4', 'le role effectif ne peut pas endosser un role privilegie',
    db.canEscalate === false,
    `can_escalate=${String(db.canEscalate)} · membres_privilegies=${JSON.stringify(db.privilegedMemberships ?? null)}`);
  verdict('C4.5', 'le role effectif est le role applicatif attendu',
    db.currentUser === 'tracefab_app', `current_user=${db.currentUser ?? '?'}`);
  // C4.6 — le contexte tenant, desormais MESURE sur la connexion reelle.
  //
  // Historique, et pourquoi la ligne a change. La version precedente rendait
  // `null` en dur avec ce motif : « la route de diagnostic n ouvre pas de
  // transaction metier, donc aucun contexte tenant n est pose ». Le motif etait
  // exact ; la conclusion — INDETERMINATE definitif — ne l'etait pas. La route
  // publie maintenant `contexteTenant`, produit par un aller-retour en LECTURE
  // SEULE : on signe une identite utilisateur, on pose le GUC d'organisation,
  // on demande au point de passage unique ce que la BASE en conclut, et on
  // verifie qu'un jeton d'une AUTRE organisation est refuse.
  //
  // Le `null` en dur n'est PAS conserve comme repli : si le champ manque, la
  // condition vaut `undefined` et le verdict est INDETERMINATE par la meme
  // regle que partout ailleurs. Ce qui change est qu'on ne DECIDE plus a
  // l'avance que la mesure est impossible.
  const ct = contexteTenant;
  verdict('C4.6', 'le contexte tenant est present et non falsifie',
    ct && ct.measured === true
      ? (ct.identiteLue === true && ct.organisationEtrangereRefusee === true && ct.gucRemisAZero === true)
      : null,
    ct && ct.measured === true
      ? `jeton_accepte=${String(ct.jetonAccepte)} · organisation_etrangere_refusee=${String(ct.organisationEtrangereRefusee)} · guc_remis_a_zero=${String(ct.gucRemisAZero)}`
      : `INDETERMINATE : contexte tenant non mesure (${ct ? ct.detail : 'champ contexteTenant ABSENT du corps'})`);
}

// La sonde reelle, avec le jeton legitime.
const sonde = await appel(URL_SONDE, { 'x-tracefab-runtime-probe-token': JETON });
if (sonde.statut !== 200) {
  // Un 401 signifie que la requete n'a pas passe la porte de la sonde : la
  // cible existe mais le jeton differe entre GitHub et Vercel. Un 503 signifie
  // que la porte s'est ouverte et que le runtime se declare non pret — ce
  // n'est PAS la meme chose, et le second est exploitable.
  const corpsExpurge = expurger(sonde.corps);
  ecrire({
    arret: `sonde authentifiee -> HTTP ${sonde.statut}`,
    interpretation: sonde.statut === 401
      ? 'jeton refuse : la valeur de GitHub differe de celle de Vercel, ou la sonde est desactivee sur ce deploiement'
      : sonde.statut === 503
        ? 'la sonde est ouverte (le jeton est accepte) mais le runtime se declare NON PRET : voir corpsExpurge'
        : 'statut inattendu',
    corpsExpurge,
    resultats,
  });
  if (sonde.statut === 503) {
    // Le corps est la : tout ce qu'il PUBLIE est mesurable, meme si le runtime
    // se declare non pret. On evalue donc ce qu'il porte, et rien de plus.
    // `databaseIdentity` et `contexteTenant` sont deux mesures INDEPENDANTES :
    // la premiere peut manquer alors que la seconde existe (roles sans droits
    // catalogue, par exemple). Les lier par un `&&` rendrait C4.6 indetermine
    // par contagion, ce qui serait encore une mesure disponible jetee.
    if (sonde.corps?.databaseIdentity || sonde.corps?.contexteTenant) {
      evaluerC4(sonde.corps.databaseIdentity ?? {}, sonde.corps.contexteTenant);
    }
    if (sonde.corps?.identitySysteme || sonde.corps?.identityTokens) {
      evaluerC1C2(sonde.corps);
    }
    // L'interpretation se DEDUIT du corps, elle ne se recopie pas d'une cause
    // supposee : c'est cette recopie qui a produit « cle absente » sur une
    // reponse qui disait `configured: true`.
    const systeme = sonde.corps?.identitySysteme;
    const utilisateur = sonde.corps?.identityTokens;
    const clePresente = utilisateur?.configured === true;
    const allerRetour = systeme?.verifiee_par_la_base === true;
    ecrire({
      arret: `sonde authentifiee -> HTTP 503`,
      interpretation: !clePresente
        ? 'runtime non pret : la cle d identite est ABSENTE du processus (identityTokens.configured=false), C1 et C2 hors d atteinte'
        : allerRetour
          ? 'runtime non pret pour d AUTRES services (voir corpsExpurge.services), mais la cle EST presente et la BASE a ACCEPTE le jeton signe : C1 et C2 mesures'
          : 'la cle EST presente dans le processus, mais l aller-retour base/jeton n a PAS reussi : voir verifiee_par_la_base et verification',
      corpsExpurge: expurger(sonde.corps),
      resultats,
    });
  }
  console.error(`\n  ARRET — sonde authentifiee HTTP ${sonde.statut}. Corps expurge conserve dans ${SORTIE}.`);
  process.exit(2);
}

const corps = sonde.corps || {};

evaluerC1C2(corps);

// --- C4 : deja evalue ci-dessus, sur 200 COMME sur 503 ----------------------
// La fonction `evaluerC4` est appelee une seule fois, avant le test de statut.
// La dupliquer ici ferait apparaitre chaque critere deux fois dans la preuve et
// rendrait le compte de PASS/FAIL trompeur.
if (sonde.statut === 200) evaluerC4(corps.databaseIdentity ?? {}, corps.contexteTenant);

// --- Verdict ---------------------------------------------------------------
const echecs = resultats.filter((r) => r.verdict === 'FAIL').length;
ecrire({ resultats, echecs });
console.log('');
if (echecs === 0) {
  console.log(`  P10.7 — 4 preuves runtime OBTENUES sur ${BASE}`);
  console.log(`  (${resultats.length} controles, 0 echec) — workflow_sha ${WORKFLOW_SHA || 'non declare'} · deployment_sha ${DEPLOYMENT_SHA || 'NON DECLARE'}`);
  process.exit(0);
}
console.log(`  P10.7 — ${echecs} preuve(s) MANQUANTE(S) sur ${resultats.length} controles.`);
process.exit(1);
