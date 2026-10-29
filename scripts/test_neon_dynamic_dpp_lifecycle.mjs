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
const client = url => new pg.Client({ connectionString: url, ssl: /sslmode=(require|verify-full|verify-ca)/.test(url) ? { rejectUnauthorized: true } : false });
const admin=client(ADMIN_URL), app=client(APP_URL);
await admin.connect(); await app.connect();
let assertions=0;
const check=(condition,message)=>{assert.ok(condition,message); assertions++; console.log(`  ok    ${message}`);};
const U=Object.fromEntries(['orgA','orgB','userA','userB','memA','memB','product','dpp','docA','docB','material','nodeA','nodeB','link','point'].map(key=>[key,randomUUID()]));

try {
  await admin.query(`INSERT INTO organizations(id,type,legal_name,display_name,country_code) VALUES
    ($1,'brand','Cycle A SAS','Cycle A','FR'),($2,'brand','Cycle B SAS','Cycle B','PT')`,[U.orgA,U.orgB]);
  // Identifiants Clerk uniques par exécution : le registre est append-only et
  // la fixture n'est pas nettoyée (voir finally) — des identifiants figés
  // rendraient la suite non rejouable sur une base conservée.
  const suffixe=U.userA.slice(0,8);
  const emailA=`cycle-a-${suffixe}@test.invalid`, emailB=`cycle-b-${suffixe}@test.invalid`;
  const slug=`dpp-live-${suffixe}`, idPublic1=`dpp-model-${suffixe}-01`, idPublic2=`dpp-model-${suffixe}-02`;
  await admin.query(`INSERT INTO users(id,clerk_user_id,email,full_name) VALUES
    ($1,$2,$3,'Responsable A'),
    ($4,$5,$6,'Responsable B')`,
    [U.userA,`clerk_dpp_cycle_a_${suffixe}`,emailA,
     U.userB,`clerk_dpp_cycle_b_${suffixe}`,emailB]);
  await admin.query(`INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES
    ($1,$2,$3,'owner','active'),($4,$5,$6,'owner','active')`,[U.memA,U.orgA,U.userA,U.memB,U.orgB,U.userB]);
  await admin.query(`INSERT INTO tracefab_products(id,brand_organization_id,reference,name,status,description,category,country_of_manufacture,data_readiness,color_name,size_range,weight_grams)
    VALUES($1,$2,'DPP-LIVE-001','Chemise vivante','active','Chemise textile de test avec provenance explicite.','shirt','FR','data_ready','Bleu',ARRAY['M'],250)`,[U.product,U.orgA]);
  await admin.query(`INSERT INTO dpp_records(id,product_id,product_version,requirement_profile_key,requirement_profile_version,
    readiness_status) VALUES($1,$2,1,'textile_readiness_mvp','1.0','data_ready')`,[U.dpp,U.product]);
  for (const [id,org,name] of [[U.docA,U.orgA,'preuve-a.pdf'],[U.docB,U.orgB,'preuve-b.pdf']]) {
    await admin.query(`INSERT INTO documents(id,owner_organization_id,storage_bucket,storage_path,original_filename,content_type,byte_size,status,visibility)
      VALUES($1,$2,'tracefab-private',$3,$4,'application/pdf',128,'uploaded','private')`,[id,org,`${org}/dpp/${name}`,name]);
  }
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('tracefab.internal_document_update','true',true)");
  await admin.query("UPDATE documents SET status='available' WHERE id=$1",[U.docA]);
  await admin.query('COMMIT');
  await admin.query(`INSERT INTO materials(id,owner_organization_id,material_type,name,origin_country_code)
    VALUES($1,$2,'fiber','Coton de test','FR')`,[U.material,U.orgA]);
  await admin.query(`INSERT INTO product_materials(product_id,material_id,percentage,product_version)
    VALUES($1,$2,100,1)`,[U.product,U.material]);
  await admin.query(`INSERT INTO supply_chain_nodes(id,node_type,product_id,material_id,label,status,source_document_id,graph_product_id)
    VALUES($1,'product',$3,NULL,'Produit documenté','documented',$4,$3),
          ($2,'material',NULL,$5,'Matière documentée','documented',$4,$3)`,
    [U.nodeA,U.nodeB,U.product,U.docA,U.material]);
  await admin.query(`INSERT INTO supply_chain_links(id,product_id,source_node_id,target_node_id,link_type)
    VALUES($1,$2,$3,$4,'contains')`,[U.link,U.product,U.nodeA,U.nodeB]);
  await admin.query(`INSERT INTO data_points(id,owner_organization_id,product_id,data_key,value,data_type,status,source_document_id)
    VALUES($1,$2,$3,'fixture.source',to_jsonb('documented'::text),'text','documented',$4)`,
    [U.point,U.orgA,U.product,U.docA]);
  check(true,'fixtures de deux tenants creees');

  const context=async(user,email,fn)=>{await app.query('BEGIN');try{
    await app.query("SELECT set_config('tracefab.user_id',$1,true)",[user]);
    await app.query("SELECT set_config('tracefab.user_email',$1,true)",[email]);
    const value=await fn(); await app.query('COMMIT'); return value;
  }catch(e){await app.query('ROLLBACK');throw e;}};
  const publicContext=fn=>context('', '', async()=>{await app.query("SELECT set_config('tracefab.public_context','true',true)");return fn();});

  const role=(await app.query("SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  check(!role.rolbypassrls&&!role.rolsuper,'role runtime soumis a RLS');

  // Barriere 20261027120000 : « aucune anomalie ouverte » n'est vrai que si la
  // qualite a ete evaluee. On eprouve d'abord le refus — sans evaluation, la
  // revue doit echouer — puis on calcule, comme le ferait la console.
  let refusSansEvaluation=null;
  try {
    await context(U.userA,emailA,()=>app.query(
      `SELECT * FROM tracefab_mark_dpp_ready_to_publish($1)`,[U.dpp]));
  } catch (error) { refusSansEvaluation=error.message; }
  check(refusSansEvaluation==='dpp_publication_requirements_not_met',
    'revue refusee tant que la qualite n a pas ete evaluee');
  // La completude produit (7 exigences du moteur qualite) exige un identifiant :
  // sans lui, le calcul ouvre une anomalie bloquante et la revue reste fermee.
  await admin.query(`INSERT INTO product_identifiers(id,product_id,identifier_type,identifier_value,is_primary)
    VALUES($1,$2,'internal','DPP-LIVE-001',true)`,[randomUUID(),U.product]);
  // Recalcul de completude en ADMIN : l'EXECUTE est retire au role runtime
  // (migration 20261021120000), ce qui est voulu — c'est un recalcul de
  // fixture, pas une action de l'utilisateur. La qualite, elle, est calculee
  // avec le role applicatif : c'est ce que fait la console.
  await admin.query(`SELECT tracefab_refresh_product_data_readiness($1)`,[U.product]);
  await context(U.userA,emailA,()=>app.query(
    `SELECT tracefab_compute_product_quality($1)`,[U.product]));

  const reviewed=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_mark_dpp_ready_to_publish($1)`,[U.dpp]));
  check(reviewed.rows[0].readiness_status==='ready_to_publish'&&reviewed.rows[0].reviewed_at,'revue autorisee horodatee avant publication');
  const published=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_set_dpp_publication($1,'publish','${slug}')`,[U.product]));
  check(published.rows[0].readiness_status==='published','revue vers publication executee en transaction');
  check((await admin.query('SELECT public_slug FROM tracefab_products WHERE id=$1',[U.product])).rows[0].public_slug===slug,'identifiant public stable pose');
  const identity=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_create_dpp_identity($1,'${idPublic1}','model',NULL)`,[U.product]));
  check(identity.rows[0].granularity==='model','identité résolvable créée à granularité modèle');
  const replaced=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_replace_dpp_identity($1,'${idPublic2}','Erreur association initiale')`,[identity.rows[0].id]));
  check(replaced.rows[0].status==='replaced'&&replaced.rows[0].replaced_by_id,'ancien identifiant conservé comme remplacé');
  const replacement=(await admin.query('SELECT * FROM dpp_resolvable_identifiers WHERE id=$1',[replaced.rows[0].replaced_by_id])).rows[0];
  check(replacement.public_id===idPublic2&&replacement.status==='active','remplaçant créé atomiquement avec portée identique');
  let foreignIdentity=false;try{await context(U.userB,emailB,()=>app.query(
    `SELECT tracefab_create_dpp_identity($1,'dpp-foreign-attempt','model',NULL)`,[U.product]));}catch(e){foreignIdentity=String(e.message).includes('dpp_identity_role_required');}
  check(foreignIdentity,'autre organisation ne peut créer une identité sur le produit');

  const visible=await publicContext(()=>app.query('SELECT id FROM tracefab_products WHERE id=$1',[U.product]));
  check(visible.rowCount===1,'produit publie resolvable en contexte anonyme');
  const publicPublication=await publicContext(()=>app.query(
    `SELECT event_type,public_summary,validation_status::text FROM dpp_lifecycle_events WHERE product_id=$1`,[U.product]));
  check(publicPublication.rows.some(e=>e.event_type==='published'&&e.public_summary),'evenement de publication visible sans detail prive');

  const added=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_add_dpp_event($1,'evidence_added','Certificat fournisseur ajoute',now(),'document','documented',
      'Une preuve documentaire a ete ajoutee','{"claim":"composition"}'::jsonb,ARRAY[$2]::uuid[],NULL,'erp-evt-001','model',NULL)`,[U.product,U.docA]));
  const evidenceEvent=added.rows[0];
  check(evidenceEvent.validation_status==='documented','preuve enregistree comme documentee, jamais certifiee automatiquement');
  check(evidenceEvent.evidence_document_ids[0]===U.docA,'preuve du bon tenant reliee a evenement');

  const duplicate=await context(U.userA,emailA,()=>app.query(
    `SELECT id FROM tracefab_add_dpp_event($1,'evidence_added','Rejeu identique',now(),'document','documented',NULL,
      '{}'::jsonb,ARRAY[$2]::uuid[],NULL,'erp-evt-001','model',NULL)`,[U.product,U.docA]));
  check(duplicate.rows[0].id===evidenceEvent.id,'rejeu idempotent retourne evenement initial sans doublon');

  const corrected=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_add_dpp_event($1,'data_corrected','Perimetre de preuve corrige',now(),'document','documented',
      'Le perimetre de la preuve a ete corrige','{}'::jsonb,ARRAY[$2]::uuid[],$3,NULL,'model',NULL)`,[U.product,U.docA,evidenceEvent.id]));
  check(corrected.rows[0].corrects_event_id===evidenceEvent.id,'correction reference explicitement evenement anterieur');
  check(Number((await admin.query('SELECT count(*) FROM dpp_lifecycle_events WHERE id=ANY($1::uuid[])',[[evidenceEvent.id,corrected.rows[0].id]])).rows[0].count)===2,'fait initial conserve apres correction');

  let rejected=false;
  try { await context(U.userA,emailA,()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'evidence_added','Preuve etrangere',now(),'document','documented',NULL,'{}',ARRAY[$2]::uuid[])`,[U.product,U.docB]));
  } catch(e){ rejected=String(e.message).includes('invalid_evidence_document'); }
  check(rejected,'preuve appartenant a un autre tenant refusee');

  const claimResult=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_add_dpp_claim($1,'composition.cotton','La composition déclarée contient du coton',
      'Composition coton documentée','documented',$2,'model',NULL,current_date-30,current_date-1,NULL,NULL)`,[U.product,evidenceEvent.id]));
  const claim=claimResult.rows[0];
  check(claim.validation_status==='documented','affirmation documentée distincte de sa preuve');
  const linkResult=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_link_dpp_claim_evidence($1,$2,'supports','Couvre la composition du modèle','accepted',
      'Document examiné dans son périmètre','Certificat de composition')`,[claim.id,U.docA]));
  check(linkResult.rows[0].verification_result==='accepted','lien de preuve accepté avec motif et périmètre');
  check(claim.validation_status!=='third_party_verified','preuve acceptée ne transforme pas automatiquement affirmation en vérification tierce');
  const publicClaims=await publicContext(()=>app.query('SELECT * FROM tracefab_public_dpp_claims($1)',[U.product]));
  check(publicClaims.rowCount===1&&publicClaims.rows[0].accepted_evidence_count===1,'projection publique compte uniquement les preuves acceptées');
  check(publicClaims.rows[0].expired===true,'expiration de affirmation signalée explicitement');
  const projectionKeys=Object.keys(publicClaims.rows[0]);
  check(!projectionKeys.some(k=>['document_id','storage_path','original_filename','coverage_note'].includes(k)),'projection publique sans identifiant ni métadonnée documentaire privée');
  let foreignClaimEvidence=false;
  try{await context(U.userA,emailA,()=>app.query(
    `SELECT tracefab_link_dpp_claim_evidence($1,$2)`,[claim.id,U.docB]));}catch(e){foreignClaimEvidence=String(e.message).includes('invalid_evidence_document');}
  check(foreignClaimEvidence,'document autre tenant refusé sur affirmation');
  let claimMutationBlocked=false;
  try{await admin.query('UPDATE dpp_claims SET statement=$1 WHERE id=$2',['altération',claim.id]);}catch(e){claimMutationBlocked=String(e.message).includes('dpp_claims_are_append_only');}
  check(claimMutationBlocked,'affirmation et chaîne de preuve append-only');

  let foreignWrite=false;
  try { await context(U.userB,emailB,()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'repair','Tentative externe')`,[U.product]));
  } catch(e){foreignWrite=String(e.message).includes('dpp_event_role_required');}
  check(foreignWrite,'organisation B ne peut pas ajouter evenement au produit A');
  const foreignRead=await context(U.userB,emailB,()=>app.query('SELECT id FROM dpp_lifecycle_events WHERE product_id=$1',[U.product]));
  check(foreignRead.rowCount===0,'organisation B ne lit aucun evenement prive de A');

  let mutationBlocked=false;
  try {await admin.query('UPDATE dpp_lifecycle_events SET summary=$1 WHERE id=$2',['altération',evidenceEvent.id]);}
  catch(e){mutationBlocked=String(e.message).includes('dpp_events_are_append_only');}
  check(mutationBlocked,'UPDATE evenement refuse meme au proprietaire de migration');

  const suspended=await context(U.userA,emailA,()=>app.query(
    `SELECT * FROM tracefab_set_dpp_publication($1,'suspend',NULL)`,[U.product]));
  check(suspended.rows[0].readiness_status==='ready_to_publish','publication suspendue sans detruire readiness revue');
  check((await admin.query('SELECT public_slug FROM tracefab_products WHERE id=$1',[U.product])).rows[0].public_slug===null,'slug retire atomiquement lors suspension');
  const invisible=await publicContext(()=>app.query('SELECT id FROM tracefab_products WHERE id=$1',[U.product]));
  check(invisible.rowCount===0,'passeport suspendu immediatement invisible via RLS publique');
  const privateHistory=await context(U.userA,emailA,()=>app.query('SELECT event_type FROM dpp_lifecycle_events WHERE product_id=$1',[U.product]));
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
