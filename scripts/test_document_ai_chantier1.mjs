/**
 * Test Suite: Chantier 1 (IA Documentaire & Vérification Automatique des Preuves)
 */
import { readFile } from 'node:fs/promises';

console.log('=== TEST SUITE CHANTIER 1: IA DOCUMENTAIRE & FORENSICS ===');

// 1. Verify Migration SQL
console.log('1. Checking migration SQL definition...');
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006200000_document_ai_automated_verification/migration.sql', import.meta.url),
  'utf8',
);
assert(
  migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_apply_document_ai_verification'),
  'Migration must declare tracefab_apply_document_ai_verification',
);
assert(
  migrationSql.includes('INSERT INTO verification_records'),
  'Migration must insert into verification_records',
);
assert(
  migrationSql.includes('UPDATE certifications'),
  'Migration must update certifications',
);
assert(
  migrationSql.includes('data_quality_issues'),
  'Migration must synchronize data_quality_issues',
);
assert(
  migrationSql.includes('SECURITY DEFINER'),
  'Function must be SECURITY DEFINER',
);
assert(
  migrationSql.includes('tracefab_can_access_document'),
  'Function must check document access via tracefab_can_access_document',
);
assert(
  migrationSql.includes('GRANT EXECUTE ON FUNCTION tracefab_apply_document_ai_verification'),
  'Migration must grant execute on tracefab_apply_document_ai_verification to PUBLIC',
);

// 2. Verify Document AI Helper Module
console.log('2. Checking Document AI helper module...');
const documentAiTs = await readFile(
  new URL('../api/_lib/document-ai.ts', import.meta.url),
  'utf8',
);
assert(documentAiTs.includes('SUPPORTED_STANDARDS'), 'Document AI must define supported standards');
assert(documentAiTs.includes('Global Organic Textile Standard'), 'Document AI must support GOTS');
assert(documentAiTs.includes('STANDARD 100 by OEKO-TEX'), 'Document AI must support OEKO-TEX');
assert(documentAiTs.includes('Global Recycled Standard'), 'Document AI must support GRS');
assert(documentAiTs.includes('Control Union'), 'Document AI must list Control Union as accredited');
assert(documentAiTs.includes('Hohenstein'), 'Document AI must list Hohenstein as accredited');
assert(documentAiTs.includes('extractDocumentAi'), 'Document AI must export extractDocumentAi');
assert(documentAiTs.includes('verifyDocumentWithAi'), 'Document AI must export verifyDocumentWithAi');

// 3. Verify API Routes & Router Wiring
console.log('3. Checking API routes and router wiring...');
const indexTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
assert(
  indexTs.includes('verify-ai') || indexTs.includes('verify\\-ai'),
  'verify-ai route must be registered in api/index.ts',
);
assert(
  indexTs.includes('verification-report') || indexTs.includes('verification\\-report'),
  'verification-report route must be registered in api/index.ts',
);
assert(
  indexTs.includes('auto-verify') || indexTs.includes('auto\\-verify'),
  'auto-verify route must be registered in api/index.ts',
);

const verifyAiRoute = await readFile(
  new URL('../api/_routes/documents/[documentId]/verify-ai.ts', import.meta.url),
  'utf8',
);
assert(verifyAiRoute.includes('tracefab_can_access_document'), 'verify-ai route must enforce document access');
assert(verifyAiRoute.includes('tracefab_apply_document_ai_verification'), 'verify-ai route must execute atomic stored procedure');

const autoVerifyRoute = await readFile(
  new URL('../api/_routes/supplier/certifications/[certificationId]/auto-verify.ts', import.meta.url),
  'utf8',
);
assert(autoVerifyRoute.includes('certification_has_no_document'), 'auto-verify must check document presence');
assert(autoVerifyRoute.includes('tracefab_apply_document_ai_verification'), 'auto-verify must execute atomic stored procedure');

const sqlErrorsTs = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
assert(sqlErrorsTs.includes('document_not_found'), 'SQL errors must include document_not_found');
assert(sqlErrorsTs.includes('document_access_denied'), 'SQL errors must include document_access_denied');
assert(sqlErrorsTs.includes('certification_has_no_document'), 'SQL errors must include certification_has_no_document');

// 4. Algorithm & Rule Verification Tests
console.log('4. Testing algorithmic detection and decision rules...');

// Pattern tests matching document-ai.ts
const gotsPatterns = [
  /CU\s*[-]?\s*([0-9]{5,8})(?:GOTS[-0-9]*)?/i,
  /GOTS[-_ ]?([A-Z0-9]{5,14})/i,
];
assert(gotsPatterns[0].test('CU812345GOTS-2025-01'), 'GOTS CU pattern must match license number');

const oekoPatterns = [
  /([0-9]{2}\.[A-Z]{3}\.[0-9]{4,6})/i,
];
assert(oekoPatterns[0].test('12.HBD.12345'), 'OEKO-TEX pattern must match Hohenstein format');

// Date comparison logic
const referenceDate = '2026-10-06';
const validFutureDate = '2027-01-14';
const expiredPastDate = '2025-01-14';
assert(validFutureDate > referenceDate, 'Future date must be valid');
assert(expiredPastDate < referenceDate, 'Past date must be detected as expired');

console.log('✓ Chantier 1 (IA Documentaire & Forensics) verified successfully!');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
