import type { NormalizedPlmProduct, NormalizedPlmMaterial, NormalizedPlmStep } from '../types.js';

export function parseLectraKubixPayload(payload: any): NormalizedPlmProduct[] {
  let articles: any[] = [];
  if (Array.isArray(payload)) {
    articles = payload;
  } else if (Array.isArray(payload?.articles)) {
    articles = payload.articles;
  } else if (payload?.articleMaster) {
    articles = [payload.articleMaster];
  } else if (payload?.code || payload?.title) {
    articles = [payload];
  }

  return articles.map((art, idx) => {
    const reference = String(art.code || art.articleCode || art.reference || `LK-ART-${idx + 1}`).trim();
    const name = String(art.title || art.name || art.description || `Article Lectra ${reference}`).trim();
    const sku = art.sku || art.barcode || reference;
    const category = art.category || art.productFamily || 'Apparel';
    const description = art.description || (art.season ? `Lectra Kubix Link - ${art.season}` : undefined);
    const colorName = art.colorName || art.color;
    const countryOfManufacture = art.madeIn || art.countryOfManufacture || art.origin;
    const weightGrams = typeof art.netWeight === 'number' ? art.netWeight : undefined;
    const gtin = art.ean13 || art.gtin || art.barcode;

    const materials: NormalizedPlmMaterial[] = [];
    const rawMats = Array.isArray(art.materials)
      ? art.materials
      : Array.isArray(art.components)
      ? art.components
      : [];

    for (const m of rawMats) {
      const matName = String(m.name || m.designation || m.code || 'Matière Lectra').trim();
      const materialType = String(m.type || m.materialType || 'fabric').trim();
      const originCountryCode = m.country || m.originCountryCode;
      const percentage = typeof m.ratio === 'number' ? m.ratio : typeof m.percentage === 'number' ? m.percentage : 100;
      const role = m.role || 'main';

      let composition: Record<string, number> = {};
      if (m.composition && typeof m.composition === 'object') {
        composition = m.composition;
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
    if (art.factoryPartner) {
      productionSteps.push({
        label: `Confection (${art.factoryPartner.name || 'Usine Partenaire'})`,
        processCode: 'assembly',
        countryCode: art.factoryPartner.country || countryOfManufacture,
        facilityName: art.factoryPartner.name,
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
