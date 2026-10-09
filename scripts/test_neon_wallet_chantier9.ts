import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { resolveDppPassData, resolveDppPassDataByGtin } from '../api/_lib/wallet/dpp-data-resolver.ts';
import { generateApplePkpass, buildPassJson } from '../api/_lib/wallet/apple-pass-generator.ts';
import { generateGoogleWalletPass } from '../api/_lib/wallet/google-wallet-generator.ts';

const prisma = new PrismaClient();

async function run() {
  console.log('=== TEST INTEGRATION NEON CHANTIER 9: LIVE DPP & WALLET GENERATION ===\n');

  try {
    // 1. Un produit REELLEMENT PUBLIE (public_slug + dpp_records publie/relu).
    //    La barriere de publication est la regle du chantier 1A-C : un
    //    produit non publie ne doit resoudre nulle part.
    const product = await prisma.tracefab_products.findFirst({
      where: {
        public_slug: { not: null },
        dpp_records: { some: { readiness_status: 'published', reviewed_at: { not: null } } },
        product_materials: { some: {} },
      },
      include: {
        organizations: true,
        product_identifiers: true,
        product_materials: { include: { materials: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!product) {
      // Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.
      console.error('NON EXECUTE — aucun produit publie (public_slug + dpp_records publie/relu) dans la base visee.');
      process.exit(2);
    }
    console.log(`[SETUP] Using published product: "${product.name}" (${product.reference})`);

    // 2. Resolution des donnees de passeport
    console.log('\n[STEP 1] Testing resolveDppPassData against the database...');
    const dppData = await resolveDppPassData(prisma, product.id);
    assert.ok(dppData, 'resolveDppPassData must return valid pass data for a published product');
    assert.equal(dppData.productId, product.id);
    assert.equal(dppData.productName.value, product.name);
    assert.equal(dppData.productName.status, 'sourced');
    assert.ok(dppData.productName.source, 'la provenance doit etre conservee');
    assert.ok(dppData.materials.length > 0, 'Must contain resolved materials');
    assert.ok(dppData.composition.value && dppData.composition.value.length > 0, 'Must contain composition string');

    // Aucune des anciennes substitutions ne doit refaire surface.
    const empreinte = JSON.stringify(dppData);
    for (const interdit of ['100% Coton peigné', 'Atelier Demo', 'Filature ➔ Tissage ➔ Ennoblissement', 'TC-VERIFIED-MB-', 'Tracefab Brand']) {
      assert.ok(!empreinte.includes(interdit), `substitution detectee dans les donnees resolues : « ${interdit} »`);
    }
    console.log('✓ DPP Pass Data resolved with provenance:', {
      brand: dppData.brandName,
      name: dppData.productName,
      composition: dppData.composition,
      pefGrade: dppData.pefGrade,
      presentation: dppData.presentation,
    });

    // 3. Generation Apple Wallet
    console.log('\n[STEP 2] Testing Apple Wallet pass.json and .pkpass generation...');
    const passJson = buildPassJson(dppData);
    assert.equal(passJson.formatVersion, 1);
    assert.equal(passJson.organizationName, dppData.brandName.value);
    assert.ok(passJson.storeCard.primaryFields.some((f: any) => f.value === dppData.productName.value));

    const pkpassBuffer = await generateApplePkpass(dppData);
    assert.ok(pkpassBuffer.length > 500, 'PKPASS buffer must be a valid non-empty zip');
    assert.equal(pkpassBuffer[0], 0x50); // 'P'
    assert.equal(pkpassBuffer[1], 0x4B); // 'K'
    console.log(`✓ Apple Wallet .pkpass bundle generated from live database product (${pkpassBuffer.length} bytes)`);

    // 4. Generation Google Wallet
    console.log('\n[STEP 3] Testing Google Wallet Pass generation...');
    const googleWallet = generateGoogleWalletPass(dppData);
    assert.ok(googleWallet.saveUrl.includes('pay.google.com'));
    assert.ok(googleWallet.jwtToken.length > 50);
    assert.equal(googleWallet.passObject.genericObject.cardTitle.defaultValue.value, dppData.brandName.value);
    assert.equal(googleWallet.passObject.genericObject.header.defaultValue.value, dppData.productName.value);
    console.log('✓ Google Wallet pass generated with Save URL:', googleWallet.saveUrl.slice(0, 60) + '...');

    // 5. Resolution par reference et par GTIN strict
    console.log('\n[STEP 4] Testing resolution by reference and strict GTIN...');
    const refResolved = await resolveDppPassData(prisma, product.reference);
    assert.ok(refResolved);
    assert.equal(refResolved.productId, product.id);
    console.log(`✓ Resolved successfully by reference "${product.reference}"`);

    const gtinRow = (product.product_identifiers || []).find((i: any) => i.identifier_type === 'gtin');
    if (gtinRow) {
      const parGtin = await resolveDppPassDataByGtin(prisma, gtinRow.identifier_value);
      assert.ok(parGtin, 'un GTIN reel d un produit publie doit resoudre');
      assert.equal(parGtin.productId, product.id);
      console.log(`✓ Resolved by strict GTIN "${gtinRow.identifier_value}"`);
    }

    // 6. Negatifs : GTIN invalide ou inconnu ne resout jamais, et surtout ne
    //    renvoie aucune fiche de substitution.
    const invalide = await resolveDppPassDataByGtin(prisma, '1234567890128'); // cle fausse
    assert.equal(invalide, null, 'un GTIN invalide (modulo-10) ne resout pas');
    const inconnu = await resolveDppPassDataByGtin(prisma, '4006381333931'); // GTIN valide, inconnu ici
    assert.equal(inconnu, null, 'un GTIN inconnu ne resout pas — jamais de fiche par defaut');
    console.log('✓ GTIN invalides/inconnus : resolution nulle, aucune donnee de substitution');

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
