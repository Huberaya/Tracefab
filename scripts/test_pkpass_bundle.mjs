#!/usr/bin/env node
/**
 * Chantier 25 — Le .pkpass produit est une archive ZIP réellement valide.
 *
 * `createPkpassZip()` est un générateur ZIP écrit à la main, sans dépendance npm
 * (« to ensure 100% serverless compatibility »). Un ZIP maison est exactement le
 * genre de code qui casse en silence : Apple rejette alors le pass sans que rien
 * n'échoue côté serveur.
 *
 * Ce test compile et exécute le vrai `generateApplePkpass()`, puis relit l'archive
 * avec un lecteur **indépendant** : en-têtes locaux, répertoire central, EOCD, et
 * un CRC-32 recalculé par une table propia au test — pas `zlib.crc32`, qui est la
 * fonction même employée par le générateur.
 *
 * Exécution : npm run test:pkpass:bundle
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;
const ok = (label) => { checks += 1; console.log(`  ok  ${label}`); };
const fail = (label, detail) => {
  failures += 1;
  checks += 1;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const assert = (condition, label, detail) => (condition ? ok(label) : fail(label, detail));
const eq = (actual, expected, label) =>
  assert(actual === expected, label, `obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options });
    let output = '';
    child.stdout?.on('data', (c) => { output += c; });
    child.stderr?.on('data', (c) => { output += c; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} a échoué (${code})\n${output}`)),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* CRC-32 indépendant : table construite ici, pas zlib.crc32.                  */
