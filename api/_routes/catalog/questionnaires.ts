import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getQuestionnaire, listQuestionnaires, questionnaireCatalogSource, questionnaireItemRows } from '../../_lib/questionnaires.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const key = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
  const version = Array.isArray(req.query.version) ? req.query.version[0] : req.query.version;
  if (key) {
    const questionnaire = getQuestionnaire(key, version);
    if (!questionnaire) return json(res, 404, { error: 'questionnaire_not_found' });
    return json(res, 200, { source: questionnaireCatalogSource(), questionnaire: { ...questionnaire, items: questionnaireItemRows(questionnaire) } });
  }
  return json(res, 200, { source: questionnaireCatalogSource(), questionnaires: listQuestionnaires() });
}
