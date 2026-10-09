/**
 * Live Neon Database Integration Test: PLM/ERP & GS1 Ingestion Pipeline
 */
import { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';

const prisma = new PrismaClient();

try {
  const userId = 'b0000000-0000-0000-0000-000000000001';
  const userEmail = 'plm-tester@neon.local';

  await prisma.$transaction(async (tx) => {
    // 1. Setup user & session context
    await tx.$executeRaw`
      INSERT INTO users (id, clerk_user_id, email, full_name)
      VALUES (${userId}::uuid, 'clerk_plm_test', ${userEmail}, 'PLM Ingestion Tester')
      ON CONFLICT (id) DO NOTHING;
    `;
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${userEmail}, true)`;

    // 2. Setup brand organization & membership
    const orgRes = await tx.$queryRaw`
      INSERT INTO organizations (type, legal_name, display_name, country_code, status, created_by)
      VALUES ('brand', 'Neon Fashion Group Ltd', 'Neon Fashion', 'FR', 'active', ${userId}::uuid)
      RETURNING id;
    `;
    const brandOrgId = orgRes[0].id;

    await tx.$executeRaw`
      INSERT INTO organization_memberships (organization_id, user_id, role, status)
      VALUES (${brandOrgId}::uuid, ${userId}::uuid, 'owner', 'active');
    `;

    // 3. Prepare enterprise Centric PLM payload with BOM, GTIN-13, and supply chain steps
    const samplePlmPayload = {
      system: 'centric_plm',
      styles: [
        {
          styleNumber: 'NEON-CTR-AW26-DENIM',
          styleName: 'Veste Denim Organique AW26',
          department: 'Denim',
          colorway: 'Raw Indigo',
          gtin: '3760345833592',
          sku: 'VD-RAW-01',
          countryOfManufacture: 'PT',
          weightGrams: 720,
          bom: [
            {
              materialName: 'Denim Coton Bio GOTS',
              materialType: 'fabric',
              role: 'main',
              percentage: 98.0,
              originCountryCode: 'PT',
              composition: { organic_cotton: 100 },
            },
            {
              materialName: 'Boutons Laiton',
              materialType: 'trim',
              role: 'hardware',
              percentage: 2.0,
              composition: { brass: 100 },
            },
          ],
          productionSteps: [
            { label: 'Filature Guimarães', processCode: 'spinning', country: 'PT' },
            { label: 'Tissage Barcelos', processCode: 'weaving', country: 'PT' },
            { label: 'Confection Porto', processCode: 'assembly', country: 'PT' },
          ],
        },
      ],
    };

    console.log('Executing tracefab_ingest_plm_erp_payload on Neon database...');
    const ingestRes = await tx.$queryRaw`
      SELECT tracefab_ingest_plm_erp_payload(
        ${brandOrgId}::uuid,
        'centric_plm',
        ${JSON.stringify(samplePlmPayload)}::jsonb,
        NULL
      ) AS res;
    `;

    const summary = ingestRes[0].res;
    console.log('Ingestion result:', summary);
    assert.equal(summary.success, true);
    assert.equal(summary.productsCreated, 1);
    assert.equal(summary.materialsCreated, 2);
    assert.equal(summary.identifiersCreated, 1);
    assert.equal(summary.nodesCreated, 3);

    // 4. Verify created product in Neon
    const product = await tx.tracefab_products.findFirst({
      where: { brand_organization_id: brandOrgId, reference: 'NEON-CTR-AW26-DENIM' },
      include: {
        product_identifiers: true,
        product_materials: { include: { materials: true } },
        supply_chain_nodes: true,
        supply_chain_links: true,
      },
    });

    assert.ok(product, 'Product must exist in Neon');
    assert.equal(product.name, 'Veste Denim Organique AW26');
    assert.equal(product.country_of_manufacture, 'PT');
    assert.equal(product.product_identifiers.length, 1);
    assert.equal(product.product_identifiers[0].identifier_type, 'gtin');
    assert.equal(product.product_identifiers[0].identifier_value, '3760345833592');

    assert.equal(product.product_materials.length, 2);
    assert.equal(product.supply_chain_links.length, 2);

    const linkedNodeIds = [...new Set(product.supply_chain_links.flatMap(l => [l.source_node_id, l.target_node_id]))];
    assert.equal(linkedNodeIds.length, 3, 'All 3 traceability stages must be linked into the DAG');

    const createdNodes = await tx.supply_chain_nodes.findMany({
      where: { id: { in: linkedNodeIds } },
    });
    assert.equal(createdNodes.length, 3);
    const processCodes = createdNodes.map(n => n.process_code).sort();
    assert.deepEqual(processCodes, ['assembly', 'spinning', 'weaving']);

    // 5. Verify sync job recorded in Neon
    const job = await tx.plm_erp_sync_jobs.findFirst({
      where: { brand_organization_id: brandOrgId },
      orderBy: { created_at: 'desc' },
    });

    assert.ok(job, 'Sync job must be logged in plm_erp_sync_jobs');
    assert.equal(job.source_system, 'centric_plm');
    assert.equal(job.status, 'completed');
    assert.equal(job.total_records, 1);
    assert.equal(job.products_created, 1);

    // 6. Test Delta / Update Ingestion (Idempotence & Updates)
    const updatePayload = {
      system: 'centric_plm',
      styles: [
        {
          styleNumber: 'NEON-CTR-AW26-DENIM',
          styleName: 'Veste Denim Organique AW26 (Mise à jour)',
          department: 'Denim',
          colorway: 'Faded Indigo',
          gtin: '3760345833592',
          countryOfManufacture: 'PT',
        },
      ],
    };

    const updateRes = await tx.$queryRaw`
      SELECT tracefab_ingest_plm_erp_payload(
        ${brandOrgId}::uuid,
        'centric_plm',
        ${JSON.stringify(updatePayload)}::jsonb,
        NULL
      ) AS res;
    `;
    const updateSummary = updateRes[0].res;
    assert.equal(updateSummary.productsCreated, 0, 'Should not duplicate product');
    assert.equal(updateSummary.productsUpdated, 1, 'Should update existing product');

    console.log('✓ Neon live database test passed: Enterprise PLM/ERP & GS1 ingestion verified!');

    // Rollback changes to keep live database pristine
    throw new Error('ROLLBACK_TEST_SUCCESS');
  }, { timeout: 25000 });
} catch (error) {
  if (error.message === 'ROLLBACK_TEST_SUCCESS') {
    console.log('Transaction safely rolled back. Neon database state is clean.');
    process.exit(0);
  }
  console.error('Neon test failed:', error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
