import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
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

  try {
    const auth = await requireClerkUser(req);

    const body = await readJsonBody<OcrBody>(req);
    const rawText = body.rawText;
    if (!rawText || typeof rawText !== 'string') {
      return json(res, 400, { error: 'raw_text_required', message: 'Field "rawText" must contain the OCR text content.' });
    }

    const activeOrgId = requestedOrganizationId(req);
    return await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
      const supplier = await currentSupplier(tx, auth.user.id, activeOrgId);
      if (!supplier) {
        return json(res, 404, { error: 'supplier_not_found' });
      }

      const ocrResult = parseCertificateOcr(rawText);

      return json(res, 200, {
        status: 'ok',
        supplierId: supplier.id,
        extracted: ocrResult,
      });
    }, activeOrgId);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/supplier/certifications/ocr-extract failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
