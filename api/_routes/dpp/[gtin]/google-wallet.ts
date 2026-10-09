import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { resolveDppPassDataByGtin } from '../../../_lib/wallet/dpp-data-resolver.js';
import { generateGoogleWalletPass } from '../../../_lib/wallet/google-wallet-generator.js';
import { withTracefabPublicContext } from '../../../_lib/context.js';

/**
 * Carte Google Wallet consommateur, par GTIN.
 *
 * Meme barriere que la carte Apple : GTIN valide, produit reellement publie,
 * aucune donnee de demonstration servie comme reelle. L'ancien chemin
 * retournait la fiche « Atelier Demo » pour n'importe quel GTIN.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = String(req.query.gtin || '').trim();
  if (!gtinOrRef) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    const dppData = await withTracefabPublicContext((tx) =>
      resolveDppPassDataByGtin(tx, gtinOrRef),
    );
    if (!dppData) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }

    const walletResult = generateGoogleWalletPass(dppData);

    // Si le navigateur visite via un lien, redirection directe vers l'URL
    // d'enregistrement Google Pay.
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
    console.error('Consumer Google Wallet error:', err instanceof Error ? err.message : String(err));
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
