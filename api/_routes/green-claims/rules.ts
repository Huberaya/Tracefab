import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { prisma } from '../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { STATIC_GREEN_CLAIMS_RULES } from '../../_lib/green-claims/rules.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const rules = await prisma.green_claims_rules.findMany({
      where: { is_active: true },
      orderBy: [{ severity: 'desc' }, { rule_code: 'asc' }],
    });

    if (rules && rules.length > 0) {
      return json(res, 200, {
        rules: rules.map((r) => ({
          ruleCode: r.rule_code,
          category: r.category,
          ruleTitle: r.rule_title,
          description: r.description,
          targetPattern: r.target_pattern,
          severity: r.severity,
          legalBasis: r.legal_basis,
          remediationAdvice: r.remediation_advice,
        })),
        source: 'neon_database',
        count: rules.length,
      });
    }

    return json(res, 200, {
      rules: STATIC_GREEN_CLAIMS_RULES,
      source: 'static_catalog',
      count: STATIC_GREEN_CLAIMS_RULES.length,
    });
  } catch (err) {
    console.error('Green claims rules fetch error:', err);
    return json(res, 200, {
      rules: STATIC_GREEN_CLAIMS_RULES,
      source: 'static_catalog_fallback',
      count: STATIC_GREEN_CLAIMS_RULES.length,
    });
  }
}
