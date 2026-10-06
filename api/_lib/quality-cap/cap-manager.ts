import type { Prisma, PrismaClient } from '@prisma/client';
import type { CorrectiveActionPlanItem } from './types.js';

export interface CreateCapParams {
  qualityIssueId: string;
  supplierOrganizationId: string;
  title: string;
  instructions: string;
  dueDate: string;
  priority?: string;
  userId?: string;
}

export async function createQualityCap(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: CreateCapParams
): Promise<CorrectiveActionPlanItem> {
  const { qualityIssueId, supplierOrganizationId, title, instructions, dueDate, priority = 'high' } = params;

  const rows = await prisma.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_create_quality_cap(
      ${qualityIssueId}::uuid,
      ${supplierOrganizationId}::uuid,
      ${title}::text,
      ${instructions}::text,
      ${dueDate}::date,
      ${priority}::text
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('cap_creation_failed');
  }

  const r = rows[0];
  return {
    id: r.id,
    qualityIssueId: r.quality_issue_id,
    brandOrganizationId: r.brand_organization_id,
    supplierOrganizationId: r.supplier_organization_id,
    productId: r.product_id,
    title: r.title,
    instructions: r.instructions,
    status: r.status,
    priority: r.priority,
    dueDate: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : dueDate,
    supplierResponseSummary: r.supplier_response_summary,
    supportingDocumentId: r.supporting_document_id,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    submittedBy: r.submitted_by,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedBy: r.reviewed_by,
    reviewVerdict: r.review_verdict,
    reviewNotes: r.review_notes,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}

export async function submitQualityRemediation(
  prisma: PrismaClient | Prisma.TransactionClient,
  capId: string,
  responseSummary: string,
  supportingDocumentId?: string,
  message?: string
): Promise<CorrectiveActionPlanItem> {
  const rows = await prisma.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_submit_quality_remediation(
      ${capId}::uuid,
      ${responseSummary}::text,
      ${supportingDocumentId ? supportingDocumentId : null}::uuid,
      ${message ? message : null}::text
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('cap_submission_failed');
  }

  const r = rows[0];
  return {
    id: r.id,
    qualityIssueId: r.quality_issue_id,
    brandOrganizationId: r.brand_organization_id,
    supplierOrganizationId: r.supplier_organization_id,
    productId: r.product_id,
    title: r.title,
    instructions: r.instructions,
    status: r.status,
    priority: r.priority,
    dueDate: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : '',
    supplierResponseSummary: r.supplier_response_summary,
    supportingDocumentId: r.supporting_document_id,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    submittedBy: r.submitted_by,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedBy: r.reviewed_by,
    reviewVerdict: r.review_verdict,
    reviewNotes: r.review_notes,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}

export async function reviewQualityRemediation(
  prisma: PrismaClient | Prisma.TransactionClient,
  capId: string,
  verdict: 'approved' | 'rejected',
  reviewNotes?: string
): Promise<CorrectiveActionPlanItem> {
  const rows = await prisma.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_review_quality_remediation(
      ${capId}::uuid,
      ${verdict}::text,
      ${reviewNotes || null}::text
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('cap_review_failed');
  }

  const r = rows[0];
  return {
    id: r.id,
    qualityIssueId: r.quality_issue_id,
    brandOrganizationId: r.brand_organization_id,
    supplierOrganizationId: r.supplier_organization_id,
    productId: r.product_id,
    title: r.title,
    instructions: r.instructions,
    status: r.status,
    priority: r.priority,
    dueDate: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : '',
    supplierResponseSummary: r.supplier_response_summary,
    supportingDocumentId: r.supporting_document_id,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    submittedBy: r.submitted_by,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedBy: r.reviewed_by,
    reviewVerdict: r.review_verdict,
    reviewNotes: r.review_notes,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
  };
}
