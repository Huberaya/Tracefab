import { PrismaClient } from '@prisma/client';
import { requireTestDatabase } from './_lib/test-database.mjs';
import { randomUUID } from 'crypto';

/*
 * Le client vient du helper, pas de `new PrismaClient()` : généré en
 * engineType « client », il exige un adaptateur de pilote, et c'est le helper
 * qui démarre la base locale quand DATABASE_URL est absent.
 */
const { prisma } = await requireTestDatabase();

async function runTests() {
  console.log('=== TEST SUITE CHANTIER 7: MASS BALANCE & ANTI-FRAUD ENGINE (NEON POSTGRES VIA PRISMA) ===\n');

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Setup mock tenant, supplier, product
      const rand = Math.floor(Math.random() * 900000 + 100000);
      const brandOrgId = randomUUID();
      const supplierOrgId = randomUUID();
      const userId = randomUUID();
      const productId = randomUUID();

      console.log('1. Setting up tenant and product test fixtures...');
      await tx.$executeRawUnsafe(`
        INSERT INTO organizations (id, legal_name, display_name, type, country_code, clerk_organization_id)
        VALUES 
          ('${brandOrgId}', 'MassBalance Test Brand SA', 'MassBalance Brand', 'brand', 'FR', 'org_mb_brand_${rand}'),
          ('${supplierOrgId}', 'MassBalance Test Mill Ltd', 'MassBalance Mill', 'supplier', 'PT', 'org_mb_supp_${rand}')
        ON CONFLICT DO NOTHING;
      `);

      await tx.$executeRawUnsafe(`
        INSERT INTO suppliers (organization_id, onboarding_status, activity_types, employee_count_range, year_established)
        VALUES ('${supplierOrgId}', 'approved', ARRAY['weaving', 'dyeing'], '51_250', 2004)
        ON CONFLICT DO NOTHING;
      `);

      await tx.$executeRawUnsafe(`
        INSERT INTO users (id, email, clerk_user_id, full_name)
        VALUES ('${userId}', 'compliance-${rand}@massbalancetest.com', 'user_mb_${rand}', 'Compliance Manager')
        ON CONFLICT DO NOTHING;
      `);

      // Give user membership in both orgs so they can act on brand and supplier
      await tx.$executeRawUnsafe(`
        INSERT INTO organization_memberships (id, organization_id, user_id, role, clerk_membership_id)
        VALUES 
          (gen_random_uuid(), '${brandOrgId}', '${userId}', 'admin', 'mem_brand_${rand}'),
          (gen_random_uuid(), '${supplierOrgId}', '${userId}', 'admin', 'mem_supp_${rand}')
        ON CONFLICT DO NOTHING;
      `);

      await tx.$executeRawUnsafe(`
        INSERT INTO tracefab_products (id, brand_organization_id, name, reference, category, status, weight_grams)
        VALUES ('${productId}', '${brandOrgId}', 'Chemise Popeline Coton Bio 100%', 'MB-SHIRT-001', 'apparel', 'active', 250)
        ON CONFLICT DO NOTHING;
      `);

      // Set session contexts for transaction
      await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${userId}', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', 'compliance-${rand}@massbalancetest.com', true)`);

      console.log('✓ Fixtures initialized successfully.\n');

      // 2. Register a Transaction Certificate (TC) via stored procedure
      console.log('2. Testing TC Registration (tracefab_register_transaction_certificate)...');
      const tcNumber = `TC-GOTS-2026-${Math.floor(Math.random() * 900000 + 100000)}`;
      const regRes = await tx.$queryRawUnsafe(`
        SELECT * FROM tracefab_register_transaction_certificate(
          p_tc_number := $1,
          p_standard := 'gots',
          p_issuer_name := 'Control Union Inspections B.V.',
          p_seller_organization_id := $2::uuid,
          p_buyer_organization_id := $3::uuid,
          p_certified_material_name := '100% Coton Biologique Peigné',
          p_total_certified_weight_kg := 1000.00,
          p_total_certified_meters := 4000.0,
          p_issue_date := '2026-03-01'::date,
          p_expiry_date := '2027-03-01'::date
        );
      `, tcNumber, supplierOrgId, brandOrgId);

      const tc = regRes[0];
      const tcId = tc.id;
      console.log(`✓ TC registered with ID: ${tcId}`);

      // Verify TC fields
      const checkTc = await tx.$queryRawUnsafe(`SELECT * FROM transaction_certificates WHERE id = $1::uuid`, tcId);
      const tcRow = checkTc[0];
      console.log(`✓ Initial balance confirmed: Total=${tcRow.total_certified_weight_kg} kg, Allocated=${tcRow.allocated_weight_kg} kg\n`);

      if (Number(tcRow.total_certified_weight_kg) !== 1000 || Number(tcRow.allocated_weight_kg) !== 0) {
        throw new Error(`Unexpected initial TC weights: ${JSON.stringify(tcRow)}`);
      }

      // 3. Test Partial Allocation to a Product
      console.log('3. Testing Partial Allocation (tracefab_allocate_tc_quantity) for 400 kg...');
      const alloc1Res = await tx.$queryRawUnsafe(`
        SELECT * FROM tracefab_allocate_tc_quantity(
          p_tc_id := $1::uuid,
          p_product_id := $2::uuid,
          p_allocated_weight_kg := 400.00,
          p_allocated_meters := 1600.0,
          p_notes := 'Allocated for Spring 2026 Batch 1'
        );
      `, tcId, productId);

      const alloc1Id = alloc1Res[0].id;
      console.log(`✓ Allocation 1 created with ID: ${alloc1Id}`);

      // Verify updated allocated weight
      const checkTc2 = await tx.$queryRawUnsafe(`SELECT allocated_weight_kg, total_certified_weight_kg FROM transaction_certificates WHERE id = $1::uuid`, tcId);
      console.log(`✓ TC updated balance: Allocated=${checkTc2[0].allocated_weight_kg} kg, Total=${checkTc2[0].total_certified_weight_kg} kg`);
      if (Number(checkTc2[0].allocated_weight_kg) !== 400) {
        throw new Error(`Expected 400 allocated, got ${checkTc2[0].allocated_weight_kg}`);
      }

      // 4. Test Second Allocation for 300 kg
      console.log('\n4. Testing Second Allocation for 300 kg...');
      const alloc2Res = await tx.$queryRawUnsafe(`
        SELECT * FROM tracefab_allocate_tc_quantity(
          p_tc_id := $1::uuid,
          p_product_id := $2::uuid,
          p_allocated_weight_kg := 300.00,
          p_allocated_meters := 1200.0,
          p_notes := 'Allocated for Spring 2026 Batch 2'
        );
      `, tcId, productId);

      const checkTc3 = await tx.$queryRawUnsafe(`SELECT allocated_weight_kg FROM transaction_certificates WHERE id = $1::uuid`, tcId);
      console.log(`✓ TC updated balance: Allocated=${checkTc3[0].allocated_weight_kg} kg`);
      if (Number(checkTc3[0].allocated_weight_kg) !== 700) {
        throw new Error(`Expected 700 allocated, got ${checkTc3[0].allocated_weight_kg}`);
      }

      // 5. Test Anti-Double-Spending Protection (Try to allocate 350 kg when only 300 kg remains)
      console.log('\n5. Testing Anti-Double-Spending Lock (Attempting to allocate 350 kg when remaining is 300 kg)...');
      let doubleSpendPrevented = false;
      await tx.$executeRawUnsafe(`SAVEPOINT double_spend_test;`);
      try {
        await tx.$queryRawUnsafe(`
          SELECT * FROM tracefab_allocate_tc_quantity(
            p_tc_id := $1::uuid,
            p_product_id := $2::uuid,
            p_allocated_weight_kg := 350.00
          );
        `, tcId, productId);
      } catch (err) {
        if (err.message.includes('tc_quantity_exceeded_double_spending_prevented')) {
          doubleSpendPrevented = true;
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT double_spend_test;`);
          console.log(`✓ Anti-double-spending trigger successfully prevented over-allocation!`);
        } else {
          throw err;
        }
      }
      if (!doubleSpendPrevented) {
        throw new Error('FAIL: Anti-double-spending check did not raise an exception!');
      }

      // 6. Test Volumetric Mass-Balance Reconciliation Engine
      // Total allocated = 700 kg.
      // Product weight = 250 grams (0.25 kg / unit).
      // Compliant: 2500 units @ 0.25 kg = 625 kg theoretical finished. With 10% cutting waste: 625 * 1.10 = 687.5 kg required.
      // 700 kg covers 687.5 kg required (coverage ratio = 700 / 687.5 = 101.8% -> fully_covered!).
      console.log('\n6. Testing Volumetric Reconciliation - Compliant Run (2500 units @ 250g with 10% cutting waste)...');
      const reconCompliantRes = await tx.$queryRawUnsafe(`
        SELECT * FROM tracefab_reconcile_mass_balance(
          p_product_id := $1::uuid,
          p_production_volume_units := 2500,
          p_cutting_waste_pct := 10.00,
          p_batch_reference := 'BATCH-2026-COMPLIANT'
        );
      `, productId);

      const r1 = reconCompliantRes[0];
      console.log(`✓ Compliant Reconciliation result:
         - Verdict: ${r1.verdict}
         - Fraud Risk Score: ${r1.fraud_risk_score}
         - Allocated Certified: ${r1.allocated_certified_kg} kg
         - Theoretical Required: ${r1.theoretical_required_kg} kg
         - Coverage Ratio: ${r1.coverage_ratio_pct}%
         - Summary: ${r1.summary}`);

      if (r1.verdict !== 'fully_covered' || r1.fraud_risk_score !== 0) {
        throw new Error(`Expected fully_covered/0, got ${r1.verdict}/${r1.fraud_risk_score}`);
      }

      // 7. Test Volumetric Fraud Detection - Fraudulent Overclaim Run (6000 units)
      // 6000 units @ 0.25 kg = 1500 kg. With 10% waste = 1650 kg required.
      // Certified allocated is only 700 kg. Coverage ratio is 700 / 1650 = 42.4% (< 50% -> severe_deficit / fraud risk 95 / blocking issue!).
      console.log('\n7. Testing Volumetric Fraud Detection - Fraudulent Overclaim Run (6000 units)...');
      const reconFraudRes = await tx.$queryRawUnsafe(`
        SELECT * FROM tracefab_reconcile_mass_balance(
          p_product_id := $1::uuid,
          p_production_volume_units := 6000,
          p_cutting_waste_pct := 10.00,
          p_batch_reference := 'BATCH-2026-SUSPECT'
        );
      `, productId);

      const r2 = reconFraudRes[0];
      console.log(`✓ Fraud Detection Reconciliation result:
         - Verdict: ${r2.verdict}
         - Fraud Risk Score: ${r2.fraud_risk_score}
         - Deficit: ${r2.deficit_kg} kg
         - Coverage Ratio: ${r2.coverage_ratio_pct}%
         - Blocking Issue Created: ${r2.blocking_issue_created}
         - Quality Issue ID: ${r2.quality_issue_id}`);

      if (r2.verdict !== 'severe_deficit' || r2.fraud_risk_score !== 95 || !r2.blocking_issue_created) {
        throw new Error(`Expected severe_deficit/95/blocking_created=true, got ${r2.verdict}/${r2.fraud_risk_score}`);
      }

      // Verify blocking data quality issue
      const issueRes = await tx.$queryRawUnsafe(`
        SELECT * FROM data_quality_issues 
        WHERE id = $1::uuid
      `, r2.quality_issue_id);
      if (issueRes.length === 0) {
        throw new Error('Expected data_quality_issues record for volumetric fraud!');
      }
      console.log(`✓ Blocking Quality Issue verified: rule=${issueRes[0].rule_key}, severity=${issueRes[0].severity}, message=${issueRes[0].message}`);

      console.log('\n=== ALL CHANTIER 7 NEON DB TESTS PASSED WITH 100% SUCCESS! ===\n');
    }, { timeout: 30000, maxWait: 10000 });
  } catch (err) {
    console.error('TEST FAILED:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
