import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { json, methodNotAllowed } from '../_lib/http';
import { getQuestionnaire } from '../_lib/questionnaires';

function routeKey(req: VercelRequest) {
  const value = req.query.questionnaireKey;
  return Array.isArray(value) ? value[0] : value;
}

function queryVersion(req: VercelRequest) {
  const value = req.query.version;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    await requireClerkUser(req);
    const template = getQuestionnaire(routeKey(req), queryVersion(req));
    if (!template) return json(res, 404, { error: 'questionnaire_not_found' });
    return json(res, 200, { questionnaire: template });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/questionnaires/:questionnaireKey failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
