import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';

const EVENT_TYPES = new Set(['passport_created','data_submitted','evidence_added','manufacturing_step','data_corrected','repair','reuse','recycling']);
const SOURCES = new Set(['actor_declaration','document','system','third_party']);
const STATUSES = new Set(['declared','documented','controlled','corroborated','third_party_verified','rejected']);
const SCOPES = new Set(['model','variant','batch','unit']);
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const routeId = (req: VercelRequest) => Array.isArray(req.query.productId) ? req.query.productId[0] : req.query.productId;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!['GET','POST'].includes(req.method || '')) return methodNotAllowed(res, ['GET','POST']);
  try {
    const productId = routeId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);
    const body = req.method === 'POST' ? await readJsonBody<Record<string, unknown>>(req) : {};
    const result = await withTracefabUserContext(user.id, user.email, async tx => {
      if (!await accessibleProduct(tx, productId)) return null;
      if (req.method === 'GET') {
        const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
          SELECT id,event_type,subject_scope,subject_reference,business_occurred_at,recorded_at,
                 actor_user_id,source_kind,validation_status,summary,details,public_summary,
                 evidence_document_ids,corrects_event_id
          FROM dpp_lifecycle_events WHERE product_id=${productId}::uuid
          ORDER BY recorded_at DESC,id DESC LIMIT 200`;
        return { events: rows };
      }
      const eventType = text(body.eventType, 80), summary = text(body.summary, 500);
      const source = text(body.sourceKind, 40) || 'actor_declaration';
      const status = text(body.validationStatus, 40) || 'declared';
      const scope = text(body.subjectScope, 20) || 'model';
      if (!eventType || !EVENT_TYPES.has(eventType)) throw new Error('invalid_event_type');
      if (!summary) throw new Error('invalid_summary');
      if (!SOURCES.has(source) || !STATUSES.has(status) || !SCOPES.has(scope)) throw new Error('invalid_event_metadata');
      const evidence = Array.isArray(body.evidenceDocumentIds) ? body.evidenceDocumentIds : [];
      if (evidence.length > 50 || evidence.some(id => !isUuid(id))) throw new Error('invalid_evidence_document_ids');
      const corrected = body.correctsEventId == null ? null : text(body.correctsEventId, 36);
      if (corrected && !isUuid(corrected)) throw new Error('invalid_corrects_event_id');
      const occurred = body.businessOccurredAt == null ? null : new Date(String(body.businessOccurredAt));
      if (occurred && Number.isNaN(occurred.getTime())) throw new Error('invalid_business_occurred_at');
      const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details) ? body.details : {};
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM tracefab_add_dpp_event(${productId}::uuid,${eventType},${summary},
          ${occurred}::timestamptz,${source},${status}::dpp_event_validation_status,
          ${text(body.publicSummary,500)},${details}::jsonb,${evidence}::uuid[],${corrected}::uuid,
          ${text(body.idempotencyKey,120)},${scope},${text(body.subjectReference,120)})`;
      return { event: rows[0] };
    });
    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, req.method === 'POST' ? 201 : 200, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const business = sqlBusinessError(error); if (business) return json(res,business.status,{error:business.error});
    if (error instanceof Error && error.message.startsWith('invalid_')) return json(res,400,{error:error.message});
    console.error('DPP lifecycle events failed', error); return json(res,500,{error:'internal_server_error'});
  }
}
