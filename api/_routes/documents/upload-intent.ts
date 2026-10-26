import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabRequestContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { isUuid } from '../../_lib/products.js';
import { isTenantError, requireActiveTenant, tenantFilter } from '../../_lib/tenant.js';
import { documentMetadata, serializeDocument, DOCUMENT_SELECT } from '../../_lib/documents.js';
import { presignedUpload, storageObjectKey } from '../../_lib/storage.js';
import { assertStorageQuotaAvailable } from '../../_lib/cloud-storage/quota-manager.js';

/**
 * Intention de depot d'une preuve (parcours MARQUE).
 *
 * Correction d'isolation : la version precedente appelait
 * `activeBrandOrganizationIds(tx, user.id)` puis retenait `brandIds[0]`.
 * Sur un compte membre de deux organisations, un document demande depuis le
 * locataire B etait enregistre dans le locataire A — et le contexte
 * `tracefab.active_organization_id` n'etait jamais arme. Le depot utilisait
 * donc l'union des organisations du compte, exactement le defaut que
 * `api/_lib/tenant.ts` documente.
 *
 * Desormais : `requireActiveTenant` valide le locataire demande (en-tete,
 * query ou corps), `withTracefabRequestContext` l'arme pour la transaction,
 * et le document est toujours enregistre dans CE locataire. Si le client
 * fournit `metadata.productId`, le serveur verifie que le produit appartient
 * au meme locataire avant d'accepter le lien au dossier DPP.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { user } = await requireClerkUser(req);
    const body = documentMetadata(await readJsonBody<Record<string, unknown>>(req));

    const metadata = body.metadata as Record<string, unknown>;
    const productId = metadata?.productId === undefined || metadata?.productId === null || metadata?.productId === ''
      ? null
      : metadata.productId;
    if (productId !== null && !isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });

    const result = await withTracefabRequestContext(req, user, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      const targetOrgId = tenant.organizationId;

      if (productId !== null) {
        const owned = await tx.tracefab_products.findFirst({
          where: { id: productId as string, brand_organization_id: tenantFilter(tenant) },
          select: { id: true },
        });
        if (!owned) throw new Error('product_not_found');
      }

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
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'document_already_registered' });
    if (error instanceof Error && error.message === 'organization_storage_quota_exceeded') {
      return json(res, 413, { error: 'organization_storage_quota_exceeded' });
    }
    if (error instanceof Error && error.message === 'product_not_found') {
      return json(res, 404, { error: 'product_not_found' });
    }
    if (error instanceof Error && /^private_storage_/.test(error.message)) return json(res, 503, { error: error.message });
    if (error instanceof Error && /^invalid_|^document_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/documents/upload-intent failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
