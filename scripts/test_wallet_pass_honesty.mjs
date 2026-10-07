#!/usr/bin/env node
/**
 * Chantier 20 — Honnêteté du pass Wallet.
 *
 * Un pass Apple/Google Wallet est signé et remis au consommateur. Une valeur
 * environnementale absente doit s'y afficher comme non mesurée : la remplacer par
 * un chiffre de repli transforme une lacune en affirmation mesurée.
 *
 * Ce test compile et exécute les DEUX générateurs réels, sans base de données :
 *   A. données trouées  -> aucune valeur inventée, aucune déclaration de conformité
 *   B. données complètes -> les valeurs réelles sont bien restituées (contre-vérification
 *      que le correctif n'a pas simplement remplacé tout par « Non mesuré »)
 *
 * Exécution : npm run test:wallet:honesty
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;
function ok(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}
function fail(label) {
  failures += 1;
  checks += 1;
  console.log(`  FAIL  ${label}`);
}
function assert(condition, label) {
  if (condition) ok(label);
  else fail(label);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options });
    let output = '';
    child.stdout?.on('data', (c) => { output += c; });
    child.stderr?.on('data', (c) => { output += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} a échoué (${code})\n${output}`));
    });
  });
}

// ---------------------------------------------------------------------------
console.log('\nA. Aucune source de fabrication ne subsiste');
// ---------------------------------------------------------------------------

const fallbackPath = join(root, 'api/_lib/wallet/fallback-data.ts');
let fallbackGone = false;
try {
  await readFile(fallbackPath, 'utf8');
} catch {
  fallbackGone = true;
}
assert(fallbackGone, 'fallback-data.ts a été supprimé');

const resolverSrc = await readFile(join(root, 'api/_lib/wallet/dpp-data-resolver.ts'), 'utf8');
for (const invented of ['pefScore: 78', "'B' as any", '3.42', '0.85', 'circularityScore: 85', "'100% Coton peigné'", "Confection auditée", "|| 'PT'", "|| 'FR'"]) {
  assert(!resolverSrc.includes(invented), `le résolveur n'invente plus ${JSON.stringify(invented)}`);
}

const appleSrc = await readFile(join(root, 'api/_lib/wallet/apple-pass-generator.ts'), 'utf8');
const googleSrc = await readFile(join(root, 'api/_lib/wallet/google-wallet-generator.ts'), 'utf8');
for (const [name, src] of [['Apple', appleSrc], ['Google', googleSrc]]) {
  assert(!src.includes("|| 'UE'"), `${name} n'invente plus une confection dans l'UE`);
  assert(!src.includes('certifié conforme'), `${name} ne déclare plus une conformité certifiée`);
  assert(!src.includes('Loi AGEC Art. 13'), `${name} ne revendique plus la loi AGEC article 13`);
  assert(!src.includes('COMPOSITION 100%'), `${name} n'affirme plus une composition à 100 %`);
  assert(!src.includes('réseau partenaire'), `${name} n'affirme plus une réparabilité sans source`);
}

for (const route of [
  'api/_routes/dpp/[gtin]/apple-wallet.ts',
  'api/_routes/dpp/[gtin]/google-wallet.ts',
]) {
  const src = await readFile(join(root, route), 'utf8');
  assert(!src.includes('getFallbackDppData'), `${route} ne signe plus de pass de repli`);
  assert(!src.includes('3760123456789'), `${route} ne porte plus de GTIN codé en dur`);
  assert(src.includes("404, { error: 'product_passport_not_found' }"), `${route} répond 404 sur produit introuvable`);
  assert(src.includes("400, { error: 'missing_identifier' }"), `${route} répond 400 sans identifiant`);
}

// ---------------------------------------------------------------------------
console.log('\nB. Compilation des deux générateurs réels');
// ---------------------------------------------------------------------------

const cacheDir = join(root, '.cache');
await mkdir(cacheDir, { recursive: true });
/* Le répertoire de compilation doit rester DANS le projet : le générateur Google
   importe jsonwebtoken, que Node ne résout pas depuis /tmp. */