/* -------------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0 ^ -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Lecteur ZIP indépendant : en-têtes locaux + répertoire central + EOCD.      */
/* -------------------------------------------------------------------------- */
function readZip(buffer) {
  // EOCD : signature 0x06054b50, cherchée depuis la fin.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD introuvable : ce n’est pas une archive ZIP');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`signature de répertoire central invalide à l'entrée ${i}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // L'en-tête local porte ses propres longueurs : ce sont elles qui cadrent les données.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(raw) : raw;

    entries.push({ name, method, crc, compressedSize, uncompressedSize, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entryCount, entries };
}

/* -------------------------------------------------------------------------- */
console.log('\nA. Compilation et exécution du générateur réel');
/* -------------------------------------------------------------------------- */

await mkdir(join(root, '.cache'), { recursive: true });
const outDir = await mkdtemp(join(root, '.cache', 'pkpass-test-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/wallet/apple-pass-generator.ts', '--outDir', outDir, '--target', 'ES2020',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--skipLibCheck',
    '--esModuleInterop', '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('apple-pass-generator.ts compile sans erreur');
} catch {
  fail('apple-pass-generator.ts ne compile pas');
}

const { generateApplePkpass } = await import(
  pathToFileURL(join(outDir, 'apple-pass-generator.js')).href
);
assert(typeof generateApplePkpass === 'function', 'generateApplePkpass importée du module réel');

const DATA = {
  gtin: '3760123456789',
  productReference: 'AW26-0248',
  productName: 'T-Shirt Coton Bio',
  brandName: 'Tracefab',
  dppUrl: 'https://tracefab.com/dpp/3760123456789',
  digitalLinkUri: 'https://id.tracefab.com/01/3760123456789',
  category: 'T-Shirt',
  materials: [{ name: 'Coton biologique', percentage: 100 }],
  pefGrade: 'C',
  carbonFootprintKgCo2e: 7.4,
};

const bundle = await generateApplePkpass(DATA);
assert(Buffer.isBuffer(bundle), 'le générateur renvoie un Buffer');
assert(bundle.length > 0, `le bundle n'est pas vide (${bundle.length} octets)`);

/* -------------------------------------------------------------------------- */
console.log('\nB. L’archive est une ZIP lisible par un lecteur indépendant');
/* -------------------------------------------------------------------------- */

eq(bundle.readUInt32LE(0), 0x04034b50, 'signature d’en-tête local « PK\\x03\\x04 » en tête de bundle');

const zip = readZip(bundle);
eq(zip.entryCount, 7, 'le répertoire central déclare sept entrées');
eq(zip.entries.length, 7, 'sept entrées effectivement parcourues');

const byName = new Map(zip.entries.map((e) => [e.name, e]));
for (const expected of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png']) {
  assert(byName.has(expected), `l'entrée « ${expected} » est présente`);
}

/* -------------------------------------------------------------------------- */
console.log('\nC. CRC-32 et tailles : recalculés indépendamment');
/* -------------------------------------------------------------------------- */

let crcMismatch = 0;
let sizeMismatch = 0;
for (const entry of zip.entries) {
  const actualCrc = crc32(entry.content);
  if (actualCrc !== entry.crc) {
    crcMismatch += 1;
    console.log(`        ${entry.name} : CRC déclaré ${entry.crc.toString(16)}, recalculé ${actualCrc.toString(16)}`);
  }
  if (entry.content.length !== entry.uncompressedSize) sizeMismatch += 1;
}
eq(crcMismatch, 0, 'tous les CRC-32 déclarés correspondent au contenu décompressé');
eq(sizeMismatch, 0, 'toutes les tailles décompressées annoncées sont exactes');
assert(
  zip.entries.every((e) => e.method === 8),
  'les sept entrées sont compressées (deflate), aucune stockée brute',
);

/* -------------------------------------------------------------------------- */
console.log('\nD. manifest.json : ce qu’Apple vérifie');
/* -------------------------------------------------------------------------- */

const manifest = JSON.parse(byName.get('manifest.json').content.toString('utf8'));
const manifestNames = Object.keys(manifest);
assert(manifestNames.length > 0, `le manifeste liste ${manifestNames.length} fichier(s)`);

let hashMismatch = 0;
for (const [name, declared] of Object.entries(manifest)) {
  const entry = byName.get(name);
  if (!entry) {
    hashMismatch += 1;
    console.log(`        ${name} : listé au manifeste mais absent de l'archive`);
    continue;
  }
  const actual = createHash('sha1').update(entry.content).digest('hex');
  if (actual !== declared) {
    hashMismatch += 1;
    console.log(`        ${name} : SHA-1 déclaré ${declared}, réel ${actual}`);
  }
}
eq(hashMismatch, 0, 'chaque SHA-1 du manifeste correspond au contenu réel');

/* manifest.json et signature ne se hachent pas eux-mêmes. */
assert(!('manifest.json' in manifest), 'le manifeste ne se liste pas lui-même');
assert(!('signature' in manifest), 'la signature n’est pas listée au manifeste');
for (const name of ['pass.json', 'icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png']) {
  assert(name in manifest, `« ${name} » est bien couvert par le manifeste`);
}

/* -------------------------------------------------------------------------- */
console.log('\nE. pass.json : structure attendue par Apple');
/* -------------------------------------------------------------------------- */

const pass = JSON.parse(byName.get('pass.json').content.toString('utf8'));
eq(pass.formatVersion, 1, 'formatVersion vaut 1');
for (const field of ['passTypeIdentifier', 'serialNumber', 'teamIdentifier', 'organizationName', 'description']) {
  assert(
    typeof pass[field] === 'string' && pass[field].length > 0,
    `« ${field} » est une chaîne non vide (${JSON.stringify(pass[field])})`,
  );
}

const STYLES = ['generic', 'eventTicket', 'boardingPass', 'coupon', 'storeCard'];
const present = STYLES.filter((s) => s in pass);
eq(present.length, 1, 'exactement une clé de style de pass est présente');
assert(present[0] === 'storeCard', `le style retenu est ${present[0]}`);
assert(
  Array.isArray(pass.storeCard?.primaryFields) && pass.storeCard.primaryFields.length > 0,
  'le style porte des champs primaires',
);

assert(pass.barcode && typeof pass.barcode.message === 'string', 'un code-barres est défini');
eq(pass.barcode.message, DATA.digitalLinkUri, 'le code-barres pointe sur le Digital Link du produit');
assert(Array.isArray(pass.barcodes) && pass.barcodes.length > 0, 'la forme plurielle « barcodes » est aussi fournie');

/* -------------------------------------------------------------------------- */
console.log('\nF. Le runtime requis est déclaré');
/* -------------------------------------------------------------------------- */

const { readFile } = await import('node:fs/promises');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert(
  Boolean(pkg.engines && pkg.engines.node),
  `package.json déclare engines.node (${pkg.engines?.node})`,
);
/* crc32 de node:zlib est la seule dépendance sensible à la version de Node. */
const generatorSrc = await readFile(join(root, 'api/_lib/wallet/apple-pass-generator.ts'), 'utf8');
assert(generatorSrc.includes("from 'node:zlib'"), 'le générateur importe bien node:zlib');
assert(
  /"node":\s*">=22/.test(JSON.stringify(pkg.engines)),
  'la borne déclarée couvre le runtime vérifié ici (Node 22)',
);

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
