import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { resolveDppPassData } from '../../../../_lib/wallet/dpp-data-resolver.js';
import { generateGoogleWalletPass } from '../../../../_lib/wallet/google-wallet-generator.js';
import { withTracefabPublicContext } from '../../../../_lib/context.js';

/**
 * Carte Google Wallet pour un produit, par identifiant.
 *
 * Meme barriere que la carte Apple par produit : resolution d'un produit
 * PUBLIE uniquement, dans le contexte public limite. Un brouillon ou un
 * produit sans etat publie explicite ne resout pas (404).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const productId = req.query.productId as string;
  if (!productId) {
    return json(res, 400, { error: 'missing_product_id' });
  }

  try {
    const dppData = await withTracefabPublicContext((tx) =>
      resolveDppPassData(tx, productId),
    );
    if (!dppData) {
      return json(res, 404, { error: 'product_not_found' });
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
    console.error('Google Wallet generation error:', err);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
