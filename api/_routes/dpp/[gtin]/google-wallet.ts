import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { prisma } from '../../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { generateGoogleWalletPass } from '../../../_lib/wallet/google-wallet-generator.js';
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

    const walletResult = generateGoogleWalletPass(dppData);
    return json(res, 200, {
      message: 'google_wallet_pass_generated',
      saveUrl: walletResult.saveUrl,
      jwt: walletResult.jwtToken,
      isSimulated: walletResult.isSimulated,
      passObject: walletResult.passObject,
    });
  } catch (err: unknown) {
    console.error('Consumer Google Wallet error:', err);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
