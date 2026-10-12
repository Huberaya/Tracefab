#!/usr/bin/env node
/**
 * Controle du client Prisma — la barriere qui manquait.
 *
 * POURQUOI CE CONTROLE EXISTE
 *
 * `@prisma/client` s'installe avec un repli factice. Tant que
 * `prisma generate` n'a pas tourne, l'import reussit mais la construction
 * leve :
 *
 *     @prisma/client did not initialize yet.
 *     Please run "prisma generate" and try to import it again.
 *
 * C'est le pire des modes de defaillance : l'installation est verte, le
 * deploiement est vert, et la premiere requete qui touche la base tombe. Le
 * 2026-10-12, la production a repondu `internal_error` a toutes les routes de
 * donnees pour cette raison exacte — le module de route ne se chargeait pas.
 *
 * CE QUE CE CONTROLE VERIFIE — ET CE QU'IL NE VERIFIE PAS
 *
 * Il ne verifie pas qu'un dossier ou un fichier existe : le repli factice
 * occupe deja `node_modules/.prisma/client`. Un controle de presence aurait
 * affiche vert sur la panne meme.
 *
 * Il verifie le comportement : le client se construit, et il expose un
 * delegue de modele pour CHAQUE modele declare dans `prisma/schema.prisma`.
 * La liste attendue est derivee du schema, jamais codee en dur — ajouter un
 * modele et oublier de regenerer fait donc echouer ce controle.
 *
 * Aucune connexion n'est ouverte : construire un client ne se connecte pas,
 * et ce script n'emet aucune requete. Une valeur de connexion factice et non
 * routable est fournie uniquement pour satisfaire la resolution de `env()`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_MESSAGE = 'did not initialize yet';

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

// --- 1. Les modeles attendus, lus depuis le schema (jamais en dur).
let expectedModels;
try {
  const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
  expectedModels = [...schema.matchAll(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)]
    .map((match) => match[1])
    .map((name) => name.charAt(0).toLowerCase() + name.slice(1));
} catch (error) {
  console.error(`\n  ECHEC — prisma/schema.prisma illisible : ${error.message}\n`);
  process.exit(1);
}

if (expectedModels.length === 0) {
  console.error('\n  ECHEC — aucun modele lu dans prisma/schema.prisma : le controle serait vide de sens.\n');
  process.exit(1);
}
console.log(`  ${expectedModels.length} modele(s) attendu(s) d apres prisma/schema.prisma`);

// --- 2. Le client se construit-il, ou est-ce encore le repli factice ?
// Une valeur non routable : la construction ne se connecte pas, et aucune
// requete n'est emise par ce script.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://verify_client:unused@127.0.0.1:1/tracefab_verify?sslmode=disable';
}

let PrismaClient;
try {
  ({ PrismaClient } = await import('@prisma/client'));
} catch (error) {
  ko(`import de @prisma/client impossible : ${String(error.message).split('\n')[0]}`);
  console.error('\n  Le paquet deploye ne pourrait charger aucune route de donnees.\n');
  process.exit(1);
}

let client;
try {
  client = new PrismaClient();
} catch (error) {
  const message = String(error.message || '');
  if (message.includes(STUB_MESSAGE)) {
    ko('le client est le repli factice : « prisma generate » n a pas tourne');
    console.error('\n  C est exactement l etat qui produit internal_error en production.');
    console.error('  Executer : npm run db:generate\n');
  } else {
    ko(`construction du client impossible : ${message.split('\n')[0]}`);
  }
  process.exit(1);
}

typeof client.$transaction === 'function'
  ? ok('le client se construit et expose $transaction')
  : ko('le client se construit mais $transaction est absent');

// --- 3. Chaque modele du schema a-t-il son delegue ?
const missing = expectedModels.filter((model) => {
  const delegate = client[model];
  return !delegate || typeof delegate.findMany !== 'function';
});

if (missing.length === 0) {
  ok(`les ${expectedModels.length} delegues de modele sont presents (findMany disponible)`);
} else {
  ko(`${missing.length} delegue(s) manquant(s) : ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}`);
  console.error('\n  Le client genere ne correspond pas a prisma/schema.prisma.');
  console.error('  Executer : npm run db:generate\n');
}

// Le chargement des modules de route (qui importent api/_lib/prisma.ts, en
// TypeScript) n'est pas verifiable par Node seul : c'est le role de
// `npm run test:router-load`, qui s'execute sous tsx et couvre le mode de
// defaillance exact observe en production.

await client.$disconnect?.().catch(() => {});

console.log('\n  --------------------------------------------');
if (echecs > 0) {
  console.log(`  Client Prisma NON conforme : ${echecs} echec(s).`);
  console.log('  --------------------------------------------\n');
  process.exit(1);
}
console.log('  Client Prisma conforme : genere, complet, chargeable.');
console.log('  --------------------------------------------\n');
