import type { Prisma } from '@prisma/client';

export interface ConfidentialSupplierData {
  productionCostPerUnitEur?: number;
  grossMarginPercent?: number;
  exactChemicalFormulation?: string;
  internalSubcontractorNames?: string[];
  minimumOrderQuantity?: number;
}

export interface SanitizedComplianceOutput {
  isCompliant: boolean;
  complianceStandard: string;
  verifiedScore: string;
  auditPassed: boolean;
  environmentalCertificationValid: boolean;
  socialAuditGrade: string;
  redactedFieldsCount: number;
}

/**
 * Sanitizes supplier trade secrets before exporting or sharing data with client fashion brands.
 * Enforces zero-leakage of unit costs, production margins, and proprietary chemical recipes.
 */
export function sanitizeSupplierTradeSecrets(
  data: Record<string, unknown>
): { sanitized: Record<string, unknown>; confidentialCount: number } {
  const sensitiveKeys = new Set([
    'productionCostPerUnitEur',
    'production_cost',
    'cost_eur',
    'unit_cost',
    'grossMarginPercent',
    'gross_margin',
    'margin_pct',
    'exactChemicalFormulation',
    'chemical_recipe',
    'proprietary_formula',
    'internalSubcontractorNames',
    'subcontractors_confidential',
  ]);

  const sanitized: Record<string, unknown> = {};
  let confidentialCount = 0;

  for (const [key, value] of Object.entries(data)) {
    if (sensitiveKeys.has(key)) {
      confidentialCount++;
      // Mark as protected trade secret without exposing value
      sanitized[key] = '[PROTECTED_TRADE_SECRET_VERIFIED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeSupplierTradeSecrets(value as Record<string, unknown>);
      sanitized[key] = nested.sanitized;
      confidentialCount += nested.confidentialCount;
    } else {
      sanitized[key] = value;
    }
  }

  return { sanitized, confidentialCount };
}
