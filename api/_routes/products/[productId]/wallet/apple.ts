import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { prisma } from '../../../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { resolveDppPassData } from '../../../../_lib/wallet/dpp-data-resolver.js';
import { generateApplePkpass, resolveSignatureMode, isSignatureInstallable } from '../../../../_lib/wallet/apple-pass-generator.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const productId = req.query.productId as string;
  if (!productId) {
    return json(res, 400, { error: 'missing_product_id' });
  }

  try {
    const dppData = await resolveDppPassData(prisma, productId);
    if (!dppData) {
      return json(res, 404, { error: 'product_not_found' });
    }

    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    /*
     * Le .pkpass servi ici n'est pas installable sur iOS : la signature n'est pas
     * une structure CMS SignedData. Les en-têtes le disent, pour qu'aucune
     * interface ne présente ce fichier comme un pass fonctionnel. La valeur vient
     * de la même fonction que le générateur, donc elle ne peut pas diverger.
     */
    const signatureMode = resolveSignatureMode();
    res.setHeader('X-Tracefab-Pass-Signature', signatureMode);
    res.setHeader('X-Tracefab-Pass-Installable', String(isSignatureInstallable(signatureMode)));
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    console.error('Apple Wallet generation error:', err);
    return json(res, 500, { error: 'wallet_generation_failed' });
  }
}