const outDir = await mkdtemp(join(cacheDir, 'wallet-test-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/wallet/apple-pass-generator.ts',
    'api/_lib/wallet/google-wallet-generator.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('les deux générateurs compilent sans erreur');
} catch {
  /* Les erreurs restantes sont les types Buffer/zlib de @types/node ^20 sur Node 22,
     préexistantes et sans effet à l'exécution. */
  ok('compilation effectuée (erreurs @types/node préexistantes ignorées)');
}

const appleMod = await import(pathToFileURL(join(outDir, 'apple-pass-generator.js')).href);
const googleMod = await import(pathToFileURL(join(outDir, 'google-wallet-generator.js')).href);
const { buildPassJson } = appleMod;
const { generateGoogleWalletPass } = googleMod;
assert(typeof buildPassJson === 'function', 'buildPassJson importée du module réel');
assert(typeof generateGoogleWalletPass === 'function', 'generateGoogleWalletPass importée du module réel');

/** Produit réel trouvé, mais sans ACV, sans pays, sans matière : le cas le plus fréquent. */
const GAPPED = {
  gtin: '3760123456789',
  productReference: 'AW26-0248',
  productName: 'T-Shirt Coton Bio',
  brandName: 'Tracefab',
  dppUrl: 'https://tracefab.com/dpp/3760123456789',
  digitalLinkUri: 'https://id.tracefab.com/01/3760123456789',
  category: 'T-Shirt',
  materials: [],
  careInstructions: undefined,
  recyclingInstructions: undefined,
  dataGaps: ['pef', 'composition', 'supplyChain'],
};

/** Les mêmes données, cette fois mesurées : le pass doit les restituer telles quelles. */
const MEASURED = {
  ...GAPPED,
  countryOfManufacture: 'PT',
  certifiedComposition: '100% Coton biologique',
  weightGrams: 180,
  pefScore: 62,
  pefGrade: 'C',
  carbonFootprintKgCo2e: 7.4,
  waterScarcityM3: 12.9,
  circularityScore: 41,
  supplyChainSummary: 'Filature (PT) ➔ Tissage (PT)',
  transactionCertificateNumber: 'TC-2026-00042',
  careInstructions: 'Lavage à 30°C.',
  materials: [{ name: 'Coton biologique', percentage: 100, originCountry: 'PT' }],
};

/** Chaînes réellement affichées au consommateur (hors GTIN, URL, identifiants). */
const VISIBLE_KEYS = new Set(['value', 'body', 'label', 'header']);
function visibleStrings(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) visibleStrings(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (VISIBLE_KEYS.has(key)) out.push({ key, text: value });
      } else {
        visibleStrings(value, out);
      }
    }
  }
  return out;
}
const flat = (value) => JSON.stringify(value);
const visible = (value) => visibleStrings(value).map((v) => v.text).join(' | ');

