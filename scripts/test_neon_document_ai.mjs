/**
 * Live Neon Database Integration Test: Document AI & Automated Verification
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  const userId = 'd0000000-0000-0000-0000-000000000001';
  const userEmail = 'doc-ai-test@neon.local';

  await prisma.$transaction(async (tx) => {
    // 1. Setup user & session context
    await tx.$executeRaw`
      INSERT INTO users (id, clerk_user_id, email, full_name)
      VALUES (${userId}::uuid, 'clerk_doc_ai', ${userEmail}, 'AI Auditor')
      ON CONFLICT (id) DO NOTHING;
    `;
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${userEmail}, true)`;

    // 2. Setup supplier organization & membership
    const orgRes = await tx.$queryRaw`
      INSERT INTO organizations (type, legal_name, display_name, country_code, status, created_by)
      VALUES ('supplier', 'Doc AI Test Factory Ltd', 'Doc AI Factory', 'PT', 'active', ${userId}::uuid)
      RETURNING id;
    `;
    const orgId = orgRes[0].id;

    await tx.$executeRaw`
      INSERT INTO organization_memberships (organization_id, user_id, role, status)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'owner', 'active');
    `;

    const supRes = await tx.$queryRaw`
      INSERT INTO suppliers (organization_id, onboarding_status, contact_email)
      VALUES (${orgId}::uuid, 'in_progress', ${userEmail})
      RETURNING id;
    `;
    const supplierId = supRes[0].id;

    // 3. Register a test document
    const docRes = await tx.$queryRaw`
      INSERT INTO documents (
        owner_organization_id,
        storage_bucket,
        storage_path,
        original_filename,
        content_type,
        byte_size,
        sha256,
        kind,
        status,
        visibility,
        uploaded_by
      )
      VALUES (
        ${orgId}::uuid,
        'tracefab-private',
        ${orgId} || '/test/cert.pdf',
        'gots_certificate_2025.pdf',
        'application/pdf',
        10240,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'certificate',
        'uploaded',
        'private',
        ${userId}::uuid
      )
      RETURNING id;
    `;
    const documentId = docRes[0].id;

    // Finalize upload so document status becomes available
    await tx.$executeRaw`
      SELECT * FROM tracefab_finalize_document_upload(
        ${documentId}::uuid,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        true,
        10240::bigint
      );
    `;

    // 4. Create an unverified certification linked to this document
    const certRes = await tx.$queryRaw`
      INSERT INTO certifications (
        owner_organization_id,
        supplier_id,
        standard_name,
        document_id,
        status,
        created_by
      )
      VALUES (
        ${orgId}::uuid,
        ${supplierId}::uuid,
        'GOTS Pending',
        ${documentId}::uuid,
        'documented',
        ${userId}::uuid
      )
      RETURNING id;
    `;
    const certId = certRes[0].id;

    // 5. Test PASSED verification
    const passedRes = await tx.$queryRaw`
      SELECT tracefab_apply_document_ai_verification(
        ${documentId}::uuid,
        'passed'::verification_status,
        'ai_document_forensics_v1'::text,
        'Preuve GOTS 7.0 certifiée par Control Union'::text,
        'gots'::text,
        'Global Organic Textile Standard (GOTS)'::text,
        'GOTS 7.0'::text,
        'CU812345GOTS-2025-01'::text,
        'Control Union Certifications'::text,
        '2025-01-15'::date,
        '2027-01-14'::date,
        0.98::numeric,
        '{"confidence": 0.98, "status": "passed"}'::jsonb
      ) AS payload;
    `;
    const payload = passedRes[0].payload;
    if (payload.status !== 'passed' || payload.certifications_updated !== 1) {
      throw new Error(`Expected passed status and 1 cert updated, got: ${JSON.stringify(payload)}`);
    }

    // Verify certification was updated to verified_by_reviewer
    const updatedCert = await tx.$queryRaw`
      SELECT standard_name, standard_code, issuer_name, certificate_number, status
      FROM certifications
      WHERE id = ${certId}::uuid;
    `;
    if (updatedCert[0].status !== 'verified_by_reviewer' || updatedCert[0].certificate_number !== 'CU812345GOTS-2025-01') {
      throw new Error(`Certification status or details not updated properly: ${JSON.stringify(updatedCert[0])}`);
    }

    // 6. Test EXPIRED verification
    const expiredRes = await tx.$queryRaw`
      SELECT tracefab_apply_document_ai_verification(
        ${documentId}::uuid,
        'expired'::verification_status,
        'ai_document_forensics_v1'::text,
        'Preuve documentaire expirée'::text,
        'gots'::text,
        'Global Organic Textile Standard (GOTS)'::text,
        'GOTS 7.0'::text,
        'CU812345GOTS-2025-01'::text,
        'Control Union Certifications'::text,
        '2023-01-15'::date,
        '2025-01-14'::date,
        0.95::numeric,
        '{"confidence": 0.95, "status": "expired"}'::jsonb
      ) AS payload;
    `;
    const expiredPayload = expiredRes[0].payload;
    if (expiredPayload.status !== 'expired') {
      throw new Error(`Expected expired status, got: ${JSON.stringify(expiredPayload)}`);
    }

    // Verify quality issue was generated
    const issues = await tx.$queryRaw`
      SELECT rule_key, severity, status
      FROM data_quality_issues
      WHERE owner_organization_id = ${orgId}::uuid
        AND rule_key = 'document_ai_certificate_expired';
    `;
    if (!issues[0] || issues[0].status !== 'open') {
      throw new Error(`Expected open data_quality_issue for expired certificate, got: ${JSON.stringify(issues)}`);
    }

    // 7. Cleanup test records
    await tx.$executeRaw`DELETE FROM data_quality_issues WHERE owner_organization_id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM verification_records WHERE owner_organization_id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM certifications WHERE owner_organization_id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM documents WHERE owner_organization_id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM suppliers WHERE organization_id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM organization_memberships WHERE organization_id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM organizations WHERE id = ${orgId}::uuid`;
    await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}::uuid`;

    console.log('✓ Neon live database test passed: Document AI verification, atomic certification upgrade, and quality issue synchronization!');
  }, { timeout: 25000, maxWait: 10000 });
} finally {
  await prisma.$disconnect();
}
