#!/usr/bin/env node
/**
 * Le dossier de securite dit la verite sur les tiers, et ne contient aucun
 * engagement laisse a blanc.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le dossier remis aux acheteurs comportait quatre lignes vides — adresse de
 * signalement, delai d'accuse, delai de notification, liste des
 * sous-traitants — avec la mention « a preciser avant diffusion ». Ce sont les
 * quatre premieres questions d'un DPO.
 *
 * Et la liste des sous-traitants, ecrite de memoire, etait incomplete :
 * elle omettait Google Fonts et jsDelivr, deux services que le navigateur du
 * visiteur appelle directement et auxquels il transmet donc son adresse IP.
 * Elle omettait aussi Apple Wallet et Google Wallet.
 *
 * Le dossier declarait par ailleurs la limitation de debit « absente » et la
 * presentait comme l'exposition principale du produit, alors qu'elle etait
 * implementee et appliquee dans le routeur. Un dossier de securite perime se
 * trompe dans les deux sens, et les deux coutent cher : l'un fait promettre ce
 * qui n'existe pas, l'autre fait perdre une vente pour un defaut repare.
 *
 * Ce test verifie que le document reste aligne sur le code, pas sur le
 * souvenir qu'on en a.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOSSIER = 'docs/commercial/dossier-securite.md';

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const texte = readFileSync(join(ROOT, DOSSIER), 'utf8');

/* --- 1. aucun engagement laisse a blanc ---------------------------------- */
const BLANCS = [/à définir/i, /à préciser/i, /à publier/i, /adresse dédiée/i, /\bTBD\b/, /\bXXX\b/];
const trouves = BLANCS.filter((r) => r.test(texte));
if (trouves.length) {
  ko(`${trouves.length} engagement(s) laisse(s) a blanc : ${trouves.map(String).join(', ')}`);
} else {
  ok('aucun engagement laisse a blanc');
}

/* --- 2. les engagements chiffres sont presents --------------------------- */
for (const [quoi, motif] of [
  ['adresse de signalement', /security@[a-z0-9.-]+/i],
  ['delai d accuse de reception', /accusé de réception\s*\|\s*[^|]*\d/i],
  ['delai de notification d incident', /notification d'incident[^|]*\|\s*[^|]*\d+\s*heures/i],
]) {
  if (motif.test(texte)) ok(`${quoi} : engage`);
  else ko(`${quoi} : absent ou non chiffre`);
}

/* --- 3. tout tiers appele par le navigateur figure dans le dossier ------- */
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const csp = (vercel.headers || [])
  .flatMap((h) => h.headers)
  .filter((x) => x.key === 'Content-Security-Policy')
  .map((x) => x.value).join(' ');

const origines = [...new Set((csp.match(/https:\/\/[*a-zA-Z0-9.-]+/g) || [])
  .map((o) => o.replace('https://', '').replace('*.', '')))];

/* Nom sous lequel chaque origine doit apparaitre dans le dossier. */
const NOM = {
  'cdn.jsdelivr.net': 'jsDelivr',
  'fonts.googleapis.com': 'Google Fonts',
  'fonts.gstatic.com': 'Google Fonts',
  'clerk.com': 'Clerk',
  'clerk.accounts.dev': 'Clerk',
  'clerk.dev': 'Clerk',
  'api.clerk.com': 'Clerk',
};

const absents = [];
for (const origine of origines) {
  const nom = NOM[origine];
  if (!nom) { absents.push(`${origine} (aucun nom connu — completer NOM dans ce test)`); continue; }
  if (!texte.includes(nom)) absents.push(`${origine} -> « ${nom} » absent du dossier`);
}
if (absents.length) {
  ko(`${absents.length} origine(s) autorisee(s) par la CSP et non declaree(s) :`);
  absents.forEach((a) => console.log(`         ${a}`));
} else {
  ok(`${origines.length} origine(s) autorisee(s) par la CSP, toutes declarees`);
}

/* --- 4. tout service appele par le serveur figure dans le dossier -------- */
const sourcesApi = execSync('git ls-files "api/**/*.ts"', { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');

const SERVICES = [
  [/RESEND_API_KEY/, 'Resend'],
  [/CLERK_SECRET_KEY/, 'Clerk'],
  [/DATABASE_URL/, 'Neon'],
  [/APPLE_PASS_/, 'Apple Wallet'],
  [/GOOGLE_WALLET_/, 'Google Wallet'],
  [/PRIVATE_STORAGE_ANTIVIRUS_URL/, 'antivirus'],
  [/PRIVATE_STORAGE_BUCKET/, 'Stockage objet'],
];
const oublies = SERVICES
  .filter(([motif]) => motif.test(sourcesApi))
  .filter(([, nom]) => !new RegExp(nom, 'i').test(texte))
  .map(([, nom]) => nom);

if (oublies.length) {
  ko(`service(s) appele(s) par l API et absent(s) du dossier : ${oublies.join(', ')}`);
} else {
  ok(`${SERVICES.length} service(s) serveur verifie(s), tous declares`);
}

/* --- 5. le dossier ne declare pas absent un controle qui existe ---------- */
const limiteurExiste = /applyHeaders|evaluate/.test(
  readFileSync(join(ROOT, 'api/index.ts'), 'utf8'),
);
const dossierDitAbsent = /Limitation de débit[^|]*\|\s*\*{0,2}Absente/i.test(texte);
if (limiteurExiste && dossierDitAbsent) {
  ko('le dossier declare la limitation de debit absente alors qu elle est appliquee '
    + 'dans le routeur — un dossier perime se trompe aussi en sa defaveur');
} else {
  ok('aucun controle en place n est declare absent');
}

console.log();
if (echecs) {
  console.log(`${echecs} probleme(s). Ce document est remis a des acheteurs : il engage.`);
  process.exit(1);
}
console.log('Le dossier de securite est aligne sur le code.');
