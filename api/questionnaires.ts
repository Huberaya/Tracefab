import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from './_lib/auth';
import { json, methodNotAllowed } from './_lib/http';
import { listQuestionnaires } from './_lib/questionnaires';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    await requireClerkUser(req);
    return json(res, 200, { questionnaires: listQuestionnaires() });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/questionnaires failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
