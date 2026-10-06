import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../catalog/certification-standards/2026.10.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../api/_lib/certification-standards.ts', import.meta.url), 'utf8');
const route = await readFile(new URL('../api/_routes/catalog/certification-standards.ts', import.meta.url), 'utf8');
const readiness = await readFile(new URL('../api/_routes/internal/p2-readiness.ts', import.meta.url), 'utf8');
const indexTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');

assert.match(catalog.catalogVersion, /^2026\.\d+$/);
assert.equal(catalog.standards.length, 7);
const codes = new Set(catalog.standards.map((standard) => standard.code));
for (const code of ['GOTS', 'OEKO-TEX-STANDARD-100', 'GRS', 'RCS', 'OCS', 'ISO-14001', 'ISO-9001']) assert(codes.has(code), `${code} missing from certification catalogue`);
for (const standard of catalog.standards) {
  assert.match(standard.officialUrl, /^https:\/\//, `${standard.code} official URL must be HTTPS`);
  assert(standard.evidenceKinds.length > 0, `${standard.code} evidence contract missing`);
  assert(standard.requiredFields.includes('certificate_number'), `${standard.code} certificate number field missing`);
  assert(standard.claimCaveat && /catalogue|evidence|certif/i.test(standard.claimCaveat), `${standard.code} must not be presented as proof`);
}
assert(source.includes('versioned_tracefab_certification_catalog') && source.includes('certification_standard_duplicate') && source.includes('\\d+(?:\\.\\d+)+'), 'catalogue validation contract missing');
assert(route.includes('certification_standard_not_found') && route.includes('listCertificationStandards'), 'catalogue route contract missing');
assert(readiness.includes('tracefab-p2-readiness-v1') && readiness.includes('configuration_only') && readiness.includes('workerAuthorized'), 'P2 readiness contract missing');
assert(indexTs.includes('certification-standards') && indexTs.includes('p2\\/readiness'), 'P2 routes missing from API router');
console.log(`P2 certification catalogue passed: ${catalog.standards.length} standards, version ${catalog.catalogVersion}, configuration readiness route protected`);
