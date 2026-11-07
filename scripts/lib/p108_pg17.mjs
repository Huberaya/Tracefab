#!/usr/bin/env node
/**
 * P10.8 — socle commun des harnais PostgreSQL 17.11 REEL.
 *
 * Aucune base distante : le harnais ne parle qu'a un PostgreSQL jetable local
 * (CI : service postgres:17 ; local : `scripts/p108_pg17_demarrer.sh`).
 * Les objets sont crees par une connexion d'administration du cluster JETABLE,
 * puis les OPERATIONS METIER sont executees par de VERITABLES connexions
 * `tracefab_app` non superutilisees (jamais `SET ROLE` depuis un superutilisateur).
 *
 * Variables :
 *   TF_P108_PG_URL        URL d'administration (defaut 127.0.0.1:55432/postgres)
 *   TF_P108_ROLE_PASSWORD mot de passe JETABLE des roles de test (jamais un secret)
 *   TF_APP_PASSWORD       mot de passe de `tracefab_app` quand le role existe deja (CI)
 */
import pg from 'pg';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const PG_URL = process.env.TF_P108_PG_URL || 'postgresql://postgres@127.0.0.1:55432/postgres';
export const ROLE_PASSWORD = process.env.TF_P108_ROLE_PASSWORD || 'p108_jetable';
export const APP_PASSWORD = process.env.TF_APP_PASSWORD || ROLE_PASSWORD;
export const MAIN = '788df22019c0d2b39301678ecfbc43ac868561bf';
export const REFS = {
  main: MAIN,
  '#108': 'refs/remotes/audit/pr108',
  '#109': 'refs/remotes/audit/pr109',
  '#110': 'refs/remotes/audit/pr110-nouveau',
  '#110-ancien': 'refs/remotes/audit/pr110',
  '#111': 'refs/remotes/audit/pr111',
  '#112': 'refs/remotes/audit/pr112',
  '#113': 'HEAD',
  '#114': 'refs/remotes/audit/pr114-nouveau',
  '#114-ancien': 'refs/remotes/audit/pr114',
};
export const CORRECTIF_NOM = '20261107120000_p108_outbox_proprietaire_et_dependances';
export const CORRECTIF_CHEMIN = `prisma/migrations/${CORRECTIF_NOM}/migration.sql`;

