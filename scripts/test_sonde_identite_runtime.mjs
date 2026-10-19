#!/usr/bin/env node
/**
 * Sonde d'identité du runtime — la requête mesure-t-elle vraiment ce qu'elle
 * prétend mesurer ?
 *
 * Tout le chantier RLS repose sur une affirmation : la connexion applicative
 * utilise un rôle soumis à la RLS. Cette affirmation ne se déduit ni du code ni
 * de la configuration attendue — seul un `current_user` lu sur la connexion
 * réelle le dit. La sonde ajoutée dans api/_lib/readiness-probes.ts sert à
 * produire cette mesure.
 *
 * Ce test ne mesure PAS le runtime. Il vérifie que l'instrument est juste, pour
 * que la mesure prise plus tard sur l'environnement autorisé veuille dire
 * quelque chose. Un instrument faux produit une preuve fausse, et une preuve
 * fausse est pire qu'une absence de preuve : elle se lit comme un feu vert.
 *
 * Trois choses sont vérifiées :
 *
 *   1. La requête est extraite du fichier source, pas recopiée. Si la sonde est
 *      réécrite, le test suit la nouvelle version au lieu de valider une copie
 *      périmée. S'il ne la retrouve plus, il échoue — pas de faux vert.
 *   2. La requête discrimine. Un rôle soumis à la RLS doit rendre
 *      `bypasses_rls = false` et le rôle propriétaire `true`. Une requête qui
 *      renvoie `false` dans les deux cas serait verte et vide de sens.
 *   3. La sonde ne publie rien de sensible : clés du résultat bornées à une
 *      liste blanche, `DATABASE_URL` jamais copié dans le résultat, et la route
 *      interne authentifie AVANT d'appeler la sonde.
 *
 * Sorties : 0 conforme · 1 défaut · 2 prérequis manquant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FICHIER_SONDE = path.join(RACINE, 'api', '_lib', 'readiness-probes.ts');
const FICHIER_ROUTE = path.join(RACINE, 'api', '_routes', 'internal', 'p2-readiness.ts');
const BASE_EPHEMERE = 'tracefab_sonde_identite';
const ROLE_SOUMIS = 'tracefab_sonde_soumis';

let vertes = 0;
let rouges = 0;
const echecs = [];

function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

function sortir(code) {
  console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
  if (echecs.length) console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(code);
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: "sonde d'identité du runtime — justesse de l'instrument",
  exitOnFailure: true,
});

const urlAdmin = process.env.DATABASE_URL;
const hote = (urlAdmin.match(/@([^/:]+)/) || [])[1] ?? 'illisible';
const urlMaintenance = urlAdmin.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

console.log(`\n  base éphémère sur ${hote} — ${BASE_EPHEMERE}`);

/* --- 1. La requête vient du fichier source, pas d'une copie --------------- */

console.log("\n  A. la sonde vérifiée est bien celle du dépôt");

const source = fs.readFileSync(FICHIER_SONDE, 'utf8');
const extrait = source.match(/prisma\.\$queryRaw<IdentityRow\[\]>`\s*([\s\S]*?)\s*`;/);

verifier(
  'la requête de la sonde est retrouvée dans readiness-probes.ts',
  Boolean(extrait),
  'introuvable : le test validerait une copie, pas la sonde',
);
if (!extrait) sortir(1);

const SQL = extrait[1];

const verbesEcriture = [...SQL.matchAll(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|TRUNCATE|COPY|SET\s+ROLE|SECURITY\s+LABEL)\b/gi)];
verifier(
  'la requête ne contient aucun verbe d écriture',
  verbesEcriture.length === 0,
  verbesEcriture.map((m) => m[1]).join(', ') || 'aucun',
);

for (const attendu of ['current_user', 'session_user', 'rolbypassrls', 'rolsuper']) {
  verifier(
    `la requête lit ${attendu}`,
    SQL.toLowerCase().includes(attendu.toLowerCase()),
    'champ absent : la mesure serait incomplète',
  );
}

/* --- 2. La requête discrimine -------------------------------------------- */

console.log('\n  B. la requête discrimine un rôle soumis d un rôle qui contourne');

const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await admin.query(`CREATE DATABASE ${BASE_EPHEMERE}`);
await admin.query(`DROP ROLE IF EXISTS ${ROLE_SOUMIS}`);
await admin.query(
  `CREATE ROLE ${ROLE_SOUMIS} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'epreuve_locale_jetable'`,
);
await admin.end();

