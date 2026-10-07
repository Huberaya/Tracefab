import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { registerTransactionCertificate } from '../../_lib/mass-balance/mass-balance-manager.js';
import { isUuid } from '../../_lib/data-requests.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  try {
    const { user } = await requireClerkUser(req);

    if (req.method === 'GET') {
      const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const memberships = await tx.organization_memberships.findMany({
          where: { user_id: user.id, status: 'active' },
          select: { organization_id: true },
        });
        const orgIds = memberships.map((m) => m.organization_id);
        if (orgIds.length === 0) return [];

        const tcs = await tx.transaction_certificates.findMany({
          where: {
            OR: [
              { seller_organization_id: { in: orgIds } },
              { buyer_organization_id: { in: orgIds } },
            ],
          },
          include: {
            organizations_transaction_certificates_seller_organization_idToorganizations: {
              select: { id: true, display_name: true, legal_name: true },
            },
            organizations_transaction_certificates_buyer_organization_idToorganizations: {
              select: { id: true, display_name: true, legal_name: true },
            },
          },
          orderBy: { issue_date: 'desc' },
        });

        return tcs.map((t) => ({
          id: t.id,
          tcNumber: t.tc_number,
          standard: t.standard,
          issuerName: t.issuer_name,
          seller: t.organizations_transaction_certificates_seller_organization_idToorganizations,
          buyer: t.organizations_transaction_certificates_buyer_organization_idToorganizations,
          certifiedMaterialName: t.certified_material_name,
          totalCertifiedWeightKg: Number(t.total_certified_weight_kg),
          totalCertifiedMeters: t.total_certified_meters ? Number(t.total_certified_meters) : null,
          allocatedWeightKg: Number(t.allocated_weight_kg),
          remainingWeightKg: Number(t.total_certified_weight_kg) - Number(t.allocated_weight_kg),
          status: t.status,
          issueDate: t.issue_date.toISOString().slice(0, 10),
          expiryDate: t.expiry_date?.toISOString?.().slice(0, 10),
        }));
      });

      return json(res, 200, { certificates: result, count: result.length });
    }

    // POST: Register TC
    const body = await readJsonBody<Record<string, unknown>>(req);
    const tcNumber = typeof body.tcNumber === 'string' ? body.tcNumber.trim() : '';
    const standard = typeof body.standard === 'string' ? body.standard.trim() : '';
    const issuerName = typeof body.issuerName === 'string' ? body.issuerName.trim() : '';
    const sellerOrganizationId = typeof body.sellerOrganizationId === 'string' ? body.sellerOrganizationId : '';
    const buyerOrganizationId = typeof body.buyerOrganizationId === 'string' ? body.buyerOrganizationId : '';
    const certifiedMaterialName = typeof body.certifiedMaterialName === 'string' ? body.certifiedMaterialName.trim() : '';
    const totalCertifiedWeightKg = Number(body.totalCertifiedWeightKg);
    const totalCertifiedMeters = body.totalCertifiedMeters ? Number(body.totalCertifiedMeters) : undefined;
    const issueDate = typeof body.issueDate === 'string' ? body.issueDate : undefined;
    const expiryDate = typeof body.expiryDate === 'string' ? body.expiryDate : undefined;
    const documentId = typeof body.documentId === 'string' && isUuid(body.documentId) ? body.documentId : undefined;

    if (!tcNumber || !standard || !issuerName || !certifiedMaterialName) {
      return json(res, 400, { error: 'tc_number_standard_issuer_and_material_required' });
    }
    if (!isUuid(sellerOrganizationId) || !isUuid(buyerOrganizationId)) {
      return json(res, 400, { error: 'invalid_seller_or_buyer_organization_id' });
    }
    if (!Number.isFinite(totalCertifiedWeightKg) || totalCertifiedWeightKg <= 0) {
      return json(res, 400, { error: 'total_certified_weight_kg_must_be_positive' });
    }

    const created = await withTracefabUserContext(user.id, user.email, async (tx) => {
      return await registerTransactionCertificate(tx, {
        tcNumber,
        standard,
        issuerName,
        sellerOrganizationId,
        buyerOrganizationId,
        certifiedMaterialName,
        totalCertifiedWeightKg,
        totalCertifiedMeters,
        issueDate,
        expiryDate,
        documentId,
      });
    });

    return json(res, 201, {
      message: 'transaction_certificate_registered',
      certificate: created,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('TC route error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
