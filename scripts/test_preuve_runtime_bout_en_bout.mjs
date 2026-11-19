#!/usr/bin/env node
/**
 * Non-regression : le script de preuve ne conclut jamais sur une cible qu'il
 * n'a pas atteinte, et il distingue trois situations qui ne doivent jamais
 * etre confondues.
 *
 * POURQUOI CE TEST EXISTE — deux defauts reels, pas des hypotheses
 * -----------------------------------------------------------------
 * 1. Le run du SHA a7f34aa a publie une preuve disant « BYPASS is not defined ».
 *    Le script avait raison de refuser de conclure, mais une ReferenceError
 *    ressemblait a un diagnostic valide.
 * 2. La premiere version de CE test dependait du DNS : elle joignait un faux
 *    hote `.vercel.app`. Il passait en local et echouait en CI, parce que le
 *    runner resout le wildcard Vercel et pas l'environnement d'analyse. Un test
 *    hors ligne qui depend du reseau n'est pas un test hors ligne.
 *
 * Le test injecte donc une doublure (scripts/doublure_vercel_p107.mjs) et
 * n'emet AUCUNE requete.
 *
 * Les trois situations viennent de mesures :
 *   sso302 -> la Preview repond 302 vers vercel.com/sso-api (releve du 2026-11-16)
 *   app401 -> l'application refuse une requete sans jeton (contrat de la route)
 *   app200 -> application joignable et jeton accepte (chemin nominal)
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(racine, 'scripts', 'preuve_runtime_p107.mjs');
const doublure = path.join(racine, 'scripts', 'doublure_vercel_p107.mjs');

let echecs = 0;
const verifier = (condition, nom, detail = '') => {
  if (condition) console.log(`  ok    ${nom}`);
  else { console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`); echecs += 1; }
};

/** Lance le script contre la doublure et rend { code, sortie, preuve }. */
const executer = (scenario, env = {}) => new Promise((resolve) => {
  const travail = mkdtempSync(path.join(tmpdir(), 'p107-'));
  const enfant = spawn(process.execPath, [script], {
    cwd: travail,
    env: {
      ...process.env,
      TF_BASE: 'https://preuve-test.vercel.app',
      TF_PREUVE_FETCH_INJECTE: doublure,
      TF_DOUBLURE_SCENARIO: scenario,
      // Aucun jeton par defaut : le chemin « sans jeton » doit etre celui teste.
      TRACEFAB_RUNTIME_PROBE_TOKEN: '',
      VERCEL_AUTOMATION_BYPASS_SECRET: '',
      ...env,
    },
  });
  let sortie = '';
  const capturer = (d) => { sortie += d; };
  enfant.stdout.on('data', capturer);
  enfant.stderr.on('data', capturer);
  enfant.on('close', (code) => {
    let preuve = '';
    try {
      preuve = readFileSync(
        path.join(travail, 'livrables-finalisation', 'preuves', 'p107-runtime-preuves.json'), 'utf8');
    } catch { /* aucune preuve ecrite */ }
    resolve({ code, sortie, preuve });
  });
});

console.log('Script de preuve — bout en bout, hors ligne');

// --- 1. Preview derriere Vercel Authentication ------------------------------
// C'est LE cas du 2026-11-16. Il doit donner un ACCES ABSENT (code 3), jamais
// un echec de C3 : la requete n'atteint pas l'application.
const sso = await executer('sso302');
verifier(sso.code === 3, 'un 302 SSO donne le code « acces absent » (3)', `code ${sso.code}`);
verifier(/INDETERMINE/.test(sso.sortie) || /INACCESSIBLE/.test(sso.preuve),
  'le resultat est nomme indetermine/inaccessible');
