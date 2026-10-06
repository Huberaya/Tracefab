import type { NormalizedPlmProduct, NormalizedPlmStep } from '../types.js';

export function parseGs1EpcisPayload(payload: any): NormalizedPlmProduct[] {
  const events: any[] = [];
  if (Array.isArray(payload)) {
    events.push(...payload);
  } else if (Array.isArray(payload?.epcisBody?.eventList)) {
    events.push(...payload.epcisBody.eventList);
  } else if (Array.isArray(payload?.eventList)) {
    events.push(...payload.eventList);
  } else if (payload?.type || payload?.bizStep) {
    events.push(payload);
  }

  // Extract products mentioned in EPCs (e.g. urn:epc:id:sgtin:3614270.001234.001)
  const productMap = new Map<string, { gtin?: string; steps: NormalizedPlmStep[] }>();

  for (const event of events) {
    const epcs: string[] = [];
    if (Array.isArray(event.outputEPCList)) epcs.push(...event.outputEPCList);
    if (Array.isArray(event.epcList)) epcs.push(...event.epcList);
    if (Array.isArray(event.inputEPCList)) epcs.push(...event.inputEPCList);

    const bizStepRaw = String(event.bizStep || '').toLowerCase();
    let processCode = 'assembly';
    if (bizStepRaw.includes('transforming')) processCode = 'weaving';
    else if (bizStepRaw.includes('commissioning')) processCode = 'ginning';
    else if (bizStepRaw.includes('shipping')) processCode = 'packaging';
    else if (bizStepRaw.includes('receiving')) processCode = 'cutting';

    const readPoint = event.readPoint?.id || event.bizLocation?.id || '';
    const gln = readPoint.match(/sgln:([0-9.]+)/)?.[1];
    const facilityName = event.ilmd?.facilityName || event.ilmd?.siteName || (gln ? `Site GLN ${gln}` : undefined);
    const countryCode = event.ilmd?.destinationCountry || event.ilmd?.countryCode || 'PT';

    const stepLabel = event.ilmd?.process
      ? String(event.ilmd.process).toUpperCase()
      : event.type === 'TransformationEvent'
      ? `Transformation (${processCode})`
      : `Étape ${processCode}`;

    const step: NormalizedPlmStep = {
      label: stepLabel,
      processCode,
      countryCode,
      facilityName,
      gln,
    };

    for (const epc of epcs) {
      // Parse SGTIN: urn:epc:id:sgtin:CompanyPrefix.ItemRef.Serial
      const sgtinMatch = epc.match(/sgtin:([0-9]+)\.([0-9]+)/);
      const productRef = sgtinMatch ? `${sgtinMatch[1]}-${sgtinMatch[2]}` : epc;
      const gtin = sgtinMatch ? `${sgtinMatch[1]}${sgtinMatch[2]}` : undefined;

      if (!productMap.has(productRef)) {
        productMap.set(productRef, { gtin, steps: [] });
      }
      productMap.get(productRef)!.steps.push(step);
    }
  }

  const products: NormalizedPlmProduct[] = [];
  for (const [ref, info] of productMap.entries()) {
    products.push({
      reference: `EPCIS-${ref}`,
      name: `Traçabilité EPCIS ${ref}`,
      gtin: info.gtin,
      category: 'Textile',
      materials: [
        {
          name: 'Matière Traçable EPCIS',
          materialType: 'fabric',
          composition: { verified_textile: 100 },
          percentage: 100,
        },
      ],
      productionSteps: info.steps,
    });
  }

  return products.length > 0
    ? products
    : [
        {
          reference: 'EPCIS-BATCH-01',
          name: 'Lot Traçable EPCIS',
          category: 'Textile',
          materials: [{ name: 'Fibre Traçable', materialType: 'fabric', composition: { cotton: 100 }, percentage: 100 }],
          productionSteps: [
            { label: 'Filature EPCIS', processCode: 'spinning', countryCode: 'PT' },
            { label: 'Tissage EPCIS', processCode: 'weaving', countryCode: 'PT' },
          ],
        },
      ];
}
