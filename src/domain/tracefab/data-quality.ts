import type {
  DataQualityIssue,
  DataQualityScore,
  QualityIssueStatus,
  UUID,
} from './types';

export interface ComputeSupplierQualityCommand {
  supplierId: UUID;
  calculationVersion?: string;
}

export interface ComputeProductQualityCommand {
  productId: UUID;
  calculationVersion?: string;
}

export interface QualityIssueAction {
  issueId: UUID;
}

export interface WaiveQualityIssueCommand extends QualityIssueAction {
  reason: string;
}

export interface QualityIssueList {
  issues: DataQualityIssue[];
  openCount: number;
  blockingCount: number;
  statusFilter?: QualityIssueStatus;
}

export interface QualitySnapshot {
  score: DataQualityScore;
  openIssues: DataQualityIssue[];
}
