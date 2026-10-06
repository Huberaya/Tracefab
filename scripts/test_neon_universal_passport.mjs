import { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';

const prisma = new PrismaClient();

async function run() {
  console.log('--- Live Neon Integration Test: Universal Supplier Passport (1-Clic) & Virality ---');

  await prisma.$transaction(async (tx) => {
    // 1. Setup a test supplier organization
    const supplierOrg = await tx.organizations.create({
      data: {
        legal_name: 'Guimarães Weaving Mills SA',
        display_name: 'Guimarães Weaving',
        type: 'supplier',
        country_code: 'PT',
      },
    });

    const supplierUser = await tx.user.create({
      data: {
        clerkUserId: `user_supp_${Date.now()}`,
        email: `contact-${Date.now()}@guimaraes-textile.test`,
        fullName: 'Manuel Oliveira',
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

    const supplier = await tx.suppliers.create({
      data: {
        organization_id: supplierOrg.id,
        onboarding_status: 'approved',
        activity_types: ['weaving', 'dyeing'],
        profile_summary: 'Spécialiste du sergé et popeline de coton biologique certifié pour le prêt-à-porter.',
        contact_name: 'Manuel Oliveira',
        contact_email: supplierUser.email,
        employee_count_range: '51_250',
        year_established: 2004,
        profile_completion: 88,
      },
    });

    // Add a site and a certification
    const site = await tx.supplier_sites.create({
      data: {
        supplier_id: supplier.id,
        name: 'Usine Principale Guimarães',
        country_code: 'PT',
        city: 'Guimarães',
        address: 'Zona Industrial de Ponte, Lote 42',
        postal_code: '4805-000',
        activity_types: ['weaving'],
        is_active: true,
      },
    });

    const cert = await tx.certifications.create({
      data: {
        owner_organization_id: supplierOrg.id,
        supplier_id: supplier.id,
        standard_name: 'Global Organic Textile Standard',
        standard_code: 'GOTS 7.0',
        issuer_name: 'Control Union',
        certificate_number: 'CU-998877-GOTS',
        status: 'verified_by_reviewer',
        expires_at: new Date(Date.now() + 365 * 86400000),
      },
    });

    console.log(`✓ Seeded supplier ${supplierOrg.display_name} with site ${site.city} and GOTS certification`);

    // Set RLS context for the supplier user
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${supplierUser.id}', true)`);
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${supplierUser.email}', true)`);

    // 2. Supplier requests/initializes Universal Passport
    const passportRows = await tx.$queryRawUnsafe(`
      SELECT * FROM tracefab_get_or_create_supplier_passport('${supplierOrg.id}'::uuid);
    `);
    assert.equal(passportRows.length, 1, 'Passport row must be created');
    const passport = passportRows[0];
    assert(passport.slug, 'Passport must have a generated slug');
    assert(passport.share_token, 'Passport must have a generated private share_token');
    assert.equal(passport.is_public, true, 'Passport should be public by default');
    assert.equal(passport.trade_secret_mode, 'redacted', 'Default mode must be redacted');
    console.log(`✓ Stored procedure tracefab_get_or_create_supplier_passport returned slug: ${passport.slug}`);

    // 3. Supplier updates passport settings (Trade Secret settings)
    const updatedRows = await tx.$queryRawUnsafe(`
      SELECT * FROM tracefab_update_supplier_passport(
        p_supplier_organization_id := '${supplierOrg.id}'::uuid,
        p_headline := 'Manufacture portugaise certifiée GOTS pour marques éco-responsables',
        p_trade_secret_mode := 'redacted',
        p_disclosed_sections := '{"sites": true, "certifications": true, "materials": true, "quality_score": true, "exact_addresses": false}'::jsonb
      );
    `);
    assert.equal(updatedRows.length, 1, 'Updated row must be returned');
    assert.equal(updatedRows[0].headline, 'Manufacture portugaise certifiée GOTS pour marques éco-responsables');
    console.log('✓ Stored procedure tracefab_update_supplier_passport updated headline and disclosure');

    // 4. Anonymous brand visits the public passport via slug
    // Clear user context to simulate unauthenticated public visitor
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '', true)`);
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '', true)`);

    const publicViewRows = await tx.$queryRawUnsafe(`
      SELECT tracefab_get_public_supplier_passport('${passport.slug}') as public_data;
    `);
    assert.equal(publicViewRows.length, 1, 'Public data must be returned');
    const publicData = typeof publicViewRows[0].public_data === 'string'
      ? JSON.parse(publicViewRows[0].public_data)
      : publicViewRows[0].public_data;

    assert.equal(publicData.supplier.displayName, 'Guimarães Weaving');
    assert.equal(publicData.passport.viewsCount, 1, 'View count must be automatically incremented to 1');
    assert.equal(publicData.sites.length, 1, 'Site must be returned');
    // Verify trade secret redaction: exact address should be masked!
    assert.equal(publicData.sites[0].address, '[Secret d\'affaires masqué]', 'Exact street address must be redacted');
    assert.equal(publicData.sites[0].city, 'Guimarães', 'City must remain visible');
    assert.equal(publicData.certifications.length, 1, 'Certification must be returned');
    assert.equal(publicData.certifications[0].isVerified, true, 'isVerified should be true for verified_by_reviewer');
    console.log('✓ Public resolution verified: trade secret address masked, view counter incremented to 1');

    // 5. Inbound conversion / Viral loop: Brand submits an access request
    const brandEmail = `sourcing-${Date.now()}@french-brand-luxury.com`;
    const requestRows = await tx.$queryRawUnsafe(`
      SELECT tracefab_request_passport_access(
        p_token_or_slug := '${passport.slug}',
        p_requester_email := '${brandEmail}',
        p_requester_name := 'Camille Dubois',
        p_requester_company := 'Maison Soie & Coton Paris',
        p_message := 'Nous préparons notre collection printemps 2027 et souhaitons auditer vos certificats de tissage.',
        p_nda_accepted := true
      ) as request_res;
    `);
    assert.equal(requestRows.length, 1, 'Request access row returned');
    const reqRes = typeof requestRows[0].request_res === 'string'
      ? JSON.parse(requestRows[0].request_res)
      : requestRows[0].request_res;
    assert(reqRes.requestId, 'Request ID must be returned');
    assert.equal(reqRes.status, 'pending', 'Initial request status must be pending');
    console.log(`✓ External brand inbound lead registered: request ${reqRes.requestId}`);

    // 6. Supplier reviews and approves brand access
    // Switch back to supplier context
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_id', '${supplierUser.id}', true)`);
    await tx.$executeRawUnsafe(`SELECT set_config('tracefab.user_email', '${supplierUser.email}', true)`);

    const reviewRows = await tx.$queryRawUnsafe(`
      SELECT * FROM tracefab_review_passport_access(
        p_request_id := '${reqRes.requestId}'::uuid,
        p_verdict := 'approved'
      );
    `);
    assert.equal(reviewRows.length, 1, 'Review row returned');
    assert.equal(reviewRows[0].status, 'approved', 'Request status must now be approved');
    console.log('✓ Supplier approved brand request via tracefab_review_passport_access');

    // Clean rollback
    throw new Error('ROLLBACK_INTENDED_CLEANUP');
  }, { timeout: 30000 }).catch((err) => {
    if (err.message === 'ROLLBACK_INTENDED_CLEANUP') {
      console.log('✓ Neon transaction rolled back cleanly');
    } else {
      throw err;
    }
  });

  await prisma.$disconnect();
  console.log('--- Live Neon Universal Supplier Passport Integration Test PASSED ---');
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