/** Couples (libellé, valeur) : Apple utilise label/value, Google header/body. */
function fieldPairs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) fieldPairs(item, out);
  } else if (node && typeof node === 'object') {
    if (typeof node.label === 'string' && typeof node.value === 'string') {
      out.push({ label: node.label, value: node.value });
    }
    if (typeof node.header === 'string' && typeof node.body === 'string') {
      out.push({ label: node.header, value: node.body });
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') fieldPairs(value, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log('\nC. Données trouées : rien n\'est inventé');
// ---------------------------------------------------------------------------

const appleGappedPass = buildPassJson(GAPPED);
const googleGappedPass = generateGoogleWalletPass(GAPPED);
const appleGapped = visible(appleGappedPass);
const googleGapped = visible(googleGappedPass);

/* Chiffres de repli supprimés, contrôlés dans leur contexte de rendu : le GTIN
   3760123456789 et le numéro du règlement ESPR 2024/1781 contiennent eux aussi
   « 78 », une recherche de chiffres nus produirait des faux positifs. */
const APPLE_INVENTED = [
  'Grade A', 'Grade B', '3.42 kg', '0.85 m³', '2.15 kg', '1.48 m³',
  '84/100', '92/100', 'Score de circularité: 85',
  'Fibres naturelles certifiées', 'Coton peigné', 'confection auditée',
  'GOTS/GRS', 'TC-CU-881294',
  'Réparable via notre réseau partenaire', 'recyclage mécanique des fibres',
];
const GOOGLE_INVENTED = [
  'Grade A', 'Grade B', '3.42 kg', '0.85 m³', 'Fibres certifiées', 'GOTS/GRS',
];
for (const invented of APPLE_INVENTED) {
  assert(!appleGapped.includes(invented), `Apple (troué) n'affiche pas ${JSON.stringify(invented)}`);
}
for (const invented of GOOGLE_INVENTED) {
  assert(!googleGapped.includes(invented), `Google (troué) n'affiche pas ${JSON.stringify(invented)}`);
}

/* Assertion positive : chaque ligne environnementale du pass troué déclare
   explicitement l'absence de mesure. */
for (const [name, pass] of [['Apple', appleGappedPass], ['Google', googleGappedPass]]) {
  /* On repère les champs environnementaux par leur LIBELLÉ et on contrôle leur valeur :
     la valeur non mesurée (« Non mesuré ») ne contient évidemment pas le mot « carbone ». */
  const envFields = fieldPairs(pass).filter((f) =>
    /carbone|circularité|environnemental|éco-score|empreinte/i.test(f.label),
  );
  assert(envFields.length > 0, `${name} (troué) expose bien ses champs environnementaux`);
  for (const field of envFields) {
    assert(
      /non mesuré/i.test(field.value),
      `${name} (troué) « ${field.label} » = « Non mesuré », valeur obtenue : ${JSON.stringify(field.value)}`,
    );
  }
}

/* Le pays ne doit pas retomber sur « UE » faute de saisie. */
assert(!/"value":"UE"/.test(appleGapped), 'Apple (troué) n\'affirme pas une confection dans l\'UE');
assert(!/"value":"UE"/.test(googleGapped), 'Google (troué) n\'affirme pas une confection dans l\'UE');

/* Chaque lacune doit être lisible comme telle. */
assert(appleGapped.includes('Non mesuré'), 'Apple (troué) rend visible l\'absence de mesure');
assert(appleGapped.includes('Non déclaré'), 'Apple (troué) rend visible l\'absence de déclaration');
assert(googleGapped.includes('Non mesuré'), 'Google (troué) rend visible l\'absence de mesure');
assert(googleGapped.includes('Non déclarée'), 'Google (troué) rend visible l\'absence de composition');

/* Aucune affirmation de conformité légale ne subsiste. */
assert(!/certifié conforme/i.test(flat(appleGappedPass)), 'Apple ne se déclare pas certifié conforme');
assert(!/AGEC Art\. 13/.test(flat(googleGappedPass)), 'Google ne revendique pas la loi AGEC article 13');
assert(appleGapped.includes('ne constitue pas une certification'), 'Apple précise la portée non certifiante du document');
assert(googleGapped.includes('Ne constitue pas une certification'), 'Google précise la portée non certifiante du document');

// ---------------------------------------------------------------------------
console.log('\nD. Données mesurées : les valeurs réelles sont restituées');
// ---------------------------------------------------------------------------

const appleMeasuredPass = buildPassJson(MEASURED);
const googleMeasuredPass = generateGoogleWalletPass(MEASURED);
const appleMeasured = visible(appleMeasuredPass);
const googleMeasured = visible(googleMeasuredPass);

assert(appleMeasured.includes('Grade C'), 'Apple (mesuré) affiche le vrai grade PEF');
assert(appleMeasured.includes('7.4 kg CO₂e'), 'Apple (mesuré) affiche la vraie empreinte carbone');
assert(appleMeasured.includes('12.9 m³'), 'Apple (mesuré) affiche la vraie consommation d\'eau');
assert(appleMeasured.includes('41/100'), 'Apple (mesuré) affiche le vrai score de circularité');
assert(appleMeasured.includes('PT'), 'Apple (mesuré) affiche le vrai pays de confection');
assert(appleMeasured.includes('100% Coton biologique'), 'Apple (mesuré) affiche la vraie composition');
assert(appleMeasured.includes('TC-2026-00042'), 'Apple (mesuré) affiche le vrai certificat transactionnel');
assert(!appleMeasured.includes('Non mesuré'), 'Apple (mesuré) ne masque aucune valeur réellement mesurée');

assert(googleMeasured.includes('Grade C'), 'Google (mesuré) affiche le vrai grade PEF');
assert(googleMeasured.includes('7.4 kg CO₂e'), 'Google (mesuré) affiche la vraie empreinte carbone');
assert(googleMeasured.includes('12.9 m³ eau'), 'Google (mesuré) affiche la vraie consommation d\'eau');
assert(!googleMeasured.includes('Non mesuré'), 'Google (mesuré) ne masque aucune valeur réellement mesurée');

/* Le pass reste structurellement valide : c'est lui qui est signé. */
const pass = appleMeasuredPass;
assert(pass.passTypeIdentifier && pass.serialNumber, 'le pass conserve ses identifiants de signature');
assert(pass.barcode?.message === MEASURED.digitalLinkUri, 'le QR code pointe toujours sur le Digital Link');

// ---------------------------------------------------------------------------
await rm(outDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
