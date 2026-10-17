import type{VercelRequest,VercelResponse}from'../../_lib/vercel-types.js';import{withTracefabPublicContext}from'../../_lib/context.js';import{json,methodNotAllowed}from'../../_lib/http.js';
const value=(v:unknown)=>Array.isArray(v)?v[0]:String(v||'');
export default async function handler(req:VercelRequest,res:VercelResponse){if(req.method!=='GET')return methodNotAllowed(res,['GET']);const publicId=value(req.query.publicId).toLowerCase();if(!/^[a-z0-9][a-z0-9-]{7,79}$/.test(publicId))return json(res,400,{error:'invalid_public_id'});try{const row=await withTracefabPublicContext(async tx=>(await tx.$queryRaw<Array<{public_id:string;granularity:string;qualifier:string|null;status:string;replacement_public_id:string|null}>>`
 SELECT i.public_id,i.granularity,i.qualifier,i.status,r.public_id replacement_public_id FROM dpp_resolvable_identifiers i LEFT JOIN dpp_resolvable_identifiers r ON r.id=i.replaced_by_id WHERE i.public_id=${publicId} LIMIT 1`)[0]||null);if(!row)return json(res,404,{error:'passport_identifier_not_found'});
 const target=row.status==='replaced'&&row.replacement_public_id?`/api/resolve/${encodeURIComponent(row.replacement_public_id)}`:`/dpp/?id=${encodeURIComponent(row.public_id)}`;
  /* Un identifiant retire a disparu publiquement : la branche HTML renvoyait
     un 302 vers la page DPP alors que la branche JSON renvoyait 410. Deux
     contrats pour le meme etat, et un retrait qui restait navigable depuis
     un QR imprime. Le 410 est desormais le meme dans les deux branches, et
     il n'est pas mis en cache. */
  if(row.status==='retired'){res.setHeader('Cache-Control','no-store');return json(res,410,{identifier:row.public_id,granularity:row.granularity,qualifier:row.qualifier,status:row.status,replacedBy:row.replacement_public_id});} if((req.headers.accept||'').includes('text/html')){res.setHeader('Cache-Control','public, max-age=60, must-revalidate');res.setHeader('Location',target);res.statusCode=row.status==='replaced'?308:302;return res.end();}
 return json(res,200,{identifier:row.public_id,granularity:row.granularity,qualifier:row.qualifier,status:row.status,canonicalUrl:target,replacedBy:row.replacement_public_id});
 }catch(error){console.error('Public DPP identity resolution failed',error);return json(res,500,{error:'internal_error'});}}
