import { randomBytes, createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { BulkProductImportRow, BulkSupplierImportRow, BulkImportSummary } from './types.js';
import { calculateGs1CheckDigit, validateGtin } from '../plm-erp/gtin-engine.js';
import { sendSupplierInvitationEmail, manualInvitationFallbackAllowed } from '../email.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Parses informal composition strings like:
 * "100% Coton Biologique" or "80% Coton bio, 20% Polyester recyclé"
 */
export function parseCompositionString(compStr: string): Array<{ name: string; percentage: number }> {
  if (!compStr || typeof compStr !== 'string') return [];
  const parts = compStr.split(/[,;\+]/);
  const results: Array<{ name: string; percentage: number }> = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Regex matching "80% Coton" or "Coton 80%" or "100 % Lin"
    const pctFirst = trimmed.match(/^([0-9]{1,3}(?:[.,][0-9]+)?)\s*%\s*(.+)$/i);
    const pctLast = trimmed.match(/^(.+?)\s+([0-9]{1,3}(?:[.,][0-9]+)?)\s*%$/i);

    if (pctFirst) {
      const pct = parseFloat(pctFirst[1].replace(',', '.'));
      const name = pctFirst[2].trim();
      if (name && !isNaN(pct)) results.push({ name, percentage: pct });
    } else if (pctLast) {
      const pct = parseFloat(pctLast[2].replace(',', '.'));
      const name = pctLast[1].trim();
      if (name && !isNaN(pct)) results.push({ name, percentage: pct });
    } else {
      // No percentage, default to 100% for single item
      results.push({ name: trimmed, percentage: 100 });
    }
  }

  return results;
}

