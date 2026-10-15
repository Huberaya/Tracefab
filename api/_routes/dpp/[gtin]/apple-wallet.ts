import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { withTracefabPublicContext } from '../../../_lib/context.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = req.query.gtin as string;
  if (!gtinOrRef) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    const dppData = await withTracefabPublicContext((tx) => resolveDppPassData(tx, gtinOrRef));
    if (!dppData) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }

    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    console.error('Consumer Apple Wallet error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