verifier(!/"resultats": \[\s*\{\s*"id": "C3\.1"/.test(sso.preuve),
  'aucun verdict C3.1 n est rendu alors que la requete n a pas atteint l application');
verifier(/x-vercel-protection-bypass/.test(sso.preuve + sso.sortie),
  'la voie officielle de contournement est nommee pour l humain');

// --- 2. Application joignable, refus sans jeton -----------------------------
// Ici la requete ATTEINT l'application : le refus est legitime et doit produire
// un verdict C3, pas un indetermine.
const refus = await executer('app401');
verifier(refus.code !== 3, 'un refus applicatif n est pas classe « acces absent »', `code ${refus.code}`);
verifier(/"id": "C3\.1"/.test(refus.preuve), 'un verdict C3.1 est rendu quand l application repond');
verifier(/"verdict": "PASS"/.test(refus.preuve),
  'le refus sans jeton est un PASS du critere, pas un echec',
  refus.preuve.slice(0, 300));

// --- 3. Aucune exception deguisee en diagnostic ----------------------------
// Le defaut de a7f34aa : une ReferenceError ressemblait a une conclusion.
for (const [nom, r] of [['sso302', sso], ['app401', refus]]) {
  verifier(!/\bis not defined\b/.test(r.preuve + r.sortie),
    `aucune ReferenceError deguisee en diagnostic (${nom})`);
}

// --- 3 bis. Un 503 de diagnostic n'est pas une absence de mesure ------------
// Mesure du run 44074983675 : la sonde etait OUVERTE (jeton accepte) mais
// rendait 503, et la preuve ne conservait que 120 caracteres — donc rien
// d'exploitable. Un 503 est un diagnostic : il doit etre conserve, expurge.
// Le 503 survient APRES l'ouverture de la porte : il faut donc un jeton, comme
// dans le cas reel du 2026-11-17 ou `bypass=PRESENT` et le jeton etait present.
const s503 = await executer('app503', { TRACEFAB_RUNTIME_PROBE_TOKEN: 'jeton-de-test-non-secret' });
verifier(s503.code === 2, 'un 503 de diagnostic donne le code d echec de mesure (2)', `code ${s503.code}`);
verifier(/"corpsExpurge"/.test(s503.preuve), 'le corps du 503 est conserve dans la preuve');
verifier(/"configurationSuffisante": false/.test(s503.preuve),
  'le motif est lisible : configurationSuffisante=false',
  s503.preuve.slice(0, 200));
verifier(!/postgres(ql)?:\/\/|\b[0-9a-fA-F]{48,}\b/.test(s503.preuve),
  'aucune chaine ressemblant a un secret dans la preuve du 503');
verifier(/"baseIdentite"/.test(s503.preuve),
  'l etat de la BASE est conserve — l operateur sait si provisionner est utile',
  s503.preuve.slice(0, 160));
verifier(/"table_vue_par_pg_class":\s*true/.test(s503.preuve),
  'le temoin independant pg_class survit lui aussi a l expurgation');
verifier(/"prisma_migrations_presente":\s*true/.test(s503.preuve),
  'le temoin de la base migree survit : il distingue base vide et base migree');
verifier(/"fonction_posterieure_presente":\s*true/.test(s503.preuve),
  'le temoin de positionnement temporel survit : il distingue retard et trou');
verifier(/"hote_empreinte":\s*"0123456789ab"/.test(s503.preuve),
  'l empreinte d hote survit : elle rattache le deploiement a un hote sans le reveler');
verifier(!/postgres(ql)?:\/\//.test(s503.preuve),
  'identite_base ne reconstitue jamais l URL de connexion');

// --- 4. Garde de cible : un runtime local n'est pas une preuve --------------
const locale = await executer('app200', { TF_BASE: 'http://127.0.0.1:3000' });
verifier(locale.code !== 0, 'une cible locale est refusee', `code ${locale.code}`);
verifier(/n'est pas une URL de deploiement Vercel|runtime local/i.test(locale.sortie),
  'le refus nomme la raison');

// --- 5. C4.6 — le contexte tenant, mesure et CONTREDIT -----------------------
//
// Le defaut corrige : C4.6 rendait `null` en dur, au motif que la mesure etait
// impossible. Elle l'etait devenue fausse : la route publie `contexteTenant`.
// Reste a prouver que le verdict SUIT la mesure, dans les deux sens.
const jetonTest = { TRACEFAB_RUNTIME_PROBE_TOKEN: 'jeton-de-test-non-secret' };

const c46ok = await executer('app503-contexte-ok', jetonTest);
verifier(/"C4\.6"[^}]*"verdict":\s*"PASS"/.test(c46ok.preuve),
  'C4.6 rend PASS quand la base accepte le jeton ET refuse l organisation etrangere',
  c46ok.preuve.slice(-400));

const c46faux = await executer('app503-contexte-faux', jetonTest);
verifier(/"C4\.6"[^}]*"verdict":\s*"FAIL"/.test(c46faux.preuve),
  'C4.6 rend FAIL quand la base ACCEPTE un jeton d une autre organisation',
  c46faux.preuve.slice(-400));

