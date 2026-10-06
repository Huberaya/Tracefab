import type { Prisma, PrismaClient } from '@prisma/client';
import type { PefAssessmentResult, PefGrade, MicroplasticsRiskGrade } from './types.js';
import { TEXTILE_EMISSION_FACTORS, STANDARD_GARMENT_WEIGHTS_KG } from './pef-factors.js';

export interface CalculatePefParams {
  productId: string;
  customWeightKg?: number;
  customCategory?: string;
  userId?: string;
}

export async function calculateAndStoreProductPef(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: CalculatePefParams
): Promise<PefAssessmentResult> {
  const { productId, customWeightKg, customCategory } = params;

  // Execute the secure PostgreSQL stored procedure
  const rows = await prisma.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_calculate_product_pef(
      ${productId}::uuid,
      ${customWeightKg !== undefined ? customWeightKg : null}::numeric,
      ${customCategory || null}::text
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('pef_calculation_failed');
  }

  const r = rows[0];

  return {
    id: r.id,
    productId: r.product_id,
    productVersion: r.product_version,
    garmentCategory: r.garment_category,
    garmentWeightKg: Number(r.garment_weight_kg),
    carbonFootprintKgCo2e: Number(r.carbon_footprint_kg_co2e),
    carbonBreakdown: r.carbon_breakdown || {},
    waterScarcityM3: Number(r.water_scarcity_m3),
    waterBreakdown: r.water_breakdown || {},
    eutrophicationFreshwaterKgPEq: Number(r.eutrophication_freshwater_kg_p_eq),
    microplasticsRiskGrade: r.microplastics_risk_grade as MicroplasticsRiskGrade,
    circularityScore: Number(r.circularity_score),
    pefEcoScore: Number(r.pef_eco_score),
    pefGrade: r.pef_grade as PefGrade,
    conventionalComparison: r.conventional_comparison || {},
    dataQualityRating: r.data_quality_rating,
    methodologyVersion: r.methodology_version,
    calculatedAt: r.calculated_at ? new Date(r.calculated_at).toISOString() : new Date().toISOString(),
  };
}

export function estimatePefInMemory(composition: Array<{ name: string; percentage: number; isOrganic?: boolean; isRecycled?: boolean }>, category = 'other', weightKg?: number) {
  const weight = weightKg || STANDARD_GARMENT_WEIGHTS_KG[category.toLowerCase()] || 0.400;
  let rawCarbon = 0;
  let rawWater = 0;
  let synthPct = 0;
  let circSum = 0;

  for (const c of composition) {
    const rawName = c.name.toLowerCase();
    const name = rawName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const ratio = (c.percentage / 100) * weight;

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

  const procCarbon = weight * (1.25 + 1.80 + 3.65 + 1.40);
  const procWater = weight * (1.85 + 0.14);
  const transportCarbon = weight * 0.085;

  const totalCarbon = Math.round((rawCarbon + procCarbon + transportCarbon) * 1000) / 1000;
  const totalWater = Math.round((rawWater + procWater) * 1000) / 1000;

  let microplasticsGrade: MicroplasticsRiskGrade = 'A';
  if (synthPct > 80) microplasticsGrade = 'E';
  else if (synthPct > 50) microplasticsGrade = 'D';
  else if (synthPct > 20) microplasticsGrade = 'C';
  else if (synthPct > 0) microplasticsGrade = 'B';

  const carbonIntensity = totalCarbon / Math.max(weight, 0.1);
  const waterIntensity = totalWater / Math.max(weight, 0.1);
  let score = Math.round(100 - (carbonIntensity * 2.8) - (waterIntensity * 2.5));
  if (circSum > 80) score += 5;
  if (microplasticsGrade === 'A') score += 5;
  score = Math.min(98, Math.max(12, score));

  let grade: PefGrade = 'C';
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'E';

  return {
    garmentWeightKg: weight,
    carbonFootprintKgCo2e: totalCarbon,
    waterScarcityM3: totalWater,
    pefEcoScore: score,
    pefGrade: grade,
    microplasticsRiskGrade: microplasticsGrade,
    circularityScore: Math.round(circSum),
  };
}
