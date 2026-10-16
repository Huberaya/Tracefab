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
    readiness_status,reviewed_at,reviewed_by) VALUES($1,$2,1,'textile_readiness_mvp','1.0','ready_to_publish',now(),$3)`,[U.dpp,U.product,U.userA]);
  for (const [id,org,name] of [[U.docA,U.orgA,'preuve-a.pdf'],[U.docB,U.orgB,'preuve-b.pdf']]) {
    await admin.query(`INSERT INTO documents(id,owner_organization_id,storage_bucket,storage_path,original_filename,content_type,byte_size,status,visibility)
      VALUES($1,$2,'tracefab-private',$3,$4,'application/pdf',128,'uploaded','private')`,[id,org,`${org}/dpp/${name}`,name]);
  }
  check(true,'fixtures de deux tenants creees');

  const context=async(user,email,fn)=>{await app.query('BEGIN');try{
    await app.query("SELECT set_config('tracefab.user_id',$1,true)",[user]);
    await app.query("SELECT set_config('tracefab.user_email',$1,true)",[email]);
    const value=await fn(); await app.query('COMMIT'); return value;
  }catch(e){await app.query('ROLLBACK');throw e;}};
  const publicContext=fn=>context('', '', async()=>{await app.query("SELECT set_config('tracefab.public_context','true',true)");return fn();});

  const role=(await app.query("SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  check(!role.rolbypassrls&&!role.rolsuper,'role runtime soumis a RLS');

  const published=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT (tracefab_set_dpp_publication($1,'publish','dpp-live-001')).*`,[U.product]));
  check(published.rows[0].readiness_status==='published','revue vers publication executee en transaction');
  check((await admin.query('SELECT public_slug FROM tracefab_products WHERE id=$1',[U.product])).rows[0].public_slug==='dpp-live-001','identifiant public stable pose');

  const visible=await publicContext(()=>app.query('SELECT id FROM tracefab_products WHERE id=$1',[U.product]));
  check(visible.rowCount===1,'produit publie resolvable en contexte anonyme');
  const publicPublication=await publicContext(()=>app.query(
    `SELECT event_type,public_summary,validation_status::text FROM dpp_lifecycle_events WHERE product_id=$1`,[U.product]));
  check(publicPublication.rows.some(e=>e.event_type==='published'&&e.public_summary),'evenement de publication visible sans detail prive');

  const added=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT (tracefab_add_dpp_event($1,'evidence_added','Certificat fournisseur ajoute',now(),'document','documented',
      'Une preuve documentaire a ete ajoutee','{"claim":"composition"}'::jsonb,ARRAY[$2]::uuid[],NULL,'erp-evt-001','model',NULL)).*`,[U.product,U.docA]));
  const evidenceEvent=added.rows[0];
  check(evidenceEvent.validation_status==='documented','preuve enregistree comme documentee, jamais certifiee automatiquement');
  check(evidenceEvent.evidence_document_ids[0]===U.docA,'preuve du bon tenant reliee a evenement');

  const duplicate=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT (tracefab_add_dpp_event($1,'evidence_added','Rejeu identique',now(),'document','documented',NULL,
      '{}'::jsonb,ARRAY[$2]::uuid[],NULL,'erp-evt-001','model',NULL)).id`,[U.product,U.docA]));
  check(duplicate.rows[0].id===evidenceEvent.id,'rejeu idempotent retourne evenement initial sans doublon');

  const corrected=await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT (tracefab_add_dpp_event($1,'data_corrected','Perimetre de preuve corrige',now(),'document','documented',
      'Le perimetre de la preuve a ete corrige','{}'::jsonb,ARRAY[$2]::uuid[],$3,NULL,'model',NULL)).*`,[U.product,U.docA,evidenceEvent.id]));
  check(corrected.rows[0].corrects_event_id===evidenceEvent.id,'correction reference explicitement evenement anterieur');
  check(Number((await admin.query('SELECT count(*) FROM dpp_lifecycle_events WHERE id=ANY($1::uuid[])',[[evidenceEvent.id,corrected.rows[0].id]])).rows[0].count)===2,'fait initial conserve apres correction');

  let rejected=false;
  try { await context(U.userA,'cycle-a@test.invalid',()=>app.query(
    `SELECT tracefab_add_dpp_event($1,'evidence_added','Preuve etrangere',now(),'document','documented',NULL,'{}',ARRAY[$2]::uuid[])`,[U.product,U.docB]));
  } catch(e){ rejected=String(e.message).includes('invalid_evidence_document'); }
  check(rejected,'preuve appartenant a un autre tenant refusee');

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
    `SELECT (tracefab_set_dpp_publication($1,'suspend',NULL)).*`,[U.product]));
  check(suspended.rows[0].readiness_status==='ready_to_publish','publication suspendue sans detruire readiness revue');
  check((await admin.query('SELECT public_slug FROM tracefab_products WHERE id=$1',[U.product])).rows[0].public_slug===null,'slug retire atomiquement lors suspension');
  const invisible=await publicContext(()=>app.query('SELECT id FROM tracefab_products WHERE id=$1',[U.product]));
  check(invisible.rowCount===0,'passeport suspendu immediatement invisible via RLS publique');
  const privateHistory=await context(U.userA,'cycle-a@test.invalid',()=>app.query('SELECT event_type FROM dpp_lifecycle_events WHERE product_id=$1',[U.product]));
  check(privateHistory.rows.some(e=>e.event_type==='publication_suspended')&&privateHistory.rowCount>=4,'historique prive conserve apres retrait public');

  console.log(`\nPasseport dynamique PostgreSQL : ${assertions} preuves executees, 0 simulation.`);
} finally {
  // Le registre est append-only jusque pour le propriétaire : aucun nettoyage
  // destructif. La base entière est détruite avec le runner CI.
  await app.end(); await admin.end();
}
