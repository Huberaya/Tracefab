#!/usr/bin/env npx tsx
/**
 * Un passeport ne doit porter que des donnees etablies.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Les deux routes Wallet publiques — /api/dpp/:gtin/apple-wallet et
 * /api/dpp/:gtin/google-wallet — ne consultaient pas la base. Elles
 * appelaient `getFallbackDppData()`, qui rendait un produit entierement
 * fictif : marque « Atelier Demo », composition « 100% Coton Biologique
 * Regeneratif », 2,15 kg CO2e, grade A, circularite 92, une chaine complete
 * « Ferme Izmir -> Hub Lyon », et un numero de certificat de transaction
 * GOTS, « TC-CU-881294-GOTS-2026 ».
 *
 * L'identifiant scanne ne servait qu'a composer le GTIN affiche. N'importe
 * quel code-barres produisait donc un laissez-passer credible portant ces
 * allegations, dans le portefeuille du consommateur, sans aucune mention de
 * demonstration.
 *
 * Le resolveur « reel » n'etait pas exempt : faute d'analyse PEF il servait
 * `pefScore: 78, pefGrade: 'B', 3.42 kg CO2e, 0.85 m3, circularite 85`, et
 * faute de matiere « 100% Coton peigne ». Et les deux generateurs affichaient
 * sur CHAQUE passeport « ESPR CONFORME » et « certifie conforme au Reglement
 * Ecoconception ESPR 2024/1781 et a la loi AGEC article 13 ».
 *
 *   npm run test:dpp-sans-invention
 */

import { readFileSync, existsSync } from 'node:fs';
import { buildPassJson } from '../api/_lib/wallet/apple-pass-generator.js';
import { generateGoogleWalletPass } from '../api/_lib/wallet/google-wallet-generator.js';
import type { DppPassData } from '../api/_lib/wallet/types.js';
import { buildGs1DigitalLink } from '../api/_lib/plm-erp/gtin-engine.js';

let echecs = 0;
const ok = (cond: boolean, message: string) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

/** Produit reel mais depourvu de toute donnee environnementale ou de chaine. */
const NU: DppPassData = {
  productId: 'p-1', brandName: 'Marque Reelle', brandLegalName: 'Marque Reelle',
  productName: 'Tee-shirt', productReference: 'REF-1', sku: 'REF-1-M',
  gtin: '3000000000001', serialNumber: 'DPP-REF-1', category: 'Maille',
  materials: [], dppUrl: 'https://x/p/1', digitalLinkUri: 'urn:x',
};

/** Le meme, entierement renseigne. */
const RENSEIGNE: DppPassData = {
  ...NU,
  countryOfManufacture: 'PT', countryOfDesign: 'FR', weightGrams: 185,
  certifiedComposition: '60% Lin, 40% Coton',
  materials: [{ name: 'Lin', percentage: 60 }, { name: 'Coton', percentage: 40 }],
  pefScore: 71, pefGrade: 'C', carbonFootprintKgCo2e: 4.8,
  waterScarcityM3: 2.1, circularityScore: 64,
  verificationDate: '2026-03-04',
  transactionCertificateNumber: 'TC-REEL-1',
  supplyChainSummary: 'Filature (ES) ➔ Confection (PT)',
  careInstructions: 'Lavage à 30°C.',
};

/**
 * Texte reellement inspectable d'un laissez-passer Google.
 *
 * `generateGoogleWalletPass` rend { saveUrl, jwtToken, passObject }. Les deux
 * premiers contiennent la carte encodee en base64url : un simple
 * JSON.stringify du resultat aurait masque toute chaine fabriquee derriere
 * l'encodage, et le test aurait valide ce qu'il croyait interdire. On decode
 * donc la charge utile du JWT et on y ajoute l'objet en clair.
 */
