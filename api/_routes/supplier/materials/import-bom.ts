import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { currentSupplier } from '../../../_lib/supplier-profile.js';
import { parseSupplierBomCsv, type BomImportRow } from '../../../_lib/bom-importer.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

type BomImportBody = {
  csvContent?: string;
  autoSaveMaterials?: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<BomImportBody>(req);
  const { csvContent, autoSaveMaterials } = body;

  if (!csvContent || typeof csvContent !== 'string') {
    return json(res, 400, { error: 'csv_content_required', message: 'Field "csvContent" is mandatory.' });
  }

  try {
    return await withTracefabTenantContext(req, auth.user, { types: ['supplier'] }, async (tx, tenant) => {
    const supplier = await currentSupplier(tx, auth.user.id, tenant.organizationId);
    if (!supplier) {
      return json(res, 404, { error: 'supplier_not_found' });
    }

    const validation = parseSupplierBomCsv(csvContent);

    let savedMaterialsCount = 0;
    if (validation.isValid && autoSaveMaterials) {
      // Ingest materials in supplier organization materials catalog
      for (const row of validation.parsedRows) {
        try {
          await tx.materials.create({
            data: {
              owner_organization_id: supplier.organization_id,
              name: row.materialName,
              material_type: row.materialType,
              origin_country_code: row.originCountry,
              composition: { percentage: row.percentage, lot: row.supplierLotNumber || null },
              created_by: auth.user.id,
            },
          });
          savedMaterialsCount++;
        } catch {
          // Continue if duplicate name or constraint violation
        }
      }
    }

    return json(res, 200, {
      status: 'ok',
      isValid: validation.isValid,
      totalPercentage: validation.totalPercentage,
      rowsCount: validation.rowsCount,
      parsedRows: validation.parsedRows,
      errors: validation.errors,
      warnings: validation.warnings,
      detectedStandards: validation.detectedStandards,
      savedMaterialsCount,
    });
    });
  } catch (error) {
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    console.error('POST /api/supplier/materials/import-bom failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
