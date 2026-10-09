import type { DppPassData } from './types.js';

export function getFallbackDppData(identifierOrId: string): DppPassData {
  const cleanId = String(identifierOrId || '3760123456789').trim();

  return {
    productId: 'demo-prod-essentiel-001',
    brandName: 'Atelier Demo',
    brandLegalName: 'Atelier Demo SAS',
    productName: 'Essentiel Coton Biologique',
    productReference: 'AT-ESS-001',
    sku: 'AT-ESS-001-NVY-M',
    gtin: cleanId.length === 13 ? cleanId : '3760123456789',
    serialNumber: `DPP-${cleanId}-2026-FW`,
    category: 'T-Shirt & Maille',
    countryOfManufacture: 'PT',
    countryOfDesign: 'FR',
    weightGrams: 185,
    certifiedComposition: '100% Coton Biologique Régénératif',
    materials: [
      { name: 'Coton Biologique GOTS', percentage: 100, role: 'Tissu principal', originCountry: 'TR' }
    ],
    pefScore: 84,
    pefGrade: 'A',
    carbonFootprintKgCo2e: 2.15,
    waterScarcityM3: 1.48,
    circularityScore: 92,
    dppUrl: `https://tracefab.vercel.app/dpp/`,
    digitalLinkUri: `https://id.tracefab.com/01/${cleanId.length === 13 ? cleanId : '03760123456789'}/21/2026-FW-001`,
    verificationDate: '2026-10-01',
    transactionCertificateNumber: 'TC-CU-881294-GOTS-2026',
    supplyChainSummary: 'Ferme Izmir (TR) ➔ Filature Haute-Vienne (FR) ➔ Tricotage Barcelos (PT) ➔ Confection Braga (PT) ➔ Hub Lyon (FR)',
    careInstructions: 'Lavage délicat à 30°C sur envers. Séchage à plat. Réparable via notre réseau partenaire (Bonus Refashion éligible).',
    recyclingInstructions: 'Produit monomatériau 100% recyclable. Déposer en borne textile Refashion ou renvoyer en boutique.'
  };
}
