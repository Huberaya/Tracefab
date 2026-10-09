import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { getFallbackDppData } from '../../../_lib/wallet/fallback-data.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = (req.query.gtin as string) || '3760123456789';

  try {
    const dppData = getFallbackDppData(gtinOrRef);
    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Apple Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed', detail: errMsg });
  }
}
