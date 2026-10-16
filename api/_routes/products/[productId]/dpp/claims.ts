import type { VercelRequest,VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser,isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { json,methodNotAllowed,readJsonBody } from '../../../../_lib/http.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
const statuses=new Set(['declared','documented','controlled','corroborated','third_party_verified','rejected']);
const scopes=new Set(['model','variant','batch','unit']);
const str=(v:unknown,n:number)=>typeof v==='string'&&v.trim()&&v.trim().length<=n?v.trim():null;
const id=(req:VercelRequest)=>Array.isArray(req.query.productId)?req.query.productId[0]:req.query.productId;
export default async function handler(req:VercelRequest,res:VercelResponse){
 if(!['GET','POST'].includes(req.method||''))return methodNotAllowed(res,['GET','POST']);
 try{const productId=id(req);if(!isUuid(productId))return json(res,400,{error:'invalid_product_id'});const {user}=await requireClerkUser(req);
 const body=req.method==='POST'?await readJsonBody<Record<string,unknown>>(req):{};
 const result=await withTracefabUserContext(user.id,user.email,async tx=>{if(!await accessibleProduct(tx,productId))return null;
  if(req.method==='GET'){const claims=await tx.$queryRaw<Array<Record<string,unknown>>>`
   SELECT c.*,COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'documentId',e.document_id,'relationship',e.relationship,
    'coverageNote',e.coverage_note,'verificationResult',e.verification_result,'verificationReason',e.verification_reason,
    'publicLabel',e.public_label,'linkedAt',e.linked_at) ORDER BY e.linked_at) FILTER(WHERE e.id IS NOT NULL),'[]') evidence
   FROM dpp_claims c LEFT JOIN dpp_claim_evidence e ON e.claim_id=c.id WHERE c.product_id=${productId}::uuid
   GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`;return{claims};}
  const key=str(body.claimKey,120),statement=str(body.statement,1000),status=str(body.validationStatus,40)||'declared',scope=str(body.subjectScope,20)||'model';
  if(!key||!/^[a-z][a-z0-9_.-]{2,119}$/.test(key))throw new Error('invalid_claim_key');if(!statement)throw new Error('invalid_claim_statement');
  if(!statuses.has(status)||!scopes.has(scope))throw new Error('invalid_claim_metadata');
  for(const field of ['lifecycleEventId','supersedesClaimId'] as const)if(body[field]!=null&&!isUuid(body[field]))throw new Error(`invalid_${field}`);
  const rows=await tx.$queryRaw<Array<Record<string,unknown>>>`SELECT * FROM tracefab_add_dpp_claim(${productId}::uuid,${key},${statement},
   ${str(body.publicStatement,500)},${status}::dpp_event_validation_status,${body.lifecycleEventId||null}::uuid,${scope},${str(body.subjectReference,120)},
   ${body.validFrom||null}::date,${body.validUntil||null}::date,${body.supersedesClaimId||null}::uuid,${str(body.rejectionReason,500)})`;
  return{claim:rows[0]};});if(!result)return json(res,404,{error:'product_not_found'});return json(res,req.method==='POST'?201:200,result);
 }catch(error){if(isUnauthorized(error))return json(res,401,{error:'unauthorized'});const b=sqlBusinessError(error);if(b)return json(res,b.status,{error:b.error});if(error instanceof Error&&error.message.startsWith('invalid_'))return json(res,400,{error:error.message});console.error('DPP claims failed',error);return json(res,500,{error:'internal_server_error'});}}