const url = urlAdmin.replace(/\/[^/?]+(\?|$)/, `/${BASE_EPHEMERE}$1`);
const urlSoumis = url.replace(/:\/\/[^@]*@/, `://${ROLE_SOUMIS}:epreuve_locale_jetable@`);

async function mesurer(connectionString) {
  const client = new pg.Client({ connectionString, ssl: sslDepuisUrl(connectionString) });
  await client.connect();
  try {
    const r = await client.query(SQL);
    return r.rows[0];
  } finally {
    await client.end();
  }
}

const soumis = await mesurer(urlSoumis);
verifier(
  'sous un rôle soumis, current_user est ce rôle',
  soumis.current_user === ROLE_SOUMIS,
  soumis.current_user,
);
verifier(
  'sous un rôle soumis, bypasses_rls est false',
  soumis.bypasses_rls === false,
  `${soumis.bypasses_rls} — la RLS ne s appliquera pas`,
);
verifier(
  'sous un rôle soumis, is_superuser est false',
  soumis.is_superuser === false,
  `${soumis.is_superuser}`,
);
verifier(
  'session_user et current_user concordent hors SET ROLE',
  soumis.session_user === soumis.current_user,
  `${soumis.session_user} ≠ ${soumis.current_user}`,
);

const proprietaire = await mesurer(url);
verifier(
  'sous le rôle propriétaire, bypasses_rls est true',
  proprietaire.bypasses_rls === true,
  `${proprietaire.bypasses_rls} — la requête ne discrimine pas`,
);
verifier(
  'la sonde rend deux verdicts différents selon le rôle',
  soumis.bypasses_rls !== proprietaire.bypasses_rls
    && soumis.current_user !== proprietaire.current_user,
  'les deux rôles produisent la même mesure : l instrument est aveugle',
);
verifier(
  'la base interrogée est bien la base cible',
  soumis.database === BASE_EPHEMERE,
  soumis.database,
);

/* --- 3. La sonde ne publie rien de sensible ------------------------------ */

console.log('\n  C. périmètre de ce que la sonde expose');

const corpsSonde = source.slice(source.indexOf('export async function probeDatabaseIdentity'));
const blocRetour = corpsSonde.match(/return \{\s*measured: true,([\s\S]*?)\n {4}\};/);

verifier(
  'le bloc de résultat de la sonde est retrouvé',
  Boolean(blocRetour),
  'introuvable : la liste blanche ne peut pas être vérifiée',
);

