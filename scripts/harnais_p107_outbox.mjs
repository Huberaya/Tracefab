#!/usr/bin/env node
/**
 * P10.7 — Chantier C : eprouver CLAIM / COMPLETE de l'outbox sur une ligne
 * reellement eligible, avec une VERITABLE connexion applicative non
 * superutilisateur (`SET SESSION AUTHORIZATION tracefab_app`), sur trois
 * chaines de migrations distinctes.
 *
 * Le proprietaire des fonctions outbox restant `postgres` (superutilisateur)
 * sur PGlite, il est transfere a `tracefab_migrator` (NOSUPERUSER,
 * NOBYPASSRLS) pour reproduire la forme d'un role d'administration Neon.
 * Sans cette modelisation, une dependance de privileges serait MASQUEE.
 *
 * Sorties : 0 epreuves produites · 1 harnais en echec.
 */
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
const MAIN='788df22019c0d2b39301678ecfbc43ac868561bf';
// #114 a avance le 2026-11-06 a 15:34:35Z apres la Phase 0 : la tete REELE est
// f0aeb51 (refs/remotes/audit/pr114-nouveau). L'ancienne tete 537bc31 reste
// disponible pour comparaison, mais toutes les epreuves portent sur la tete
// actuelle. Ce choix est explicite : aucune conclusion n'est recopiee d'avant.
const TETE_114='f0aeb51cb52ce778f7f9a5e857438603d81fa5ad';
const REFS={main:MAIN,'#110':'refs/remotes/audit/pr110','#111':'refs/remotes/audit/pr111','#112':'refs/remotes/audit/pr112','#113':'HEAD','#114':'refs/remotes/audit/pr114-nouveau','#114-ancien':'refs/remotes/audit/pr114'};
const RENAMES={'20261105120000_identite_systeme_signee':'20261105120010_identite_systeme_signee',
               '20261105180000_active_tenant_access_guards':'20261105180010_active_tenant_access_guards'};
const ROOT='/home/user/Tracefab';
const CORRECTIF=path.join(ROOT,'docs','security','candidats','2026-11-06-proprietaire-outbox-identite-systeme.sql');
function migs(ref){const o=execFileSync('git',['ls-tree','-r','--name-only',ref,'prisma/migrations'],{encoding:'utf8'});
  return [...new Set(o.split('\n').filter(l=>l.endsWith('/migration.sql')).map(l=>l.split('/')[2]))].sort();}
function sql(ref,d){return execFileSync('git',['show',`${ref}:prisma/migrations/${d}/migration.sql`],{encoding:'utf8',maxBuffer:20*1024*1024});}
function build(refs,extra){
  const map=new Map();
  for(const r of refs) for(const d of migs(REFS[r])) if(!map.has(d)) map.set(d,r);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'p107-outbox-'));
  const ordered=[...map.entries()].map(([d,r])=>({src:d,dst:RENAMES[d]||d,ref:r,text:sql(REFS[r],d)})).sort((a,b)=>a.dst.localeCompare(b.dst));
  if(extra) ordered.push({src:'CORRECTIF',dst:'20261106120300_outbox_owner_identite_systeme',ref:'local',text:fs.readFileSync(extra,'utf8')});
  for(const o of ordered){fs.mkdirSync(path.join(tmp,o.dst),{recursive:true});fs.writeFileSync(path.join(tmp,o.dst,'migration.sql'),o.text);}
  return {tmp,ordered};
}
const A='a0000000-0000-4000-8000-000000000001', B='b0000000-0000-4000-8000-000000000002';
const REQ='30000000-0000-4000-8000-000000000001', OUT='40000000-0000-4000-8000-000000000001';
const cle=randomBytes(32);
const exp=()=>Math.floor(Date.now()/1000)+60;
const jetonSysteme=()=>{const c=`v1|tracefab_system|tracefab_worker|${exp()}`;return `${c}.${createHmac('sha256',cle).update(c).digest('hex')}`;};
const jetonUser=(u,o)=>{const c=`v1|${u}|${o}|tracefab_identity|${exp()}`;return `${c}.${createHmac('sha256',cle).update(c).digest('hex')}`;};

