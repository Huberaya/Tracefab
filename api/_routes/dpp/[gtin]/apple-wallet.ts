import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { prisma } from '../../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { getFallbackDppData } from '../../../_lib/wallet/fallback-data.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = req.query.gtin as string;
  if (!gtinOrRef) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    let dppData = null;
    try {
      dppData = await resolveDppPassData(prisma, gtinOrRef);
    } catch (dbErr) {
      console.warn('Database lookup failed or table missing, using fallback DPP data:', dbErr);
    }

    if (!dppData) {
      dppData = getFallbackDppData(gtinOrRef);
    }

    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    console.error('Consumer Apple Wallet error:', err);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
