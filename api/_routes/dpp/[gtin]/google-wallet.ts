import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateGoogleWalletPass } from '../../../_lib/wallet/google-wallet-generator.js';
import { getFallbackDppData } from '../../../_lib/wallet/fallback-data.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = (req.query.gtin as string) || '3760123456789';

  try {
    const dppData = getFallbackDppData(gtinOrRef);
    const walletResult = generateGoogleWalletPass(dppData);
    
    // If the browser visits via a link, redirect directly to Google Pay save URL!
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
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Google Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed', detail: errMsg });
  }
}
