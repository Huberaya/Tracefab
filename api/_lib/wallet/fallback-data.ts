import type { DppPassData, SourcedField } from './types.js';

function demo<T>(value: T): SourcedField<T> {
  return { value, status: 'unverified', source: 'demo-fallback' };
}

export function getFallbackDppData(identifierOrId: string): DppPassData {
  const cleanId = String(identifierOrId || '3760123456789').trim();
  const gtin = cleanId.length === 13 ? cleanId : '3760123456789';
  return {
    productId: 'demo-prod-essentiel-001',
    productName: demo('Essentiel Coton Biologique'),
    productReference: demo('AT-ESS-001'),
    sku: demo('AT-ESS-001-NVY-M'),
    gtin: demo(gtin),
    serialNumber: demo(`DPP-${cleanId}-2026-FW`),
    category: demo('T-Shirt & Maille'),
    brandName: demo('Atelier Demo'),
    countryOfManufacture: demo('PT'),
    countryOfDesign: demo('FR'),
    weightGrams: demo(185),
    composition: demo('100% Coton Biologique'),
    materials: [
      {
        name: demo('Coton Biologique GOTS'),
        percentage: demo(100),
        role: demo('Tissu principal'),
        originCountry: demo('TR'),
      },
    ],
    supplyChainSummary: demo('Ferme Izmir (TR) -> Filature (FR) -> Confection (PT)'),
    pefScore: demo(84),
    pefGrade: demo('A'),
    carbonFootprintKgCo2e: demo(2.15),
    waterScarcityM3: demo(1.48),
    circularityScore: demo(92),
    verificationDate: demo('2026-10-01'),
    transactionCertificateNumber: demo('TC-CU-881294-GOTS-2026'),
    careInstructions: demo('Lavage delicat 30C. Sechage a plat.'),
    recyclingInstructions: demo('Produit monomateriau recyclable. Borne textile Refashion.'),
    dppUrl: 'https://tracefab.vercel.app/dpp/',
    digitalLinkUri: demo('https://id.tracefab.com/01/' + gtin + '/21/2026-FW-001'),
    presentation: { source: 'empty', sourcedFieldCount: 0, missingFieldCount: 1 },
  };
}
