import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import { currentSupplier, requestedOrganizationId } from '../_lib/supplier-profile';
import { DOCUMENT_SELECT, serializeDocument } from '../_lib/documents';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);
    const documents = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      return tx.documents.findMany({ where: { owner_organization_id: supplier.organization_id, status: { not: 'deleted' } }, select: DOCUMENT_SELECT, orderBy: { created_at: 'desc' } });
    });
    if (!documents) return json(res, 404, { error: 'supplier_profile_not_found' });
    return json(res, 200, { documents: documents.map(serializeDocument) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/supplier/documents failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
