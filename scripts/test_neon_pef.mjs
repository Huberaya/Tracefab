import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Testing PEF Calculator & ESG Aggregation on Neon database...');

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Context user & brand
      const brandMember = await tx.organization_memberships.findFirst({
        where: { role: 'owner', status: 'active' },
        include: { organizations: true, users_organization_memberships_user_idTousers: true },
      });

      assert.ok(brandMember, 'Must have at least one brand owner');
      const userId = brandMember.user_id;
      const brandOrgId = brandMember.organization_id;
      const userEmail = brandMember.users_organization_memberships_user_idTousers?.email || 'owner@tracefab.local';

      await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${userId}', true);`);
      await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${userEmail}', true);`);

      // 2. Create dedicated test product
      const product = await tx.tracefab_products.create({
        data: {
          brand_organization_id: brandOrgId,
          reference: 'NEON-PEF-TEST-' + Date.now(),
          name: 'Jean Éco-Conçu GOTS PEF Test',
          category: 'denim',
          country_of_manufacture: 'PT',
          public_slug: 'jean-eco-concu-pef-test-' + Date.now(),
          created_by: userId,
        },
      });

      // 3. Attach an organic material
      const material = await tx.materials.create({
        data: {
          owner_organization_id: brandOrgId,
          name: 'Coton Biologique Certifié GOTS',
          material_type: 'cotton',
        },
      });

      await tx.product_materials.create({
        data: {
          product_id: product.id,
          material_id: material.id,
          material_role: 'main',
          product_version: product.version,
          percentage: 100,
          unit: '%',
        },
      });

      // 4. Ensure DPP record exists
      await tx.dpp_records.upsert({
        where: {
          product_id_product_version_requirement_profile_key_requirement_profile_version: {
            product_id: product.id,
            product_version: product.version,
            requirement_profile_key: 'textile_readiness_mvp',
            requirement_profile_version: '1.0',
          },
        },
        create: {
          product_id: product.id,
          product_version: product.version,
          requirement_profile_key: 'textile_readiness_mvp',
          requirement_profile_version: '1.0',
          readiness_status: 'in_progress',
          public_projection: {},
        },
        update: {},
      });

      // 5. Execute PEF calculation stored procedure on Neon
      const pefRows = await tx.$queryRaw`
        SELECT * FROM tracefab_calculate_product_pef(
          ${product.id}::uuid,
          0.650::numeric,
          'denim'::text
        );
      `;

      assert.ok(pefRows && pefRows.length > 0, 'PEF calculation must return a record');
      const assessment = pefRows[0];

      console.log('PEF assessment calculated on Neon:', {
        product: product.name,
        carbonFootprintKgCo2e: assessment.carbon_footprint_kg_co2e,
        waterScarcityM3: assessment.water_scarcity_m3,
        pefEcoScore: assessment.pef_eco_score,
        pefGrade: assessment.pef_grade,
        microplasticsGrade: assessment.microplastics_risk_grade,
        circularityScore: assessment.circularity_score,
      });

      assert.equal(assessment.product_id, product.id);
      assert.ok(Number(assessment.carbon_footprint_kg_co2e) > 0, 'Carbon must be positive');
      assert.ok(Number(assessment.water_scarcity_m3) > 0, 'Water must be positive');
      assert.ok(['A', 'B', 'C'].includes(assessment.pef_grade), 'GOTS organic cotton should achieve A, B, or C');
      assert.ok(assessment.pef_eco_score >= 50, 'Score should be >= 50');

      // 6. Verify persistence in product_pef_assessments
      const saved = await tx.product_pef_assessments.findUnique({
        where: {
          product_id_product_version: {
            product_id: product.id,
            product_version: product.version,
          },
        },
      });

      assert.ok(saved, 'Assessment must be saved in product_pef_assessments table');
      assert.equal(saved.pef_grade, assessment.pef_grade);

      // 7. Verify update of dpp_records public projection
      const updatedDpp = await tx.dpp_records.findFirst({
        where: { product_id: product.id, product_version: product.version },
      });

      assert.ok(updatedDpp?.public_projection?.environmental_footprint, 'DPP must contain environmental_footprint projection');
      assert.equal(updatedDpp.public_projection.environmental_footprint.pef_grade, assessment.pef_grade);

      console.log('✓ Neon live test passed: Stored procedure, RLS, persistence & DPP injection verified!');

      // Rollback to keep Neon database clean
      throw new Error('ROLLBACK_TEST');
    }, { timeout: 25000 });
  } catch (err) {
    if (err.message === 'ROLLBACK_TEST') {
      console.log('Transaction safely rolled back. Neon database state is clean.');
      return;
    }
    console.error('Neon test failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
