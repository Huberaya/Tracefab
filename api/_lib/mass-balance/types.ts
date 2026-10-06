/**
 * Mass-Balance & Volumetric Anti-Fraud Engine Types
 * Chantier 7: Reconciliation between Transaction Certificates (TC) and Confection Volumes
 */

export type ReconciliationVerdict = 'fully_covered' | 'partially_covered' | 'severe_deficit' | 'unsupported';

export interface TransactionCertificateRecord {
  id: string;
  tcNumber: string;
  standard: string;
  issuerName: string;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  certifiedMaterialName: string;
  totalCertifiedWeightKg: number;
  totalCertifiedMeters?: number | null;
  allocatedWeightKg: number;
  allocatedMeters: number;
  remainingWeightKg: number;
  status: 'active' | 'exhausted' | 'revoked' | 'expired';
  issueDate: string;
  expiryDate?: string | null;
  documentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MassBalanceAllocationRecord {
  id: string;
  transactionCertificateId: string;
  productId: string;
  orderId?: string | null;
  allocatedWeightKg: number;
  allocatedMeters?: number;
  notes?: string | null;
  createdAt: string;
}

export interface MassBalanceReconciliationRecord {
  id: string;
  productId: string;
  brandOrganizationId: string;
  batchReference: string;
  productionVolumeUnits: number;
  unitWeightGrams: number;
  cuttingWastePct: number;
  theoreticalRequiredKg: number;
  allocatedCertifiedKg: number;
  deficitKg: number;
  coverageRatioPct: number;
  verdict: ReconciliationVerdict;
  fraudRiskScore: number;
  summary: string;
  blockingIssueCreated: boolean;
  qualityIssueId?: string | null;
  createdAt: string;
}

export interface RegisterTransactionCertificateInput {
  tcNumber: string;
  standard: string;
  issuerName: string;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  certifiedMaterialName: string;
  totalCertifiedWeightKg: number;
  totalCertifiedMeters?: number;
  issueDate?: string;
  expiryDate?: string;
  documentId?: string;
}

export interface AllocateTcQuantityInput {
  tcId: string;
  productId: string;
  allocatedWeightKg: number;
  allocatedMeters?: number;
  orderId?: string;
  notes?: string;
}

export interface ReconcileProductMassBalanceInput {
  productId: string;
  productionVolumeUnits: number;
  cuttingWastePct?: number;
  batchReference?: string;
}
