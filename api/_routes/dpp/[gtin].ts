import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { resolveDppPassData } from '../../_lib/wallet/dpp-data-resolver.js';
import { withTracefabPublicContext } from '../../_lib/context.js';
import {
  toPublicClaim,
  toPublicDppProjection,
  toPublicHistoryEvent,
  type PublicClaim,
} from '../../_lib/dpp-public.js';

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
        verified_by_name: string | null;
      }>>`
        SELECT e.id,e.event_type,e.business_occurred_at,e.recorded_at,
               e.validation_status::text,e.public_summary,
               tracefab_public_verifier_name(e.verified_by_organization_id) AS verified_by_name
        FROM dpp_lifecycle_events e
        WHERE e.product_id=${dpp.productId}::uuid AND e.public_summary IS NOT NULL
          AND e.validation_status <> 'rejected'
        ORDER BY e.recorded_at DESC,e.id DESC LIMIT 100`;
      const claims = await tx.$queryRaw<Array<{
        id: string; claim_key: string; statement: string; validation_status: string;
        valid_from: Date | null; valid_until: Date | null; expired: boolean;
        accepted_evidence_count: number; evidence_labels: string[];
        contradicting_evidence_count: number; verifier_display_name: string | null;
        reviewed_at: Date | null;
      }>>`SELECT * FROM tracefab_public_dpp_claims(${dpp.productId}::uuid)`;
      return { dpp, history, claims };
    });
    if (!resolved) {
      return json(res, 404, { error: 'product_passport_not_found' });
    }
    const { dpp: dppData, history, claims } = resolved;

    // Remappage en liste blanche : aucune colonne ajoutee demain ne devient
    // publique par simple `SELECT *`.
    const publicClaims = (claims as Array<Record<string, unknown>>)
      .slice(0, 200)
      .map(toPublicClaim)
      .filter((claim): claim is PublicClaim => claim !== null);
    const publicHistory = (history as Array<Record<string, unknown>>).map(toPublicHistoryEvent);
    const lastUpdatedAt = publicHistory.reduce<string | null>((latest, event) => {
      if (!event.recordedAt) return latest;
      return latest === null || event.recordedAt > latest ? event.recordedAt : latest;
    }, null);
    const projected = toPublicDppProjection(dppData, {
      lastUpdatedAt,
      claims: publicClaims,
    });

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return json(res, 200, {
      dpp: projected,
      history: publicHistory,
      claims: publicClaims,
      links: {
        appleWalletUrl: `/api/dpp/${encodeURIComponent(gtinOrRef)}/apple-wallet`,
        googleWalletUrl: `/api/dpp/${encodeURIComponent(gtinOrRef)}/google-wallet`,
        digitalLinkUri: projected.links.digitalLinkUri.value ?? projected.links.dppUrl,
      },
    });
  } catch (err: unknown) {
    console.error('DPP data resolution error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
