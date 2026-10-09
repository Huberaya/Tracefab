import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { prisma } from '../../../_lib/prisma.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { withTracefabPublicContext } from '../../../_lib/context.js';

/**
 * Carte Apple Wallet d'un passeport PUBLIC, résolu par GTIN.
 *
 * CE QUE CETTE ROUTE FAISAIT
 *   `const dppData = getFallbackDppData(gtinOrRef);` — la base n'était jamais
 *   consultée. Le GTIN absent était remplacé par `3760123456789`. Toute personne
 *   scannant n'importe quel code-barres obtenait un pkpass signé au nom
 *   d'« Atelier Demo », avec un éco-score A inventé et la mention « ESPR
 *   CONFORME ».
 *
 *   C'est la raison pour laquelle `fallback-data.ts` n'est plus importé ici :
 *   une donnée de démonstration n'a pas sa place dans un parcours consommateur.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtin = req.query.gtin as string;
  if (!gtin) {
    // Pas de GTIN par défaut : un identifiant manquant est une requête invalide,
    // pas une invitation à servir un produit de démonstration.
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    // Route anonyme : le contexte public arme les politiques de lecture, et le
    // mode 'gtin' valide l'identifiant et interdit la résolution par référence
    // interne ou par SKU.
    const dppData = await withTracefabPublicContext((tx) =>
      resolveDppPassData(tx, gtin, undefined, { mode: 'gtin' }),
    );

    if (!dppData) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }

    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Apple Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
