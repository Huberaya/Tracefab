export type PefGrade = 'A' | 'B' | 'C' | 'D' | 'E';
export type MicroplasticsRiskGrade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface CarbonBreakdown {
  raw_materials_kg_co2e: number;
  spinning_kg_co2e: number;
  weaving_knitting_kg_co2e: number;
  dyeing_finishing_kg_co2e: number;
  assembly_kg_co2e: number;
  transport_kg_co2e: number;
}

export interface WaterBreakdown {
  raw_materials_m3: number;
  dyeing_finishing_m3: number;
  manufacturing_other_m3: number;
  transport_m3: number;
}

export interface ConventionalComparison {
  conventional_carbon_kg_co2e: number;
  carbon_savings_pct: number;
  conventional_water_m3: number;
  water_savings_pct: number;
}

export interface PefAssessmentResult {
  id?: string;
  productId: string;
  productVersion: number;
  garmentCategory: string;
  garmentWeightKg: number;
  carbonFootprintKgCo2e: number;
  carbonBreakdown: CarbonBreakdown;
  waterScarcityM3: number;
  waterBreakdown: WaterBreakdown;
  eutrophicationFreshwaterKgPEq: number;
  microplasticsRiskGrade: MicroplasticsRiskGrade;
  circularityScore: number;
  pefEcoScore: number;
  pefGrade: PefGrade;
  conventionalComparison: ConventionalComparison;
  dataQualityRating: 'high' | 'medium' | 'proxy_based';
  methodologyVersion: string;
  calculatedAt: string;
}

export interface EmissionFactor {
  factorKey: string;
  name: string;
  category: string;
  carbonKgCo2e: number;
  waterM3: number;
  eutrophicationKgP: number;
  microplasticsRisk: MicroplasticsRiskGrade;
  circularityRecyclabilityPct: number;
}
