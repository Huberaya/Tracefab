import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { prisma } from '../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { resolveDppPassData } from '../../_lib/wallet/dpp-data-resolver.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = req.query.gtin as string;
  if (!gtinOrRef) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    const dppData = await resolveDppPassData(prisma, gtinOrRef);
    if (!dppData) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    return json(res, 200, {
      dpp: dppData,
      links: {
        appleWalletUrl: `/api/dpp/${encodeURIComponent(gtinOrRef)}/apple-wallet`,
        googleWalletUrl: `/api/dpp/${encodeURIComponent(gtinOrRef)}/google-wallet`,
        digitalLinkUri: dppData.digitalLinkUri,
      },
    });
  } catch (err: unknown) {
    console.error('DPP data resolution error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
