import { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';

const prisma = new PrismaClient();

async function run() {
  console.log('--- Chantier 5 Live Neon Integration Test: Corrective Action Plan (CAP) Workflow ---');

  await prisma.$transaction(async (tx) => {
    // 1. Setup brand and supplier organizations
    const brandOrg = await tx.organizations.create({
      data: {
        legal_name: 'Test Brand CAP SA',
        display_name: 'Brand CAP',
        type: 'brand',
      },
    });

    const supplierOrg = await tx.organizations.create({
      data: {
        legal_name: 'Test Supplier CAP Lda',
        display_name: 'Supplier CAP',
        type: 'supplier',
      },
    });

    // Setup users
    const brandUser = await tx.user.create({
      data: {
        clerkUserId: `user_brand_${Date.now()}`,
        email: `brand-${Date.now()}@test.tracefab.com`,
        fullName: 'Brand Quality Auditor',
      },
    });

    const supplierUser = await tx.user.create({
      data: {
        clerkUserId: `user_supplier_${Date.now()}`,
        email: `supplier-${Date.now()}@test.tracefab.com`,
        fullName: 'Supplier Quality Manager',
      },
    });

    // Setup memberships
    await tx.organization_memberships.create({
      data: {
        organization_id: brandOrg.id,
        user_id: brandUser.id,
        role: 'owner',
        status: 'active',
      },
    });

    await tx.organization_memberships.create({
      data: {
        organization_id: supplierOrg.id,
        user_id: supplierUser.id,
        role: 'owner',
        status: 'active',
      },
    });

    // Create a product
    const product = await tx.tracefab_products.create({
      data: {
        brand_organization_id: brandOrg.id,
        reference: 'CAP-TEST-001',
        name: 'Veste Éco-Conçue Test CAP',
        status: 'draft',
      },
    });

    // Create a data quality issue
    const issue = await tx.data_quality_issues.create({
      data: {
        organizations: { connect: { id: brandOrg.id } },
        tracefab_products: { connect: { id: product.id } },
        rule_key: 'product_missing_certified_scope',
        rule_version: '1.0',
        severity: 'blocking',
        message: 'Certificat GOTS 7.0 manquant pour la filature partenaire',
        status: 'open',
      },
    });

    console.log(`✓ Seeded product ${product.reference} and blocking issue ${issue.id}`);

    // Set RLS session context as brand user
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${brandUser.id}', true)`);
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${brandUser.email}', true)`);

    // 2. Brand creates a Corrective Action Plan (CAP)
    const capRows = await tx.$queryRawUnsafe(`
      SELECT * FROM tracefab_create_quality_cap(
        p_quality_issue_id := '${issue.id}'::uuid,
        p_supplier_organization_id := '${supplierOrg.id}'::uuid,
        p_title := 'Remédiation requise : transmission certificat GOTS filature',
        p_instructions := 'Veuillez téléverser le certificat de portée GOTS 7.0 en cours de validité délivré par Control Union.',
        p_due_date := (NOW() + interval '14 days')::date,
        p_priority := 'critical'
      );
    `);

    assert.equal(capRows.length, 1, 'CAP should be returned by stored procedure');
    const cap = capRows[0];
    assert.equal(cap.status, 'requested', 'Initial CAP status must be requested');
    assert.equal(cap.priority, 'critical', 'CAP priority must be critical');
    assert.equal(cap.quality_issue_id, issue.id, 'CAP must be linked to quality issue');
    assert.equal(cap.product_id, product.id, 'CAP must be linked to product');
    console.log(`✓ Stored procedure tracefab_create_quality_cap succeeded with id ${cap.id}`);

    // 3. Bilateral message exchange
    const brandMessage = await tx.quality_cap_messages.create({
      data: {
        cap_id: cap.id,
        sender_organization_id: brandOrg.id,
        sender_user_id: brandUser.id,
        sender_role: 'brand',
        message: 'Bonjour, ce blocage empêche le calcul PEF et la publication DPP du produit. Merci de traiter en priorité.',
      },
    });
    assert(brandMessage.id, 'Brand message must be created');

    // Switch context to supplier
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${supplierUser.id}', true)`);
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${supplierUser.email}', true)`);

    const supplierMessage = await tx.quality_cap_messages.create({
      data: {
        cap_id: cap.id,
        sender_organization_id: supplierOrg.id,
        sender_user_id: supplierUser.id,
        sender_role: 'supplier',
        message: 'Bien reçu, nous venons de renouveler notre audit annuel avec Control Union, nous vous transmettons le document scellé.',
      },
    });
    assert(supplierMessage.id, 'Supplier message must be created');
    console.log('✓ Bilateral communication messages logged on CAP thread');

    // 4. Supplier submits remediation evidence
    const submitRows = await tx.$queryRawUnsafe(`
      SELECT * FROM tracefab_submit_quality_remediation(
        p_cap_id := '${cap.id}'::uuid,
        p_response_summary := 'Audit annuel renouvelé avec succès le 05/10/2026. Scope certificate GOTS CU-892100 valide jusqu’au 04/10/2027.',
        p_message := 'Veuillez trouver ci-joint les éléments pour validation.'
      );
    `);

    assert.equal(submitRows.length, 1, 'Submission row returned');
    const submittedCap = submitRows[0];
    assert.equal(submittedCap.status, 'submitted', 'CAP status must now be submitted');
    assert(submittedCap.submitted_at, 'submitted_at must be populated');
    console.log('✓ Supplier remediation submitted via tracefab_submit_quality_remediation');

    // 5. Brand reviews and approves remediation
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${brandUser.id}', true)`);
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${brandUser.email}', true)`);

    const reviewRows = await tx.$queryRawUnsafe(`
      SELECT * FROM tracefab_review_quality_remediation(
        p_cap_id := '${cap.id}'::uuid,
        p_verdict := 'approved',
        p_review_notes := 'Certificat GOTS CU-892100 vérifié et conforme aux exigences du référentiel PEF. Clôture de l’anomalie.'
      );
    `);

    assert.equal(reviewRows.length, 1, 'Review row returned');
    const approvedCap = reviewRows[0];
    assert.equal(approvedCap.status, 'approved', 'CAP status must now be approved');
    assert(approvedCap.reviewed_at, 'reviewed_at must be populated');
    console.log('✓ Brand approved remediation via tracefab_review_quality_remediation');

    // 6. Verify that the underlying data_quality_issues record is automatically resolved
    const updatedIssue = await tx.data_quality_issues.findUnique({
      where: { id: issue.id },
    });
    assert.equal(updatedIssue.status, 'resolved', 'Quality issue must be automatically resolved upon CAP approval');
    console.log(`✓ Underlying data_quality_issues ${issue.id} automatically transitioned to 'resolved'`);

    // Roll back transaction to keep database clean
    throw new Error('ROLLBACK_INTENDED_CLEANUP');
  }, { timeout: 30000 }).catch((err) => {
    if (err.message === 'ROLLBACK_INTENDED_CLEANUP') {
      console.log('✓ Neon transaction rolled back cleanly');
    } else {
      throw err;
    }
  });

  await prisma.$disconnect();
  console.log('--- Chantier 5 Live Neon Integration Test PASSED ---');
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
