import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../_lib/products.js';
import { DPP_REQUIREMENT_LABELS, classifyRequirementPillar } from '../../_lib/dpp.js';

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

function queryOrganizationId(req: VercelRequest) {
  const value = req.query.organizationId;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) return json(res, 401, { error: 'unauthorized' });

  const requestedOrganizationId = queryOrganizationId(req);
  if (requestedOrganizationId && !isUuid(requestedOrganizationId)) {
    return json(res, 400, { error: 'invalid_organization_id' });
  }

  const payload = await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
    const organizationIds = await activeBrandOrganizationIds(tx, auth.user.id);
    if (requestedOrganizationId && !organizationIds.includes(requestedOrganizationId)) {
      return null;
    }
    const scope = requestedOrganizationId ? [requestedOrganizationId] : organizationIds;
    if (!scope.length) return null;

    // DISTINCT ON retient le dernier calcul par produit : un produit recalcule
    // plusieurs fois ne doit peser qu'une fois dans l'agregat.
    const rows = await tx.$queryRaw<Array<{
      product_id: string;
      reference: string | null;
      name: string | null;
      readiness_status: string;
      missing_fields: unknown;
      blocking_issues: unknown;
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
        d.requirement_profile_key,
        d.requirement_profile_version,
        d.computed_at
      FROM dpp_records d
      JOIN tracefab_products p ON p.id = d.product_id
      WHERE p.brand_organization_id = ANY(${scope}::uuid[])
      ORDER BY d.product_id, d.computed_at DESC
    `;

    const totalProducts = await tx.tracefab_products.count({
      where: { brand_organization_id: { in: scope } },
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
      if (row.readiness_status in statusCounts) statusCounts[row.readiness_status] += 1;
      if (row.requirement_profile_key) profileKey = row.requirement_profile_key;
      if (row.requirement_profile_version) profileVersion = row.requirement_profile_version;
      if (!lastComputedAt || row.computed_at > lastComputedAt) lastComputedAt = row.computed_at;

      const missing: MissingField[] = Array.isArray(row.missing_fields)
        ? (row.missing_fields as MissingField[])
        : [];
      const blocking = Array.isArray(row.blocking_issues) ? row.blocking_issues : [];
      if (blocking.length) blockedProducts += 1;

      // Le profil fixe le nombre d'exigences ; a defaut on le reconstitue a
      // partir des manquantes pour ne pas inventer un denominateur.
      const totalRequirements = missing.length + Math.max(0, 9 - missing.length);
      requirementSum += totalRequirements;
      metSum += Math.max(0, totalRequirements - missing.length);

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
    requirementSum += uncomputed * 9;

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
  });

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
}
