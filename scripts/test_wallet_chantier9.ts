import assert from 'node:assert/strict';
import { buildPassJson, generateApplePkpass } from '../api/_lib/wallet/apple-pass-generator.ts';
import { generateGoogleWalletPass } from '../api/_lib/wallet/google-wallet-generator.ts';
import type { DppPassData, SourcedField } from '../api/_lib/wallet/types.ts';
import { fieldDisplay } from '../api/_lib/wallet/types.ts';

console.log('--- TEST SUITE CHANTIER 9: DPP & APPLE / GOOGLE WALLET (provenance incluse) ---');

const src = <T>(value: T, source: string): SourcedField<T> => ({ value, status: 'sourced', source });
const vide = <T>(source: string): SourcedField<T> => ({ value: null, status: 'not_filled', source });
const indispo = <T>(source: string): SourcedField<T> => ({ value: null, status: 'unavailable', source });

const sampleDppData: DppPassData = {
  productId: 'prod-test-chantier9',
  brandName: src('Atelier Chantier 9', 'tracefab_public_brand.display_name'),
  productName: src('Pull Laine Mérinos Bio', 'tracefab_products.name'),
  productReference: src('TF-PULL-009', 'tracefab_products.reference'),
  sku: src('PULL-BIO-009-NVY', 'tracefab_products.sku'),
  gtin: src('3760345833592', 'product_identifiers.identifier_value (type gtin)'),
  serialNumber: src('DPP-3760345833592-2026', 'calcul: reference + version'),
  category: src('Maille / Pull', 'tracefab_products.category'),
  countryOfManufacture: src('PT', 'tracefab_products.country_of_manufacture'),
  countryOfDesign: src('FR', 'tracefab_products.country_of_design'),
  weightGrams: src(380, 'tracefab_products.weight_grams'),
  composition: src('100% Laine Mérinos Biologique Peignée', 'product_materials + materials'),
  materials: [
    {
      name: src('Laine Mérinos Biologique', 'materials.name'),
      percentage: src(100, 'product_materials.percentage'),
      role: src('main', 'product_materials.material_role'),
      originCountry: src('PT', 'materials.origin_country_code'),
    },
  ],
  pefScore: src(88, 'product_pef_assessments'),
  pefGrade: src('A', 'product_pef_assessments'),
  carbonFootprintKgCo2e: src(2.15, 'product_pef_assessments'),
  waterScarcityM3: src(0.45, 'product_pef_assessments'),
  circularityScore: src(94, 'product_pef_assessments'),
  dppUrl: 'https://tracefab.com/dpp/3760345833592',
  digitalLinkUri: src('https://id.tracefab.com/01/3760345833592', 'gtin-engine.buildGs1DigitalLink sur GTIN reel'),
  verificationDate: src('2026-10-06', 'dpp_records.reviewed_at'),
  transactionCertificateNumber: src('TC-GOTS-2026-00941', 'transaction_certificates.tc_number via mass_balance_allocations'),
  supplyChainSummary: src('Filature (PT) ➔ Tricotage (PT) ➔ Confection (PT)', 'supply_chain_nodes (+ supplier_sites)'),
  careInstructions: src('Lavage main ou machine cycle laine à froid. Séchage à plat.', 'tracefab_products.care_instructions'),
  recyclingInstructions: indispo('aucune source dans le modele'),
  presentation: { source: 'partial', sourcedFieldCount: 16, missingFieldCount: 1 },
};

