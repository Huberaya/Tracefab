export type DppQualitySeverity='blocking'|'warning'|'info';
export type DppQualityFinding={code:string;severity:DppQualitySeverity;message:string;reason:string;correctiveAction:string;subjectType:'product'|'composition'|'claim'|'evidence'|'event';subjectId:string|null;fieldKey:string|null};
export type DppQualityInput={
 product:{id:string;reference:string|null;name:string|null;category:string|null;countryOfManufacture:string|null};
 materials:Array<{id:string;percentage:number|null}>;
 claims:Array<{id:string;claimKey:string;validationStatus:string;validUntil:string|null}>;
 evidence:Array<{id:string;claimId:string;relationship:string;verificationResult:string;documentExpiresAt:string|null}>;
 events:Array<{id:string;eventType:string;businessOccurredAt:string|null;recordedAt:string;sourceKind:string;evidenceCount:number}>;
 now?:string;
};
const finding=(code:string,severity:DppQualitySeverity,message:string,reason:string,correctiveAction:string,subjectType:DppQualityFinding['subjectType'],subjectId:string|null=null,fieldKey:string|null=null):DppQualityFinding=>({code,severity,message,reason,correctiveAction,subjectType,subjectId,fieldKey});
export function evaluateDppQuality(input:DppQualityInput){
 const out:DppQualityFinding[]=[];const now=new Date(input.now||new Date().toISOString());
 for(const [key,value,label] of [['reference',input.product.reference,'référence'],['name',input.product.name,'nom'],['category',input.product.category,'catégorie'],['country_of_manufacture',input.product.countryOfManufacture,'pays de fabrication']] as const){
  if(!value?.trim())out.push(finding(`product.${key}.missing`,'blocking',`Le ${label} du produit est manquant.`,`Le champ ${key} est vide.`,`Renseigner le ${label} depuis une source identifiable.`,'product',input.product.id,key));
 }
 if(!input.materials.length)out.push(finding('composition.missing','blocking','La composition textile est absente.','Aucune matière n’est associée au produit.','Ajouter les matières et leurs pourcentages sans supposer les valeurs inconnues.','composition',input.product.id,'composition'));
 else {const invalid=input.materials.filter(m=>m.percentage==null||!Number.isFinite(m.percentage)||m.percentage<0||m.percentage>100);const total=input.materials.reduce((s,m)=>s+(Number(m.percentage)||0),0);
  if(invalid.length)out.push(finding('composition.percentage.invalid','blocking','Un ou plusieurs pourcentages de composition sont invalides.',`${invalid.length} matière(s) sans pourcentage compris entre 0 et 100.`,'Corriger les pourcentages concernés à partir des données fournisseur.','composition',input.product.id,'percentage'));
  if(Math.abs(total-100)>0.01)out.push(finding('composition.total.invalid','blocking','La composition ne totalise pas 100 %.',`Total calculé : ${total.toFixed(2)} %.`,'Compléter ou corriger la composition; ne pas répartir automatiquement l’écart.','composition',input.product.id,'percentage'));
 }
 const acceptedByClaim=new Map<string,number>();for(const e of input.evidence){if(e.verificationResult==='accepted'&&e.relationship==='supports')acceptedByClaim.set(e.claimId,(acceptedByClaim.get(e.claimId)||0)+1);
  if(e.verificationResult==='accepted'&&e.documentExpiresAt&&new Date(e.documentExpiresAt)<now)out.push(finding('evidence.document.expired','blocking','Une preuve acceptée est expirée.',`Le document a expiré le ${e.documentExpiresAt}.`,'Remplacer la preuve ou réexaminer explicitement l’affirmation.','evidence',e.id,'expires_at'));
  if(e.verificationResult==='rejected')out.push(finding('evidence.rejected','warning','Une preuve reliée à l’affirmation a été rejetée.','Le résultat de vérification du lien est rejected.','Consulter le motif, corriger le document ou retirer la revendication publique.','evidence',e.id,'verification_result'));
 }
 for(const c of input.claims){const accepted=acceptedByClaim.get(c.id)||0;
  if(c.validUntil&&new Date(c.validUntil)<now)out.push(finding('claim.expired','warning','Une affirmation a dépassé sa période de validité.',`Validité terminée le ${c.validUntil}.`,'Réexaminer l’affirmation et créer une nouvelle version si elle reste applicable.','claim',c.id,'valid_until'));
  if(['documented','controlled','corroborated','third_party_verified'].includes(c.validationStatus)&&accepted===0)out.push(finding('claim.evidence.missing','blocking','Le niveau de confiance annoncé n’a aucune preuve acceptée.',`Statut ${c.validationStatus}, mais aucune preuve de soutien acceptée.`,'Faire contrôler une preuve pertinente ou ramener le statut à déclaré.','claim',c.id,'validation_status'));
 }
 const terminal=input.events.filter(e=>['reuse','recycling'].includes(e.eventType)&&e.businessOccurredAt).map(e=>new Date(e.businessOccurredAt!)).sort((a,b)=>a.getTime()-b.getTime())[0];
 for(const e of input.events){const business=e.businessOccurredAt?new Date(e.businessOccurredAt):null;
  if(business&&business>new Date(e.recordedAt))out.push(finding('event.date.after_recording','warning','La date métier est postérieure à l’enregistrement.',`Événement ${e.eventType} daté après sa création.`,'Vérifier la date métier et enregistrer une correction si nécessaire.','event',e.id,'business_occurred_at'));
  if(terminal&&business&&e.eventType==='manufacturing_step'&&business>terminal)out.push(finding('event.sequence.inconsistent','blocking','Une fabrication est datée après un événement de fin de vie.',`Étape de fabrication postérieure au ${terminal.toISOString().slice(0,10)}.`,'Corriger la date ou la relation de l’événement; ne pas supprimer l’historique.','event',e.id,'business_occurred_at'));
  if(e.sourceKind==='document'&&e.evidenceCount===0)out.push(finding('event.document.missing','warning','Un événement déclaré comme documentaire n’a aucun justificatif.',`L’événement ${e.eventType} utilise source_kind=document avec zéro document.`,'Associer le document source ou corriger le type de provenance.','event',e.id,'evidence_document_ids'));
 }
 const rank={blocking:0,warning:1,info:2};out.sort((a,b)=>rank[a.severity]-rank[b.severity]||a.code.localeCompare(b.code));
 return{status:out.some(f=>f.severity==='blocking')?'blocked':out.some(f=>f.severity==='warning')?'review_required':'clear',summary:{blocking:out.filter(f=>f.severity==='blocking').length,warnings:out.filter(f=>f.severity==='warning').length,total:out.length},findings:out,calculation:{engine:'tracefab-dpp-quality',version:'1.0.0',computedAt:now.toISOString(),notice:'Contrôles déterministes explicables; ils détectent des incohérences, pas la fraude.'}};
}
