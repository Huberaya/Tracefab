import type { VercelRequest, VercelResponse } from '@vercel/node';
import { prisma } from '../../_lib/prisma.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { getPublicSupplierPassport } from '../../_lib/supplier-passport/passport-manager.js';

function routeTokenOrSlug(req: VercelRequest) {
  const value = req.query.tokenOrSlug;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const tokenOrSlug = routeTokenOrSlug(req);
    if (!tokenOrSlug || typeof tokenOrSlug !== 'string') {
      return json(res, 400, { error: 'token_or_slug_required' });
    }

    const passportData = await getPublicSupplierPassport(prisma, tokenOrSlug);

    // Support HTML redirect if browser requests HTML directly
    const acceptHeader = req.headers.accept || '';
    if (acceptHeader.includes('text/html') && !req.query.format) {
      res.setHeader('Location', `/passport/?ref=${encodeURIComponent(passportData.passport.slug)}`);
      res.statusCode = 302;
      res.end();
      return;
    }

    return json(res, 200, passportData);
  } catch (err: unknown) {
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('passport_not_found')) {
      return json(res, 404, { error: 'Passeport fournisseur introuvable ou restreint.' });
    }
    console.error('Public passport fetch error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
