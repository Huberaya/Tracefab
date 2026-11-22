#!/usr/bin/env node
/* ==========================================================================
   Generation du client Prisma SANS acces a binaries.prisma.sh.

   POURQUOI CE SCRIPT EXISTE
   -------------------------
   `prisma generate` commence par telecharger les moteurs (schema-engine,
   query-engine) depuis `binaries.prisma.sh`. Dans un environnement ou ce
   domaine n'est pas joignable, la commande echoue :

       request to https://binaries.prisma.sh/.../schema-engine.gz.sha256
       failed, reason: Client network socket disconnected

   Consequence en cascade : `node_modules/.prisma/client` n'existe pas,
   `@prisma/client` ne peut rien exporter, et `npm run api:typecheck` echoue
   sur des dizaines de « Module '@prisma/client' has no exported member
   'Prisma' » — des erreurs qui ne disent rien du code du depot.

   CE QUE LE SCRIPT FAIT
   ---------------------
   Il court-circuite le telechargement sans court-circuiter la generation :

     1. le DMMF (le modele de donnees compile) est produit par le moteur de
        schema **WASM** embarque dans `@prisma/internals` — donc hors ligne,
        et sans approximation : c'est le meme DMMF qu'en CI ;
     2. le generateur officiel `prisma-client-js`
        (`@prisma/client/generator-build`) est execute via le protocole RPC
        habituel — donc le meme code de generation qu'en CI ;
     3. seuls les BINAIRES de moteur de requete sont omis (`noEngine`), avec
        un chemin factice declare pour que la resolution n'aille pas sur le
        reseau. Le client obtenu est complet **cote types** ; il ne peut pas
        executer de requete, ce qui est exactement le besoin d'un typecheck.

   CE QUE LE SCRIPT NE FAIT PAS
   ----------------------------
   Il ne remplace pas `db:generate` en CI, et il ne verifie pas le runtime :
   un client sans moteur ne peut pas interroger la base. Le typecheck qu'il
   permet de lancer porte sur les types, pas sur le comportement a l'execution.
   Le script refuse de se declarer reussi si le client produit ne contient pas
   les modeles du schema (le generateur ecrit sinon un repli `PrismaClient:
   any` qui ferait passer le typecheck en le vidant de son sens).

   Usage : npm run db:generate:offline
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(root, 'prisma/schema.prisma');
const target = path.join(root, 'node_modules/.prisma/client');

if (!fs.existsSync(schemaPath)) {
  console.error(`ECHEC  schema introuvable : ${schemaPath}`);
  process.exit(1);
}

let internals;
try {
  internals = require('@prisma/internals');
} catch (error) {
  console.error('ECHEC  @prisma/internals introuvable — executer `npm ci`.');
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}

const datamodel = fs.readFileSync(schemaPath, 'utf8');

// Le seul modele dont on verifie la presence dans la sortie : s'il manque,
// c'est que le generateur a ecrit son repli `any` au lieu d'un vrai client.
const PROBE_MODEL = 'tracefab_products';

// Moteur de requete : on declare un chemin qui n'existe pas. `noEngine` empeche
// de le copier ; la resolution, elle, n'essaie plus d'aller sur le reseau.
const enginePlaceholder = path.join(root, 'node_modules/.prisma/engine-absent.so.node');

process.env.PRISMA_GENERATE_SKIP_AUTOINSTALL = 'true';

const generators = await internals.getGenerators({
  schemaPath,
  dataModel: datamodel,
  // Le generateur officiel, celui que `prisma generate` utilise aussi.
  registry: {
    'prisma-client-js': {
      type: 'rpc',
      generatorPath: require.resolve('@prisma/client/generator-build/index.js'),
      isNode: true,
    },
  },
  skipDownload: true,
  noEngine: true,
  binaryPathsOverride: { libqueryEngine: [enginePlaceholder] },
});

if (!generators.length) {
  console.error('ECHEC  aucun generateur trouve dans prisma/schema.prisma');
  process.exit(1);
}

for (const generator of generators) {
  await generator.generate();
  await generator.stop();
}

// Sans `output` explicite, le generateur ecrit a cote du schema
// (`prisma/.prisma/client`) ; `@prisma/client` resout `node_modules/.prisma/client`.
const sideOutput = path.join(root, 'prisma/.prisma/client');
if (fs.existsSync(sideOutput)) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(sideOutput, target);
  try { fs.rmdirSync(path.join(root, 'prisma/.prisma')); } catch { /* non vide : sans importance */ }
}

const typeFile = path.join(target, 'index.d.ts');
if (!fs.existsSync(typeFile)) {
  console.error(`ECHEC  ${path.relative(root, typeFile)} absent apres generation.`);
  process.exit(1);
}

const types = fs.readFileSync(typeFile, 'utf8');
if (!types.includes(PROBE_MODEL)) {
  console.error(
    `ECHEC  le client genere ne contient pas ${PROBE_MODEL} : c'est le repli `
    + '`PrismaClient: any` ecrit par le generateur quand il echoue. Un typecheck '
    + 'lance sur ce fichier ne prouverait rien.',
  );
  process.exit(1);
}

const size = (fs.statSync(typeFile).size / 1024).toFixed(0);
console.log(`Client Prisma genere hors ligne dans ${path.relative(root, target)} (index.d.ts, ${size} Ko).`);
console.log('Types complets, moteur de requete absent : ce client sert au typecheck, pas aux requetes.');