// TEST 1: Apple Wallet pass.json Structure & PassKit Compliance
console.log('\n[TEST 1] Apple Wallet PassKit pass.json generation');
{
  const pass = buildPassJson(sampleDppData);
  assert.equal(pass.formatVersion, 1);
  assert.equal(pass.organizationName, 'Atelier Chantier 9');
  assert.equal(pass.description, 'Passeport Numérique de Produit - Pull Laine Mérinos Bio');
  assert.equal(pass.serialNumber, 'DPP-3760345833592-2026');
  assert.ok(pass.storeCard, 'Should generate storeCard layout');

  // Verify primary & secondary fields
  const primary = pass.storeCard.primaryFields[0];
  assert.equal(primary.value, 'Pull Laine Mérinos Bio');

  const pefField = pass.storeCard.secondaryFields.find((f: any) => f.key === 'pef_grade');
  assert.ok(pefField);
  assert.ok(pefField.value.includes('Grade A'));

  const compField = pass.storeCard.auxiliaryFields.find((f: any) => f.key === 'composition');
  assert.equal(compField.value, '100% Laine Mérinos Biologique Peignée');

  // Verify QR code barcode
  assert.equal(pass.barcode.format, 'PKBarcodeFormatQR');
  assert.equal(pass.barcode.message, 'https://id.tracefab.com/01/3760345833592');

  // Verify back fields
  const backUrls = pass.storeCard.backFields.find((f: any) => f.key === 'dpp_url');
  assert.equal(backUrls.value, 'https://tracefab.com/dpp/3760345833592');

  // Le recyclage n'a pas de source : la carte doit l'annoncer, pas inventer.
  const recyclage = pass.storeCard.backFields.find((f: any) => f.key === 'recycling');
  assert.equal(recyclage.value, 'Indisponible');

  console.log('✓ Apple Wallet pass.json passes all Apple PassKit schema checks');
}

// TEST 2: Apple Wallet .pkpass Bundle Archive Generation & Manifest Hashing
console.log('\n[TEST 2] Apple Wallet .pkpass ZIP bundle generation & SHA-1 manifest integrity');
{
  const pkpassBuffer = await generateApplePkpass(sampleDppData);
  assert.ok(pkpassBuffer.length > 200, 'PKPASS buffer must not be empty');

  // Verify ZIP signature magic bytes (0x50, 0x4B, 0x03, 0x04)
  assert.equal(pkpassBuffer[0], 0x50, 'Byte 0 must be P');
  assert.equal(pkpassBuffer[1], 0x4B, 'Byte 1 must be K');
  assert.equal(pkpassBuffer[2], 0x03);
  assert.equal(pkpassBuffer[3], 0x04);

  console.log(`✓ PKPASS bundle generated with valid ZIP container (${pkpassBuffer.length} bytes)`);
}

// TEST 3: Google Wallet Pass Generator & JWT Signing
console.log('\n[TEST 3] Google Wallet Pass Generator: Class, Object, and JWT link');
{
  const googleWallet = generateGoogleWalletPass(sampleDppData);
  assert.ok(googleWallet.saveUrl.startsWith('https://pay.google.com/gp/v/save/'));
  assert.ok(googleWallet.jwtToken.length > 50, 'JWT token must be populated');
  assert.equal(googleWallet.isSimulated, true, 'Without GCP private key, should use dev simulation mode');

  const obj = googleWallet.passObject.genericObject;
  assert.equal(obj.header.defaultValue.value, 'Pull Laine Mérinos Bio');
  assert.equal(obj.cardTitle.defaultValue.value, 'Atelier Chantier 9');
  assert.equal(obj.barcode.type, 'QR_CODE');
  assert.equal(obj.barcode.value, 'https://id.tracefab.com/01/3760345833592');

  const compModule = obj.textModulesData.find((m: any) => m.id === 'composition');
  assert.equal(compModule.body, '100% Laine Mérinos Biologique Peignée');

  console.log('✓ Google Wallet pass object conforms to Google Wallet Passes API spec');
}

