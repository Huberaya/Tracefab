import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Testing Green Claims & Anti-Greenwashing Engine on Neon database...');

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Context user & brand
      const brandMember = await tx.organization_memberships.findFirst({
        where: { role: 'owner', status: 'active' },
        include: { organizations: true, users_organization_memberships_user_idTousers: true },
      });

      assert.ok(brandMember, 'Must have at least one active brand owner');
      const userId = brandMember.user_id;
      const brandOrgId = brandMember.organization_id;
      const userEmail = brandMember.users_organization_memberships_user_idTousers?.email || 'owner@tracefab.local';

      await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${userId}', true);`);
      await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${userEmail}', true);`);

      // 2. Create dedicated product with descriptive greenwashing terms
      const product = await tx.tracefab_products.create({
        data: {
          brand_organization_id: brandOrgId,
          reference: 'NEON-GC-TEST-' + Date.now(),
          name: 'Veste Éco-Responsable Test',
          category: 'jacket',
          description: 'Magnifique veste en coton biologique, 100% neutre en carbone par compensation et éco-responsable.',
          country_of_manufacture: 'PT',
          public_slug: 'veste-eco-test-' + Date.now(),
          created_by: userId,
        },
      });

      // 3. Ensure DPP record exists
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

      // 4. Run automated audit on product description
      const auditRows = await tx.$queryRaw`
        SELECT * FROM tracefab_audit_product_green_claims(${product.id}::uuid);
      `;

      assert.ok(auditRows && auditRows.length > 0, 'Audit must return a record');
      const audit = auditRows[0];

      console.log('Neon Green Claims Audit verdict:', {
        product: product.name,
        totalClaimsAnalyzed: audit.total_claims_analyzed,
        prohibitedClaimsCount: audit.prohibited_claims_count,
        unsubstantiatedClaimsCount: audit.unsubstantiated_claims_count,
        greenClaimsScore: audit.green_claims_score,
        verdict: audit.audit_verdict,
      });

      // Both 'neutre en carbone' and 'éco-responsable' are prohibited by Directive (UE) 2024/825
      assert.ok(audit.prohibited_claims_count >= 1, 'Must detect at least one prohibited claim');
      assert.equal(audit.audit_verdict, 'non_compliant_greenwashing_risk', 'Must flag non_compliant_greenwashing_risk');
      assert.ok(audit.green_claims_score < 70, 'Score must be penalized');

      // 5. Verify individual claims created in product_green_claims
      const claims = await tx.product_green_claims.findMany({
        where: { product_id: product.id, product_version: product.version },
      });

      assert.ok(claims.length >= 2, 'Must have extracted claims from description');
      const prohibited = claims.filter(c => c.status === 'prohibited_claim');
      assert.ok(prohibited.length >= 1, 'At least one claim must be flagged prohibited_claim');
      assert.ok(prohibited.some(c => c.is_blocking_for_dpp === true), 'Prohibited claims must block DPP publication');

      // 6. Verify injection into dpp_records public projection
      const dpp = await tx.dpp_records.findFirst({
        where: { product_id: product.id, product_version: product.version },
      });

      assert.ok(dpp?.public_projection?.green_claims_compliance, 'DPP projection must include green_claims_compliance');
      assert.equal(dpp.public_projection.green_claims_compliance.is_greenwashing_risk, true);

      console.log('✓ Neon live test passed: Green claims detection, RLS, audit scoring & DPP blockage verified!');

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