export async function bulkImportProducts(
  tx: PrismaTx,
  brandOrganizationId: string,
  rows: BulkProductImportRow[],
  userId?: string
): Promise<BulkImportSummary & { createdProductIds: string[] }> {
  const summary: BulkImportSummary & { createdProductIds: string[] } = {
    totalProcessed: rows.length,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errors: [],
    createdProductIds: [],
  };

  let materialsCreatedCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const rowNum = idx + 1;
    const r = rows[idx];

    const ref = (r.reference || '').trim();
    const name = (r.name || '').trim();

    if (!ref) {
      summary.errors.push({ row: rowNum, identifier: 'unknown', message: 'Référence produit obligatoire.' });
      summary.skippedCount++;
      continue;
    }
    if (!name) {
      summary.errors.push({ row: rowNum, identifier: ref, message: 'Nom du produit obligatoire.' });
      summary.skippedCount++;
      continue;
    }

    try {
      const category = (r.category || '').trim() || null;
      const sku = (r.sku || '').trim() || null;
      const desc = (r.description || '').trim() || null;
      const weightGrams = r.weightGrams ? Number(r.weightGrams) : null;
      const countryOfManufacture = (r.countryOfManufacture || '').trim().slice(0, 2).toUpperCase() || null;
      const countryOfDesign = (r.countryOfDesign || '').trim().slice(0, 2).toUpperCase() || null;

      // Check if product with this reference already exists for the brand
      const existing = await tx.tracefab_products.findFirst({
        where: {
          brand_organization_id: brandOrganizationId,
          reference: ref,
        },
      });

      let productId: string;

      if (existing) {
        // Update product attributes
        const updated = await tx.tracefab_products.update({
          where: { id: existing.id },
          data: {
            name,
            category: category || existing.category,
            sku: sku || existing.sku,
            description: desc || existing.description,
            weight_grams: weightGrams !== null ? weightGrams : existing.weight_grams,
            country_of_manufacture: countryOfManufacture || existing.country_of_manufacture,
            country_of_design: countryOfDesign || existing.country_of_design,
            updated_at: new Date(),
          },
        });
        productId = updated.id;
        summary.updatedCount++;
      } else {
        // Create new product
        const created = await tx.tracefab_products.create({
          data: {
            brand_organization_id: brandOrganizationId,
            reference: ref,
            name,
            category,
            sku,
            description: desc,
            weight_grams: weightGrams,
            country_of_manufacture: countryOfManufacture,
            country_of_design: countryOfDesign,
            status: 'active',
            created_by: userId || null,
          },
        });
        productId = created.id;
        summary.createdCount++;
        summary.createdProductIds.push(productId);
      }

      // Handle GTIN / EAN barcode
      if (r.gtin) {
        let gtinVal = r.gtin.trim().replace(/[^0-9]/g, '');
        if (gtinVal.length === 12) {
          // 12 digits -> calculate standard GS1 check digit to make a 13-digit EAN/GTIN-13
          const check = calculateGs1CheckDigit(gtinVal);
          gtinVal = gtinVal + String(check);
        }
        if (validateGtin(gtinVal).isValid) {
          await tx.product_identifiers.upsert({
            where: {
              product_id_identifier_type_identifier_value: {
                product_id: productId,
                identifier_type: 'gtin',
                identifier_value: gtinVal,
              },
            },
            create: {
              product_id: productId,
              identifier_type: 'gtin',
              identifier_value: gtinVal,
              is_primary: true,
              created_by: userId || null,
            },
            update: {
              is_primary: true,
            },
          });
        }
      }

      // Handle Materials & Composition
      if (r.materialComposition) {
        const compItems = parseCompositionString(r.materialComposition);
        for (const item of compItems) {
          // Look up or create material for brand
          let mat = await tx.materials.findFirst({
            where: {
              owner_organization_id: brandOrganizationId,
              name: { equals: item.name, mode: 'insensitive' },
            },
          });

          if (!mat) {
            mat = await tx.materials.create({
              data: {
                owner_organization_id: brandOrganizationId,
                name: item.name,
                material_type: 'fiber',
                origin_country_code: countryOfManufacture || 'FR',
                created_by: userId || null,
              },
            });
            materialsCreatedCount++;
          }

          // Link material in product_materials
          await tx.product_materials.upsert({
            where: {
              product_id_material_id_material_role_product_version: {
                product_id: productId,
                material_id: mat.id,
                material_role: 'main',
                product_version: 1,
              },
            },
            create: {
              product_id: productId,
              material_id: mat.id,
              material_role: 'main',
              percentage: item.percentage,
              unit: '%',
              product_version: 1,
            },
            update: {
              percentage: item.percentage,
            },
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({ row: rowNum, identifier: ref, message: msg });
      summary.skippedCount++;
    }
  }

  // Record job in plm_erp_sync_jobs for audit trail
  try {
    await tx.plm_erp_sync_jobs.create({
      data: {
        brand_organization_id: brandOrganizationId,
        source_system: 'generic_bom',
        job_reference: `IMPORT-CSV-${Date.now().toString().slice(-6)}`,
        status: summary.errors.length === 0 || summary.createdCount > 0 ? 'completed' : 'failed',
        total_records: rows.length,
        products_created: summary.createdCount,
        products_updated: summary.updatedCount,
        materials_created: materialsCreatedCount,
        warnings: summary.errors as any,
        created_by: userId || null,
      },
    });
  } catch (e) {
    console.error('Failed to log bulk import job:', e);
  }

  return summary;
}

export async function bulkImportSuppliers(
  tx: PrismaTx,
  brandOrganizationId: string,
  rows: BulkSupplierImportRow[],
  userId?: string
): Promise<BulkImportSummary & { invitations: Array<{ email: string; invitationToken?: string; status: string }> }> {
  const summary: BulkImportSummary & { invitations: Array<{ email: string; invitationToken?: string; status: string }> } = {
    totalProcessed: rows.length,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errors: [],
    invitations: [],
  };

  const brand = await tx.organizations.findUnique({
    where: { id: brandOrganizationId },
    select: { legal_name: true, display_name: true },
  });
  const brandName = brand?.display_name || brand?.legal_name || 'Tracefab Brand';

  for (let idx = 0; idx < rows.length; idx++) {
    const rowNum = idx + 1;
    const r = rows[idx];

    const email = (r.email || '').trim().toLowerCase();
    const legalName = (r.legalName || '').trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      summary.errors.push({ row: rowNum, identifier: email || 'unknown', message: 'Email fournisseur invalide.' });
      summary.skippedCount++;
      continue;
    }
    if (!legalName) {
      summary.errors.push({ row: rowNum, identifier: email, message: 'Raison sociale / nom légal obligatoire.' });
      summary.skippedCount++;
      continue;
    }

    try {
      const displayName = (r.displayName || '').trim() || null;
      const countryCode = (r.countryCode || '').trim().slice(0, 2).toUpperCase() || null;

      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      // Call database stored procedure
      const invRows = await tx.$queryRaw<Array<{
        relationship_id: string;
        supplier_organization_id: string;
        supplier_id: string;
        invitation_id: string;
        expires_at: Date;
      }>>`
        SELECT *
        FROM tracefab_invite_supplier(
          ${brandOrganizationId}::uuid,
          ${email},
          ${legalName},
          ${displayName},
          ${countryCode},
          ${tokenHash}
        )
      `;

      const inv = invRows[0];
      if (!inv) throw new Error('supplier_invitation_creation_failed');

      // Attempt email delivery
      const delivery = await sendSupplierInvitationEmail({
        to: email,
        supplierName: displayName || legalName,
        brandName,
        invitationToken: rawToken,
        expiresAt: inv.expires_at,
      });

      summary.createdCount++;
      summary.invitations.push({
        email,
        status: delivery.status,
        invitationToken: manualInvitationFallbackAllowed() ? rawToken : undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('active_supplier_invitation_exists')) {
        summary.errors.push({ row: rowNum, identifier: email, message: 'Une invitation active existe déjà pour ce fournisseur.' });
      } else {
        summary.errors.push({ row: rowNum, identifier: email, message: msg });
      }
      summary.skippedCount++;
    }
  }

  return summary;
}