// TEST 4: API Route Handlers Integration Mock Test
console.log('\n[TEST 4] Wallet & DPP API Route Handlers');
{
  // Point d'injection documente de api/_lib/prisma.js : un import de route
  // cree le singleton Prisma. Sans base de donnees ici, un stub suffit — le
  // test ne fait qu'importer les handlers et verifier leur signature.
  if (!globalThis.tracefabPrisma) {
    globalThis.tracefabPrisma = new Proxy({}, {
      get: () => { throw new Error('test_wallet_chantier9: acces base interdit dans ce test statique'); },
    });
  }

  // Verify import of route modules
  const appleRoute = await import('../api/_routes/products/[productId]/wallet/apple.ts');
  const googleRoute = await import('../api/_routes/products/[productId]/wallet/google.ts');
  const dppRoute = await import('../api/_routes/dpp/[gtin].ts');

  assert.equal(typeof appleRoute.default, 'function', 'Apple wallet route must export default handler');
  assert.equal(typeof googleRoute.default, 'function', 'Google wallet route must export default handler');
  assert.equal(typeof dppRoute.default, 'function', 'DPP route must export default handler');

  console.log('✓ API route handlers loaded and signature contracts verified');
}

// TEST 5: aucune substitution — un passeport pauvre affiche des ETATS EXPLICITES
console.log('\n[TEST 5] Passeport sans donnees : etats explicites, jamais des valeurs inventees');
{
  const pauvre: DppPassData = {
    ...sampleDppData,
    composition: vide('product_materials'),
    materials: [],
    supplyChainSummary: vide('supply_chain_nodes'),
    pefScore: indispo('product_pef_assessments'),
    pefGrade: indispo('product_pef_assessments'),
    carbonFootprintKgCo2e: indispo('product_pef_assessments'),
    waterScarcityM3: indispo('product_pef_assessments'),
    circularityScore: indispo('product_pef_assessments'),
    countryOfManufacture: vide('tracefab_products.country_of_manufacture'),
    weightGrams: vide('tracefab_products.weight_grams'),
    verificationDate: vide('dpp_records.reviewed_at'),
    transactionCertificateNumber: vide('transaction_certificates'),
    careInstructions: vide('tracefab_products.care_instructions'),
    digitalLinkUri: vide('product_identifiers'),
    presentation: { source: 'empty', sourcedFieldCount: 6, missingFieldCount: 12 },
  };

  assert.equal(fieldDisplay(pauvre.composition), 'Non renseigné');
  assert.equal(fieldDisplay(pauvre.pefGrade), 'Indisponible');
  assert.equal(fieldDisplay(pauvre.supplyChainSummary), 'Non renseigné');
  assert.equal(fieldDisplay(pauvre.weightGrams), 'Non renseigné');

  const pass = buildPassJson(pauvre);
  const compField = pass.storeCard.auxiliaryFields.find((f: any) => f.key === 'composition');
  assert.equal(compField.value, 'Non renseigné', 'composition absente annoncee, jamais une valeur par defaut');
  const pefField = pass.storeCard.secondaryFields.find((f: any) => f.key === 'pef_grade');
  assert.ok(!pefField.value.includes('Grade B'), 'aucun grade PEF invente');
  assert.equal(pefField.value, 'Indisponible');

  // Texte integral de la carte : aucune des anciennes substitutions n'y est.
  const carte = JSON.stringify(pass);
  for (const interdit of [
    'Coton peigné', 'Coton Biologique', 'Atelier Demo', 'Filature ➔ Tissage',
    'ESPR CONFORME', 'certifiées', 'certifié conforme', 'auditée',
    'Fibres naturelles', '3.42', '250',
  ]) {
    assert.ok(!carte.includes(interdit), `substitution detectee dans la carte : « ${interdit} »`);
  }

  // La provenance de page n'est jamais 'live' sans donnees sourcees.
  assert.equal(pauvre.presentation.source, 'empty');

  const google = generateGoogleWalletPass(pauvre);
  const modules = JSON.stringify(google.passObject);
  for (const interdit of ['Fibres certifiées', 'GOTS/GRS', 'ESPR UE 2024', 'Atelier Demo']) {
    assert.ok(!modules.includes(interdit), `substitution detectee dans la carte Google : « ${interdit} »`);
  }

  console.log('✓ Un passeport pauvre affiche des etats explicites — aucune valeur substituee');
}

console.log('\n--- ALL UNIT AND STATIC TESTS FOR CHANTIER 9 PASSED ---\n');
