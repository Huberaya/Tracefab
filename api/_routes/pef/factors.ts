import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prisma } from '../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { TEXTILE_EMISSION_FACTORS } from '../../_lib/pef/pef-factors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    // Try to query active factors from Neon DB
    const dbFactors = await prisma.pef_emission_factors.findMany({
      where: { is_active: true },
      orderBy: [{ factor_type: 'asc' }, { name: 'asc' }],
    });

    if (dbFactors && dbFactors.length > 0) {
      return json(res, 200, {
        factors: dbFactors.map((f) => ({
          factorKey: f.factor_key,
          factorType: f.factor_type,
          name: f.name,
          category: f.category,
          unit: f.unit,
          carbonKgCo2e: Number(f.carbon_kg_co2e),
          waterM3: Number(f.water_m3),
          eutrophicationKgP: Number(f.eutrophication_kg_p),
          microplasticsRisk: f.microplastics_risk,
          circularityRecyclabilityPct: Number(f.circularity_recyclability_pct),
          sourceReference: f.source_reference,
        })),
        source: 'neon_database',
        count: dbFactors.length,
      });
    }

    // Fallback to static catalog
    const staticList = Object.values(TEXTILE_EMISSION_FACTORS);
    return json(res, 200, {
      factors: staticList,
      source: 'static_catalog',
      count: staticList.length,
    });
  } catch (err) {
    console.error('Factors fetch error:', err);
    // Graceful fallback
    const staticList = Object.values(TEXTILE_EMISSION_FACTORS);
    return json(res, 200, {
      factors: staticList,
      source: 'static_catalog_fallback',
      count: staticList.length,
    });
  }
}
