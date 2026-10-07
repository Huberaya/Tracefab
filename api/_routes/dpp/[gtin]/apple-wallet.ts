import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { generateApplePkpass } from '../../../_lib/wallet/apple-pass-generator.js';
import { resolveDppPassData } from '../../../_lib/wallet/dpp-data-resolver.js';
import { prisma } from '../../../_lib/prisma.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = req.query.gtin as string;
  if (!gtinOrRef) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    const resolved = await resolveDppPassData(prisma, gtinOrRef).catch((err) => {
      console.error('Wallet DPP resolution failed:', err instanceof Error ? err.message : err);
      return null;
    });
    // Un pass signé ne peut pas être émis sur un produit introuvable : le repli
    // générait un passeport complet inventé (PEF 84/A, 2,15 kg CO2e, certificat
    // TC-CU-881294-GOTS-2026) remis au consommateur comme une mesure réelle.
    if (!resolved) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }
    const dppData = resolved;
    const pkpassBuffer = await generateApplePkpass(dppData);
    const filename = `dpp-${(dppData.gtin || dppData.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}.pkpass`;

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(pkpassBuffer);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Consumer Apple Wallet error:', errMsg);
    return json(res, 500, { error: 'wallet_generation_failed', detail: errMsg });
  }
}