if (blocRetour) {
  const blanches = new Set([
    'measured', 'currentUser', 'sessionUser', 'database',
    'bypassesRls', 'isSuperuser', 'detail',
  ]);
  const cles = [...blocRetour[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  const horsListe = cles.filter((c) => !blanches.has(c));
  verifier(
    'le résultat ne contient que des clés de la liste blanche',
    horsListe.length === 0,
    horsListe.join(', ') || 'aucune',
  );
}

// DATABASE_URL ne doit servir qu'à décider si la sonde a un sens. Le recopier
// dans le résultat exposerait l'hôte, l'utilisateur et le mot de passe.
const usagesUrl = [...corpsSonde.matchAll(/process\.env\.DATABASE_URL/g)].length;
const copieUrl = /return[\s\S]{0,200}process\.env\.DATABASE_URL/.test(corpsSonde);
verifier(
  'DATABASE_URL n est jamais copié dans le résultat',
  usagesUrl > 0 && !copieUrl,
  copieUrl ? 'la valeur atteint un return' : 'aucun usage, la sonde ne se protège plus de l absence',
);

verifier(
  'le message d erreur de la sonde passe par redact()',
  /redact\(message\)/.test(corpsSonde),
  'un message brut peut contenir la chaîne de connexion',
);

const route = fs.readFileSync(FICHIER_ROUTE, 'utf8');
const lignes = route.split('\n');
const idx = (motif) => lignes.findIndex((l) => l.includes(motif));
const ligneSecret = idx('workerSecretConfigured()');
const ligneAutorise = idx('workerAuthorized(req)');
const ligneSonde = idx('probeDatabaseIdentity()');

verifier(
  'la route appelle la sonde',
  ligneSonde >= 0,
  'sonde jamais appelée depuis la route interne',
);
verifier(
  'la route authentifie avant d appeler la sonde',
  ligneSecret >= 0 && ligneAutorise >= 0 && ligneSonde > ligneAutorise && ligneSonde > ligneSecret,
  `secret L${ligneSecret + 1}, autorisé L${ligneAutorise + 1}, sonde L${ligneSonde + 1}`,
);
verifier(
  'l identité reste opt-in, hors du passage de supervision courant',
  /identity\s*===\s*'1'/.test(route),
  'la sonde tournerait à chaque appel',
);
verifier(
  'aucune route administrative nouvelle n a été créée',
  !/databaseIdentity[\s\S]{0,400}res\.setHeader/.test(route),
  'une réponse directe contournerait la garde',
);

/* --- 4. Désactivée par défaut, et sur les deux branches ------------------- */

console.log('\n  D. désactivée par défaut');

// « Opt-in » ne vaut que si la clé est réellement absente de la réponse par
// défaut, pas seulement si la sonde n'est pas appelée. Les deux branches de la
// route (configurationOnly et live) doivent appliquer la même condition, sinon
// l'une des deux publierait l'identité sans qu'on la demande.
verifier(
  'la condition d activation ne dépend que de identity === 1',
  /const wantIdentity = req\.query\?\.identity === '1';/.test(route),
  'une autre valeur pourrait activer la sonde',
);
verifier(
  'la sonde n est pas appelée quand la condition est fausse',
  /const databaseIdentity = wantIdentity \? await probeDatabaseIdentity\(\) : undefined;/.test(route),
  'appel inconditionnel',
);

const spreads = [...route.matchAll(/\.\.\.\(databaseIdentity \? \{ databaseIdentity \} : \{\}\)/g)];
verifier(
  'les deux branches de réponse propagent l identité sous condition',
  spreads.length === 2,
  `${spreads.length} occurrence(s), attendu 2`,
);

// La route compte quatre retours : deux réponses de garde (503 non configuré,
// 401 non autorisé) qui ne doivent rien publier d'autre qu'un code d'erreur, et
// deux réponses de données (configurationOnly et live) qui doivent toutes deux
// appliquer la condition.
//
// Une première version cherchait le corps par une expression régulière bornée à
// la première accolade fermante. Les réponses de données contiennent un objet
// imbriqué — `{ databaseIdentity }` — la capture s'y arrêtait, et l'assertion
// échouait en annonçant « 2/2 », ce qui était contradictoire. Le découpage par
// `return json(res,` évite de deviner où finit un objet imbriqué.
const morceaux = route.split('return json(res,').slice(1);
const gardes = morceaux.filter((corps) => /error:/.test(corps));
const donnees = morceaux.filter((corps) => !/error:/.test(corps));
verifier(
  'la route compte deux réponses de garde et deux réponses de données',
  gardes.length === 2 && donnees.length === 2,
  `${gardes.length} garde(s), ${donnees.length} donnée(s)`,
);
verifier(
  'les réponses de garde ne publient qu un code d erreur',
  gardes.every((corps) => /^\s*\d+,\s*\{\s*error:/.test(corps)),
  gardes.map((c) => c.trim().split('\n')[0]).join(' | '),
);
verifier(
  'les deux réponses de données propagent l identité sous condition',
  donnees.every((corps) => /\.\.\.\(databaseIdentity \? \{ databaseIdentity \} : \{\}\)/.test(corps)),
  `${donnees.filter((c) => /databaseIdentity \? \{ databaseIdentity \} : \{\}/.test(c)).length}/2`,
);

// La réponse par défaut ne doit contenir aucune clé d'identité.
verifier(
  'aucune clé d identité n est écrite en dur dans la réponse',
  !/currentUser|sessionUser|bypassesRls|isSuperuser/.test(route),
  'une clé publiée hors de la propagation conditionnelle',
);

// L'état « non mesuré » doit être explicite et nul, pas absent : un consommateur
// qui lirait `measured` comme vrai par défaut conclurait à une mesure.
verifier(
  'l état indisponible déclare measured false',
  /IDENTITY_UNAVAILABLE[\s\S]{0,120}measured: false/.test(source),
  'un défaut ambigu pourrait passer pour une mesure',
);
const champsNuls = ['currentUser', 'sessionUser', 'database', 'bypassesRls', 'isSuperuser'];
verifier(
  'l état indisponible ne renseigne aucun champ d identité',
  champsNuls.every((c) => new RegExp(`${c}: null`).test(source)),
  champsNuls.filter((c) => !new RegExp(`${c}: null`).test(source)).join(', ') || 'aucun',
);

/* --- nettoyage ------------------------------------------------------------ */

const nettoyeur = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await nettoyeur.connect();
await nettoyeur.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await nettoyeur.query(`DROP ROLE IF EXISTS ${ROLE_SOUMIS}`);
await nettoyeur.end();
console.log('\n  base éphémère et rôle de test détruits');

sortir(rouges === 0 ? 0 : 1);
