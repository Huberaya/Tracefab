import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../_lib/products.js';
import {
  SUPPLIER_CERTIFICATION_SELECT,
  certificationValues,
  serializeSupplierCertification,
  type SupplierCertificationRecord,
} from '../_lib/supplier-certifications.js';

/* Chantier 09 — Certification Intelligence : vue marque des certificats.
   GET : certificats des organisations marque actives de l'utilisateur PLUS
   ceux de leurs fournisseurs actifs (brand_supplier_relationships, statut
   actif) — c'est la « vue marque des certificats » de la roadmap, avec la
   meme isolation tenant que /api/suppliers. POST : declaration d'un
   certificat propre a la marque (ni fournisseur, ni site, ni produit) via
   la fonction SQL tracefab_register_certification, qui verifie elle-meme
   le role et l'authentification. Aucun statut n'est invente : la fonction
   derive declared/documented depuis la presence d'une preuve. */

type CertificationBody = Record<string, unknown>;
type OwnerRow = { organization_id: string; legal_name: string; display_name: string | null };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      if (!brandIds.length) return { empty: true as const };

      if (req.method === 'GET') {
        const supplierRows = await tx.$queryRaw<Array<{ supplier_organization_id: string }>>`
          SELECT DISTINCT supplier_organization_id
          FROM brand_supplier_relationships
          WHERE brand_organization_id = ANY(${brandIds}::uuid[])
            AND status = 'active'
        `;
        const ownerIds = [...brandIds, ...supplierRows.map((row) => row.supplier_organization_id)];
        const [certifications, owners] = await Promise.all([
          tx.certifications.findMany({
            where: { owner_organization_id: { in: ownerIds } },
            select: {
              ...SUPPLIER_CERTIFICATION_SELECT,
              product_id: true,
              _count: { select: { verification_records: true } },
            },
            orderBy: { created_at: 'desc' },
            take: 500,
          }),
          tx.$queryRaw<OwnerRow[]>`
            SELECT id::text AS organization_id, legal_name, display_name
            FROM organizations
            WHERE id = ANY(${ownerIds}::uuid[])
          `,
        ]);
        const ownerName = new Map(owners.map((o) => [o.organization_id, o.display_name || o.legal_name]));
        const brandIdSet = new Set(brandIds);
        return {
          certifications: certifications.map((certification) => ({
            ...serializeSupplierCertification(certification),
            productId: (certification as SupplierCertificationRecord & { product_id: string | null }).product_id,
            ownerName: ownerName.get(certification.owner_organization_id) || null,
            ownedByBrand: brandIdSet.has(certification.owner_organization_id),
            verificationCount: certification._count.verification_records,
          })),
        };
      }

      const body = await readJsonBody<CertificationBody>(req);
      const values = certificationValues(body);
      if (values.supplierSiteId) throw new Error('invalid_supplier_site_id');
      const brandId = typeof body.brandOrganizationId === 'string' ? body.brandOrganizationId : brandIds[0];
      if (!brandIds.includes(brandId)) throw new Error('brand_organization_not_found');
      if (values.documentId) {
        const document = await tx.documents.findFirst({
          where: { id: values.documentId, owner_organization_id: brandId, status: 'available' },
          select: { id: true },
        });
        if (!document) throw new Error('invalid_document_id');
      }
      const rows = await tx.$queryRaw<SupplierCertificationRecord[]>`
        SELECT * FROM tracefab_register_certification(
          ${brandId}::uuid,
          NULL::uuid,
          NULL::uuid,
          NULL::uuid,
          ${values.standardName},
          ${values.standardCode},
          ${values.issuerName},
          ${values.certificateNumber},
          ${values.issuedAt}::date,
          ${values.expiresAt}::date,
          ${values.documentId}::uuid
        )
      `;
      return { certification: rows[0] ?? null };
    });

    if (result && 'empty' in result) return json(res, 200, { certifications: [] });
    if (result && 'certifications' in result) return json(res, 200, result);
    const certification = (result as { certification: SupplierCertificationRecord | null }).certification;
    if (!certification) return json(res, 500, { error: 'certification_creation_failed' });
    return json(res, 201, { certification: serializeSupplierCertification(certification) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'certification_already_exists' });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'brand_organization_not_found') return json(res, 400, { error: 'brand_organization_not_found' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/certifications failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
