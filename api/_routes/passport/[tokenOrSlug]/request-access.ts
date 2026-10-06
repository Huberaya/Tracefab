import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prisma } from '../../../_lib/prisma.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { requestPassportAccess } from '../../../_lib/supplier-passport/passport-manager.js';

function routeTokenOrSlug(req: VercelRequest) {
  const value = req.query.tokenOrSlug;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const tokenOrSlug = routeTokenOrSlug(req);
    if (!tokenOrSlug || typeof tokenOrSlug !== 'string') {
      return json(res, 400, { error: 'token_or_slug_required' });
    }

    const body = await readJsonBody<Record<string, unknown>>(req);
    const requesterEmail = typeof body.requesterEmail === 'string' ? body.requesterEmail.trim().toLowerCase() : '';
    const requesterName = typeof body.requesterName === 'string' ? body.requesterName.trim() : '';
    const requesterCompany = typeof body.requesterCompany === 'string' ? body.requesterCompany.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : undefined;
    const ndaAccepted = body.ndaAccepted === true || body.ndaAccepted === 'true';

    if (!requesterEmail || !requesterEmail.includes('@')) {
      return json(res, 400, { error: 'Adresse email professionnelle valide requise.' });
    }
    if (!requesterName || !requesterCompany) {
      return json(res, 400, { error: 'Nom et entreprise de la marque requis.' });
    }
    if (!ndaAccepted) {
      return json(res, 400, { error: 'L\'engagement de confidentialité NDA doit être accepté.' });
    }

    const result = await requestPassportAccess(prisma, tokenOrSlug, {
      requesterEmail,
      requesterName,
      requesterCompany,
      message,
      ndaAccepted,
    });

    return json(res, 201, result);
  } catch (err: unknown) {
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('passport_not_found')) {
      return json(res, 404, { error: 'Passeport introuvable.' });
    }
    console.error('Request passport access error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
