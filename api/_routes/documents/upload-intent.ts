import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { activeBrandOrganizationIds, isUuid } from '../../_lib/products.js';
import { documentMetadata, serializeDocument, DOCUMENT_SELECT } from '../../_lib/documents.js';
import { presignedUpload, storageObjectKey } from '../../_lib/storage.js';
import { assertStorageQuotaAvailable } from '../../_lib/cloud-storage/quota-manager.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { user } = await requireClerkUser(req);
    const body = documentMetadata(await readJsonBody<Record<string, unknown>>(req));
    const queryOrgId = req.query.organizationId;
    const requestedId = Array.isArray(queryOrgId) ? queryOrgId[0] : queryOrgId;

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      let targetOrgId: string | undefined;

      if (requestedId && isUuid(requestedId) && brandIds.includes(requestedId)) {
        targetOrgId = requestedId;
      } else if (brandIds.length > 0) {
        targetOrgId = brandIds[0];
      }

      if (!targetOrgId) return null;

      // Enforce organization storage quota
      await assertStorageQuotaAvailable(tx, targetOrgId, body.byteSize);

      const storagePath = storageObjectKey(targetOrgId, body.originalFilename);
      const rows = await tx.$queryRaw<Array<Prisma.documentsGetPayload<{ select: typeof DOCUMENT_SELECT }>>>`
        SELECT * FROM tracefab_register_document(
          ${targetOrgId}::uuid,
          ${storagePath},
          ${body.originalFilename},
          ${body.contentType},
          ${body.byteSize}::bigint,
          NULL,
          ${body.kind}::document_kind,
          ${body.expiresAt}::date,
          ${JSON.stringify(body.metadata)}::jsonb
        )
      `;
      const document = rows[0];
      if (!document) throw new Error('document_registration_failed');
      return { document, upload: presignedUpload(storagePath, body.contentType) };
    });

    if (!result) return json(res, 404, { error: 'organization_not_found' });
    return json(res, 201, {
      document: serializeDocument(result.document),
      upload: {
        method: 'PUT',
        url: result.upload.url,
        headers: result.upload.headers,
        expiresInSeconds: Number(process.env.PRIVATE_STORAGE_PRESIGN_SECONDS || 600),
      },
      next: { scan: `/api/documents/${result.document.id}/scan` },
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'document_already_registered' });
    if (error instanceof Error && error.message === 'organization_storage_quota_exceeded') {
      return json(res, 413, { error: 'organization_storage_quota_exceeded' });
    }
    if (error instanceof Error && /^private_storage_/.test(error.message)) return json(res, 503, { error: error.message });
    if (error instanceof Error && /^invalid_|^document_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/documents/upload-intent failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
