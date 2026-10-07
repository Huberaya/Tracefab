import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateGoogleWalletPass } from '../../../_lib/wallet/google-wallet-generator.js';
import { getFallbackDppData } from '../../../_lib/wallet/fallback-data.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { prisma } from '../../../_lib/prisma.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = (req.query.gtin as string) || '3760123456789';

  try {
    // Données réelles d'abord. Le repli statique n'est utilisé que si le produit
    // est introuvable ou si la base est injoignable — auparavant il était la seule
    // source, quel que soit le GTIN demandé.
    const resolved = await resolveDppPassData(prisma, gtinOrRef).catch((err) => {
      console.error('Wallet DPP resolution failed, using static fallback:', err instanceof Error ? err.message : err);
      return null;
    });
    const dppData = resolved || getFallbackDppData(gtinOrRef);
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
