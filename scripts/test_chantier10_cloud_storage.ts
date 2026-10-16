import assert from 'node:assert/strict';
import { analyzeDocumentBytes } from '../api/_lib/cloud-storage/antivirus-scanner.ts';
import { configuredStorageQuota, DEFAULT_STORAGE_QUOTA_BYTES } from '../api/_lib/cloud-storage/quota-manager.ts';
import { safeObjectFilename, storageObjectKey } from '../api/_lib/storage.ts';

console.log('=== TEST SUITE CHANTIER 10: CLOUD STORAGE & FORENSIC ANTIVIRUS ===\n');

// 1. Antivirus & Heuristic Forensics Tests
console.log('[TEST 1] Testing Forensic Antivirus Scanner with Clean & Threat Files...');
{
  // 1.1 Clean PDF Document
  const cleanPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
  const cleanResult = analyzeDocumentBytes(cleanPdf, 'gots-cert.pdf', 'application/pdf');
  assert.equal(cleanResult.clean, true, 'Clean PDF must be marked clean');
  assert.equal(cleanResult.status, 'clean');
  assert.equal(cleanResult.details.fileHeaderValid, true);
  assert.equal(cleanResult.details.eicarDetected, false);
  assert.equal(cleanResult.details.embeddedScriptsFound, false);
  console.log('✓ Clean PDF document verified and passed');

  // 1.2 EICAR AntiVirus Test Signature
  const eicarFile = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const eicarResult = analyzeDocumentBytes(eicarFile, 'test-eicar.com', 'application/octet-stream');
  assert.equal(eicarResult.clean, false, 'EICAR file must NOT be marked clean');
  assert.equal(eicarResult.status, 'infected');
  assert.equal(eicarResult.threatName, 'EICAR_Standard_AntiVirus_Test_Signature');
  assert.equal(eicarResult.details.eicarDetected, true);
  console.log('✓ EICAR antivirus test signature successfully detected and quarantined');

  // 1.3 Spoofed Executable (MZ Windows PE disguised as PDF)
  const fakePdf = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), Buffer.alloc(100)]);
  const spoofedResult = analyzeDocumentBytes(fakePdf, 'invoice.pdf', 'application/pdf');
  assert.equal(spoofedResult.clean, false, 'Spoofed executable must be blocked');
  assert.equal(spoofedResult.status, 'infected');
  assert.equal(spoofedResult.threatName, 'Executable_Payload_Spoofed_MimeType');
  assert.equal(spoofedResult.details.fileHeaderValid, false);
  console.log('✓ Executable disguised as PDF detected and quarantined');

  // 1.4 PDF with Active Script Injection (/JavaScript & /Launch)
  const exploitPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\nendobj\n%%EOF');
  const exploitResult = analyzeDocumentBytes(exploitPdf, 'report.pdf', 'application/pdf');
  assert.equal(exploitResult.clean, false, 'Active script execution in PDF must be blocked');
  assert.equal(exploitResult.status, 'suspicious');
  assert.equal(exploitResult.threatName, 'PDF_Active_Script_Execution_Vulnerability');
  assert.equal(exploitResult.details.embeddedScriptsFound, true);
  console.log('✓ PDF with malicious /JavaScript action detected and flagged');
}

// 2. Storage Quota Calculations
console.log('\n[TEST 2] Testing Storage Quota Manager...');
{
  const defaultQuota = configuredStorageQuota();
  assert.equal(defaultQuota, DEFAULT_STORAGE_QUOTA_BYTES, 'Default quota must be 1 GiB');

  // Test custom environment quota
  process.env.ORGANIZATION_STORAGE_QUOTA_BYTES = String(500 * 1024 * 1024); // 500 MB
  const customQuota = configuredStorageQuota();
  assert.equal(customQuota, 500 * 1024 * 1024);
  delete process.env.ORGANIZATION_STORAGE_QUOTA_BYTES;
  console.log('✓ Storage quota parsing and fallback verified');
}

// 3. Object Filename & Tenant-Scoped Key Sanitation
console.log('\n[TEST 3] Testing Safe Filename & Storage Key Sanitization...');
{
  const sanitized = safeObjectFilename('../../etc/passwd.pdf');
  assert.equal(sanitized, 'passwd.pdf');

  const specialChars = safeObjectFilename('Mon Certificat GOTS (V1.2) #2026!.pdf');
  assert.ok(!specialChars.includes('('));
  assert.ok(!specialChars.includes('#'));
  assert.ok(specialChars.endsWith('.pdf'));

  const tenantKey = storageObjectKey('org-1234', 'test document.pdf');
  assert.ok(tenantKey.startsWith('org-1234/'));
  assert.ok(tenantKey.endsWith('test_document.pdf'));
  console.log('✓ Path traversal prevention and tenant isolation key formatting verified');
}

// 4. API Endpoints Contract Verification
console.log('\n[TEST 4] Testing API Route Exports & Contracts...');
{
  // Point d'injection documente de api/_lib/prisma.js : un import de route
  // cree le singleton Prisma. Sans base de donnees ici, un stub suffit — le
  // test ne fait qu'importer les handlers et verifier leur signature.
  if (!globalThis.tracefabPrisma) {
    globalThis.tracefabPrisma = new Proxy({}, {
      get: () => { throw new Error('test_chantier10: acces base interdit dans ce test statique'); },
    });
  }

  const supplierUsage = await import('../api/_routes/supplier/storage/usage.ts');
  const brandUsage = await import('../api/_routes/organization/storage/usage.ts');
  const brandUpload = await import('../api/_routes/documents/upload-intent.ts');
  const securityReport = await import('../api/_routes/documents/[documentId]/security-report.ts');

  assert.equal(typeof supplierUsage.default, 'function', 'Supplier storage usage handler must be exported');
  assert.equal(typeof brandUsage.default, 'function', 'Brand storage usage handler must be exported');
  assert.equal(typeof brandUpload.default, 'function', 'Brand upload intent handler must be exported');
  assert.equal(typeof securityReport.default, 'function', 'Security report handler must be exported');
  console.log('✓ All 4 Chantier 10 API routes verified with valid signatures');
}

console.log('\n======================================================');
console.log('SUCCESS: All Chantier 10 Cloud Storage tests PASSED!');
console.log('======================================================\n');