function texteGoogle(res: any): string {
  let charge = '';
  const jeton = String(res?.jwtToken || '');
  const parts = jeton.split('.');
  if (parts.length === 3) {
    try { charge = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch { charge = ''; }
  }
  if (!charge) throw new Error('charge utile du JWT illisible — le test ne peut rien prouver');
  return charge + JSON.stringify(res?.passObject ?? {});
}

const texte = (o: unknown) => JSON.stringify(o);

// --- A. le fichier de fiction a disparu ---
console.log('\n  A. source de fiction');
ok(!existsSync('api/_lib/wallet/fallback-data.ts'),
  'api/_lib/wallet/fallback-data.ts n\'existe plus');
for (const route of ['apple-wallet', 'google-wallet']) {
  const src = readFileSync(`api/_routes/dpp/[gtin]/${route}.ts`, 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!/getFallbackDppData/.test(code), `la route ${route} n'appelle plus de repli`);
  ok(/resolveDppPassData/.test(code) && /withTracefabPublicContext/.test(code),
    `la route ${route} resout le produit publie sous contexte public`);
  ok(/product_passport_not_found/.test(code),
    `la route ${route} refuse quand aucun produit publie ne correspond`);
}

// --- B. produit nu : aucune valeur metier inventee ---
console.log('\n  B. produit sans donnees — rien ne doit etre comble');
const apple = texte(buildPassJson(NU));
const google = texteGoogle(generateGoogleWalletPass(NU));
const INVENTIONS: Array<[string, string]> = [
  ['3.42', 'empreinte carbone par defaut'],
  ['"78"', 'score PEF par defaut'],
  ['Grade B', 'grade PEF par defaut'],
  ['0.85', 'eau par defaut'],
  ['Coton peigné', 'composition par defaut'],
  ['Fibres naturelles certifiées', 'composition par defaut (Apple)'],
  ['Fibres certifiées', 'composition par defaut (Google)'],
  ['Filature ➔ Tissage', 'chaine par defaut'],
  ['GOTS/GRS auditables', 'chaine « certifiee » par defaut'],
  ['registre bilanciel', 'certificat de transaction par defaut'],
  ['Traçabilité complète', 'tracabilite affirmee par defaut'],
  ['TC-CU-881294', 'numero de certificat GOTS fictif'],
  ['Atelier Demo', 'marque fictive'],
  ['undefined', 'valeur manquante affichee telle quelle'],
];
for (const [aiguille, quoi] of INVENTIONS) {
  ok(!apple.includes(aiguille), `Apple n'ecrit pas ${quoi} (« ${aiguille} »)`);
  ok(!google.includes(aiguille), `Google n'ecrit pas ${quoi} (« ${aiguille} »)`);
}

// --- C. aucune affirmation de conformite ---
console.log('\n  C. aucune affirmation de conformite');
for (const [nom, charge] of [['Apple', apple], ['Google', google]] as const) {
  ok(!/ESPR CONFORME|certifié conforme|ESPR UE 2024/.test(charge),
    `${nom} n'affirme pas la conformite reglementaire`);
  ok(/ne constitue pas une attestation/i.test(charge),
    `${nom} enonce la portee reelle du passeport`);
}
ok(!/MODÈLE CERTIFIÉ/.test(apple), 'Apple n\'intitule plus le produit « MODÈLE CERTIFIÉ »');
ok(!/COMPOSITION 100%/.test(apple) && !/COMPOSITION 100%/.test(google),
  'l\'intitule « COMPOSITION 100% » a disparu');

// --- D. produit renseigne : tout doit apparaitre ---
console.log('\n  D. produit renseigne — rien ne doit etre perdu');
const appleR = texte(buildPassJson(RENSEIGNE));
const googleR = texteGoogle(generateGoogleWalletPass(RENSEIGNE));
for (const [aiguille, quoi] of [
  ['Grade C', 'grade PEF reel'],
  ['4.8', 'empreinte reelle'],
  ['60% Lin, 40% Coton', 'composition reelle'],
  ['PT', 'pays de confection reel'],
  ['Filature (ES)', 'chaine reelle'],
] as Array<[string, string]>) {
  ok(appleR.includes(aiguille), `Apple restitue ${quoi}`);
  ok(googleR.includes(aiguille), `Google restitue ${quoi}`);
}
ok(appleR.includes('TC-REEL-1'), 'Apple restitue le certificat de transaction reel');
ok(appleR.includes('2.1'), 'Apple restitue la consommation d\'eau reelle');
ok(appleR.includes('Lavage à 30'), 'Apple restitue les consignes d\'entretien saisies');

// --- E. le passeport nu reste structurellement valide ---
console.log('\n  E. validite structurelle du passeport nu');
const nu = buildPassJson(NU) as any;
ok(nu.formatVersion === 1 && typeof nu.serialNumber === 'string',
  'pass.json conserve ses champs obligatoires');
ok(Array.isArray(nu.storeCard.primaryFields) && nu.storeCard.primaryFields.length === 1,
  'le nom du produit reste affiche');
ok(nu.storeCard.secondaryFields.length === 0,
  `aucune rubrique secondaire quand rien n'est renseigne (${nu.storeCard.secondaryFields.length})`);
ok(nu.storeCard.headerFields.length === 0,
  'aucune date de mise a jour inventee en en-tete');
const garnie = buildPassJson(RENSEIGNE) as any;
ok(garnie.storeCard.secondaryFields.length === 2,
  `les deux rubriques secondaires reapparaissent quand la donnee existe (${garnie.storeCard.secondaryFields.length})`);
ok(garnie.storeCard.backFields.length > nu.storeCard.backFields.length,
  `le dos s'etoffe avec la donnee reelle (${nu.storeCard.backFields.length} -> ${garnie.storeCard.backFields.length})`);

// --- F. le resolveur ne contient plus de repli de valeur metier ---
console.log('\n  F. resolveur');
const resolveur = readFileSync('api/_lib/wallet/dpp-data-resolver.ts', 'utf8')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
for (const motif of ['78', '3.42', '0.85', "'B'", '250', 'Coton peigné', 'Filature ➔']) {
  ok(!resolveur.includes(motif), `le resolveur n'a plus le repli « ${motif} »`);
}

// --- G. lien GS1 : plus de prefixe d'entreprise invente ---
// Le resolveur fabriquait « urn:epc:id:sgtin:3760123.… ». 3760123 est un
// prefixe GS1 qui appartient a une entreprise reelle, et TRACEFAB ne l'a pas
// achete : le code-barres de chaque passeport designait donc quelqu'un d'autre.
console.log('\n  G. lien GS1');
for (const motif of ['3760123', 'urn:epc:id:sgtin', 'sgtin']) {
  ok(!resolveur.includes(motif), `le resolveur n'emet plus « ${motif} »`);
}
const AVEC_GTIN: DppPassData = { ...RENSEIGNE, gtin: '03760123456789',
  digitalLinkUri: buildGs1DigitalLink({ gtin: '03760123456789', linkType: 'gs1:pip' }) };
ok(decodeURIComponent(String(AVEC_GTIN.digitalLinkUri))
  === 'https://id.tracefab.com/01/03760123456789?linkType=gs1:pip',
  `le lien GS1 est canonique (${AVEC_GTIN.digitalLinkUri})`);
const avecQr = buildPassJson(AVEC_GTIN) as any;
ok(avecQr.barcodes[0].message === AVEC_GTIN.digitalLinkUri,
  'le QR porte le lien GS1 quand le GTIN existe');
// Sans GTIN il n'y a pas de Digital Link possible : le QR retombe sur l'URL du
// passeport plutot que d'inventer un identifiant.
const SANS_GTIN: DppPassData = { ...RENSEIGNE, gtin: undefined, digitalLinkUri: undefined };
const sansQr = buildPassJson(SANS_GTIN) as any;
ok(sansQr.barcodes[0].message === SANS_GTIN.dppUrl,
  'sans GTIN, le QR retombe sur l\'URL du passeport');
ok(!JSON.stringify(sansQr).includes('id.tracefab.com/01/'),
  'sans GTIN, aucun Digital Link n\'est fabrique');
const sansQrG = generateGoogleWalletPass(SANS_GTIN) as any;
ok(!JSON.stringify(sansQrG).includes('id.tracefab.com/01/'),
  'idem cote Google Wallet');

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Aucune valeur metier inventee ne quitte la plateforme.\n');
process.exit(echecs ? 1 : 0);
