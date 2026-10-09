import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateGoogleWalletPass } from '../../../_lib/wallet/google-wallet-generator.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { withTracefabPublicContext } from '../../../_lib/context.js';

/**
 * Carte Google Wallet d'un passeport PUBLIC, résolu par GTIN.
 *
 * Même défaut que la route Apple, même correctif : la base n'était jamais
 * consultée, `getFallbackDppData` servait « Atelier Demo » pour n'importe quel
 * GTIN, et le GTIN absent était remplacé par `3760123456789`.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtin = req.query.gtin as string;
  if (!gtin) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    const dppData = await withTracefabPublicContext((tx) =>
      resolveDppPassData(tx, gtin, undefined, { mode: 'gtin' }),
    );

    if (!dppData) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }

    const walletResult = generateGoogleWalletPass(dppData);

    // Un navigateur qui suit le lien est redirigé vers l'URL d'enregistrement.
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
      provenance: dppData.provenance,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Google Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
