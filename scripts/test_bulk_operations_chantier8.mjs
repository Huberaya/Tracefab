import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../api/_lib/bulk-operations/csv-parser.ts';
import { parseCompositionString } from '../api/_lib/bulk-operations/bulk-importer.ts';
import { calculateGs1CheckDigit, validateGtin } from '../api/_lib/plm-erp/gtin-engine.ts';

console.log('--- TEST SUITE CHANTIER 8: MOTEUR D\'IMPORT / EXPORT MASSIF & CATALOG ONBOARDING ---');

// Test 1: CSV Parser with various delimiters, quotes, newlines, and BOM
console.log('\n[TEST 1] CSV Parser: Delimiters, escaping, and BOM handling');
{
  const standardCsv = `reference,name,category,sku,countryOfManufacture,weightGrams,materialsSummary
TF-POLO-001,"Polo Piqué, Blanc",Polo,SKU-001,PT,240,"100% Coton biologique"
TF-PANT-002,"Chino ""Confort""",Pantalon,SKU-002,TN,450,"98% Coton, 2% Élasthanne"`;

  const parsed = parseCsv(standardCsv);
  assert.equal(parsed.length, 2, 'Should parse exactly 2 records');
  assert.equal(parsed[0].reference, 'TF-POLO-001');
  assert.equal(parsed[0].name, 'Polo Piqué, Blanc', 'Should preserve comma inside quotes');
  assert.equal(parsed[0].materialsSummary, '100% Coton biologique');
  assert.equal(parsed[1].name, 'Chino "Confort"', 'Should unescape double quotes');
  assert.equal(parsed[1].materialsSummary, '98% Coton, 2% Élasthanne');
  console.log('✓ Standard comma-delimited with escaped quotes passed');

  // Semicolon delimited with UTF-8 BOM
  const semicolonCsv = '\uFEFF' + `legalName;displayName;email;countryCode;role
Filature de Lyon SAS;Filature Lyon;contact@filature.fr;FR;spinning
Tissage du Sud Lda;Tissage Sud;info@tissage.pt;PT;weaving`;

  const parsedSemicolon = parseCsv(semicolonCsv);
  assert.equal(parsedSemicolon.length, 2);
  assert.equal(parsedSemicolon[0].legalName, 'Filature de Lyon SAS', 'Should strip BOM and parse header correctly');
  assert.equal(parsedSemicolon[0].countryCode, 'FR');
  assert.equal(parsedSemicolon[1].role, 'weaving');
  console.log('✓ Semicolon-delimited with BOM passed');
}

// Test 2: CSV Serializer (toCsv)
console.log('\n[TEST 2] CSV Serializer: RFC 4180 escaping and column mapping');
{
  const data = [
    { reference: 'REF-01', name: 'T-shirt, Bio', price: 29.90, desc: 'T-shirt avec "style"' },
    { reference: 'REF-02', name: 'Hoodie', price: 79.00, desc: 'Simple' }
  ];
  const columns = [
    { key: 'reference', label: 'Reference' },
    { key: 'name', label: 'Product Name' },
    { key: 'desc', label: 'Description' }
  ];

  const serialized = toCsv(data, columns);
  const lines = serialized.trim().split('\n');
  assert.equal(lines[0], 'Reference,Product Name,Description');
  assert.equal(lines[1], 'REF-01,"T-shirt, Bio","T-shirt avec ""style"""');
  assert.equal(lines[2], 'REF-02,Hoodie,Simple');
  console.log('✓ CSV serialization with escaping passed');
}

// Test 3: Textile Composition String Parser
console.log('\n[TEST 3] Textile Composition String Parser');
{
  const comp1 = '80% Coton biologique, 20% Chanvre';
  const parsed1 = parseCompositionString(comp1);
  assert.equal(parsed1.length, 2);
  assert.equal(parsed1[0].name, 'Coton biologique');
  assert.equal(parsed1[0].percentage, 80);
  assert.equal(parsed1[1].name, 'Chanvre');
  assert.equal(parsed1[1].percentage, 20);

  const comp2 = '100% Lin Normand';
  const parsed2 = parseCompositionString(comp2);
  assert.equal(parsed2.length, 1);
  assert.equal(parsed2[0].name, 'Lin Normand');
  assert.equal(parsed2[0].percentage, 100);

  const comp3 = '70% Laine Mérinos, 25% Soie, 5% Cachemire';
  const parsed3 = parseCompositionString(comp3);
  assert.equal(parsed3.length, 3);
  assert.equal(parsed3[0].name, 'Laine Mérinos');
  assert.equal(parsed3[0].percentage, 70);
  assert.equal(parsed3[1].name, 'Soie');
  assert.equal(parsed3[1].percentage, 25);
  assert.equal(parsed3[2].name, 'Cachemire');
  assert.equal(parsed3[2].percentage, 5);

  const empty = parseCompositionString('');
  assert.equal(empty.length, 0);
  console.log('✓ Composition parser successfully decomposed complex textile blends');
}

// Test 4: GTIN-13 GS1 Checksum Algorithm
console.log('\n[TEST 4] GS1 GTIN-13 Checksum Logic');
{
  // Known valid GTIN-13s:
  // 376034583359 + checksum 2 = 3760345833592
  const check1 = calculateGs1CheckDigit('376034583359');
  assert.equal(check1, 2, 'GTIN-13 check digit for 376034583359 must be 2');

  const val1 = validateGtin('3760345833592');
  assert.equal(val1.isValid, true);
  assert.equal(val1.format, 'GTIN-13');

  // 400638133393 + checksum 1 = 4006381333931
  const check2 = calculateGs1CheckDigit('400638133393');
  assert.equal(check2, 1, 'GTIN-13 check digit for 400638133393 must be 1');

  const val2 = validateGtin('4006381333931');
  assert.equal(val2.isValid, true);
  assert.equal(val2.format, 'GTIN-13');

  console.log('✓ GS1 Modulo-10 checksum verified against official standards');
}

console.log('\n--- ALL UNIT AND STATIC TESTS FOR CHANTIER 8 PASSED ---\n');
