import type { Prisma } from '@prisma/client';
import { activeOrganizationIds } from './products';

export const REQUEST_SELECT = {
  id: true,
  brand_organization_id: true,
  supplier_organization_id: true,
  product_id: true,
  title: true,
  questionnaire_key: true,
  questionnaire_version: true,
  status: true,
  due_at: true,
  created_by: true,
  submitted_at: true,
  closed_at: true,
  created_at: true,
  updated_at: true,
  relationship_id: true,
  idempotency_key: true,
  completion_percentage: true,
  last_activity_at: true,
  reviewed_at: true,
  reviewed_by: true,
} satisfies Prisma.data_requestsSelect;

export type RequestRecord = Prisma.data_requestsGetPayload<{ select: typeof REQUEST_SELECT }>;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

export function serializeRequest(request: RequestRecord) {
  return {
    id: request.id,
    brandOrganizationId: request.brand_organization_id,
    supplierOrganizationId: request.supplier_organization_id,
    productId: request.product_id,
    title: request.title,
    questionnaireKey: request.questionnaire_key,
    questionnaireVersion: request.questionnaire_version,
    status: request.status,
    dueAt: request.due_at,
    createdBy: request.created_by,
    submittedAt: request.submitted_at,
    closedAt: request.closed_at,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
    relationshipId: request.relationship_id,
    idempotencyKey: request.idempotency_key,
    completionPercentage: String(request.completion_percentage),
    lastActivityAt: request.last_activity_at,
    reviewedAt: request.reviewed_at,
    reviewedBy: request.reviewed_by,
  };
}

export async function accessibleRequest<T extends Prisma.data_requestsSelect = typeof REQUEST_SELECT>(
  tx: Prisma.TransactionClient,
  userId: string,
  requestId: string,
  select: T = REQUEST_SELECT as T,
): Promise<Prisma.data_requestsGetPayload<{ select: T }> | null> {
  const organizationIds = await activeOrganizationIds(tx, userId);
  if (organizationIds.length === 0) return null;

  return tx.data_requests.findFirst({
    where: {
      id: requestId,
      OR: [
        { brand_organization_id: { in: organizationIds } },
        {
          supplier_organization_id: { in: organizationIds },
          status: { not: 'draft' },
        },
      ],
    },
    select,
  });
}

export function parseDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`invalid_${field}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_${field}`);
  return date;
}

export function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

export function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim() || null;
}

export function jsonObject(value: unknown, field: string) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${field}`);
  return value;
}
