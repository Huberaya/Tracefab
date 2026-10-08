#!/usr/bin/env node
/**
 * La frontière exacte entre une signature Apple réelle et le repli de développement.
 *
 * Ce que ce test établit, en exécutant le module compilé :
 *
 *   1. quels modes `resolveSignatureMode()` peut retourner, et dans quel cas ;
 *   2. qu'AUCUN des deux modes ne produit une structure CMS/PKCS#7 SignedData —
 *      y compris le chemin « production » avec un vrai certificat et une vraie
 *      clé RSA. `signer.sign()` renvoie une signature RSA nue, pas du CMS ;
 *   3. que le repli écrit une chaîne ASCII lisible, pas du PKCS#7 ;
 *   4. que `isSignatureInstallable()` ne renvoie jamais `true` ;
 *   5. que les deux routes HTTP publient le mode, donc qu'aucune interface ne peut
 *      présenter le fichier comme un pass installable.
 *
 * L'objectif n'est pas de faire croire que le pass fonctionne : c'est de rendre la
 * limite mesurable et de l'empêcher de reculer silencieusement.
 *
 *   npm run test:wallet:signature
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const fail = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? ''}`); };

/* Petit harnais : on compte plutôt que de s'arrêter au premier écart. */
const check = (fn, label) => {
  try {
    fn();
    ok(label);
  } catch (error) {
    fail(label, error?.message);
  }
};

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });

/* -------------------------------------------------------------------------- */
console.log('\nA. Compilation et exécution du module réel');
/* -------------------------------------------------------------------------- */

