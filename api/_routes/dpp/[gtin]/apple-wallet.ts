import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { resolveDppPassData, IdentifiantPublicAmbigu } from '../../../_lib/wallet/dpp-data-resolver.js';
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
    // CETTE ROUTE NE CONSULTAIT PAS LA BASE.
    //
    // Elle appelait `getFallbackDppData()`, qui rendait un jeu de donnees
    // entierement fictif — marque « Atelier Demo », composition « 100% Coton
    // Biologique Regeneratif », empreinte 2,15 kg CO2e, grade A, chaine
    // « Ferme Izmir -> ... -> Hub Lyon » et, le plus grave, un numero de
    // certificat de transaction GOTS, « TC-CU-881294-GOTS-2026 ».
    //
    // Comme l'identifiant scanne n'etait utilise que pour composer le GTIN
    // affiche, N'IMPORTE QUEL code-barres produisait un laissez-passer
    // credible portant ces allegations, livre dans le portefeuille du
    // consommateur. Rien ne le signalait comme une demonstration.
    //
    // On resout desormais le produit reellement publie, et on refuse quand il
    // n'y en a pas : mieux vaut 404 qu'un certificat invente.
    const dppData = await withTracefabPublicContext((tx) => resolveDppPassData(tx, gtinOrRef));
    if (!dppData) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }
    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    // Ambigu n'est pas introuvable : plusieurs produits publies repondent
    // a cet identifiant. Choisir pour le lecteur reviendrait a lui servir
    // le passeport d'une autre marque.
    if (err instanceof IdentifiantPublicAmbigu) {
      return json(res, 409, { error: 'ambiguous_public_identifier' });
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Apple Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed', detail: errMsg });
  }
}
