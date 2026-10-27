import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import {
  assertPreviewStorageConfig,
  PREVIEW_STORAGE_CAPABILITY_HEADER,
  usesPreviewPostgresStorage,
  verifyPreviewCapability,
} from '../../_lib/preview-storage-policy.js';
import { putPreviewObject, readPreviewObject } from '../../_lib/preview-postgres-store.js';

/**
 * Echange de bytes de TEST par capacite a duree courte, dans un en-tete
 * jamais dans l'URL. La capacite PUT ou GET est emise uniquement apres les
 * controles Clerk/RLS des routes documentaires. Aucune route d'objet n'est
 * utilisable en production ou sur une autre branche Preview.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'PUT' && req.method !== 'GET') return methodNotAllowed(res, ['PUT', 'GET']);
  try {
    if (!usesPreviewPostgresStorage()) return json(res, 404, { error: 'route_not_found' });
    assertPreviewStorageConfig();
  } catch {
    // Pas d'indice de configuration, notamment en production.
    return json(res, 404, { error: 'route_not_found' });
  }
  const capability = verifyPreviewCapability(req.headers[PREVIEW_STORAGE_CAPABILITY_HEADER], req.method);
  if (!capability) return json(res, 403, { error: 'private_storage_unauthorized' });
  try {
    if (req.method === 'PUT') {
      if (req.headers['content-type'] !== 'application/octet-stream' || !Buffer.isBuffer(req.body)) {
        return json(res, 400, { error: 'private_storage_invalid_body' });
      }
      if (req.body.length !== capability.size) return json(res, 400, { error: 'document_size_mismatch' });
      const inserted = await putPreviewObject(capability.key, capability.contentType!, req.body);
      if (!inserted) return json(res, 409, { error: 'private_storage_object_immutable' });
      return res.status(200).end();
    }
    const bytes = Buffer.from(await readPreviewObject(capability.key));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    return res.status(200).send(bytes);
  } catch (error) {
    if (error instanceof Error && error.message === 'document_object_not_found') {
      return json(res, 404, { error: 'document_object_not_found' });
    }
    // Ne journaliser ni capacite, ni octets, ni erreur SQL contenant la cible.
    return json(res, 503, { error: 'private_storage_unavailable' });
  }
}
