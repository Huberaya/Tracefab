import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  TransactionCertificateRecord,
  MassBalanceAllocationRecord,
  MassBalanceReconciliationRecord,
  RegisterTransactionCertificateInput,
  AllocateTcQuantityInput,
  ReconcileProductMassBalanceInput,
  ReconciliationVerdict,
} from './types.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Registers a new Transaction Certificate (TC) in the ledger.
 */
export async function registerTransactionCertificate(
  tx: PrismaTx,
  input: RegisterTransactionCertificateInput
): Promise<TransactionCertificateRecord> {
  const rows = await tx.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_register_transaction_certificate(
      p_tc_number := ${input.tcNumber},
      p_standard := ${input.standard},
      p_issuer_name := ${input.issuerName},
      p_seller_organization_id := ${input.sellerOrganizationId}::uuid,
      p_buyer_organization_id := ${input.buyerOrganizationId}::uuid,
      p_certified_material_name := ${input.certifiedMaterialName},
      p_total_certified_weight_kg := ${input.totalCertifiedWeightKg}::numeric,
      p_total_certified_meters := ${input.totalCertifiedMeters ?? null}::numeric,
      p_issue_date := ${input.issueDate ?? null}::date,
      p_expiry_date := ${input.expiryDate ?? null}::date,
      p_document_id := ${input.documentId ?? null}::uuid
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('failed_to_register_tc');
  }

  const tc = rows[0];
  const total = Number(tc.total_certified_weight_kg);
  const allocated = Number(tc.allocated_weight_kg);
  return {
    id: tc.id,
    tcNumber: tc.tc_number,
    standard: tc.standard,
    issuerName: tc.issuer_name,
    sellerOrganizationId: tc.seller_organization_id,
    buyerOrganizationId: tc.buyer_organization_id,
    certifiedMaterialName: tc.certified_material_name,
    totalCertifiedWeightKg: total,
    totalCertifiedMeters: tc.total_certified_meters ? Number(tc.total_certified_meters) : null,
    allocatedWeightKg: allocated,
    allocatedMeters: Number(tc.allocated_meters || 0),
    remainingWeightKg: total - allocated,
    status: tc.status,
    issueDate: tc.issue_date?.toISOString?.()?.slice(0, 10) || tc.issue_date,
    expiryDate: tc.expiry_date?.toISOString?.()?.slice(0, 10) || tc.expiry_date,
    documentId: tc.document_id,
    createdAt: tc.created_at?.toISOString?.() || tc.created_at,
    updatedAt: tc.updated_at?.toISOString?.() || tc.updated_at,
  };
}

/**
 * Allocates certified quantity from a TC to a specific product batch (with strict anti-double spending protection).
 */
export async function allocateTcQuantity(
  tx: PrismaTx,
  input: AllocateTcQuantityInput
): Promise<MassBalanceAllocationRecord> {
  const rows = await tx.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_allocate_tc_quantity(
      p_tc_id := ${input.tcId}::uuid,
      p_product_id := ${input.productId}::uuid,
      p_allocated_weight_kg := ${input.allocatedWeightKg}::numeric,
      p_allocated_meters := ${input.allocatedMeters ?? 0}::numeric,
      p_order_id := ${input.orderId ?? null}::uuid,
      p_notes := ${input.notes ?? null}
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('failed_to_allocate_tc');
  }

  const a = rows[0];
  return {
    id: a.id,
    transactionCertificateId: a.transaction_certificate_id,
    productId: a.product_id,
    orderId: a.order_id,
    allocatedWeightKg: Number(a.allocated_weight_kg),
    allocatedMeters: Number(a.allocated_meters || 0),
    notes: a.notes,
    createdAt: a.created_at?.toISOString?.() || a.created_at,
  };
}

/**
 * Runs volumetric reconciliation on a product batch and detects greenwashing fraud risks.
 */
export async function reconcileProductMassBalance(
  tx: PrismaTx,
  input: ReconcileProductMassBalanceInput
): Promise<MassBalanceReconciliationRecord> {
  const rows = await tx.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_reconcile_mass_balance(
      p_product_id := ${input.productId}::uuid,
      p_production_volume_units := ${input.productionVolumeUnits}::integer,
      p_cutting_waste_pct := ${input.cuttingWastePct ?? 12.00}::numeric,
      p_batch_reference := ${input.batchReference ?? 'SERIE_PRODUCTION_2026'}
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('failed_to_reconcile_mass_balance');
  }

  const r = rows[0];
  return {
    id: r.id,
    productId: r.product_id,
    brandOrganizationId: r.brand_organization_id,
    batchReference: r.batch_reference,
    productionVolumeUnits: Number(r.production_volume_units),
    unitWeightGrams: Number(r.unit_weight_grams),
    cuttingWastePct: Number(r.cutting_waste_pct),
    theoreticalRequiredKg: Number(r.theoretical_required_kg),
    allocatedCertifiedKg: Number(r.allocated_certified_kg),
    deficitKg: Number(r.deficit_kg),
    coverageRatioPct: Number(r.coverage_ratio_pct),
    verdict: r.verdict as ReconciliationVerdict,
    fraudRiskScore: Number(r.fraud_risk_score),
    summary: r.summary,
    blockingIssueCreated: r.blocking_issue_created,
    qualityIssueId: r.quality_issue_id,
    createdAt: r.created_at?.toISOString?.() || r.created_at,
  };
}

/**
 * Retrieves full mass-balance state for a product.
 */
export async function getProductMassBalanceSummary(
  tx: PrismaTx,
  productId: string
): Promise<{
  latestReconciliation: MassBalanceReconciliationRecord | null;
  allocations: Array<any>;
  totalAllocatedKg: number;
}> {
  const latestRow = await tx.mass_balance_reconciliations.findFirst({
    where: { product_id: productId },
    orderBy: { created_at: 'desc' },
  });

  const allocations = await tx.mass_balance_allocations.findMany({
    where: { product_id: productId },
    include: {
      transaction_certificates: {
        select: {
          id: true,
          tc_number: true,
          standard: true,
          issuer_name: true,
          certified_material_name: true,
          total_certified_weight_kg: true,
          allocated_weight_kg: true,
        },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  const totalAllocatedKg = allocations.reduce((sum, a) => sum + Number(a.allocated_weight_kg), 0);

  let reconRecord: MassBalanceReconciliationRecord | null = null;
  if (latestRow) {
    reconRecord = {
      id: latestRow.id,
      productId: latestRow.product_id,
      brandOrganizationId: latestRow.brand_organization_id,
      batchReference: latestRow.batch_reference,
      productionVolumeUnits: Number(latestRow.production_volume_units),
      unitWeightGrams: Number(latestRow.unit_weight_grams),
      cuttingWastePct: Number(latestRow.cutting_waste_pct),
      theoreticalRequiredKg: Number(latestRow.theoretical_required_kg),
      allocatedCertifiedKg: Number(latestRow.allocated_certified_kg),
      deficitKg: Number(latestRow.deficit_kg),
      coverageRatioPct: Number(latestRow.coverage_ratio_pct),
      verdict: latestRow.verdict as ReconciliationVerdict,
      fraudRiskScore: Number(latestRow.fraud_risk_score),
      summary: latestRow.summary,
      blockingIssueCreated: latestRow.blocking_issue_created,
      qualityIssueId: latestRow.quality_issue_id,
      createdAt: latestRow.created_at.toISOString(),
    };
  }

  return {
    latestReconciliation: reconRecord,
    allocations,
    totalAllocatedKg,
  };
}
