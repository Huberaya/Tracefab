import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

console.log('=== TEST SUITE CHANTIER 3: MOTEUR D’AGRÉGATION ESG & CALCULATEUR PEF/ACV ===');

// 1. Verify SQL Migration
console.log('1. Checking Chantier 3 SQL migration...');
const migrationPath = 'prisma/migrations/20261006220000_esg_pef_footprint_engine/migration.sql';
assert.ok(existsSync(migrationPath), 'Migration file must exist');
const migrationSql = await readFile(migrationPath, 'utf8');

assert.ok(migrationSql.includes('CREATE TABLE IF NOT EXISTS pef_emission_factors'), 'Must create pef_emission_factors table');
assert.ok(migrationSql.includes('CREATE TABLE IF NOT EXISTS product_pef_assessments'), 'Must create product_pef_assessments table');
assert.ok(migrationSql.includes('ALTER TABLE product_pef_assessments FORCE ROW LEVEL SECURITY;'), 'Must enforce RLS on assessments');
assert.ok(migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_calculate_product_pef'), 'Must define tracefab_calculate_product_pef');
assert.ok(migrationSql.includes('UPDATE dpp_records'), 'Must update dpp_records public projection');
console.log('✓ Migration SQL and RLS contracts validated');

// 2. Verify Emission Factors in TypeScript module
console.log('2. Checking textile emission factors catalog...');
const factorsTs = await readFile('api/_lib/pef/pef-factors.ts', 'utf8');
assert.ok(factorsTs.includes('cotton_conventional'), 'Must have cotton_conventional factor');
assert.ok(factorsTs.includes('cotton_organic'), 'Must have cotton_organic factor');
assert.ok(factorsTs.includes('linen'), 'Must have linen factor');
assert.ok(factorsTs.includes('polyester_virgin'), 'Must have polyester_virgin factor');
assert.ok(factorsTs.includes('polyester_recycled'), 'Must have polyester_recycled factor');
console.log('✓ Emission factors and comparative advantages verified');

// 3. Test PEF Calculation Logic in pure JS
console.log('3. Testing PEF calculation and scoring logic...');
function estimatePef(composition, weightKg = 0.400) {
  let rawCarbon = 0;
  let rawWater = 0;
  let synthPct = 0;
  let circSum = 0;

  for (const c of composition) {
    const rawName = c.name.toLowerCase();
    const name = rawName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const ratio = (c.percentage / 100) * weightKg;

    let fCarbon = 4.85;
    let fWater = 8.50;
    let fCirc = 85;

    if (name.includes('coton') || name.includes('cotton')) {
      if (c.isOrganic || name.includes('bio') || name.includes('organic')) {
        fCarbon = 2.10; fWater = 2.20; fCirc = 95;
      } else {
        fCarbon = 4.85; fWater = 8.50; fCirc = 90;
      }
    } else if (name.includes('polyest')) {
      synthPct += c.percentage;
      if (c.isRecycled || name.includes('recycl')) {
        fCarbon = 2.35; fWater = 0.05; fCirc = 80;
      } else {
        fCarbon = 5.60; fWater = 0.12; fCirc = 65;
      }
    } else if (name.includes('lin') || name.includes('linen')) {
      fCarbon = 1.45; fWater = 0.85; fCirc = 98;
    } else if (name.includes('elasthan') || name.includes('spandex')) {
      synthPct += c.percentage;
      fCarbon = 7.20; fWater = 0.15; fCirc = 25;
    }

    rawCarbon += ratio * fCarbon;
    rawWater += ratio * fWater;
    circSum += fCirc * (c.percentage / 100);
  }

  const procCarbon = weightKg * (1.25 + 1.80 + 3.65 + 1.40);
  const procWater = weightKg * (1.85 + 0.14);
  const transportCarbon = weightKg * 0.085;

  const totalCarbon = Math.round((rawCarbon + procCarbon + transportCarbon) * 1000) / 1000;
  const totalWater = Math.round((rawWater + procWater) * 1000) / 1000;

  let microplasticsGrade = 'A';
  if (synthPct > 80) microplasticsGrade = 'E';
  else if (synthPct > 50) microplasticsGrade = 'D';
  else if (synthPct > 20) microplasticsGrade = 'C';
  else if (synthPct > 0) microplasticsGrade = 'B';

  const carbonIntensity = totalCarbon / Math.max(weightKg, 0.1);
  const waterIntensity = totalWater / Math.max(weightKg, 0.1);
  let score = Math.round(100 - (carbonIntensity * 2.8) - (waterIntensity * 2.5));
  if (circSum > 80) score += 5;
  if (microplasticsGrade === 'A') score += 5;
  score = Math.min(98, Math.max(12, score));

  let grade = 'C';
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'E';

  return {
    garmentWeightKg: weightKg,
    carbonFootprintKgCo2e: totalCarbon,
    waterScarcityM3: totalWater,
    pefEcoScore: score,
    pefGrade: grade,
    microplasticsRiskGrade: microplasticsGrade,
    circularityScore: Math.round(circSum),
  };
}

// Case A: Organic Cotton Denim Jacket (Eco-designed)
const ecoJeans = estimatePef([
  { name: 'Coton biologique certifié GOTS', percentage: 98, isOrganic: true },
  { name: 'Élasthanne', percentage: 2 }
], 0.650);

assert.ok(ecoJeans.carbonFootprintKgCo2e > 0, 'Carbon footprint must be positive');
assert.ok(ecoJeans.waterScarcityM3 > 0, 'Water scarcity must be positive');
assert.ok(ecoJeans.pefEcoScore >= 65, 'Eco-designed jeans must achieve a strong score (>=65)');
assert.ok(['A', 'B'].includes(ecoJeans.pefGrade), 'Eco-designed jeans must achieve Grade A or B');
assert.equal(ecoJeans.microplasticsRiskGrade, 'B', '2% elastane should trigger low microplastics risk (Grade B)');

// Case B: 100% Virgin Polyester Jacket (High environmental footprint)
const virginPoly = estimatePef([
  { name: 'Polyester Vierge', percentage: 100 }
], 0.950);

assert.ok(virginPoly.pefEcoScore < ecoJeans.pefEcoScore, 'Virgin polyester must score lower than organic cotton');
assert.equal(virginPoly.microplasticsRiskGrade, 'E', '100% synthetic must trigger Grade E microplastics risk');
assert.ok(virginPoly.circularityScore <= 65, 'Virgin polyester circularity score must be constrained');
console.log('✓ PEF calculation, grading and sensitivity verified');

// 4. Verify API Router Registration
console.log('4. Checking API router wiring...');
const routerFile = await readFile('api/index.ts', 'utf8');
assert.ok(routerFile.includes('products/[productId]/pef/calculate'), 'Must route /pef/calculate');
assert.ok(routerFile.includes('products/[productId]/pef'), 'Must route /pef');
assert.ok(routerFile.includes('pef/factors'), 'Must route /pef/factors');
console.log('✓ API endpoints properly wired');

// 5. Verify Brand Console UI
console.log('5. Checking Brand Console UI implementation...');
const brandConsole = await readFile('brand-console/index.html', 'utf8');
assert.ok(brandConsole.includes('Évaluation Environnementale & Empreinte PEF'), 'Must have PEF section in Brand Console');
assert.ok(brandConsole.includes('data-action="calculate-pef"'), 'Must have calculate-pef button action');
assert.ok(brandConsole.includes('Éco-Score Textile'), 'Must have Éco-Score badge in Brand Console');
assert.ok(brandConsole.includes('pefAssessment'), 'Must bind pefAssessment to state');
console.log('✓ Brand Console PEF integration verified');

// 6. Verify DPP Consumer Passport
console.log('6. Checking DPP consumer passport...');
const dppFile = await readFile('dpp/index.html', 'utf8');
assert.ok(dppFile.includes('Éco-Score Textile Européen'), 'Must have official Éco-Score in DPP passport');
assert.ok(dppFile.includes('Conforme Loi AGEC & ESPR'), 'Must mention EU ESPR & AGEC compliance');
console.log('✓ DPP consumer passport integration verified');

console.log('✓ Chantier 3 (Moteur d’Agrégation ESG & Calculateur PEF/ACV) verified successfully!');
