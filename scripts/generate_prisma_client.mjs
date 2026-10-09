#!/usr/bin/env node
/**
 * Génère le client Prisma SANS binaries.prisma.sh.
 *
 * POURQUOI
 *   `prisma generate` télécharge un binaire natif `schema-engine`. Sans accès à
 *   binaries.prisma.sh, la commande échoue et `@prisma/client` reste un
 *   placeholder : `new PrismaClient()` lève « did not initialize yet », donc
 *   `api/_lib/prisma.ts` lève à l'import et aucune route ne peut démarrer.
 *
 * COMMENT
 *   1. Le schéma est compilé par le moteur Prisma en WASM (`@prisma/prisma-schema-wasm`),
 *      publié sur le registre npm public dans la même version de moteur.
 *   2. Le DMMF obtenu est passé au générateur officiel `prisma-client-js`,
 *      piloté directement par son protocole JSON-RPC. Ce n'est pas une
 *      réimplémentation du générateur : c'est le générateur de Prisma lui-même,
 *      donc le client produit est celui que produirait `prisma generate`.
 *
 * LE MOTEUR D'EXÉCUTION
 *   Par défaut `engineType` vaut « client » : le compilateur de requêtes WASM
 *   est déjà livré, inliné en base64, dans
 *   `@prisma/client/runtime/query_compiler_bg.<fournisseur>.wasm-base64.js`.
 *   C'est le seul mode qui ne réclame aucun binaire natif.
 *
 *   EN CONTREPARTIE le client exige un adaptateur de pilote à l'instanciation :
 *       new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
 *   Sans adaptateur il lève « Missing configured driver adapter » — ce n'est pas
 *   un défaut de génération, c'est le contrat de ce mode.
 *
 *   `PRISMA_ENGINE_TYPE=library` produit un client classique, mais celui-ci
 *   cherchera un binaire natif à l'exécution.
 *
 * LES DEUX PIÈGES DU PROTOCOLE, déjà payés une fois
 *   - Le générateur répond sur **stderr**, pas sur stdout. Écouter stdout fait
 *     expirer l'appel alors que la réponse est bien arrivée.
 *   - `getManifest` reçoit le générateur **directement** comme paramètre, et
 *     `get_config` renvoie `{ config: { generators, datasources } }` : oublier le
 *     `.config` donne « Cannot read properties of undefined ».
 *
 *   npm run prisma:generate:offline
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  engineHashOf, expectedEngineVersion, getConfig, getDmmf, installedWasmVersion,
  loadSchemaWasm, schemaWasmAvailable, validateSchema,
} from './_lib/prisma-schema-wasm.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);

const fail = (message) => { console.error(`\nÉCHEC — ${message}`); process.exit(1); };

if (!schemaWasmAvailable()) {
  fail(`@prisma/prisma-schema-wasm n'est pas installé.
  à faire : npm install --save-dev @prisma/prisma-schema-wasm@<version de moteur>
  version attendue par le Prisma installé : ${expectedEngineVersion() ?? 'inconnue'}`);
}

const wanted = expectedEngineVersion();
const have = installedWasmVersion();
/* Le commit de moteur est le dernier segment hexadécimal de la version, pas tout
   ce qui suit le premier point : découper sur « . » donnait « 1.1-3.<hash> » et
   déclenchait un avertissement de divergence sur une version parfaitement
   alignée. */
const haveHash = engineHashOf(have);
if (wanted && haveHash && haveHash !== wanted) {
  console.error(`ATTENTION — version de moteur divergente :
  @prisma/engines-version attend ${wanted}
  @prisma/prisma-schema-wasm fournit ${haveHash}
  Le DMMF peut ne pas correspondre au client installé.`);
}

const schemaPath = at('prisma/schema.prisma');
const prismaSchema = await readFile(schemaPath, 'utf8');

/* Valider AVANT de générer : un schéma invalide fait échouer get_dmmf avec un
   trap WASM peu lisible, alors que validate renvoie le message de Prisma. */
const verdict = validateSchema(prismaSchema);
if (!verdict.ok) fail(`le schéma ne valide pas :\n${verdict.errors}`);
console.log('schéma validé par le moteur Prisma (WASM)');

const dmmf = getDmmf(prismaSchema);
console.log(`DMMF : ${dmmf.datamodel.models.length} modèles, ${dmmf.datamodel.enums.length} enums`);

const config = getConfig(prismaSchema);
const generator = config.generators.find((g) => g.provider.value === 'prisma-client-js');
if (!generator) fail('aucun bloc generator « prisma-client-js » dans le schéma');

/*
 * Le schéma ne précise pas `output`, donc get_config renvoie null — et le
 * générateur lève sur `parseEnvValue(null)`. Prisma résout normalement cette
 * valeur lui-même ; on fournit sa cible par défaut.
 */
const output = process.env.PRISMA_CLIENT_OUTPUT || at('node_modules/.prisma/client');
generator.output = { fromEnvVar: null, value: output };

const engineType = process.env.PRISMA_ENGINE_TYPE || 'client';
generator.config = { ...(generator.config || {}), engineType };

const clientPkg = require('@prisma/client/package.json');
const generatorBin = at('node_modules/@prisma/client/generator-build/index.js');

const child = spawn(process.execPath, [generatorBin], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PRISMA_CLIENT_ENGINE_TYPE: engineType },
});

let buffer = '';
const pending = new Map();
const onLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try { message = JSON.parse(trimmed); } catch { console.error(trimmed); return; }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
/* Les réponses arrivent sur stderr ; stdout ne porte que du journal. */
child.stderr.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    onLine(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
  }
});
child.stdout.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code) => {
  for (const [, reject] of pending) reject(new Error(`le générateur a quitté (code ${code})`));
  pending.clear();
});

const send = (id, method, params) => new Promise((resolveCall, rejectCall) => {
  const timer = setTimeout(() => rejectCall(new Error(`expiration du délai sur ${method}`)), 180000);
  pending.set(id, (message) => {
    clearTimeout(timer);
    if (message.error) {
      rejectCall(new Error(`${method} : ${message.error.message ?? JSON.stringify(message.error)}`));
    } else resolveCall(message.result);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

try {
  await send(1, 'getManifest', generator);
  await send(2, 'generate', {
    generator,
    otherGenerators: [],
    schemaPath,
    datamodel: prismaSchema,
    dmmf,
    datasources: config.datasources,
    /* Le générateur lit binaryPaths pour lister les cibles ; en mode « client »
       il n'y en a aucune, mais la clé doit exister. */
    binaryPaths: { queryEngine: {}, libqueryEngine: {} },
    envPaths: { rootEnvPath: at('.env'), schemaEnvPath: at('prisma/.env') },
    version: clientPkg.version,
    typedSql: [],
  });
} catch (e) {
  child.kill();
  fail(e.message);
}
child.stdin.end();

console.log(`\nSUCCÈS — client Prisma ${clientPkg.version} écrit dans ${output}`);
console.log(`  engineType : ${engineType}${engineType === 'client'
  ? ' (adaptateur de pilote obligatoire à l\'instanciation)' : ''}`);
