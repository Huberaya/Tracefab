import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { currentSupplier, requestedOrganizationId } from '../../../_lib/supplier-profile.js';
import { parseCertificateOcr } from '../../../_lib/certificate-ocr.js';

type OcrBody = {
  rawText?: string;
  documentId?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<OcrBody>(req);
  const rawText = body.rawText;
  if (!rawText || typeof rawText !== 'string') {
    return json(res, 400, { error: 'raw_text_required', message: 'Field "rawText" must contain the OCR text content.' });
  }

  return withTracefabTenantContext(req, auth.user, { types: ['supplier'] }, async (tx, tenant) => {
    const supplier = await currentSupplier(tx, auth.user.id, tenant.organizationId);
    if (!supplier) {
      return json(res, 404, { error: 'supplier_not_found' });
    }

    const ocrResult = parseCertificateOcr(rawText);

    return json(res, 200, {
      status: 'ok',
      supplierId: supplier.id,
      extracted: ocrResult,
    });
  });
}
