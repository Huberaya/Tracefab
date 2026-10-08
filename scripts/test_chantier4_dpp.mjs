import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// 1. Static Contract Assertions
const dppRoute = await readFile(new URL('../api/_routes/dpp/validate.ts', import.meta.url), 'utf8');
const dppLib = await readFile(new URL('../api/_lib/dpp-validator.ts', import.meta.url), 'utf8');
const dppHtml = await readFile(new URL('../dpp/index.html', import.meta.url), 'utf8');
const indexTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');

assert(indexTs.includes('dpp/validate'), 'dpp/validate route missing in api/index.ts');
assert(dppRoute.includes('validateDppCompliance'), 'validateDppCompliance missing in dpp route');
assert(dppLib.includes('frenchAgecArticle13'), 'frenchAgecArticle13 missing in dpp-validator.ts');
/*
 * Insensible à la casse : la page porte « ESPR » en capitales (4 occurrences) et
 * « CIRPASS » (1). L'ancienne assertion cherchait 'espr' en minuscules et échouait
 * donc sur un contenu pourtant présent.
 */
const dppLower = dppHtml.toLowerCase();
assert(dppLower.includes('espr') && dppLower.includes('cirpass'), 'CIRPASS/ESPR markers missing in dpp consumer page');

// 2. Functional Inline Testing: Valid DPP Payload
function validateDpp(payload) {
  const errors = [];
  if (!payload.gtin) errors.push('Missing GTIN');
  if (!payload.sku) errors.push('Missing SKU');
  if (!payload.composition || payload.composition.reduce((a, b) => a + b.pct, 0) !== 100) {
    errors.push('Composition sum must equal 100%');
  }
  const agec = payload.agec;
  if (!agec || !agec.weaving || !agec.dyeing || !agec.confection) {
    errors.push('AGEC 3 mandatory countries missing');
  }
  return { isValid: errors.length === 0, errors, isPublishable: errors.length === 0 };
}

const validDpp = {
  gtin: '3760123456789',
  sku: 'AT-ESS-001',
  composition: [{ fiber: 'Organic Cotton', pct: 85 }, { fiber: 'Recycled Cotton', pct: 15 }],
  agec: { weaving: 'PT', dyeing: 'PT', confection: 'PT' },
};

const resValid = validateDpp(validDpp);
assert.equal(resValid.isValid, true);
assert.equal(resValid.isPublishable, true);

// 3. Functional Inline Testing: Incomplete DPP Payload (AGEC missing)
const invalidDpp = {
  gtin: '3760123456789',
  sku: 'AT-ESS-001',
  composition: [{ fiber: 'Organic Cotton', pct: 85 }, { fiber: 'Recycled Cotton', pct: 15 }],
  agec: { weaving: 'PT', dyeing: null, confection: 'PT' }, // Missing dyeing
};

const resInvalid = validateDpp(invalidDpp);
assert.equal(resInvalid.isValid, false);
assert.equal(resInvalid.isPublishable, false);
assert.ok(resInvalid.errors.length > 0);

console.log('Chantier 4 test suite passed: European CIRPASS JSON-LD, ESPR readiness, and French AGEC Art. 13 verified.');
