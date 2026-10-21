import type { VercelRequest,VercelResponse } from '../../../../../../_lib/vercel-types.js';
import { requireClerkUser,isUnauthorized } from '../../../../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../../../../_lib/context.js';
import { isUuid } from '../../../../../../_lib/data-requests.js';
import { json,methodNotAllowed,readJsonBody } from '../../../../../../_lib/http.js';
import { accessibleProduct } from '../../../../../../_lib/quality.js';
import { sqlBusinessError } from '../../../../../../_lib/sql-errors.js';
const value=(q:unknown)=>Array.isArray(q)?q[0]:q;const str=(v:unknown,n:number)=>typeof v==='string'&&v.trim()&&v.trim().length<=n?v.trim():null;
export default async function handler(req:VercelRequest,res:VercelResponse){if(req.method!=='POST')return methodNotAllowed(res,['POST']);
 try{
  // Refuser les requêtes anonymes avant toute validation métier ou lecture du corps.
  const {user}=await requireClerkUser(req);
  const productId=value(req.query.productId),claimId=value(req.query.claimId);if(!isUuid(productId)||!isUuid(claimId))return json(res,400,{error:'invalid_identifier'});
  const body=await readJsonBody<Record<string,unknown>>(req),documentId=str(body.documentId,36);if(!isUuid(documentId))return json(res,400,{error:'invalid_document_id'});
  const relationship=str(body.relationship,20)||'supports',verification=str(body.verificationResult,20)||'pending';
  if(!['supports','contradicts','context'].includes(relationship)||!['pending','accepted','rejected'].includes(verification))return json(res,400,{error:'invalid_evidence_metadata'});
  const result=await withTracefabRequestContext(req,user,async tx=>{if(!await accessibleProduct(tx,productId))return null;
   const claim=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM dpp_claims WHERE id=${claimId}::uuid AND product_id=${productId}::uuid LIMIT 1`;if(!claim[0])return null;
   const rows=await tx.$queryRaw<Array<Record<string,unknown>>>`SELECT * FROM tracefab_link_dpp_claim_evidence(${claimId}::uuid,${documentId}::uuid,${relationship},
    ${str(body.coverageNote,500)},${verification},${str(body.verificationReason,500)},${str(body.publicLabel,200)})`;return{evidence:rows[0]};});
  if(!result)return json(res,404,{error:'claim_not_found'});return json(res,201,result);
 }catch(error){if(isUnauthorized(error))return json(res,401,{error:'unauthorized'});const b=sqlBusinessError(error);if(b)return json(res,b.status,{error:b.error});if(error instanceof Error&&error.message.startsWith('invalid_'))return json(res,400,{error:error.message});console.error('DPP claim evidence failed',error);return json(res,500,{error:'internal_server_error'});}}
