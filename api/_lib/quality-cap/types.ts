export type CapStatus = 'requested' | 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'closed';
export type CapPriority = 'low' | 'medium' | 'high' | 'critical';

export type QualityCapStatus = CapStatus;
export type QualityCapPriority = CapPriority;

export interface CreateQualityCapInput {
  qualityIssueId: string;
  supplierOrganizationId: string;
  title: string;
  instructions: string;
  dueDate: string;
  priority?: string;
  userId?: string;
}

export interface CorrectiveActionPlanItem {
  id: string;
  qualityIssueId: string;
  brandOrganizationId: string;
  supplierOrganizationId: string;
  productId?: string | null;
  title: string;
  instructions: string;
  status: CapStatus;
  priority: CapPriority;
  dueDate: string;
  supplierResponseSummary?: string | null;
  supportingDocumentId?: string | null;
  submittedAt?: string | null;
  submittedBy?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewVerdict?: 'approved' | 'rejected' | null;
  reviewNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapMessageItem {
  id: string;
  capId: string;
  senderOrganizationId: string;
  senderUserId?: string | null;
  senderRole: 'brand' | 'supplier' | 'auditor';
  message: string;
  attachmentDocumentId?: string | null;
  createdAt: string;
}
