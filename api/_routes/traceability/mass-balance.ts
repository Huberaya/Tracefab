import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { reconcileMassBalance, type TransformationStage } from '../../_lib/mass-balance.js';

type MassBalanceBody = {
  stages?: TransformationStage[];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<MassBalanceBody>(req);
  const stages = body.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    return json(res, 400, { error: 'invalid_stages', message: 'Field "stages" must be a non-empty array.' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async () => {
    const reconciliationReport = stages.map((stage: TransformationStage) => {
      const result = reconcileMassBalance(stage);
      return {
        stageId: stage.stageId,
        tier: stage.tier,
        stageName: stage.stageName,
        facilityName: stage.facilityName,
        facilityCountry: stage.facilityCountry,
        result,
      };
    });

    const totalInputKg = stages.reduce((acc, s) => acc + (Number(s.inputQuantityKg) || 0), 0);
    const totalOutputKg = stages.reduce((acc, s) => acc + (Number(s.outputQuantityKg) || 0), 0);
    const overallLossPercent = totalInputKg > 0 
      ? Number((((totalInputKg - totalOutputKg) / totalInputKg) * 100).toFixed(2))
      : 0;
    
    const hasAnomalies = reconciliationReport.some(r => r.result.anomalyDetected);

    return json(res, 200, {
      status: 'ok',
      productId: req.query.productId || null,
      totalInputKg,
      totalOutputKg,
      overallLossPercent,
      isFullyBalanced: !hasAnomalies,
      stagesCount: stages.length,
      report: reconciliationReport,
    });
  });
}
