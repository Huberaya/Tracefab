import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { certificationStandardsSource, getCertificationStandard, listCertificationStandards } from '../../_lib/certification-standards.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const code = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
  if (code) {
    const standard = getCertificationStandard(code);
    if (!standard) return json(res, 404, { error: 'certification_standard_not_found' });
    return json(res, 200, { source: certificationStandardsSource(), standard });
  }
  return json(res, 200, { source: certificationStandardsSource(), standards: listCertificationStandards() });
}
