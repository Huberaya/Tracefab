import type { NormalizedPlmProduct, NormalizedPlmMaterial, NormalizedPlmStep } from '../types.js';

export function parseSapS4HanaPayload(payload: any): NormalizedPlmProduct[] {
  let articles: any[] = [];
  if (Array.isArray(payload)) {
    articles = payload;
  } else if (Array.isArray(payload?.articles)) {
    articles = payload.articles;
  } else if (Array.isArray(payload?.MARA)) {
    articles = payload.MARA;
  } else if (payload?.MATNR || payload?.MAKTX) {
    articles = [payload];
  }

  return articles.map((art, idx) => {
    const reference = String(art.MATNR || art.articleNumber || art.reference || `SAP-${idx + 1}`).trim();
    const name = String(art.MAKTX || art.articleDescription || art.name || `Article SAP ${reference}`).trim();
    const sku = art.MATNR ? String(art.MATNR).replace(/^0+/, '') : reference;
    const category = art.MATKL || art.materialGroup || 'Textile';
    const description = art.MAKTX;
    const colorName = art.COLOR || art.FARBE;
    const countryOfManufacture = art.HERKL || art.countryOfOrigin;
    const weightGrams = typeof art.BRGEW === 'number' ? art.BRGEW : undefined;
    const gtin = art.EAN11 || art.ean || art.gtin;

    const materials: NormalizedPlmMaterial[] = [];
    const rawBom = Array.isArray(art.BOM) ? art.BOM : Array.isArray(art.materials) ? art.materials : [];

    for (const b of rawBom) {
      const matName = String(b.POSTX || b.IDNRK || b.name || 'Composant SAP').trim();
      const materialType = 'fabric';
      const originCountryCode = b.HERKL || countryOfManufacture;
      const percentage = typeof b.MENGE === 'number' ? b.MENGE : 100;
      const role = 'main';

      materials.push({
        name: matName,
        materialType,
        originCountryCode,
        composition: { [matName.toLowerCase().replace(/[^a-z0-9_]/g, '_')]: 100 },
        percentage,
        role,
      });
    }

    const productionSteps: NormalizedPlmStep[] = [];
    if (art.WERKS || art.NAME1) {
      productionSteps.push({
        label: `Production Site SAP ${art.WERKS || ''} (${art.NAME1 || 'Usine'})`.trim(),
        processCode: 'assembly',
        countryCode: countryOfManufacture,
        facilityName: art.NAME1,
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
