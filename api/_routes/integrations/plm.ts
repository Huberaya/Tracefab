import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { ingestPlmProductBom, type PlmProductSyncPayload } from '../../_lib/plm-connector.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (process.env.NODE_ENV === 'production' && process.env.TRACEFAB_PLM_ENABLED !== 'true') {
    return json(res, 404, { error: 'plm_integration_disabled' });
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
    if (req.method === 'GET') {
      /* Aucune table ne stocke de connecteur PLM/ERP : il n'y a donc rien à lister.
         Cette branche renvoyait auparavant trois connecteurs inventés — Centric,
         Lectra et SAP — tous marqués CONNECTED avec un lastSyncedAt calculé sur
         Date.now(). La route étant devenue joignable au Chantier 24, ces affirmations
         étaient publiées. Le contrat de réponse est conservé, la liste est vide. */
      return json(res, 200, {
        status: 'ok',
        availableConnectors: [],
        notice:
          'Aucun connecteur PLM/ERP n’est configuré : TRACEFAB ne stocke pas d’intégration. ' +
          'L’ingestion de nomenclatures reste disponible via POST sur cet endpoint.',
      });
    }

    // POST: Ingest BOM lines from external PLM
    const body = await readJsonBody<PlmProductSyncPayload>(req);
    try {
      const syncResult = ingestPlmProductBom(body);
      return json(res, 200, {
        status: 'ok',
        syncResult,
      });
    } catch (err: any) {
      console.warn('PLM payload rejected', { errorCode: err instanceof Error ? err.message : 'invalid_payload' });
      return json(res, 400, {
        error: 'plm_sync_error',
      });
    }
  });
}
