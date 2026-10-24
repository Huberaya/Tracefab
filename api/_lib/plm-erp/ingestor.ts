import { Prisma } from '@prisma/client';
import type { PlmErpSystemType, NormalizedPlmProduct, IngestionJobSummary } from './types.js';
import { parseCentricPlmPayload } from './parsers/centric-plm.js';
import { parseLectraKubixPayload } from './parsers/lectra-kubix.js';
import { parseSapS4HanaPayload } from './parsers/sap-s4hana.js';
import { parseGs1EpcisPayload } from './parsers/gs1-epcis.js';
import { validateGtin } from './gtin-engine.js';

export function normalizePlmErpPayload(systemType: PlmErpSystemType, rawPayload: any): NormalizedPlmProduct[] {
  let products: NormalizedPlmProduct[] = [];

  switch (systemType) {
    case 'centric_plm':
      products = parseCentricPlmPayload(rawPayload);
      break;
    case 'lectra_kubix':
      products = parseLectraKubixPayload(rawPayload);
      break;
    case 'sap_s4hana':
      products = parseSapS4HanaPayload(rawPayload);
      break;
    case 'gs1_epcis':
      products = parseGs1EpcisPayload(rawPayload);
      break;
    case 'generic_csv':
    default:
      if (Array.isArray(rawPayload)) {
        products = rawPayload.map((item, idx) => ({
          reference: String(item.reference || item.ref || item.code || `PROD-${idx + 1}`).trim(),
          name: String(item.name || item.title || `Produit ${item.reference || idx + 1}`).trim(),
          sku: item.sku,
          category: item.category,
          description: item.description,
          colorName: item.colorName || item.color,
          countryOfManufacture: item.countryOfManufacture || item.country,
          weightGrams: item.weightGrams ? Number(item.weightGrams) : undefined,
          gtin: item.gtin || item.ean,
          materials: Array.isArray(item.materials) ? item.materials : [],
          productionSteps: Array.isArray(item.productionSteps) ? item.productionSteps : [],
        }));
      } else if (rawPayload?.reference || rawPayload?.name) {
        products = [rawPayload];
      }
      break;
  }

  // Validate and clean GTINs
  for (const prod of products) {
    if (prod.gtin) {
      const gtinCheck = validateGtin(prod.gtin);
      if (!gtinCheck.isValid) {
        // Log warning or keep raw if invalid
      }
    }
  }

  return products;
}

export async function ingestPlmErpData(
  tx: Prisma.TransactionClient,
  organizationId: string,
  systemType: PlmErpSystemType,
  rawPayload: any,
  integrationId?: string
): Promise<IngestionJobSummary> {
  const normalizedProducts = normalizePlmErpPayload(systemType, rawPayload);

  if (normalizedProducts.length === 0) {
    throw new Error('Aucun produit exploitable trouvé dans le payload d\'ingestion.');
  }

  // La fonction SQL est SECURITY DEFINER et exige le contexte utilisateur
  // (tracefab_current_user_id + rôle dans l'organisation cible). Elle doit
  // donc être appelée sur la transaction qui porte ce contexte — jamais sur
  // le client global, qui ouvrirait une autre connexion sans aucun GUC :
  // la fonction y lèverait `authentication_required` (échec fermé, mais
  // route cassée) et la barrière d'appartenance en base ne serait jamais
  // exercée. Le client est un paramètre obligatoire pour que l'oubli soit
  // impossible à écrire.
  const result: any = await tx.$queryRaw`
    SELECT tracefab_ingest_plm_erp_payload(
      ${organizationId}::uuid,
      ${systemType},
      ${JSON.stringify(normalizedProducts)}::jsonb,
      ${integrationId ? integrationId : null}::uuid
    ) AS summary
  `;

  const summary = result?.[0]?.summary || {};

  return {
    success: summary.success ?? true,
    jobId: summary.jobId || '',
    systemType,
    recordsIngested: summary.recordsIngested || normalizedProducts.length,
    productsCreated: summary.productsCreated || 0,
    productsUpdated: summary.productsUpdated || 0,
    materialsCreated: summary.materialsCreated || 0,
    identifiersCreated: summary.identifiersCreated || 0,
    nodesCreated: summary.nodesCreated || 0,
    summary: summary.summary || 'Ingestion complétée avec succès.',
  };
}
