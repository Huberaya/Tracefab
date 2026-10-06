export type ClaimStatus = 'verified' | 'partially_substantiated' | 'unsubstantiated' | 'prohibited_claim';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type AuditVerdict = 'compliant' | 'warning_attention_needed' | 'non_compliant_greenwashing_risk';

export interface GreenClaimItem {
  id?: string;
  productId: string;
  productVersion: number;
  claimText: string;
  claimType: 'product_level' | 'material_level' | 'packaging' | 'process';
  targetSubjectId?: string | null;
  status: ClaimStatus;
  riskLevel: RiskLevel;
  isBlockingForDpp: boolean;
  supportingCertificationId?: string | null;
  supportingDocumentId?: string | null;
  complianceExplanation: string;
  remediationSuggestion?: string | null;
  verifiedAt?: string | null;
}

export interface GreenClaimsAuditResult {
  id?: string;
  productId: string;
  productVersion: number;
  totalClaimsAnalyzed: number;
  verifiedClaimsCount: number;
  prohibitedClaimsCount: number;
  unsubstantiatedClaimsCount: number;
  greenClaimsScore: number;
  auditVerdict: AuditVerdict;
  blockingIssues: Array<{
    claim_id?: string;
    claim_text: string;
    reason: string;
    remediation: string;
  }>;
  auditSummary: string;
  auditedAt: string;
}

export interface GreenClaimRule {
  ruleCode: string;
  category: string;
  ruleTitle: string;
  description: string;
  targetPattern: string;
  severity: RiskLevel;
  legalBasis: string;
  remediationAdvice: string;
}
