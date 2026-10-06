import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { resolveDppPassData } from '../api/_lib/wallet/dpp-data-resolver.ts';
import { generateApplePkpass, buildPassJson } from '../api/_lib/wallet/apple-pass-generator.ts';
import { generateGoogleWalletPass } from '../api/_lib/wallet/google-wallet-generator.ts';

const prisma = new PrismaClient();

async function run() {
  console.log('=== TEST INTEGRATION NEON CHANTIER 9: LIVE DPP & WALLET GENERATION ===\n');

  try {
    // 1. Fetch a real product from Neon DB
    const product = await prisma.tracefab_products.findFirst({
      where: {
        product_materials: { some: {} },
      },
      include: {
        organizations: true,
        product_identifiers: true,
        product_materials: { include: { materials: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    assert.ok(product, 'A product with materials must exist in Neon DB');
    console.log(`[SETUP] Using Neon Product: "${product.name}" (${product.reference})`);

    // 2. Resolve DPP Pass Data
    console.log('\n[STEP 1] Testing resolveDppPassData against Neon DB...');
    const dppData = await resolveDppPassData(prisma, product.id);
    assert.ok(dppData, 'resolveDppPassData must return valid pass data');
    assert.equal(dppData.productId, product.id);
    assert.equal(dppData.productName, product.name);
    assert.ok(dppData.materials.length > 0, 'Must contain resolved materials');
    assert.ok(dppData.certifiedComposition.length > 0, 'Must contain composition string');
    console.log('✓ DPP Pass Data resolved successfully:', {
      brand: dppData.brandName,
      name: dppData.productName,
      composition: dppData.certifiedComposition,
      pefGrade: dppData.pefGrade,
      carbonKgCo2e: dppData.carbonFootprintKgCo2e,
      gtin: dppData.gtin,
    });

    // 3. Apple Wallet Generation
    console.log('\n[STEP 2] Testing Apple Wallet pass.json and .pkpass generation...');
    const passJson = buildPassJson(dppData);
    assert.equal(passJson.formatVersion, 1);
    assert.equal(passJson.organizationName, dppData.brandName);
    assert.ok(passJson.storeCard.primaryFields.some((f: any) => f.value === dppData.productName));

    const pkpassBuffer = await generateApplePkpass(dppData);
    assert.ok(pkpassBuffer.length > 500, 'PKPASS buffer must be a valid non-empty zip');
    assert.equal(pkpassBuffer[0], 0x50); // 'P'
    assert.equal(pkpassBuffer[1], 0x4B); // 'K'
    console.log(`✓ Apple Wallet .pkpass bundle generated from live database product (${pkpassBuffer.length} bytes)`);

    // 4. Google Wallet Generation
    console.log('\n[STEP 3] Testing Google Wallet Pass generation...');
    const googleWallet = generateGoogleWalletPass(dppData);
    assert.ok(googleWallet.saveUrl.includes('pay.google.com'));
    assert.ok(googleWallet.jwtToken.length > 50);
    assert.equal(googleWallet.passObject.genericObject.cardTitle.defaultValue.value, dppData.brandName);
    assert.equal(googleWallet.passObject.genericObject.header.defaultValue.value, dppData.productName);
    console.log('✓ Google Wallet pass generated with Save URL:', googleWallet.saveUrl.slice(0, 60) + '...');

    // 5. Test resolution via GTIN or Reference
    console.log('\n[STEP 4] Testing resolution by Reference / GTIN identifier...');
    const refResolved = await resolveDppPassData(prisma, product.reference);
    assert.ok(refResolved);
    assert.equal(refResolved.productId, product.id);
    console.log(`✓ Resolved successfully by Reference "${product.reference}"`);

    console.log('\n=============================================================');
    console.log('SUCCESS: All Chantier 9 Neon live integration tests passed!');
    console.log('=============================================================\n');
  } catch (err) {
    console.error('Test failed with error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
