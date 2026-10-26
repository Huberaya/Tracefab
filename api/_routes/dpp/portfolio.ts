import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
import { DPP_REQUIREMENT_LABELS, DPP_STANDARD_REQUIREMENT_KEYS, classifyRequirementPillar } from '../../_lib/dpp.js';

/**
 * Agregat de preparation DPP a l'echelle du portefeuille.
 *
 * La console n'exposait la preparation que produit par produit : sans vue
 * d'ensemble, « ce qui manque » restait une enquete a mener produit par
 * produit. Cette route repond a la seule question utile a l'echelle de la
 * marque : quelles exigences bloquent le plus de produits, et lesquels.
 *
 * Lecture seule, cadree par les organisations de marque de l'utilisateur.
 * Le score renvoye est un INDICATEUR DE PREPARATION, jamais une conformite.
 */

type GapAccumulator = {
  key: string;
  label: string;
  blocking: boolean;
  pillar: string;
  products: Array<{ id: string; reference: string | null; name: string | null }>;
};

type MissingField = { key?: unknown; label?: unknown; blocking?: unknown };

const MAX_PRODUCTS_PER_GAP = 12;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  // Enveloppe d'erreur explicite. La version precedente n'avait AUCUN
  // try/catch, et `isUnauthorized(auth)` etait du code mort : requireClerkUser
  // LEVE l'erreur d'authentification, il ne la retourne jamais. Un jeton absent
  // ou une erreur de base ne produisait donc aucune reponse de cette route —
  // seule la barriere centrale d'api/index.ts repondait, en 500, y compris pour
  // ce qui etait en realite un 401.
  try {
    const auth = await requireClerkUser(req);

    const payload = await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
      // Locataire actif obligatoire. L'agregat de preparation DPP est un chiffre
      // de pilotage : additionner plusieurs tenants produirait un total qu'aucun
      // des tenants ne reconnait.
      const tenant = await requireActiveTenant(tx, req, auth.user.id, { types: ['brand'] });
      const scope = [tenant.organizationId];

      // DISTINCT ON retient le dernier calcul par produit : un produit recalcule
      // plusieurs fois ne doit peser qu'une fois dans l'agregat.
      const rows = await tx.$queryRaw<Array<{
        product_id: string;
        reference: string | null;
        name: string | null;
        readiness_status: string;
        missing_fields: unknown;
        blocking_issues: unknown;
        source_snapshot: unknown;
        requirement_profile_key: string;
        requirement_profile_version: string;
        computed_at: Date;
      }>>`
        SELECT DISTINCT ON (d.product_id)
          d.product_id,
          p.reference,
          p.name,
          d.readiness_status::text AS readiness_status,
          d.missing_fields,
          d.blocking_issues,
          d.source_snapshot,
          d.requirement_profile_key,
          d.requirement_profile_version,
          d.computed_at
        FROM dpp_records d
        JOIN tracefab_products p ON p.id = d.product_id
        WHERE p.brand_organization_id = ANY(${scope}::uuid[])
          AND p.status <> 'archived'
        ORDER BY d.product_id, d.computed_at DESC
      `;

      const totalProducts = await tx.tracefab_products.count({
        where: { brand_organization_id: { in: scope }, status: { not: 'archived' } },
      });

      const statusCounts: Record<string, number> = {
        not_started: 0,
        in_progress: 0,
        data_ready: 0,
        review_required: 0,
        ready_to_publish: 0,
        published: 0,
      };

      const gaps = new Map<string, GapAccumulator>();
      let blockedProducts = 0;
      let metSum = 0;
      let requirementSum = 0;
      let profileKey = 'textile_readiness_mvp';
      let profileVersion = '1.0';
      let lastComputedAt: Date | null = null;

      for (const row of rows) {
        if (row.requirement_profile_key) profileKey = row.requirement_profile_key;
        if (row.requirement_profile_version) profileVersion = row.requirement_profile_version;
        if (!lastComputedAt || row.computed_at > lastComputedAt) lastComputedAt = row.computed_at;

        const snapshot = row.source_snapshot && typeof row.source_snapshot === 'object'
          ? row.source_snapshot as { requirement_results?: unknown }
          : {};
        const results = Array.isArray(snapshot.requirement_results)
          ? snapshot.requirement_results as Array<{ key?: unknown; met?: unknown }>
          : [];
        // Fail closed against the active 13-key profile. Historical missing_fields
        // can be empty even when a newer source_snapshot contains unmet gates.
        const missing: MissingField[] = DPP_STANDARD_REQUIREMENT_KEYS
          .filter((key) => results.find((entry) => entry?.key === key)?.met !== true)
          .map((key) => ({ key, label: DPP_REQUIREMENT_LABELS[key] || key, blocking: true }));
        if (missing.length) {
          blockedProducts += 1;
          statusCounts.in_progress += 1;
        } else if (row.readiness_status in statusCounts) {
          statusCounts[row.readiness_status] += 1;
        }

        const totalRequirements = DPP_STANDARD_REQUIREMENT_KEYS.length;
        requirementSum += totalRequirements;
        metSum += totalRequirements - missing.length;

        for (const field of missing) {
          const key = typeof field?.key === 'string' ? field.key : null;
          if (!key) continue;
          const existing = gaps.get(key);
          const entry: GapAccumulator = existing || {
            key,
            label: typeof field?.label === 'string' && field.label
              ? field.label
              : DPP_REQUIREMENT_LABELS[key] || key,
            blocking: Boolean(field?.blocking),
            pillar: classifyRequirementPillar(key),
            products: [],
          };
          if (field?.blocking) entry.blocking = true;
          if (entry.products.length < MAX_PRODUCTS_PER_GAP) {
            entry.products.push({ id: row.product_id, reference: row.reference, name: row.name });
          }
          gaps.set(key, entry);
        }
      }

      const gapList = [...gaps.values()]
        .map((g) => ({ ...g, productCount: g.products.length }))
        .sort((a, b) => (Number(b.blocking) - Number(a.blocking)) || (b.productCount - a.productCount));

      // Les produits jamais calcules comptent comme non commences : les omettre
      // gonflerait artificiellement le score du portefeuille.
      const uncomputed = Math.max(0, totalProducts - rows.length);
      statusCounts.not_started += uncomputed;
      requirementSum += uncomputed * DPP_STANDARD_REQUIREMENT_KEYS.length;

      return {
        profileKey,
        profileVersion,
        totalProducts,
        computedProducts: rows.length,
        uncomputedProducts: uncomputed,
        blockedProducts,
        readinessScore: requirementSum > 0 ? Math.round((metSum / requirementSum) * 1000) / 10 : 0,
        statusCounts,
        gaps: gapList,
        lastComputedAt: lastComputedAt ? lastComputedAt.toISOString() : null,
      };
    }, requestedTenantId(req));

    if (!payload) {
      return json(res, 200, {
        status: 'ok',
        scoreIsReadinessIndicatorOnly: true,
        profileKey: 'textile_readiness_mvp',
        profileVersion: '1.0',
        totalProducts: 0,
        computedProducts: 0,
        uncomputedProducts: 0,
        blockedProducts: 0,
        readinessScore: 0,
        statusCounts: {},
        gaps: [],
        lastComputedAt: null,
      });
    }

    return json(res, 200, { status: 'ok', scoreIsReadinessIndicatorOnly: true, ...payload });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/dpp/portfolio failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
