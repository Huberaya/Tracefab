import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { resolveDppPassDataByGtin } from '../../../_lib/wallet/dpp-data-resolver.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { withTracefabPublicContext } from '../../../_lib/context.js';

/**
 * Carte Apple Wallet consommateur, par GTIN.
 *
 * Le GTIN est valide (modulo-10 GS1) puis resolu vers le produit REELLEMENT
 * publie (public_slug + dpp_records publie et relu). Aucune donnee de
 * demonstration n'est servie sur ce parcours : l'ancien chemin retournait la
 * fiche « Atelier Demo » pour n'importe quel GTIN, faute de resoudre quoi que
 * ce soit en base.
 *
 * Route anonyme : la lecture passe par le contexte public, qui n'expose que
 * les produits explicitement publies.
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
      // Un GTIN inconnu, invalide, ou rattache a un produit non publie est un
      // 404 — jamais une fiche de substitution qui ressemblerait a du reel.
      return json(res, 404, { error: 'product_passport_not_found' });
    }

    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin.value || dppData.productReference.value || 'passeport').replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Apple Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
