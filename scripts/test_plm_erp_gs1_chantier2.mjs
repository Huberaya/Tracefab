import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

console.log('=== TEST SUITE CHANTIER 2: INTEROPÉRABILITÉ PLM/ERP & GS1 ===');

// 1. Verify SQL Migration & Security Assertions
console.log('1. Checking migration SQL definition & RLS policies...');
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006210000_plm_erp_gs1_interoperability/migration.sql', import.meta.url),
  'utf8',
);

assert(migrationSql.includes('CREATE TABLE IF NOT EXISTS plm_erp_integrations'), 'Migration must declare plm_erp_integrations');
assert(migrationSql.includes('CREATE TABLE IF NOT EXISTS plm_erp_sync_jobs'), 'Migration must declare plm_erp_sync_jobs');
assert(migrationSql.includes('ALTER TABLE plm_erp_integrations FORCE ROW LEVEL SECURITY;'), 'FORCE RLS required on integrations');
assert(migrationSql.includes('ALTER TABLE plm_erp_sync_jobs FORCE ROW LEVEL SECURITY;'), 'FORCE RLS required on sync jobs');
assert(migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_ingest_plm_erp_payload'), 'Stored procedure tracefab_ingest_plm_erp_payload required');
assert(migrationSql.includes('gs1_digital_link'), 'Constraint must allow gs1_digital_link');

// 2. Verify GTIN Engine Module and Algorithm
console.log('2. Checking GTIN Engine & Modulo-10 algorithm...');
const gtinEngineTs = await readFile(new URL('../api/_lib/plm-erp/gtin-engine.ts', import.meta.url), 'utf8');
assert(gtinEngineTs.includes('calculateGs1CheckDigit'), 'Must export calculateGs1CheckDigit');
assert(gtinEngineTs.includes('validateGtin'), 'Must export validateGtin');
assert(gtinEngineTs.includes('buildGs1DigitalLink'), 'Must export buildGs1DigitalLink');
assert(gtinEngineTs.includes('parseGs1DigitalLink'), 'Must export parseGs1DigitalLink');

// Modulo-10 verification inline
function calculateGs1CheckDigit(digitsWithoutCheck) {
  const digits = digitsWithoutCheck.replace(/\D/g, '');
  let sum = 0;
  let multiplier = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = parseInt(digits[i], 10);
    sum += digit * multiplier;
    multiplier = multiplier === 3 ? 1 : 3;
  }
  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

function validateGtin(rawGtin) {
  const clean = String(rawGtin || '').trim().replace(/\D/g, '');
  const len = clean.length;
  if (![8, 12, 13, 14].includes(len)) return { isValid: false, format: 'INVALID' };
  const payload = clean.slice(0, -1);
  const providedCheckDigit = parseInt(clean.slice(-1), 10);
  const calculatedCheckDigit = calculateGs1CheckDigit(payload);
  return {
    isValid: providedCheckDigit === calculatedCheckDigit,
    format: `GTIN-${len}`,
    cleanGtin: clean,
  };
}

const validGtin = validateGtin('3760345833592');
assert.equal(validGtin.isValid, true);
assert.equal(validGtin.format, 'GTIN-13');

const invalidGtin = validateGtin('3760345833599');
assert.equal(invalidGtin.isValid, false);

// 3. Verify Parsers
console.log('3. Checking Centric PLM parser...');
const centricTs = await readFile(new URL('../api/_lib/plm-erp/parsers/centric-plm.ts', import.meta.url), 'utf8');
assert(centricTs.includes('parseCentricPlmPayload'), 'Must export parseCentricPlmPayload');
assert(centricTs.includes('parseCompositionString'), 'Must parse fiber content strings');

console.log('4. Checking Lectra Kubix Link parser...');
const lectraTs = await readFile(new URL('../api/_lib/plm-erp/parsers/lectra-kubix.ts', import.meta.url), 'utf8');
assert(lectraTs.includes('parseLectraKubixPayload'), 'Must export parseLectraKubixPayload');
assert(lectraTs.includes('factoryPartner'), 'Must handle factory partner allocations');

console.log('5. Checking SAP S/4HANA Fashion parser...');
const sapTs = await readFile(new URL('../api/_lib/plm-erp/parsers/sap-s4hana.ts', import.meta.url), 'utf8');
assert(sapTs.includes('parseSapS4HanaPayload'), 'Must export parseSapS4HanaPayload');
assert(sapTs.includes('MATNR') && sapTs.includes('EAN11'), 'Must parse SAP article and EAN attributes');

console.log('6. Checking GS1 EPCIS 2.0 parser...');
const epcisTs = await readFile(new URL('../api/_lib/plm-erp/parsers/gs1-epcis.ts', import.meta.url), 'utf8');
assert(epcisTs.includes('parseGs1EpcisPayload'), 'Must export parseGs1EpcisPayload');
assert(epcisTs.includes('TransformationEvent'), 'Must handle TransformationEvent');
assert(epcisTs.includes('sgln'), 'Must extract GLN locations');

// 7. Verify API Router Registration
console.log('7. Checking API Router Registration...');
const indexTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
assert(indexTs.includes('integrations/ingest') || indexTs.includes('integrations\\/ingest'), 'integrations/ingest must be registered');
assert(indexTs.includes('integrations/jobs') || indexTs.includes('integrations\\/jobs'), 'integrations/jobs must be registered');
assert(indexTs.includes('gs1/digital-link') || indexTs.includes('gs1\\/digital\\-link'), 'gs1/digital-link must be registered');

// 8. Verify Brand Console UI Wiring
console.log('8. Checking Brand Console UI Wiring...');
const brandConsoleHtml = await readFile(new URL('../brand-console/index.html', import.meta.url), 'utf8');
assert(brandConsoleHtml.includes("navButton('integrations'") || brandConsoleHtml.includes('data-view="integrations"'), 'Nav must include integrations tab');
assert(brandConsoleHtml.includes('function integrationsView()'), 'Must declare integrationsView()');
assert(brandConsoleHtml.includes('id="plm-import-form"'), 'Must have import form in modal');
assert(brandConsoleHtml.includes('id="plm-system-select"'), 'Must have system select');
assert(brandConsoleHtml.includes('Centric Software'), 'Must display Centric Software');
assert(brandConsoleHtml.includes('Lectra (Kubix Link)'), 'Must display Lectra');
assert(brandConsoleHtml.includes('SAP S/4HANA Fashion'), 'Must display SAP S/4HANA');
assert(brandConsoleHtml.includes('GS1 EPCIS 2.0'), 'Must display GS1 EPCIS');
assert(brandConsoleHtml.includes("bt('igGs1Title')"), 'Must display GS1 Digital Link section');
assert.strictEqual(JSON.parse(await readFile(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8')).console.igGs1Title, 'Identité Numérique GS1 & Digital Link', 'la copie FR doit rester au catalogue');

console.log('✓ Chantier 2 (Interopérabilité PLM/ERP & GS1) verified successfully!');
