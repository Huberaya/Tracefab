#!/usr/bin/env node
/**
 * Preuve PostgreSQL du passeport dynamique.
 *
 * Ecrit uniquement sur une base jetable via run-db-suite.mjs. Toutes les
 * operations produit sont ensuite executees avec tracefab_app, sans BYPASSRLS.
 * Le test refuse de confondre code present et capacite operationnelle.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ADMIN_URL = process.env.DATABASE_URL;
const APP_URL = process.env.TF_RLS_APP_URL;
if (!ADMIN_URL || !APP_URL) {
  console.error('NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont obligatoires.');
  process.exit(2);
}
const client = url => new pg.Client({ connectionString: url, ssl: /sslmode=(require|verify-full|verify-ca)/.test(url) ? { rejectUnauthorized: false } : false });
const admin=client(ADMIN_URL), app=client(APP_URL);
await admin.connect(); await app.connect();
let assertions=0;
const check=(condition,message)=>{assert.ok(condition,message); assertions++; console.log(`  ok    ${message}`);};
const U=Object.fromEntries(['orgA','orgB','userA','userB','memA','memB','product','dpp','docA','docB'].map(key=>[key,randomUUID()]));

try {
  await admin.query(`INSERT INTO organizations(id,type,legal_name,display_name,country_code) VALUES
    ($1,'brand','Cycle A SAS','Cycle A','FR'),($2,'brand','Cycle B SAS','Cycle B','PT')`,[U.orgA,U.orgB]);
  await admin.query(`INSERT INTO users(id,clerk_user_id,email,full_name) VALUES
    ($1,'clerk_dpp_cycle_a','cycle-a@test.invalid','Responsable A'),
    ($2,'clerk_dpp_cycle_b','cycle-b@test.invalid','Responsable B')`,[U.userA,U.userB]);
  await admin.query(`INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES
    ($1,$2,$3,'owner','active'),($4,$5,$6,'owner','active')`,[U.memA,U.orgA,U.userA,U.memB,U.orgB,U.userB]);
  await admin.query(`INSERT INTO tracefab_products(id,brand_organization_id,reference,name,status,description,category,country_of_manufacture,data_readiness)
    VALUES($1,$2,'DPP-LIVE-001','Chemise vivante','active','Chemise textile de test avec provenance explicite.','shirt','FR','data_ready')`,[U.product,U.orgA]);
  await admin.query(`INSERT INTO dpp_records(id,product_id,product_version,requirement_profile_key,requirement_profile_version,
    readiness_status) VALUES($1,$2,1,'textile_readiness_mvp','1.0','data_ready')`,[U.dpp,U.product]);
  for (const [id,org,name] of [[U.docA,U.orgA,'preuve-a.pdf'],[U.docB,U.orgB,'preuve-b.pdf']]) {
    await admin.query(`INSERT INTO documents(id,owner_organization_id,storage_bucket,storage_path,original_filename,content_type,byte_size,status,visibility)
      VALUES($1,$2,'tracefab-private',$3,$4,'application/pdf',128,'uploaded','private')`,[id,org,`${org}/dpp/${name}`,name]);
  }
  const V=Object.fromEntries(['org','user','mem','orgNoMandate','userNoMandate','memNoMandate']
    .map(key=>[key,randomUUID()]));
  await admin.query(`INSERT INTO organizations(id,type,legal_name,display_name,country_code) VALUES
    ($1,'verifier','Bureau de controle Test SAS','Bureau de controle Test','FR'),
    ($2,'verifier','Verificateur sans mandat SAS','Verificateur sans mandat','FR')`,[V.org,V.orgNoMandate]);
  await admin.query(`INSERT INTO users(id,clerk_user_id,email,full_name) VALUES
    ($1,'clerk_verifier_a','verifier-a@test.invalid','Auditeur Verificateur'),
    ($2,'clerk_verifier_b','verifier-b@test.invalid','Verificateur sans mandat')`,[V.user,V.userNoMandate]);
  await admin.query(`INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES
    ($1,$2,$3,'owner','active'),($4,$5,$6,'owner','active')`,[V.mem,V.org,V.user,V.memNoMandate,V.orgNoMandate,V.userNoMandate]);
  check(true,'fixtures de deux tenants et de deux verificateurs creees');

  const context=async(user,email,fn)=>{await app.query('BEGIN');try{
    await app.query("SELECT set_config('tracefab.user_id',$1,true)",[user]);
    await app.query("SELECT set_config('tracefab.user_email',$1,true)",[email]);
    const value=await fn(); await app.query('COMMIT'); return value;
  }catch(e){await app.query('ROLLBACK');throw e;}};
  const publicContext=fn=>context('', '', async()=>{await app.query("SELECT set_config('tracefab.public_context','true',true)");return fn();});

  const mandate=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_grant_dpp_verification_mandate($1,$2,'Audit independant du passeport')`,[U.orgA,V.org]));
  check(mandate.rows[0].status==='active'&&mandate.rows[0].verifier_organization_id===V.org,'mandat verificateur explicite accorde par la marque');
  let foreignMandate=false;
  try{await context(U.userB,'cycle-b@test.invalid',()=>app.query(
    `SELECT tracefab_grant_dpp_verification_mandate($1,$2,'Tentative externe')`,[U.orgA,V.orgNoMandate]));
  }catch(e){foreignMandate=String(e.message).includes('dpp_mandate_role_required');}
  check(foreignMandate,'une autre organisation ne peut pas accorder de mandat sur la marque A');

  const role=(await app.query("SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  check(!role.rolbypassrls&&!role.rolsuper,'role runtime soumis a RLS');

  const reviewed=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_mark_dpp_ready_to_publish($1)`,[U.dpp]));
  check(reviewed.rows[0].readiness_status==='ready_to_publish'&&reviewed.rows[0].reviewed_at,'revue autorisee horodatee avant publication');
  const published=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_set_dpp_publication($1,'publish','dpp-live-001')`,[U.product]));
  check(published.rows[0].readiness_status==='published','revue vers publication executee en transaction');
  check((await admin.query('SELECT public_slug FROM tracefab_products WHERE id=$1',[U.product])).rows[0].public_slug==='dpp-live-001','identifiant public stable pose');
  const identity=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_create_dpp_identity($1,'dpp-model-stable-001','model',NULL)`,[U.product]));
  check(identity.rows[0].granularity==='model','identité résolvable créée à granularité modèle');
  const replaced=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_replace_dpp_identity($1,'dpp-model-stable-002','Erreur association initiale')`,[identity.rows[0].id]));
  check(replaced.rows[0].status==='replaced'&&replaced.rows[0].replaced_by_id,'ancien identifiant conservé comme remplacé');
  const replacement=(await admin.query('SELECT * FROM dpp_resolvable_identifiers WHERE id=$1',[replaced.rows[0].replaced_by_id])).rows[0];
  check(replacement.public_id==='dpp-model-stable-002'&&replacement.status==='active','remplaçant créé atomiquement avec portée identique');
  let foreignIdentity=false;try{await context(U.userB,'cycle-b@test.invalid',()=>app.query(
    `SELECT tracefab_create_dpp_identity($1,'dpp-foreign-attempt','model',NULL)`,[U.product]));}catch(e){foreignIdentity=String(e.message).includes('dpp_identity_role_required');}
  check(foreignIdentity,'autre organisation ne peut créer une identité sur le produit');

  const visible=await publicContext(()=>app.query('SELECT id FROM tracefab_products WHERE id=$1',[U.product]));
  check(visible.rowCount===1,'produit publie resolvable en contexte anonyme');
  const publicPublication=await publicContext(()=>app.query(
    `SELECT event_type,public_summary,validation_status::text FROM dpp_lifecycle_events WHERE product_id=$1`,[U.product]));
  check(publicPublication.rows.some(e=>e.event_type==='published'&&e.public_summary),'evenement de publication visible sans detail prive');

  const added=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_add_dpp_event($1,'evidence_added','Certificat fournisseur ajoute',now(),'document','documented',
      'Une preuve documentaire a ete ajoutee','{"claim":"composition"}'::jsonb,ARRAY[$2]::uuid[],NULL,'erp-evt-001','model',NULL)`,[U.product,U.docA]));
  const evidenceEvent=added.rows[0];
  check(evidenceEvent.validation_status==='documented','preuve enregistree comme documentee, jamais certifiee automatiquement');
  check(evidenceEvent.evidence_document_ids[0]===U.docA,'preuve du bon tenant reliee a evenement');

  const duplicate=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT id FROM tracefab_add_dpp_event($1,'evidence_added','Rejeu identique',now(),'document','documented',NULL,
      '{}'::jsonb,ARRAY[$2]::uuid[],NULL,'erp-evt-001','model',NULL)`,[U.product,U.docA]));
  check(duplicate.rows[0].id===evidenceEvent.id,'rejeu idempotent retourne evenement initial sans doublon');

  const corrected=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_add_dpp_event($1,'data_corrected','Perimetre de preuve corrige',now(),'document','documented',
      'Le perimetre de la preuve a ete corrige','{}'::jsonb,ARRAY[$2]::uuid[],$3,NULL,'model',NULL)`,[U.product,U.docA,evidenceEvent.id]));
  check(corrected.rows[0].corrects_event_id===evidenceEvent.id,'correction reference explicitement evenement anterieur');
  check(Number((await admin.query('SELECT count(*) FROM dpp_lifecycle_events WHERE id=ANY($1::uuid[])',[[evidenceEvent.id,corrected.rows[0].id]])).rows[0].count)===2,'fait initial conserve apres correction');

  let rejected=false;
  try { await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'evidence_added','Preuve etrangere',now(),'document','documented',NULL,'{}',ARRAY[$2]::uuid[])`,[U.product,U.docB]));
  } catch(e){ rejected=String(e.message).includes('invalid_evidence_document'); }
  check(rejected,'preuve appartenant a un autre tenant refusee');

  const claimResult=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_add_dpp_claim($1,'composition.cotton','La composition déclarée contient du coton',
      'Composition coton documentée','declared',$2,'model',NULL,current_date-30,current_date-1,NULL,NULL)`,[U.product,evidenceEvent.id]));
  const claim=claimResult.rows[0];
  check(claim.validation_status==='declared','une affirmation nait declaree, jamais pre-verifiee');

  let forgedInitialStatus=false;
  try{await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_add_dpp_claim($1,'composition.forged','Statut fabrique','Statut fabrique','third_party_verified')`,[U.product]));
  }catch(e){forgedInitialStatus=String(e.message).includes('dpp_claim_initial_status_must_be_declared');}
  check(forgedInitialStatus,'creation directe en third_party_verified refusee');

  const linkResult=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_link_dpp_claim_evidence($1,$2,'supports','Couvre la composition du modèle','accepted',
      'Document examiné dans son périmètre','Certificat de composition')`,[claim.id,U.docA]));
  check(linkResult.rows[0].verification_result==='accepted','lien de preuve accepté avec motif et périmètre');
  check(claim.validation_status!=='third_party_verified','preuve acceptée ne transforme pas automatiquement affirmation en vérification tierce');

  const publicBeforeReview=await publicContext(()=>app.query('SELECT * FROM tracefab_public_dpp_claims($1)',[U.product]));
  check(publicBeforeReview.rows[0].validation_status==='declared','la preuve seule ne change pas le statut public');

  let foreignReview=false;
  try{await context(U.userB,'cycle-b@test.invalid',()=>app.query(
    `SELECT tracefab_review_dpp_claim($1,'documented','Examen externe',NULL,NULL)`,[claim.id]));
  }catch(e){foreignReview=String(e.message).includes('dpp_claim_review_role_required');}
  check(foreignReview,'une autre organisation ne peut pas revoir affirmation de A');

  let brandCannotSelfVerify=false;
  try{await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_review_dpp_claim($1,'third_party_verified','Auto-attestation',NULL,NULL)`,[claim.id]));
  }catch(e){brandCannotSelfVerify=String(e.message).includes('third_party_verifier_role_required');}
  check(brandCannotSelfVerify,'la marque ne peut pas s auto-attribuer third_party_verified');

  const reviewedClaim=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_review_dpp_claim($1,'documented','Examen du certificat de composition',
      'Document examiné et accepté',NULL)`,[claim.id]));
  check(reviewedClaim.rows[0].resulting_status==='documented'&&reviewedClaim.rows[0].reviewer_organization_id===null,'revue interne documentee enregistree sans organisme tiers');

  const publicClaims=await publicContext(()=>app.query('SELECT * FROM tracefab_public_dpp_claims($1)',[U.product]));
  check(publicClaims.rowCount>=1&&publicClaims.rows.find(r=>r.claim_key==='composition.cotton')?.accepted_evidence_count===1,'projection publique compte uniquement les preuves acceptées');
  check(publicClaims.rows.find(r=>r.claim_key==='composition.cotton')?.validation_status==='documented'&&publicClaims.rows.find(r=>r.claim_key==='composition.cotton')?.reviewed_at,'statut public effectif issu de la derniere revue');
  check(publicClaims.rows[0].expired===true,'expiration de affirmation signalée explicitement');
  const projectionKeys=Object.keys(publicClaims.rows[0]);
  check(!projectionKeys.some(k=>['document_id','storage_path','original_filename','coverage_note','created_by'].includes(k)),'projection publique sans identifiant ni métadonnée documentaire privée');

  const claimWithoutEvidence=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_add_dpp_claim($1,'water.footprint','Consommation d eau evaluee','Eau verifiee','declared')`,[U.product]));
  const claimWater=claimWithoutEvidence.rows[0];
  let reviewWithoutEvidence=false;
  try{await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_review_dpp_claim($1,'documented','Examen sans preuve',NULL,NULL)`,[claimWater.id]));
  }catch(e){reviewWithoutEvidence=String(e.message).includes('dpp_claim_evidence_required');}
  check(reviewWithoutEvidence,'revue documented refusee sans preuve acceptee');

  let noMandate=false;
  try{await context(V.userNoMandate,'verifier-b@test.invalid',()=>app.query(
    `SELECT tracefab_review_dpp_claim($1,'third_party_verified','Controle non mandate',NULL,$2)`,[claimWater.id,V.orgNoMandate]));
  }catch(e){noMandate=String(e.message).includes('dpp_verification_mandate_required');}
  check(noMandate,'verificateur sans relation active refuse');

  let verifierInternalStatus=false;
  try{await context(V.user,'verifier-a@test.invalid',()=>app.query(
    `SELECT tracefab_review_dpp_claim($1,'documented','Statut interne',NULL,$2)`,[claimWater.id,V.org]));
  }catch(e){verifierInternalStatus=String(e.message).includes('third_party_review_status_invalid');}
  check(verifierInternalStatus,'verificateur limite aux statuts tiers et rejet');

  await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_link_dpp_claim_evidence($1,$2,'supports','Couvre l evaluation eau','accepted',
      'Document examine','Evaluation eau acceptee')`,[claimWater.id,U.docA]));

  const thirdParty=await context(V.user,'verifier-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_review_dpp_claim($1,'third_party_verified','Controle independant du 17 octobre',
      'Preuve acceptee dans le perimetre du modele',$2)`,[claimWater.id,V.org]));
  check(thirdParty.rows[0].resulting_status==='third_party_verified'&&thirdParty.rows[0].reviewer_organization_id===V.org,'revue tierce acceptee avec organisme identifie');

  const publicThirdParty=await publicContext(()=>app.query('SELECT * FROM tracefab_public_dpp_claims($1)',[U.product]));
  const waterPublic=publicThirdParty.rows.find(row=>row.claim_key==='water.footprint');
  check(waterPublic.validation_status==='third_party_verified'&&waterPublic.verifier_display_name==='Bureau de controle Test','projection publique identifie le verificateur sans donnee de contact');

  let eventWithoutEvidence=false;
  try{await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'repair','Reparation sans preuve',now(),'actor_declaration','documented',NULL,'{}'::jsonb,'{}'::uuid[])`,[U.product]));
  }catch(e){eventWithoutEvidence=String(e.message).includes('dpp_event_evidence_required');}
  check(eventWithoutEvidence,'evenement documented refuse sans justificatif');

  let eventWithoutVerifier=false;
  try{await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'repair','Controle sans organisme',now(),'third_party','third_party_verified',NULL,'{}'::jsonb,ARRAY[$2]::uuid[])`,[U.product,U.docA]));
  }catch(e){eventWithoutVerifier=String(e.message).includes('third_party_verifier_organization_required');}
  check(eventWithoutVerifier,'evenement third_party_verified refuse sans organisme');

  const verifiedEvent=await context(V.user,'verifier-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_add_dpp_event($1,'repair','Reparation controlee par un tiers',now(),'third_party','third_party_verified',
      'Reparation controlee par un tiers','{}'::jsonb,ARRAY[$2]::uuid[],NULL,NULL,'model',NULL,$3)`,[U.product,U.docA,V.org]));
  check(verifiedEvent.rows[0].verified_by_organization_id===V.org,'evenement tiers enregistre avec organisme identifie');
  const publicHistoryCheck=await publicContext(()=>app.query(
    `SELECT event_type,tracefab_public_verifier_name(verified_by_organization_id) AS verifier FROM dpp_lifecycle_events WHERE id=$1`,[verifiedEvent.rows[0].id]));
  check(publicHistoryCheck.rows[0]?.verifier==='Bureau de controle Test','historique public expose le nom du verificateur, jamais son contact');

  const verifierRead=await context(V.user,'verifier-a@test.invalid',()=>app.query(
    `SELECT id FROM dpp_claims WHERE product_id=$1`,[U.product]));
  check(verifierRead.rowCount>=2,'verificateur mandate lit les affirmations de la marque');
  const verifierDocuments=await context(V.user,'verifier-a@test.invalid',()=>app.query('SELECT id FROM documents WHERE owner_organization_id=$1',[U.orgA]));
  check(verifierDocuments.rowCount===0,'verificateur ne lit pas les fichiers documentaires prives');

  const revokedMandate=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_revoke_dpp_verification_mandate($1,'Fin de la mission de controle')`,[mandate.rows[0].id]));
  check(revokedMandate.rows[0].status==='revoked'&&revokedMandate.rows[0].revoked_at,'mandat revoque avec date conservee');
  let reviewAfterRevoke=false;
  try{await context(V.user,'verifier-a@test.invalid',()=>app.query(
    `SELECT tracefab_review_dpp_claim($1,'third_party_verified','Apres revocation',NULL,$2)`,[claimWater.id,V.org]));
  }catch(e){reviewAfterRevoke=String(e.message).includes('dpp_verification_mandate_required');}
  check(reviewAfterRevoke,'revocation du mandat bloque toute nouvelle revue tierce');
  const publicAfterRevoke=await publicContext(()=>app.query('SELECT * FROM tracefab_public_dpp_claims($1)',[U.product]));
  check(publicAfterRevoke.rows.find(row=>row.claim_key==='water.footprint')?.validation_status==='third_party_verified','une attestation passee reste publique apres revocation du mandat');


  let reviewMutationBlocked=false;
  try{await admin.query('UPDATE dpp_claim_reviews SET method=$1 WHERE id=$2',['alteration',reviewedClaim.rows[0].id]);}
  catch(e){reviewMutationBlocked=String(e.message).includes('dpp_claim_reviews_are_append_only');}
  check(reviewMutationBlocked,'revue append-only, meme pour le proprietaire de migration');

  let foreignClaimEvidence=false;
  try{await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_link_dpp_claim_evidence($1,$2)`,[claim.id,U.docB]));}catch(e){foreignClaimEvidence=String(e.message).includes('invalid_evidence_document');}
  check(foreignClaimEvidence,'document autre tenant refusé sur affirmation');
  let claimMutationBlocked=false;
  try{await admin.query('UPDATE dpp_claims SET statement=$1 WHERE id=$2',['altération',claim.id]);}catch(e){claimMutationBlocked=String(e.message).includes('dpp_claims_are_append_only');}
  check(claimMutationBlocked,'affirmation et chaîne de preuve append-only');

  let foreignWrite=false;
  try { await context(U.userB,'cycle-b@test.invalid',()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'repair','Tentative externe')`,[U.product]));
  } catch(e){foreignWrite=String(e.message).includes('dpp_event_role_required');}
  check(foreignWrite,'organisation B ne peut pas ajouter evenement au produit A');
  const foreignRead=await context(U.userB,'cycle-b@test.invalid',()=>app.query('SELECT id FROM dpp_lifecycle_events WHERE product_id=$1',[U.product]));
  check(foreignRead.rowCount===0,'organisation B ne lit aucun evenement prive de A');

  let mutationBlocked=false;
  try {await admin.query('UPDATE dpp_lifecycle_events SET summary=$1 WHERE id=$2',['altération',evidenceEvent.id]);}
  catch(e){mutationBlocked=String(e.message).includes('dpp_events_are_append_only');}
  check(mutationBlocked,'UPDATE evenement refuse meme au proprietaire de migration');

  const suspended=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT * FROM tracefab_set_dpp_publication($1,'suspend',NULL)`,[U.product]));
  check(suspended.rows[0].readiness_status==='ready_to_publish','publication suspendue sans detruire readiness revue');
  check((await admin.query('SELECT public_slug FROM tracefab_products WHERE id=$1',[U.product])).rows[0].public_slug===null,'slug retire atomiquement lors suspension');
  const invisible=await publicContext(()=>app.query('SELECT id FROM tracefab_products WHERE id=$1',[U.product]));
  check(invisible.rowCount===0,'passeport suspendu immediatement invisible via RLS publique');
  const privateHistory=await context(U.userA,'cycle-a@test.invalid',()=>app.query('SELECT event_type FROM dpp_lifecycle_events WHERE product_id=$1',[U.product]));
  check(privateHistory.rows.some(e=>e.event_type==='publication_suspended')&&privateHistory.rowCount>=4,'historique prive conserve apres retrait public');

  console.log(`\nPasseport dynamique PostgreSQL : ${assertions} preuves executees, 0 simulation.`);
} catch (error) {
  // GitHub masque parfois le flux de logs du service PostgreSQL. Une annotation
  // concise garde la cause observable sans publier de chaîne de connexion.
  const message=error instanceof Error ? error.message.split('\n')[0] : String(error);
  console.error(`::error title=DPP lifecycle PostgreSQL::${message.slice(0,500)}`);
  process.exitCode=1;
} finally {
  // Le registre est append-only jusque pour le propriétaire : aucun nettoyage
  // destructif. La base entière est détruite avec le runner CI.
  await app.end(); await admin.end();
}
