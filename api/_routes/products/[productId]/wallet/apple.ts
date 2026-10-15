import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { resolveDppPassData } from '../../../../_lib/wallet/dpp-data-resolver.js';
import { generateApplePkpass } from '../../../../_lib/wallet/apple-pass-generator.js';
import { withTracefabPublicContext } from '../../../../_lib/context.js';

/**
 * Carte Apple Wallet pour un produit, par identifiant.
 *
 * La route resout un produit PUBLIE uniquement. Elle lit donc dans le contexte
 * public limite (tracefab.public_context) : sans lui, la resolution echoue en
 * `tracefab_app` (0 ligne par conception), et avec un role BYPASSRLS elle
 * aurait pu servir un brouillon. Le contexte public + la barriere de
 * publication du resolveur ferment les deux cas : seuls les produits portant
 * un public_slug ET un dpp_records publie/relu sont resolubles.
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

    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin.value || dppData.productReference.value || 'passeport').replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    console.error('Apple Wallet generation error:', err);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
