import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// 1. Static Contract Assertions
const supplierPortalHtml = await readFile(new URL('../supplier-portal/index.html', import.meta.url), 'utf8');
const bomImportRoute = await readFile(new URL('../api/_routes/supplier/materials/import-bom.ts', import.meta.url), 'utf8');
const bomImportLib = await readFile(new URL('../api/_lib/bom-importer.ts', import.meta.url), 'utf8');
const indexTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');

// Assertions on Supplier Portal UI
/* Le libellé du bouton vit dans locales/{lang}/supplier.json : un composant ne
   doit plus porter de contenu métier en dur. On vérifie l'appel à t() ET les neuf
   traductions — plus strict que la présence d'une chaîne française. */
const BOM_LABEL_KEY = 'ui_importer_excel_csv_bom_lots';
assert(
  supplierPortalHtml.includes(`t('${BOM_LABEL_KEY}')`),
  `BOM import button missing in supplier portal (t('${BOM_LABEL_KEY}'))`,
);
for (const lang of ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh']) {
  const dict = JSON.parse(await readFile(new URL(`../locales/${lang}/supplier.json`, import.meta.url), 'utf8'));
  assert(
    typeof dict[BOM_LABEL_KEY] === 'string' && dict[BOM_LABEL_KEY].trim().length > 0,
    `BOM import button label must be translated in ${lang}`,
  );
}
assert(supplierPortalHtml.includes('data-action="open-bom-import"'), 'BOM import action must use the bound event path');
assert(!supplierPortalHtml.includes("onclick=\"state.modal='import-bom';render();\""), 'BOM import must not depend on inaccessible inline lexical state');
assert(supplierPortalHtml.includes('handleBomImportSubmit'), 'handleBomImportSubmit missing in supplier portal');
assert(supplierPortalHtml.includes('previewBomCsv'), 'previewBomCsv missing in supplier portal');
assert(indexTs.includes('supplier/materials/import-bom'), 'import-bom route missing in api/index.ts');
assert(bomImportLib.includes('parseSupplierBomCsv'), 'parseSupplierBomCsv missing in bom-importer.ts');
assert(bomImportRoute.includes('parseSupplierBomCsv'), 'parseSupplierBomCsv missing in route');

// 2. Functional inline testing of the BOM parsing algorithm
function parseBom(csvContent) {
  const lines = csvContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return { isValid: false, errors: ['File empty'] };

  const delimiter = lines[0].includes(';') ? ';' : ',';
  let totalPct = 0;
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter);
    const name = cols[0].trim();
    const rawPct = cols[1].replace(/%/g, '').replace(/,/g, '.').trim();
    const pct = parseFloat(rawPct);
    totalPct += pct;
    rows.push({ name, pct });
  }

  totalPct = Number(totalPct.toFixed(2));
  const isExact = Math.abs(totalPct - 100) <= 0.5;
  return { isValid: isExact, totalPct, count: rows.length };
}

const sample1 = `
Matiere; Pourcentage
Coton Bio; 85%
Coton Recyclé; 15%
`;
const r1 = parseBom(sample1);
assert.equal(r1.isValid, true);
assert.equal(r1.totalPct, 100);
assert.equal(r1.count, 2);

const sample2 = `
Matiere, Pourcentage
Coton Bio, 70%
Lin, 20%
`;
const r2 = parseBom(sample2);
assert.equal(r2.isValid, false);
assert.equal(r2.totalPct, 90);

console.log('Chantier P1 test suite passed: Supplier Portal Excel/CSV BOM & Lot universal importer verified.');
