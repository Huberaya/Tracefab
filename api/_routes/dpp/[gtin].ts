import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { prisma } from '../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { resolveDppPassData } from '../../_lib/wallet/dpp-data-resolver.js';
import { withTracefabPublicContext } from '../../_lib/context.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const gtinOrRef = req.query.gtin as string;
  if (!gtinOrRef) {
    return json(res, 400, { error: 'missing_identifier' });
  }

  try {
    // Route anonyme : sans contexte public, chaque table tenant rend 0 ligne
    // une fois l'application connectee en tracefab_app.
    const resolved = await withTracefabPublicContext(async (tx) => {
      const dpp = await resolveDppPassData(tx, gtinOrRef);
      if (!dpp) return null;
      // Liste blanche SQL + RLS : aucun detail, acteur, document ou metadata
      // prive ne traverse cette projection anonyme.
      const history = await tx.$queryRaw<Array<{
        id: string; event_type: string; business_occurred_at: Date | null;
        recorded_at: Date; validation_status: string; public_summary: string;
      }>>`
        SELECT id,event_type,business_occurred_at,recorded_at,
               validation_status::text,public_summary
        FROM dpp_lifecycle_events
        WHERE product_id=${dpp.productId}::uuid AND public_summary IS NOT NULL
        ORDER BY recorded_at DESC,id DESC LIMIT 100`;
      return { dpp, history };
    });
    if (!resolved) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }
    const { dpp: dppData, history } = resolved;

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return json(res, 200, {
      dpp: dppData,
      history,
      links: {
        appleWalletUrl: `/api/dpp/${encodeURIComponent(gtinOrRef)}/apple-wallet`,
        googleWalletUrl: `/api/dpp/${encodeURIComponent(gtinOrRef)}/google-wallet`,
        digitalLinkUri: dppData.digitalLinkUri.value ?? dppData.dppUrl,
      },
    });
  } catch (err: unknown) {
    console.error('DPP data resolution error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