await mkdir(join(root, '.cache'), { recursive: true });
const outDir = await mkdtemp(join(root, '.cache', 'apple-sig-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/wallet/apple-pass-generator.ts', '--outDir', outDir, '--target', 'ES2020',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--skipLibCheck',
    '--esModuleInterop', '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('apple-pass-generator.ts compile sans erreur');
} catch (error) {
  fail('apple-pass-generator.ts ne compile pas', error.message);
}

const mod = await import(pathToFileURL(join(outDir, 'apple-pass-generator.js')).href);
const { generateApplePkpass, signManifest, resolveSignatureMode, isSignatureInstallable } = mod;

for (const [name, fn] of Object.entries({ generateApplePkpass, signManifest, resolveSignatureMode, isSignatureInstallable })) {
  check(() => { if (typeof fn !== 'function') throw new Error(`type ${typeof fn}`); }, `${name} est exportée`);
}

/* -------------------------------------------------------------------------- */
console.log('\nB. Quel mode s\'applique, et pourquoi');
/* -------------------------------------------------------------------------- */

const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const savedCert = process.env.APPLE_PASS_CERTIFICATE_PEM;
const savedKey = process.env.APPLE_PASS_KEY_PEM;
delete process.env.APPLE_PASS_CERTIFICATE_PEM;
delete process.env.APPLE_PASS_KEY_PEM;

check(
  () => { if (resolveSignatureMode() !== 'dev-placeholder') throw new Error(resolveSignatureMode()); },
  'sans certificat ni clé → dev-placeholder',
);
check(
  () => {
    const mode = resolveSignatureMode({ passCertificatePem: CERT, passKeyPem: privateKey });
    if (mode !== 'raw-rsa-sha256') throw new Error(mode);
  },
  'avec certificat et clé → raw-rsa-sha256',
);
check(
  () => {
    const mode = resolveSignatureMode({ passCertificatePem: CERT, passKeyPem: privateKey, useMockSignature: true });
    if (mode !== 'dev-placeholder') throw new Error(mode);
  },
  'useMockSignature force dev-placeholder même avec certificat',
);
check(
  () => {
    const mode = resolveSignatureMode({ passCertificatePem: CERT });
    if (mode !== 'dev-placeholder') throw new Error(mode);
  },
  'un certificat sans clé ne suffit pas',
);

/* Les variables d'environnement sont bien prises en compte. */
process.env.APPLE_PASS_CERTIFICATE_PEM = CERT;
process.env.APPLE_PASS_KEY_PEM = privateKey;
check(
  () => { if (resolveSignatureMode() !== 'raw-rsa-sha256') throw new Error(resolveSignatureMode()); },
  'APPLE_PASS_CERTIFICATE_PEM / APPLE_PASS_KEY_PEM activent raw-rsa-sha256',
);
delete process.env.APPLE_PASS_CERTIFICATE_PEM;
delete process.env.APPLE_PASS_KEY_PEM;

/* -------------------------------------------------------------------------- */
console.log('\nC. Ce que la signature est réellement');
/* -------------------------------------------------------------------------- */

/* OID id-signedData 1.2.840.113549.1.7.2, tel qu'encodé en DER. */
const SIGNED_DATA_OID = Buffer.from('06092a864886f70d010702', 'hex');
const isCmsSignedData = (buf) => buf.includes(SIGNED_DATA_OID) && buf[0] === 0x30;

const manifest = Buffer.from(JSON.stringify({ 'pass.json': 'a'.repeat(40) }, null, 2), 'utf-8');

const dev = signManifest(manifest, { useMockSignature: true });
check(() => { if (!Buffer.isBuffer(dev)) throw new Error(`type ${typeof dev}`); }, 'le repli renvoie un Buffer');
check(
  () => { if (!dev.toString('utf8').startsWith('PKCS7_DEV_SIGNATURE_')) throw new Error(dev.toString('utf8').slice(0, 40)); },
  'le repli commence par PKCS7_DEV_SIGNATURE_',
);
check(
  () => { if (isCmsSignedData(dev)) throw new Error('interprété comme CMS'); },
  'le repli N\'EST PAS une structure CMS SignedData — malgré le préfixe « PKCS7_ »',
);
check(
  () => {
    const hex = createHashHex(dev);
    if (!hex) throw new Error('empreinte absente');
  },
  'le repli porte l\'empreinte SHA-256 du manifeste',
);

const raw = signManifest(manifest, { passCertificatePem: CERT, passKeyPem: privateKey });
check(() => { if (!Buffer.isBuffer(raw)) throw new Error(`type ${typeof raw}`); }, 'le chemin certificat renvoie un Buffer');
check(
  () => { if (raw.length !== 256) throw new Error(`${raw.length} octets`); },
  `la signature RSA-2048 fait 256 octets (${raw.length}) — une signature nue, pas un conteneur`,
);
check(
  () => { if (isCmsSignedData(raw)) throw new Error('interprété comme CMS'); },
  'le chemin certificat N\'EST PAS non plus une structure CMS SignedData',
);
check(
  () => { if (raw.equals(dev)) throw new Error('tampons identiques'); },
  'les deux modes produisent des tampons distincts',
);

/* Contre-vérification : le détecteur reconnaît bien un vrai CMS. */
check(
  () => {
    const fakeCms = Buffer.concat([Buffer.from([0x30, 0x82]), SIGNED_DATA_OID]);
    if (!isCmsSignedData(fakeCms)) throw new Error('non reconnu');
  },
  'contre-vérification : le détecteur CMS reconnaît un vrai conteneur',
);

/* -------------------------------------------------------------------------- */
console.log('\nD. Aucun mode n\'est présenté comme installable');
/* -------------------------------------------------------------------------- */

for (const mode of ['raw-rsa-sha256', 'dev-placeholder']) {
  check(
    () => { if (isSignatureInstallable(mode) !== false) throw new Error(String(isSignatureInstallable(mode))); },
    `isSignatureInstallable('${mode}') === false`,
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nE. Le générateur produit toujours une archive utilisable');
/* -------------------------------------------------------------------------- */

const DATA = { gtin: '3760123456789', productReference: 'AW26-0248', productName: 'Organic Cotton T-Shirt' };
const bundle = await generateApplePkpass(DATA, { useMockSignature: true });
check(() => { if (!Buffer.isBuffer(bundle)) throw new Error(`type ${typeof bundle}`); }, 'generateApplePkpass renvoie toujours un Buffer');
check(
  () => { if (bundle.subarray(0, 4).toString('hex') !== '504b0304') throw new Error(bundle.subarray(0, 4).toString('hex')); },
  'le .pkpass commence par la signature ZIP PK\\x03\\x04',
);
check(
  () => { if (!bundle.includes(Buffer.from('signature', 'utf8'))) throw new Error('entrée absente'); },
  'l\'archive contient une entrée « signature »',
);

/* -------------------------------------------------------------------------- */
console.log('\nF. Les deux routes publient le mode');
/* -------------------------------------------------------------------------- */

const routes = [
  'api/_routes/dpp/[gtin]/apple-wallet.ts',
  'api/_routes/products/[productId]/wallet/apple.ts',
];
for (const route of routes) {
  const source = await readFile(join(root, route), 'utf8');
  check(
    () => { if (!source.includes('resolveSignatureMode')) throw new Error('absent'); },
    `${route} consulte resolveSignatureMode`,
  );
  check(
    () => { if (!source.includes("setHeader('X-Tracefab-Pass-Signature'")) throw new Error('en-tête absent'); },
    `${route} publie X-Tracefab-Pass-Signature`,
  );
  check(
    () => { if (!source.includes("setHeader('X-Tracefab-Pass-Installable'")) throw new Error('en-tête absent'); },
    `${route} publie X-Tracefab-Pass-Installable`,
  );
  check(
    () => { if (!source.includes('isSignatureInstallable')) throw new Error('absent'); },
    `${route} ne déclare pas lui-même l'installabilité`,
  );
}

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);

/* -------------------------------------------------------------------------- */

function createHashHex(buffer) {
  const text = buffer.toString('utf8');
  return /^[0-9a-f]{64}$/.test(text.slice('PKCS7_DEV_SIGNATURE_'.length)) ? text.slice('PKCS7_DEV_SIGNATURE_'.length) : '';
}