const c46nm = await executer('app503-contexte-non-mesure', jetonTest);
verifier(/"C4\.6"[^}]*"verdict":\s*"INDETERMINATE"/.test(c46nm.preuve),
  'C4.6 rend INDETERMINATE quand la mesure a echoue — ni PASS ni FAIL',
  c46nm.preuve.slice(-400));

// Une preuve qui publierait un jeton de contexte en clair serait pire que le
// defaut qu'elle documente. Le corps est expurge, mais on le verifie ici.
verifier(!/[0-9a-f]{64}/.test(c46ok.preuve),
  'aucun jeton signe (64 hex) ne fuit dans la preuve publiee');

// --- 6. L endpoint publie ne peut pas devenir une chaine de connexion -------
//
// P10.8 publie `identite_base.hote` pour rendre le rattachement DECIDABLE :
// une empreinte permet de comparer, jamais de nommer. Ce champ est le seul du
// corps qui vient d'une URL. Une extraction ratee y verserait l utilisateur ou
// le mot de passe, et la preuve expurgee les publierait.
const fuiteUrl = await executer('app503-hote-avec-mot-de-passe', jetonTest);
verifier(/"expurge"/.test(fuiteUrl.preuve),
  'un corps dont l hote contient « user:pass@ » est RETIRE, pas publie',
  fuiteUrl.preuve.slice(-260));
verifier(!/MOTDEPASSE_FACTICE/.test(fuiteUrl.preuve),
  'aucune trace du mot de passe factice dans la preuve');

const hotePropre = await executer('app503-hote-propre', jetonTest);
verifier(/ep-exemple-123\.eu-central-1\.aws\.neon\.tech/.test(hotePropre.preuve),
  'un nom d hote propre est publie tel quel (il est necessaire au rattachement)');

// --- 7. C5 — le rattachement de la base rend un VERDICT ---------------------
//
// Pendant toute la session du 2026-11-19 ce point est reste INDETERMINATE
// faute de pouvoir NOMMER l endpoint. Il est desormais publie et compare. On
// verifie les trois etats, dont le FAIL : un controle qui ne saurait rendre que
// des verts ne rattacherait rien.
const c5ok = await executer('app503-rattachement-ok', jetonTest);
verifier(/"C5\.3"[^}]*"verdict":\s*"PASS"/.test(c5ok.preuve),
  'C5.3 rend PASS quand l endpoint joint est celui declare', c5ok.preuve.slice(-300));

const c5faux = await executer('app503-rattachement-faux', jetonTest);
verifier(/"C5\.3"[^}]*"verdict":\s*"FAIL"/.test(c5faux.preuve),
  'C5.3 rend FAIL quand le deploiement joint un AUTRE hote', c5faux.preuve.slice(-300));

const c5nd = await executer('app503-rattachement-non-declare', jetonTest);
verifier(/"C5\.2"[^}]*"verdict":\s*"INDETERMINATE"/.test(c5nd.preuve),
  'C5.2 rend INDETERMINATE quand aucun endpoint n est declare', c5nd.preuve.slice(-300));
verifier(/"C5\.3"[^}]*"verdict":\s*"INDETERMINATE"/.test(c5nd.preuve),
  'C5.3 rend INDETERMINATE — pas PASS — quand la comparaison n a pas eu lieu');

console.log(echecs === 0 ? '  Bout en bout : OK.' : `  Bout en bout : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