export function url(db = 'postgres', role = null) {
  const u = new URL(PG_URL);
  u.pathname = `/${db}`;
  if (role) {
    u.username = role;
    // En CI l'URL d'administration porte deja le mot de passe JETABLE du
    // superutilisateur du service postgres:17 : ne PAS l'ecraser. Les roles
    // crees par le harnais, eux, portent ROLE_PASSWORD / APP_PASSWORD.
    if (role === 'tracefab_app') u.password = APP_PASSWORD;
    else if (role === 'tracefab_migrator') u.password = ROLE_PASSWORD;
  }
  return u.toString();
}
export async function connecter(db = 'postgres', role = null) {
  const c = new pg.Client({ connectionString: url(db, role) });
  await c.connect();
  return c;
}
export function sha256(texte) {
  return crypto.createHash('sha256').update(texte).digest('hex');
}
export function migrations(ref) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'prisma/migrations'], { encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(l => l.endsWith('/migration.sql')).map(l => l.split('/')[2]))].sort();
}
export function sqlMigration(ref, dir) {
  return execFileSync('git', ['show', `${ref}:prisma/migrations/${dir}/migration.sql`],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}
/** Compose une chaine : premiers refs gagnants, ordre lexicographique des noms. */
export function composer(refs, extras = []) {
  const map = new Map();
  for (const r of refs) for (const d of migrations(REFS[r] || r)) if (!map.has(d)) map.set(d, REFS[r] || r);
  const entrees = [...map.entries()].map(([d, r]) => ({ nom: d, ref: r, texte: sqlMigration(r, d) }));
  for (const x of extras) entrees.push(x);
  entrees.sort((a, b) => a.nom.localeCompare(b.nom));
  return entrees;
}
export function collisions(entrees) {
  const h = new Map();
  for (const e of entrees) { const t = e.nom.slice(0, 14); h.set(t, (h.get(t) || 0) + 1); }
  return [...h.entries()].filter(([, n]) => n > 1).map(([t, n]) => ({ horodatage: t, n }));
}

/** Cree une base vierge + extensions + roles de test jetables. */
export async function baseVierge(nom) {
  const a = await connecter('postgres');
  try {
    await a.query(`DROP DATABASE IF EXISTS ${nom} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${nom}`);
  } finally { await a.end(); }
  const c = await connecter(nom);
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await c.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    for (const r of ['tracefab_app', 'tracefab_worker', 'tracefab_migrator']) {
      // `tracefab_migrator` modelise le role d'administration d'un PostgreSQL
      // manage (neondb_owner) : NOSUPERUSER / NOBYPASSRLS mais CREATEROLE et
      // CREATE WITH GRANT OPTION sur public, seuls droits qu'exige ALTER OWNER.
      // tracefab_worker est NOLOGIN NOINHERIT : c'est une identite non
      // connectable, exigee par 20261028120100_worker_identity_not_forgeable
      // (postcondition `tracefab_worker_role_not_least_privilege`).
      const attrs = r === 'tracefab_migrator'
        ? 'LOGIN CREATEROLE NOCREATEDB NOINHERIT'
        : r === 'tracefab_app'
          ? 'LOGIN NOCREATEROLE NOCREATEDB NOINHERIT'
          : 'NOLOGIN NOCREATEROLE NOCREATEDB NOINHERIT';
      await c.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${r}') THEN
          CREATE ROLE ${r} PASSWORD '${ROLE_PASSWORD}'
            NOSUPERUSER NOBYPASSRLS ${attrs};
        END IF;
      END $$`);
    }
    // Les roles sont GLOBAUX au cluster jetable : normaliser leurs attributs a
    // chaque base vierge, sinon une base precedente laisserait un worker LOGIN
    // et la postcondition `tracefab_worker_role_not_least_privilege` (#111)
    // echouerait pour une raison unrelated a la chaine etudiee.
    await c.query(`ALTER ROLE tracefab_worker NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
    await c.query(`ALTER ROLE tracefab_migrator LOGIN CREATEROLE NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB`);
    await c.query(`ALTER ROLE tracefab_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
    // En base managee, le role de migration a CREE tracefab_worker (migration
    // 20261028120100) et en detient donc l'ADMIN OPTION : il peut endosser le
    // role, condition exigeee par ALTER OWNER et VERIFIEE par le correctif.
    // On modelise ce fait ici, sans jamais l'accorder au runtime.
    await c.query('GRANT tracefab_worker TO tracefab_migrator WITH ADMIN OPTION');
    await c.query('GRANT USAGE, CREATE ON SCHEMA public TO tracefab_migrator WITH GRANT OPTION');
    await c.query('GRANT USAGE ON SCHEMA public TO tracefab_app, tracefab_worker');
  } finally { await c.end(); }
  return await connecter(nom);
}

/** Applique la chaine en une seule connexion d'administration du cluster jetable. */
export async function appliquer(c, entrees) {
  const appliquees = [];
  for (const e of entrees) {
    try { await c.query(e.texte); appliquees.push({ nom: e.nom, ref: e.ref, sha256: sha256(e.texte) }); }
    catch (err) {
      return { appliquees, echec: { nom: e.nom, ref: e.ref, sqlstate: err.code, message: String(err.message).slice(0, 400) } };
    }
  }
  return { appliquees, echec: null };
}

/**
 * MODELISATION de la forme d'un PostgreSQL manage : les objets crees par le
 * superutilisateur du cluster jetable sont reassignes a `tracefab_migrator`
 * (NOSUPERUSER, NOBYPASSRLS). Sans cela, un superutilisateur proprietaire
 * contournerait RLS et masquerait le defaut de permissions (mesure P10.7).
 * Les membres d'extension (pgcrypto, uuid-ossp) sont exclus.
 * A executer APRES l'insertion des fixtures d'administration.
 */
/**
 * MODELISATION FIDELE de la forme d'un PostgreSQL manage (et de la CI).
 *
 * Deux ensembles d'objets sont volontairement separes, car c'est exactement la
 * configuration d'ACL que #114 declare et que P10.7 a mesuree :
 *
 *   - les TABLES et les 13 OPERATIONS SYSTEME gardees par #114 sont reassignees
 *     a `tracefab_migrator` (NOSUPERUSER, NOBYPASSRLS). Sans cela un
 *     superutilisateur proprietaire contournerait RLS et masquerait le defaut.
 *   - le PREDICAT `tracefab_identite_systeme()`, son VERIFICATEUR HMAC et les
 *     fonctions de pgcrypto restent possedes par l'administrateur du cluster
 *     jetable, avec `REVOKE ALL ... FROM PUBLIC` et `GRANT EXECUTE ... TO
 *     tracefab_worker` poses par #114. L'operation systeme (migrateur) n'a donc
 *     PAS EXECUTE sur le predicat : c'est le 42501 reel, pas une simulation.
 *
 * Ne pas tout transferer au meme role : cela donnerait au proprietaire des
 * operations un droit implicite sur le predicat et masquerait la dependance.
 * Le correctif, lui, transfere les operations a `tracefab_worker`, qui possede
 * exactement les deux droits requis (EXECUTE sur le predicat + politique RLS
 * `current_user='tracefab_worker'`).
 */
export const MODELISATION_PROPRIETAIRE = `
DO $p108_model$ DECLARE r RECORD; BEGIN
  FOR r IN
    SELECT c.oid::regclass AS obj, c.relkind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')
       AND c.relkind IN ('r','p','v','m','S')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE pg_catalog.format('ALTER %s %s OWNER TO tracefab_migrator',
      CASE WHEN r.relkind IN ('r','p') THEN 'TABLE'
           WHEN r.relkind = 'S' THEN 'SEQUENCE'
           WHEN r.relkind = 'v' THEN 'VIEW'
           ELSE 'MATERIALIZED VIEW' END, r.obj);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS f
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
       AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')
       AND p.prosecdef
       AND p.proname IN (
         'tracefab_sync_clerk_membership','tracefab_sync_clerk_organization',
         'tracefab_revoke_clerk_membership','tracefab_upsert_clerk_user',
         'tracefab_ensure_clerk_user','tracefab_soft_delete_clerk_user',
         'tracefab_archive_clerk_organization','tracefab_clerk_organization_uuid',
         'tracefab_notification_outbox_health','tracefab_claim_notification_outbox',
         'tracefab_complete_notification_outbox',
         'tracefab_enqueue_due_data_request_reminders',
         'tracefab_enqueue_manual_data_request_reminder')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_migrator', r.f);
  END LOOP;
END $p108_model$;`;

export const IDS = {
  A: 'a0000000-0000-4000-8000-000000000001',
  B: 'b0000000-0000-4000-8000-000000000002',
  C: 'c0000000-0000-4000-8000-000000000003',
  REL: '50000000-0000-4000-8000-000000000001',
  REQ: '30000000-0000-4000-8000-000000000001',
  OUT: '40000000-0000-4000-8000-000000000001',
  OUT2: '40000000-0000-4000-8000-000000000002',
  OUT3: '40000000-0000-4000-8000-000000000003',
};

export function jetonSysteme(cle, decalage = 60) {
  const corps = `v1|tracefab_system|tracefab_worker|${Math.floor(Date.now() / 1000) + decalage}`;
  return `${corps}.${crypto.createHmac('sha256', cle).update(corps).digest('hex')}`;
}
export function jetonUtilisateur(cle, user, org, decalage = 60) {
  const corps = `v1|${user}|${org}|tracefab_identity|${Math.floor(Date.now() / 1000) + decalage}`;
  return `${corps}.${crypto.createHmac('sha256', cle).update(corps).digest('hex')}`;
}

/** Fixtures d'administration : a inserer AVANT la modelisation du proprietaire. */
export async function fixtures(c, cle, opts = {}) {
  await c.query(`INSERT INTO public.tracefab_identity_cles(version,secret,actif)
    VALUES (99001,$1,true) ON CONFLICT (version) DO UPDATE SET secret=EXCLUDED.secret,actif=true`, [cle]);
  if (opts.strictSysteme !== false) {
    try { await c.query('UPDATE public.tracefab_identity_politique SET systeme_strict=true WHERE singleton'); } catch { /* #114 absent */ }
  }
  await c.query(`INSERT INTO organizations(id,type,legal_name,status) VALUES
    ($1,'brand','Marque A','active'),($2,'supplier','Fournisseur B','active'),($3,'brand','Marque C','active')
    ON CONFLICT (id) DO NOTHING`, [IDS.A, IDS.B, IDS.C]);
  await c.query(`INSERT INTO brand_supplier_relationships(id,brand_organization_id,supplier_organization_id,status)
    VALUES ($1,$2,$3,'active') ON CONFLICT (id) DO NOTHING`, [IDS.REL, IDS.A, IDS.B]);
  await c.query(`INSERT INTO data_requests(id,brand_organization_id,supplier_organization_id,relationship_id,title,questionnaire_key,questionnaire_version,status)
    VALUES ($1,$2,$3,$4,'Demande P10.8','q','1','sent') ON CONFLICT (id) DO NOTHING`, [IDS.REQ, IDS.A, IDS.B, IDS.REL]);
  const lignes = opts.lignes || [
    { id: IDS.OUT, key: 'evt-p108-1', org: IDS.A },
    { id: IDS.OUT2, key: 'evt-p108-2', org: IDS.B },
    { id: IDS.OUT3, key: 'evt-p108-3', org: IDS.A },
  ];
  for (const l of lignes) {
    await c.query(`INSERT INTO tracefab_notification_outbox
      (id,event_key,event_type,request_id,recipient_organization_id,recipient_emails,recipient_name,brand_name,supplier_name,request_title,status,attempts)
      VALUES ($1,$2,'request_sent',$3,$4,ARRAY['x@example.test'],'X','Marque A','Fournisseur B','Demande','pending',0)
      ON CONFLICT (id) DO NOTHING`, [l.id, l.key, IDS.REQ, l.org]);
    await c.query(`UPDATE tracefab_notification_outbox SET status='pending',attempts=0,locked_at=NULL,sent_at=NULL,available_at=now() WHERE id=$1`, [l.id]);
  }
}

/** Etat observable d'une session : prouve l'absence d'elevation artificielle. */
export async function identiteSession(c) {
  const r = await c.query(`SELECT current_user::text cu, session_user::text su,
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) super,
    (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user) bypassrls`);
  return r.rows[0];
}
export async function etatRLS(c) {
  const r = await c.query(`SELECT relrowsecurity rls, relforcerowsecurity force,
    (SELECT count(*)::int FROM pg_catalog.pg_policies WHERE tablename='tracefab_notification_outbox') politiques
    FROM pg_catalog.pg_class WHERE oid='public.tracefab_notification_outbox'::regclass`);
  return r.rows[0];
}

/**
 * SECOND MODELE, plus proche d'une base managee : le role de migration possede
 * TOUS les objets du schema public, y compris les types enum et les fonctions
 * de pgcrypto qu'il a installees. Il sert a deux mesures distinctes :
 *   - la cause racine n°2 : meme quand le predicat est EXECUTABLE (proprietaire
 *     commun), la politique RLS FORCEE `notification_outbox_update_trusted`
 *     exige `current_user='tracefab_worker'` et le claim rend 0 ligne ;
 *   - I2 : application du correctif par un role NON superutilisateur qui
 *     possede reellement les objets sur lesquels il pose des GRANT.
 * Ce modele N'EST PAS utilise pour les reproductions S1/S3 : il masquerait le
 * 42501 sur le predicat (le proprietaire en a implicitement l'EXECUTE).
 */
export const MODELISATION_PROPRIETE_PLEINE = `
DO $p108_plein$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT c.oid::regclass obj, c.relkind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres')
     AND c.relkind IN ('r','p','v','m','S')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  LOOP
    EXECUTE pg_catalog.format('ALTER %s %s OWNER TO tracefab_migrator',
      CASE WHEN r.relkind IN ('r','p') THEN 'TABLE' WHEN r.relkind='S' THEN 'SEQUENCE'
           WHEN r.relkind='v' THEN 'VIEW' ELSE 'MATERIALIZED VIEW' END, r.obj);
  END LOOP;
  FOR r IN SELECT t.oid::regtype ty FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres')
      AND (t.typtype='e' OR t.typtype='c')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
  LOOP
    EXECUTE pg_catalog.format('ALTER TYPE %s OWNER TO tracefab_migrator', r.ty);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure f FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres')
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_migrator', r.f);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure f FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='hmac'
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres')
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO tracefab_migrator', r.f);
  END LOOP;
END $p108_plein$;`;