async function scenario(nom,refs,{modelerProprietaire=true,correctif=false,strictSysteme=true}={}){
  const {tmp,ordered}=build(refs,correctif?CORRECTIF:null);
  const db=new PGlite({extensions:{pgcrypto,uuid_ossp}}); await db.waitReady;
  let appliquees=0, err=null;
  try{
    await db.exec(`CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE tracefab_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      GRANT USAGE ON SCHEMA public TO tracefab_app;`);
    for(const o of ordered){await db.exec(o.text);appliquees++;}
  }catch(e){err=`migration ${ordered[appliquees]?.dst}: ${e.message.slice(0,200)}`;}
  const R={nom,total:ordered.length,appliquees,erreurChaine:err};
  if(!err){
    try{
      // Cles + fixtures (admin, base jetable)
      await db.query(`INSERT INTO public.tracefab_identity_cles(version,secret,actif) VALUES (99001,$1,true)`,[cle]);
      if(strictSysteme) await db.query(`UPDATE public.tracefab_identity_politique SET systeme_strict=true WHERE singleton`).catch(()=>{});
      await db.exec(`INSERT INTO organizations(id,type,legal_name,status) VALUES ('${A}','brand','Marque A','active'),('${B}','supplier','Fournisseur B','active');
        INSERT INTO brand_supplier_relationships(id,brand_organization_id,supplier_organization_id,status)
          VALUES ('50000000-0000-4000-8000-000000000001','${A}','${B}','active');
        INSERT INTO data_requests(id,brand_organization_id,supplier_organization_id,relationship_id,title,questionnaire_key,questionnaire_version,status)
          VALUES ('${REQ}','${A}','${B}','50000000-0000-4000-8000-000000000001','Demande','q','1','sent');
        INSERT INTO tracefab_notification_outbox(id,event_key,event_type,request_id,recipient_organization_id,recipient_emails,recipient_name,brand_name,supplier_name,request_title,status,attempts)
          VALUES ('${OUT}','evt-p107-1','request_sent','${REQ}','${A}',ARRAY['x@example.test'],'X','Marque A','Fournisseur B','Demande','pending',0);`);
      R.fixtures='ok';
      // Modelisation du proprietaire NON superutilisateur (forme Neon)
      const owners=await db.query(`SELECT p.proname, pg_get_userbyid(p.proowner) owner, p.prosecdef
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('tracefab_claim_notification_outbox','tracefab_complete_notification_outbox','tracefab_notification_outbox_health')
        ORDER BY p.proname`);
      R.owners=owners.rows;
      if(modelerProprietaire){
        for(const f of owners.rows){
          if(f.owner==='postgres'){
            try{await db.exec(`ALTER FUNCTION public.${f.proname}(${f.proname==='tracefab_claim_notification_outbox'?'integer':f.proname==='tracefab_complete_notification_outbox'?'uuid, public.tracefab_notification_status, text, text, timestamptz':''}) OWNER TO tracefab_migrator`);}catch(e){}
          }
        }
        R.ownersApresModelisation=(await db.query(`SELECT p.proname, pg_get_userbyid(p.proowner) owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('tracefab_claim_notification_outbox','tracefab_complete_notification_outbox') ORDER BY p.proname`)).rows;
      }
      R.predicat=(await db.query(`SELECT p.proname, pg_get_userbyid(p.proowner) owner,
        has_function_privilege('tracefab_worker',p.oid,'EXECUTE') worker,
        has_function_privilege('tracefab_app',p.oid,'EXECUTE') app,
        has_function_privilege('tracefab_migrator',p.oid,'EXECUTE') migrateur
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('tracefab_identite_systeme','tracefab_identite_systeme_jeton_valide') ORDER BY p.proname`)).rows;
      R.aclOutbox=(await db.query(`SELECT has_table_privilege('tracefab_worker','public.tracefab_notification_outbox','UPDATE') worker_update,
         has_table_privilege('tracefab_app','public.tracefab_notification_outbox','UPDATE') app_update,
         (SELECT count(*)::int FROM pg_policies WHERE tablename='tracefab_notification_outbox') policies`)).rows[0];
      R.etatInitial=(await db.query(`SELECT status, attempts FROM public.tracefab_notification_outbox WHERE id='${OUT}'`)).rows[0];
      // CLAIM : veritable connexion applicative non superutilisateur
      await db.exec('SET SESSION AUTHORIZATION tracefab_app');
      R.roleApp=(await db.query('SELECT current_user::text cu, session_user::text su')).rows[0];
      let claim=null, complete=null;
      try{
        await db.exec('BEGIN');
        await db.query(`SELECT set_config('tracefab.identity_systeme',$1,true)`,[jetonSysteme()]);
        await db.query(`SELECT set_config('tracefab.identity',$1,true)`,[jetonUser('10000000-0000-4000-8000-000000000002',A)]);
        await db.query(`SELECT set_config('tracefab.active_organization_id',$1,true)`,[A]);
        claim=await db.query(`SELECT id::text, status, attempts FROM public.tracefab_claim_notification_outbox(5)`);
        await db.exec('COMMIT');
        R.claim={ok:true,lignes:claim.rows};
      }catch(e){R.claim={ok:false,erreur:e.message.slice(0,220)};await db.exec('ROLLBACK').catch(()=>{});}
      R.etatApresClaim=(await db.query(`SELECT status, attempts FROM public.tracefab_notification_outbox WHERE id='${OUT}'`)).rows[0];
      if(R.claim.ok && R.claim.lignes.length>0){
        try{
          await db.exec('BEGIN');
          await db.query(`SELECT set_config('tracefab.identity_systeme',$1,true)`,[jetonSysteme()]);
          await db.query(`SELECT public.tracefab_complete_notification_outbox('${OUT}'::uuid,'sent'::public.tracefab_notification_status,NULL,NULL,NULL)`);
          await db.exec('COMMIT');
          R.complete={ok:true};
        }catch(e){R.complete={ok:false,erreur:e.message.slice(0,220)};await db.exec('ROLLBACK').catch(()=>{});}
      } else R.complete={ok:false,erreur:'claim non reussi'};
      R.etatFinal=(await db.query(`SELECT status, attempts, locked_at IS NULL AS deverrouille FROM public.tracefab_notification_outbox WHERE id='${OUT}'`)).rows[0];
      // Témoin négatif : sans jeton systeme en strict
      try{
        await db.exec('BEGIN');
        await db.query(`SELECT set_config('tracefab.identity_systeme','',true)`);
        await db.query(`SELECT public.tracefab_claim_notification_outbox(5)`);
        await db.exec('ROLLBACK');
        R.sansJeton='ACCEPTE (defaut)';
      }catch(e){R.sansJeton=`REFUSE ${e.message.slice(0,90)}`;await db.exec('ROLLBACK').catch(()=>{});}
    }catch(e){R.erreurEpreuve=`${e.message.slice(0,300)}`;}
  }
  await db.close(); fs.rmSync(tmp,{recursive:true,force:true});
  return R;
}
const scenarios=[
  ['S1 #114 seule',['main','#114'],{}],
  ['S2 #111 + #114',['main','#111','#114'],{}],
  ['S3 canonique SANS correctif',['main','#113','#114'],{}],
  ['S3b canonique AVEC correctif',['main','#113','#114'],{correctif:true}],
];
const resultats=[];
for(const [n,r,o] of scenarios){
  const x=await scenario(n,r,o); resultats.push(x);
  console.log(`${x.nom.padEnd(34)} chaine=${x.appliquees}/${x.total} claim=${x.claim?.ok?'PASS':'FAIL'} complete=${x.complete?.ok?'PASS':'FAIL'} sansJeton=${x.sansJeton}`);
  if(x.claim?.erreur) console.log(`    claim : ${x.claim.erreur}`);
}
const artefact=path.join(ROOT,'docs','security','2026-11-06-p107-outbox-scenarios.json');
fs.writeFileSync(artefact,JSON.stringify({schema:'tracefab-p107-outbox-v2',date:new Date().toISOString(),
  environnement:'PGlite / PostgreSQL 18.6 jetable local — role applicatif via SET SESSION AUTHORIZATION',
  tete_114:TETE_114,
  note_tete:'#114 a avance apres la Phase 0 (537bc31 -> f0aeb51). Toutes les epreuves ci-dessous sont REJOUEES sur f0aeb51.',
  avertissement:'Aucune preuve Neon, Preview ou Production. Proprietaire non superutilisateur MODEL explicitement.',
  scenarios:resultats},null,2));
console.log(`\nArtefact : ${artefact}`);
process.exit(0);
