import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateGoogleWalletPass } from '../../../_lib/wallet/google-wallet-generator.js';
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

    const walletResult = generateGoogleWalletPass(dppData);

    if (req.headers.accept?.includes('text/html')) {
      res.setHeader('Location', walletResult.saveUrl);
      return res.status(302).end();
    }

    return json(res, 200, {
      message: 'google_wallet_pass_generated',
      saveUrl: walletResult.saveUrl,
      jwt: walletResult.jwtToken,
      isSimulated: walletResult.isSimulated,
      passObject: walletResult.passObject,
    });
  } catch (err: unknown) {
    console.error('Consumer Google Wallet error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
