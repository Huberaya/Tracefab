import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { bulkImportProducts, bulkImportSuppliers, parseCompositionString } from '../api/_lib/bulk-operations/bulk-importer.ts';
import { exportProductsCsv, exportSuppliersCsv, exportAuditDossierJson } from '../api/_lib/bulk-operations/compliance-exporter.ts';
import { parseCsvRows } from '../api/_lib/bulk-operations/csv-parser.ts';

const prisma = new PrismaClient();

async function run() {
  console.log('=== TEST INTEGRATION NEON CHANTIER 8: BULK IMPORT & REGULATORY EXPORT ===\n');

  try {
    // 1. Fetch or create a test brand organization and user
    let brandOrg = await prisma.organizations.findFirst({
      where: { type: 'brand' }
    });

    if (!brandOrg) {
      brandOrg = await prisma.organizations.create({
        data: {
          legal_name: 'Atelier Test Chantier 8 SAS',
          display_name: 'Atelier Chantier 8',
          country_code: 'FR',
          type: 'brand'
        }
      });
    }

    let testUser = await prisma.user.findFirst();

    console.log(`[SETUP] Using Brand Organization: "${brandOrg.display_name || brandOrg.legal_name}" (${brandOrg.id})`);

    // Run within a transaction setting tracefab context
    await prisma.$transaction(async (tx) => {
      const timestamp = Date.now().toString().slice(-6);

      if (testUser) {
        await tx.$executeRaw`
          INSERT INTO organization_memberships (id, organization_id, user_id, role, clerk_membership_id)
          VALUES (gen_random_uuid(), ${brandOrg.id}::uuid, ${testUser.id}::uuid, 'admin'::membership_role, ${'mem_bulk_' + timestamp})
          ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'admin'::membership_role;
        `;
        await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${testUser.id}, true)`;
      }
      const csvContent = `reference,name,category,sku,countryOfManufacture,weightGrams,materialsSummary,gtin
TF-BULK-01-${timestamp},"Pull Laine Mérinos Bio",Pull,SKU-MERINOS-01,PT,380,"100% Laine Mérinos",376034583359
TF-BULK-02-${timestamp},"Veste Jean Selvedge",Veste,SKU-DENIM-02,TN,720,"98% Coton biologique, 2% Élasthanne",400638133393`;

      const parsedRows = parseCsvRows(csvContent);
      assert.equal(parsedRows.length, 2, 'Should parse 2 CSV rows');

      const importRows = parsedRows.map((r) => ({
        reference: r.reference,
        name: r.name,
        category: r.category,
        sku: r.sku,
        countryOfManufacture: r.countryOfManufacture,
        weightGrams: r.weightGrams ? Number(r.weightGrams) : undefined,
        materialComposition: r.materialsSummary,
        gtin: r.gtin
      }));

      const importResult = await bulkImportProducts(tx, brandOrg.id, importRows, testUser?.id);

      console.log('Bulk Product Import Summary:', {
        totalProcessed: importResult.totalProcessed,
        createdCount: importResult.createdCount,
        updatedCount: importResult.updatedCount,
        skippedCount: importResult.skippedCount,
        errors: importResult.errors
      });

      assert.equal(importResult.totalProcessed, 2);
      assert.equal(importResult.createdCount, 2, 'Both products should be created');
      assert.equal(importResult.skippedCount, 0);

      // Verify products in database
      const p1 = await tx.tracefab_products.findFirst({
        where: { brand_organization_id: brandOrg.id, reference: `TF-BULK-01-${timestamp}` },
        include: { product_materials: { include: { materials: true } }, product_identifiers: true }
      });

      assert.ok(p1, 'Product 1 must exist in Neon DB');
      assert.equal(p1.name, 'Pull Laine Mérinos Bio');
      assert.equal(p1.country_of_manufacture, 'PT');
      assert.equal(Number(p1.weight_grams), 380);
      assert.ok(p1.product_materials.length >= 1, 'Product 1 must have materials linked');
      assert.equal(p1.product_materials[0].materials.name, 'Laine Mérinos');

      // Verify GTIN-13 check digit calculation:
      // '376034583359' (12 digits) -> check digit 2 -> '3760345833592'
      const gtinIdent1 = p1.product_identifiers.find((i) => i.identifier_type === 'gtin');
      assert.ok(gtinIdent1, 'GTIN identifier must be created');
      assert.equal(gtinIdent1.identifier_value, '3760345833592', 'GTIN-13 check digit 2 must be calculated correctly');
      console.log(`✓ Product 1 created with GTIN: ${gtinIdent1.identifier_value} and Material: ${p1.product_materials[0].materials.name}`);

      const p2 = await tx.tracefab_products.findFirst({
        where: { brand_organization_id: brandOrg.id, reference: `TF-BULK-02-${timestamp}` },
        include: { product_materials: { include: { materials: true } }, product_identifiers: true }
      });
      assert.ok(p2, 'Product 2 must exist in Neon DB');
      assert.equal(p2.product_materials.length, 2, 'Product 2 must have 2 blended materials');
      const gtinIdent2 = p2.product_identifiers.find((i) => i.identifier_type === 'gtin');
      assert.ok(gtinIdent2);
      assert.equal(gtinIdent2.identifier_value, '4006381333931', 'GTIN-13 check digit 1 must be calculated correctly');
      console.log(`✓ Product 2 created with GTIN: ${gtinIdent2.identifier_value} and 2 blended materials`);

      // TEST 2: Export Products CSV
      console.log('\n[STEP 2] Testing Products CSV Compliance Export...');
      const productsCsv = await exportProductsCsv(tx, brandOrg.id);
      assert.ok(productsCsv.length > 50, 'Products CSV must not be empty');
      assert.ok(productsCsv.includes(`TF-BULK-01-${timestamp}`), 'CSV must include newly imported reference 1');
      assert.ok(productsCsv.includes(`TF-BULK-02-${timestamp}`), 'CSV must include newly imported reference 2');
      assert.ok(productsCsv.includes('3760345833592'), 'CSV must include GTIN barcode');
      assert.ok(productsCsv.includes('Laine Mérinos'), 'CSV must include material composition');
      console.log('✓ Products CSV compliance export generated successfully with required headers and data');

      // TEST 3: Bulk Supplier Onboarding
      console.log('\n[STEP 3] Testing Bulk Supplier Onboarding...');
      const supplierRows = [
        {
          legalName: `Filature Guimarães SAS ${timestamp}`,
          displayName: `Filature Guimarães ${timestamp}`,
          email: `contact.guimaraes.${timestamp}@example.com`,
          countryCode: 'PT',
          tier: 'spinning'
        },
        {
          legalName: `Atelier Confection Tunisien ${timestamp}`,
          displayName: `Confection Tunis ${timestamp}`,
          email: `contact.confection.${timestamp}@example.com`,
          countryCode: 'TN',
          tier: 'assembly'
        }
      ];

      const suppResult = await bulkImportSuppliers(tx, brandOrg.id, supplierRows, testUser?.id);
      console.log('Bulk Supplier Import Summary:', {
        totalProcessed: suppResult.totalProcessed,
        createdCount: suppResult.createdCount,
        skippedCount: suppResult.skippedCount,
        errors: suppResult.errors,
        invitationsCount: suppResult.invitations.length
      });

      assert.equal(suppResult.totalProcessed, 2);
      assert.equal(suppResult.createdCount, 2, 'Both suppliers should be onboarded');
      assert.equal(suppResult.invitations.length, 2, 'Both invitations should be generated');

      // Verify relationship in database
      const rels = await tx.brand_supplier_relationships.findMany({
        where: { brand_organization_id: brandOrg.id },
        include: { organizations_brand_supplier_relationships_supplier_organization_idToorganizations: true }
      });
      const onboarded1 = rels.find((r) => r.organizations_brand_supplier_relationships_supplier_organization_idToorganizations?.legal_name === `Filature Guimarães SAS ${timestamp}`);
      assert.ok(onboarded1, 'Supplier 1 relationship must exist in Neon DB');
      console.log(`✓ Supplier "${onboarded1.organizations_brand_supplier_relationships_supplier_organization_idToorganizations.legal_name}" successfully onboarded via tracefab_invite_supplier`);

      // TEST 4: Export Suppliers CSV
      console.log('\n[STEP 4] Testing Suppliers CSV Compliance Export...');
      const suppliersCsv = await exportSuppliersCsv(tx, brandOrg.id);
      assert.ok(suppliersCsv.length > 50, 'Suppliers CSV must not be empty');
      assert.ok(suppliersCsv.includes(`Filature Guimarães SAS ${timestamp}`), 'CSV must include onboarded supplier');
      console.log('✓ Suppliers CSV compliance export generated successfully');

      // TEST 5: Regulatory Audit Dossier JSON (CSRD / ESPR)
      console.log('\n[STEP 5] Testing CSRD & ESPR Regulatory Audit Dossier JSON Export...');
      const dossier = await exportAuditDossierJson(tx, brandOrg.id);
      assert.ok(dossier, 'Dossier must be returned');
      assert.equal(dossier.metadata.standard, 'ESPR_CSRD_AUDIT_DOSSIER_V1');
      assert.equal(dossier.metadata.auditReadiness, 'READY_FOR_THIRD_PARTY_VERIFICATION');
      assert.equal(dossier.brand.id, brandOrg.id);
      assert.ok(Array.isArray(dossier.products), 'Dossier must include products');
      assert.ok(Array.isArray(dossier.suppliers), 'Dossier must include suppliers');
      assert.ok(Array.isArray(dossier.materials), 'Dossier must include materials');
      assert.ok(dossier.products.some((p) => p.reference === `TF-BULK-01-${timestamp}`), 'Dossier must include test product 1');
      console.log(`✓ Regulatory audit dossier generated with ${dossier.products.length} products, ${dossier.suppliers.length} suppliers, and ${dossier.materials.length} certified materials`);
    }, { timeout: 30000 });

    console.log('\n=============================================================');
    console.log('SUCCESS: All Chantier 8 Neon live integration tests passed!');
    console.log('=============================================================\n');
  } catch (err) {
    console.error('Test failed with error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
