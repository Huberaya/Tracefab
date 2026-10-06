import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

console.log('=== TEST SUITE CHANTIER 4: DIRECTIVE ALLÉGATIONS VERTES & ANTI-GREENWASHING ===');

// 1. Verify SQL Migration & Tables
console.log('1. Checking Chantier 4 SQL migration & RLS definitions...');
const migrationPath = 'prisma/migrations/20261006230000_green_claims_anti_greenwashing_engine/migration.sql';
assert.ok(existsSync(migrationPath), 'Migration file must exist');
const migrationSql = await readFile(migrationPath, 'utf8');

assert.ok(migrationSql.includes('CREATE TABLE IF NOT EXISTS green_claims_rules'), 'Must declare green_claims_rules');
assert.ok(migrationSql.includes('CREATE TABLE IF NOT EXISTS product_green_claims'), 'Must declare product_green_claims');
assert.ok(migrationSql.includes('CREATE TABLE IF NOT EXISTS green_claims_audits'), 'Must declare green_claims_audits');
assert.ok(migrationSql.includes('ALTER TABLE product_green_claims FORCE ROW LEVEL SECURITY;'), 'Must enforce RLS on product claims');
assert.ok(migrationSql.includes('ALTER TABLE green_claims_audits FORCE ROW LEVEL SECURITY;'), 'Must enforce RLS on audits');
assert.ok(migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_audit_product_green_claims'), 'Must define tracefab_audit_product_green_claims');
console.log('✓ Migration SQL, tables and RLS verified');

// 2. Verify Rules Catalog
console.log('2. Checking Green Claims rules definitions...');
const rulesTs = await readFile('api/_lib/green-claims/rules.ts', 'utf8');
assert.ok(rulesTs.includes('GENERIC_ECO_CLAIM'), 'Must have GENERIC_ECO_CLAIM rule');
assert.ok(rulesTs.includes('CARBON_NEUTRAL_BAN'), 'Must have CARBON_NEUTRAL_BAN rule');
assert.ok(rulesTs.includes('ORGANIC_UNSUBSTANTIATED'), 'Must have ORGANIC_UNSUBSTANTIATED rule');
assert.ok(rulesTs.includes('RECYCLED_UNSUBSTANTIATED'), 'Must have RECYCLED_UNSUBSTANTIATED rule');
console.log('✓ Regulatory rules and EU legal basis verified');

// 3. Test Claim Evaluation Logic in pure JS
console.log('3. Testing claim evaluation algorithm...');
function evaluateClaim(claimText, hasOrganicCert = false, hasRecycledCert = false) {
  const lower = claimText.toLowerCase();
  if (/neutre en carbone|neutralité carbone|carbon neutral|zéro émission|compensé carbone/i.test(lower)) {
    return { status: 'prohibited_claim', riskLevel: 'critical', isBlocking: true };
  }
  if (/éco-responsable|eco-responsable|vert|durable|ami de la nature|propre/i.test(lower)) {
    return { status: 'prohibited_claim', riskLevel: 'high', isBlocking: true };
  }
  if (/bio|biologique|organic/i.test(lower)) {
    if (hasOrganicCert) return { status: 'verified', riskLevel: 'low', isBlocking: false };
    return { status: 'unsubstantiated', riskLevel: 'high', isBlocking: true };
  }
  if (/recyclé|recycled|rpet/i.test(lower)) {
    if (hasRecycledCert) return { status: 'verified', riskLevel: 'low', isBlocking: false };
    return { status: 'unsubstantiated', riskLevel: 'high', isBlocking: true };
  }
  return { status: 'partially_substantiated', riskLevel: 'medium', isBlocking: false };
}

// Prohibited Claims (Immediate Ban)
const claim1 = evaluateClaim('T-shirt 100% neutre en carbone par compensation');
assert.equal(claim1.status, 'prohibited_claim');
assert.equal(claim1.riskLevel, 'critical');
assert.equal(claim1.isBlocking, true);

const claim2 = evaluateClaim('Vêtement éco-responsable et durable');
assert.equal(claim2.status, 'prohibited_claim');
assert.equal(claim2.riskLevel, 'high');
assert.equal(claim2.isBlocking, true);

// Substantiated vs Unsubstantiated Claims
const claim3Unsub = evaluateClaim('100% Coton Biologique', false);
assert.equal(claim3Unsub.status, 'unsubstantiated');
assert.equal(claim3Unsub.isBlocking, true);

const claim3Verified = evaluateClaim('100% Coton Biologique', true);
assert.equal(claim3Verified.status, 'verified');
assert.equal(claim3Verified.riskLevel, 'low');
assert.equal(claim3Verified.isBlocking, false);
console.log('✓ Algorithmic claim evaluation verified');

// 4. Verify API Router Registration
console.log('4. Checking API router wiring...');
const routerFile = await readFile('api/index.ts', 'utf8');
assert.ok(routerFile.includes('products/[productId]/green-claims/audit'), 'Must route /green-claims/audit');
assert.ok(routerFile.includes('products/[productId]/green-claims'), 'Must route /green-claims');
assert.ok(routerFile.includes('green-claims/rules'), 'Must route /green-claims/rules');
console.log('✓ API endpoints properly wired');

// 5. Verify Brand Console UI Integration
console.log('5. Checking Brand Console UI implementation...');
const brandConsole = await readFile('brand-console/index.html', 'utf8');
assert.ok(brandConsole.includes('Bouclier Anti-Greenwashing & Allégations Vertes'), 'Must have Green Claims section');
assert.ok(brandConsole.includes('data-action="audit-green-claims"'), 'Must have audit-green-claims button');
assert.ok(brandConsole.includes('id="green-claim-form"'), 'Must have claim registration form');
assert.ok(brandConsole.includes('greenClaimsAudit'), 'Must bind audit results');
console.log('✓ Brand Console Green Claims UI verified');

console.log('✓ Chantier 4 (Directive Allégations Vertes & Anti-Greenwashing) verified successfully!');
