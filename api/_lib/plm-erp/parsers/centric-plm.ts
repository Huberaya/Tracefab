import type { NormalizedPlmProduct, NormalizedPlmMaterial, NormalizedPlmStep } from '../types.js';

export function parseCentricPlmPayload(payload: any): NormalizedPlmProduct[] {
  let styles: any[] = [];
  if (Array.isArray(payload)) {
    styles = payload;
  } else if (Array.isArray(payload?.styles)) {
    styles = payload.styles;
  } else if (payload?.styleNumber || payload?.reference) {
    styles = [payload];
  }

  return styles.map((style, idx) => {
    const reference = String(style.styleNumber || style.reference || style.code || `CTR-STYLE-${idx + 1}`).trim();
    const name = String(style.styleName || style.name || style.title || `Centric Style ${reference}`).trim();
    const sku = style.sku || style.styleCode || reference;
    const category = style.department || style.category || style.season || 'Apparel';
    const description = style.description || (style.season ? `Collection Centric ${style.season}` : undefined);
    const colorName = style.colorway || style.color_name || style.color;
    const countryOfManufacture = style.countryOfManufacture || style.country_of_manufacture || style.countryCode;
    const weightGrams = typeof style.weightGrams === 'number' ? style.weightGrams : undefined;
    const gtin = style.gtin || style.ean || style.upc;

    const materials: NormalizedPlmMaterial[] = [];
    const rawBom = Array.isArray(style.bom) ? style.bom : Array.isArray(style.materials) ? style.materials : [];

    for (const item of rawBom) {
      const matName = String(item.materialName || item.name || item.materialCode || 'Matière Centric').trim();
      const materialType = String(item.materialType || item.type || 'fabric').trim();
      const originCountryCode = item.supplierCountry || item.originCountryCode || item.country;
      const percentage = typeof item.percentage === 'number' ? item.percentage : 100;
      const role = item.role || 'main';

      let composition: Record<string, number> = {};
      if (item.composition && typeof item.composition === 'object') {
        composition = item.composition;
      } else if (typeof item.fiberContent === 'string') {
        // e.g. "100% Cotton" or "80% Organic Cotton, 20% Polyester"
        composition = parseCompositionString(item.fiberContent);
      } else {
        composition = { [matName.toLowerCase().replace(/[^a-z0-9_]/g, '_')]: 100 };
      }

      materials.push({
        name: matName,
        materialType,
        originCountryCode,
        composition,
        percentage,
        role,
      });
    }

    const productionSteps: NormalizedPlmStep[] = [];
    const rawSteps = Array.isArray(style.productionSteps)
      ? style.productionSteps
      : Array.isArray(style.routing)
      ? style.routing
      : [];

    for (const step of rawSteps) {
      productionSteps.push({
        label: String(step.label || step.operationName || step.step || 'Étape industrielle').trim(),
        processCode: String(step.processCode || step.step || 'assembly').toLowerCase().trim(),
        countryCode: step.country || step.countryCode,
        facilityName: step.facilityName || step.supplierName,
      });
    }

    return {
      reference,
      name,
      sku,
      category,
      description,
      colorName,
      countryOfManufacture,
      weightGrams,
      gtin,
      materials,
      productionSteps,
    };
  });
}

function parseCompositionString(str: string): Record<string, number> {
  const result: Record<string, number> = {};
  const parts = str.split(/[,;/]/);
  for (const part of parts) {
    const match = part.match(/(\d+(?:\.\d+)?)\s*%\s*([a-zA-Z\s-]+)/);
    if (match) {
      const pct = parseFloat(match[1]);
      const fiber = match[2].trim().toLowerCase().replace(/\s+/g, '_');
      result[fiber] = pct;
    }
  }
  return Object.keys(result).length > 0 ? result : { standard_fiber: 100 };
}
