import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { buildDppSummary } from '../../../../_lib/dpp.js';

const routeId = (req: VercelRequest) => Array.isArray(req.query.productId) ? req.query.productId[0] : req.query.productId;
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res,['POST']);
  try {
    const productId=routeId(req); if (!isUuid(productId)) return json(res,400,{error:'invalid_product_id'});
    const body=await readJsonBody<Record<string,unknown>>(req);
    const action=typeof body.action==='string' ? body.action : '';
    const slug=typeof body.publicSlug==='string' ? body.publicSlug.trim() : null;
    if (!['publish','suspend','withdraw'].includes(action)) return json(res,400,{error:'invalid_publication_action'});
    const {user}=await requireClerkUser(req);
    const result=await withTracefabUserContext(user.id,user.email,async tx=>{
      if (!await accessibleProduct(tx,productId)) return null;
      const rows=await tx.$queryRaw<Array<any>>`
        SELECT id,product_id,product_version,requirement_profile_key,requirement_profile_version,
          readiness_status::text,missing_fields,blocking_issues,source_snapshot,computed_at,
          computed_by,input_fingerprint,reviewed_at,reviewed_by
        FROM tracefab_set_dpp_publication(${productId}::uuid,${action},${slug})`;
      return buildDppSummary(rows[0],productId);
    });
    if (!result) return json(res,404,{error:'product_not_found'});
    res.setHeader('Cache-Control','no-store');
    return json(res,200,{dpp:result,publication:{action,publicSlug:action==='publish'?slug:null}});
  } catch(error) {
    if(isUnauthorized(error)) return json(res,401,{error:'unauthorized'});
    const business=sqlBusinessError(error); if(business) return json(res,business.status,{error:business.error});
    if(error instanceof Error && /^invalid_/.test(error.message)) return json(res,400,{error:error.message});
    console.error('DPP publication transition failed',error); return json(res,500,{error:'internal_server_error'});
  }
}
