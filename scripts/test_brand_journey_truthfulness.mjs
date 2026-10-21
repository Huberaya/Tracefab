import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../assets/js/brand-console.1.js', import.meta.url), 'utf8');
const fr = JSON.parse(fs.readFileSync(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8'));
const strings = fr.brandConsole || fr.console || Object.values(fr).find((v) => v && typeof v === 'object' && v.journeyIntegrityTitle);
assert.ok(strings, 'catalogue Brand Console FR introuvable');

for (const token of [
  "bt('journeyIntegrityNote')",
  'data-report-safeguard',
  "bt('journeySignalNotFraud')",
  "bt('journeyNoConnection')",
  "bt('journeyTechnicalOrgId')",
  'data-chain-links',
  'id="plm-import-form"',
  'id="allocate-tc-form"',
  "bt('journeyCompletenessNotQuality')",
  "bt('journeyReadinessNotValidation')",
]) assert.ok(source.includes(token), `garde-fou absent: ${token}`);

assert.ok(!source.includes('name="productId" placeholder="UUID produit"'), 'un UUID technique ne doit pas être demandé à la marque');
assert.ok(!source.includes('<h2>${bt(\'qbAutoCompliance\')}</h2>'), 'le mapping ne doit pas être présenté comme conformité automatisée');
assert.match(strings.journeyIntegrityNote, /ni son authenticité/);
assert.match(strings.journeyMassBalanceWarning, /BOM à 100 %/);
assert.match(strings.journeyReportWarning, /n’atteste pas la conformité/);
console.log('Brand journey truthfulness contract passed');
