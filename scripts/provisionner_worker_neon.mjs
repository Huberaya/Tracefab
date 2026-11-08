#!/usr/bin/env node
/**
 * Préflight Neon : isole le rôle worker du grant ADMIN OPTION géré par Neon.
 *
 * Neon accorde automatiquement au créateur d'un rôle une appartenance
 * cloud_admin avec ADMIN OPTION, INHERIT=false et SET=false. Le rôle worker
 * historique ne peut donc pas être utilisé directement comme rôle temporaire
 * du migrateur sans lui laisser une capacité de délégation.
 *
 * Cette opération :
 *   1. renomme l'ancien rôle en tracefab_worker_legacy ;
 *   2. crée tracefab_worker sous neondb_owner (grant cloud_admin à l'admin,
 *      jamais au migrateur) ;
 *   3. transfère les 10 fonctions propriétaires et recopie les ACL utiles ;
 *   4. rend l'ancien rôle inerte (aucun objet, ACL ou privilège de schéma) ;
 *   5. retire les appartenances temporaires.
 *
 * N'altère PAS _prisma_migrations et n'applique aucune migration.
 *
 * Usage :
 *   node scripts/provisionner_worker_neon.mjs --etat
 *   TF_ALLOW_WORKER_ROLE_SWAP=oui node scripts/provisionner_worker_neon.mjs --appliquer
 *
 * Production exige en plus TF_ALLOW_PRODUCTION_ROLE_SWAP=oui.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const { Client } = pg;
const urlMigrateur = process.env.DATABASE_URL;
const urlAdmin = process.env.TF_ADMIN_URL;
const etatSeulement = process.argv.includes('--etat');
const appliquer = process.argv.includes('--appliquer');
const hotesProduction = (process.env.TF_PRODUCTION_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);

function refuser(message) {
  throw new Error(message);
}
function identifiant(s) {
  return '"' + String(s).replaceAll('"', '""') + '"';
}
function verifRole(rows, attendu, etiquette) {
  if (rows.length !== 1 || rows[0].current_user !== attendu) {
    refuser(`${etiquette} : connexion attendue en ${attendu}, reçue ${rows[0]?.current_user ?? 'aucune'}.`);
  }
}
function valeur(rows, cle) {
  return Number(rows[0]?.[cle] ?? 0);
}

if (!urlMigrateur || !urlAdmin) {
  console.error('REFUS — DATABASE_URL et TF_ADMIN_URL sont obligatoires.');
  process.exit(2);
}
if (!etatSeulement && !appliquer) {
  console.error('Usage : --etat ou --appliquer.');
  process.exit(2);
}
if (appliquer && process.env.TF_ALLOW_WORKER_ROLE_SWAP !== 'oui') {
  console.error('REFUS — définir TF_ALLOW_WORKER_ROLE_SWAP=oui pour autoriser cette opération de rôles.');
  process.exit(2);
}

let uM, uA;
try { uM = new URL(urlMigrateur); uA = new URL(urlAdmin); } catch {
  console.error('REFUS — URL PostgreSQL invalide.');
  process.exit(2);
}
if (uM.hostname !== uA.hostname || uM.pathname !== uA.pathname) {
  console.error('REFUS — DATABASE_URL et TF_ADMIN_URL doivent viser le même hôte et la même base.');
  process.exit(2);
}
if (appliquer) {
  if (process.env.TF_EXPECTED_DATABASE_HOST !== uM.hostname || process.env.TF_EXPECTED_DATABASE_NAME !== uM.pathname.replace(/^\//, '')) {
    console.error('REFUS — TF_EXPECTED_DATABASE_HOST et TF_EXPECTED_DATABASE_NAME doivent confirmer explicitement la cible.');
    process.exit(3);
  }
  if (!process.env.TF_PRODUCTION_HOSTS) {
    console.error('REFUS — fournir TF_PRODUCTION_HOSTS (liste séparée par des virgules) pour protéger explicitement Production.');
    process.exit(3);
  }
  if (uM.hostname.includes('-pooler')) {
    console.error('REFUS — utiliser les URLs directes Neon, pas le pooler, pour conserver les verrous de session.');
    process.exit(3);
  }
  if (hotesProduction.includes(uM.hostname) && process.env.TF_ALLOW_PRODUCTION_ROLE_SWAP !== 'oui') {
    console.error('REFUS — cible Production. Un GO spécifique TF_ALLOW_PRODUCTION_ROLE_SWAP=oui est requis.');
    process.exit(3);
  }
}

const migrateur = new Client({ connectionString: urlMigrateur, ssl: sslDepuisUrl(urlMigrateur) });
const admin = new Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin) });

async function role(c, nom) {
  const r = await c.query(
    `SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit
       FROM pg_catalog.pg_roles WHERE rolname=$1`, [nom],
  );
  return r.rows[0] ?? null;
}
async function membership(c, membre, roleNom) {
  return (await c.query(
    `SELECT x.grantor::regrole::text AS grantor,x.admin_option,x.inherit_option,x.set_option
       FROM pg_catalog.pg_auth_members x
       JOIN pg_catalog.pg_roles m ON m.oid=x.member
       JOIN pg_catalog.pg_roles r ON r.oid=x.roleid
      WHERE m.rolname=$1 AND r.rolname=$2`, [membre, roleNom],
  )).rows;
}
async function compte(c, sql) {
  const r = await c.query(sql);
  return valeur(r.rows, 'n');
}
async function etatFinal(c) {
  const legacy = await role(c, 'tracefab_worker_legacy');
  const worker = await role(c, 'tracefab_worker');
  if (!legacy || !worker) return { final: false, legacy, worker };
  const owned = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_shdepend WHERE refobjid='tracefab_worker_legacy'::regrole AND deptype='o'`);
  const tableAcl = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee='tracefab_worker_legacy'::regrole`);
  const functionAcl = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee='tracefab_worker_legacy'::regrole`);
  const sequenceAcl = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('S',c.relowner))) a WHERE c.relkind='S' AND a.grantee='tracefab_worker_legacy'::regrole`);
  const typeAcl = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_type t CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a WHERE t.typacl IS NOT NULL AND a.grantee='tracefab_worker_legacy'::regrole`);
  const schemaAcl = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE a.grantee='tracefab_worker_legacy'::regrole`);
  const defaultAcl = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_default_acl WHERE defaclrole='tracefab_worker_legacy'::regrole`);
  const externalAcl = await compte(c, `SELECT (SELECT count(*) FROM pg_catalog.pg_database WHERE datacl::text LIKE '%tracefab_worker_legacy%') + (SELECT count(*) FROM pg_catalog.pg_language WHERE lanacl::text LIKE '%tracefab_worker_legacy%') + (SELECT count(*) FROM pg_catalog.pg_foreign_server WHERE srvacl::text LIKE '%tracefab_worker_legacy%') + (SELECT count(*) FROM pg_catalog.pg_foreign_data_wrapper WHERE fdwacl::text LIKE '%tracefab_worker_legacy%') + (SELECT count(*) FROM pg_catalog.pg_largeobject_metadata WHERE lomacl::text LIKE '%tracefab_worker_legacy%') + (SELECT count(*) FROM pg_catalog.pg_parameter_acl WHERE paracl::text LIKE '%tracefab_worker_legacy%') AS n`);
  const memberships = await membership(c, 'tracefab_migrator', 'tracefab_worker_legacy');
  const newMembership = await membership(c, 'tracefab_migrator', 'tracefab_worker');
  const appNew = await membership(c, 'tracefab_app', 'tracefab_worker');
  const appLegacy = await membership(c, 'tracefab_app', 'tracefab_worker_legacy');
  const migratorLegacySet = (await c.query(`SELECT pg_has_role('tracefab_migrator','tracefab_worker_legacy','SET') AS b`)).rows[0].b;
  const migratorLegacyUsage = (await c.query(`SELECT pg_has_role('tracefab_migrator','tracefab_worker_legacy','USAGE') AS b`)).rows[0].b;
  const newOwned = await compte(c, `SELECT count(*)::int n FROM pg_catalog.pg_shdepend WHERE refobjid='tracefab_worker'::regrole AND deptype='o'`);
  const workerCreate = (await c.query(`SELECT has_schema_privilege('tracefab_worker','public','CREATE') AS b`)).rows[0].b;
  const safeAttrs = !worker.rolcanlogin && !worker.rolsuper && !worker.rolbypassrls
    && !worker.rolcreaterole && !worker.rolcreatedb && !worker.rolreplication && !worker.rolinherit;
  const legacySafe = !legacy.rolcanlogin && !legacy.rolsuper && !legacy.rolbypassrls
    && !legacy.rolcreaterole && !legacy.rolcreatedb && !legacy.rolreplication && !legacy.rolinherit;
  const cloudGrant = memberships.length === 1
    && memberships[0].grantor === 'cloud_admin'
    && memberships[0].admin_option === true
    && memberships[0].inherit_option === false
    && memberships[0].set_option === false;
  return {
    final: owned === 0 && tableAcl === 0 && functionAcl === 0 && sequenceAcl === 0
      && typeAcl === 0 && schemaAcl === 0 && defaultAcl === 0 && externalAcl === 0 && cloudGrant && newMembership.length === 0
      && appNew.length === 0 && appLegacy.length === 0 && !migratorLegacySet
      && !migratorLegacyUsage && safeAttrs && legacySafe && !workerCreate && newOwned > 0,
    owned, tableAcl, functionAcl, sequenceAcl, typeAcl, schemaAcl, defaultAcl, externalAcl,
    memberships, newMembership, appNew, appLegacy, migratorLegacySet,
    migratorLegacyUsage, newOwned, workerCreate, safeAttrs, legacySafe,
    workerAttrs: { login: worker.rolcanlogin, superuser: worker.rolsuper, bypassRls: worker.rolbypassrls, createRole: worker.rolcreaterole, createDb: worker.rolcreatedb, replication: worker.rolreplication, inherit: worker.rolinherit },
    legacyAttrs: { login: legacy.rolcanlogin, superuser: legacy.rolsuper, bypassRls: legacy.rolbypassrls, createRole: legacy.rolcreaterole, createDb: legacy.rolcreatedb, replication: legacy.rolreplication, inherit: legacy.rolinherit },
  };
}

async function verifierEtat(c) {
  const s = await etatFinal(c);
  console.log(JSON.stringify(s, null, 2));
  return s.final;
}

async function assurerMembership(c, membre, roleNom, options, grantor) {
  const rows = await membership(c, membre, roleNom);
  const ok = rows.some(x => x.grantor === grantor
    && x.admin_option === options.admin
    && x.inherit_option === options.inherit
    && x.set_option === options.set);
  if (!ok) {
    await c.query(`GRANT ${identifiant(roleNom)} TO ${identifiant(membre)} WITH ADMIN ${options.admin ? 'TRUE' : 'FALSE'}, INHERIT ${options.inherit ? 'TRUE' : 'FALSE'}, SET ${options.set ? 'TRUE' : 'FALSE'}`);
  }
}

async function copierAclEtTransferrer() {
  await migrateur.query('GRANT CREATE ON SCHEMA public TO tracefab_worker');
  await migrateur.query('BEGIN');
  try {
    await migrateur.query('SET LOCAL ROLE tracefab_worker_legacy');
    const fonctions = await migrateur.query(
      `SELECT p.oid::regprocedure::text AS signature
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proowner='tracefab_worker_legacy'::regrole
        ORDER BY p.proname`,
    );
    for (const f of fonctions.rows) {
      await migrateur.query(`ALTER FUNCTION ${f.signature} OWNER TO tracefab_worker`);
    }
    await migrateur.query('RESET ROLE');

    const tables = await migrateur.query(
      `SELECT n.nspname,c.relname,a.privilege_type,bool_or(a.is_grantable) AS grantable
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
          AND a.grantee='tracefab_worker_legacy'::regrole
        GROUP BY n.nspname,c.relname,a.privilege_type ORDER BY c.relname,a.privilege_type`,
    );
    for (const r of tables.rows) {
      const obj = `${identifiant(r.nspname)}.${identifiant(r.relname)}`;
      const grant = `GRANT ${r.privilege_type} ON TABLE ${obj} TO tracefab_worker${r.grantable ? ' WITH GRANT OPTION' : ''}`;
      const revoke = `REVOKE ${r.privilege_type} ON TABLE ${obj} FROM tracefab_worker_legacy`;
      await migrateur.query(grant);
      await migrateur.query(revoke);
    }

    const fonctionsAcl = await migrateur.query(
      `SELECT p.oid::regprocedure::text AS signature,a.privilege_type,bool_or(a.is_grantable) AS grantable
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE n.nspname='public' AND a.grantee='tracefab_worker_legacy'::regrole
        GROUP BY p.oid,a.privilege_type ORDER BY p.proname,a.privilege_type`,
    );
    for (const r of fonctionsAcl.rows) {
      await migrateur.query(`GRANT ${r.privilege_type} ON FUNCTION ${r.signature} TO tracefab_worker${r.grantable ? ' WITH GRANT OPTION' : ''}`);
      await migrateur.query(`REVOKE ${r.privilege_type} ON FUNCTION ${r.signature} FROM tracefab_worker_legacy`);
    }

    const sequences = await migrateur.query(
      `SELECT n.nspname,c.relname,a.privilege_type,bool_or(a.is_grantable) AS grantable
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('S',c.relowner))) a
        WHERE n.nspname='public' AND c.relkind='S' AND a.grantee='tracefab_worker_legacy'::regrole
        GROUP BY n.nspname,c.relname,a.privilege_type ORDER BY c.relname,a.privilege_type`,
    );
    for (const r of sequences.rows) {
      const obj = `${identifiant(r.nspname)}.${identifiant(r.relname)}`;
      await migrateur.query(`GRANT ${r.privilege_type} ON SEQUENCE ${obj} TO tracefab_worker${r.grantable ? ' WITH GRANT OPTION' : ''}`);
      await migrateur.query(`REVOKE ${r.privilege_type} ON SEQUENCE ${obj} FROM tracefab_worker_legacy`);
    }

    const types = await migrateur.query(
      `SELECT n.nspname,t.typname,a.privilege_type,bool_or(a.is_grantable) AS grantable
         FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
        WHERE n.nspname='public' AND t.typacl IS NOT NULL
          AND a.grantee='tracefab_worker_legacy'::regrole
        GROUP BY n.nspname,t.typname,a.privilege_type ORDER BY t.typname,a.privilege_type`,
    );
    for (const r of types.rows) {
      const obj = `${identifiant(r.nspname)}.${identifiant(r.typname)}`;
      await migrateur.query(`GRANT ${r.privilege_type} ON TYPE ${obj} TO tracefab_worker${r.grantable ? ' WITH GRANT OPTION' : ''}`);
      await migrateur.query(`REVOKE ${r.privilege_type} ON TYPE ${obj} FROM tracefab_worker_legacy`);
    }

    await migrateur.query('REVOKE ALL ON SCHEMA public FROM tracefab_worker_legacy');
    await migrateur.query('REVOKE CREATE ON SCHEMA public FROM tracefab_worker');
    const s = await etatFinal(migrateur);
    if (s.owned || s.tableAcl || s.functionAcl || s.sequenceAcl || s.typeAcl || s.schemaAcl || s.defaultAcl || s.externalAcl) {
      refuser('Le rôle legacy conserve des objets ou ACL ; transaction annulée.');
    }
    await migrateur.query('COMMIT');
    console.log(`transfert vérifié : ${fonctions.rows.length} fonction(s) propriétaire(s), ${tables.rows.length} table/ACL, ${fonctionsAcl.rows.length} fonction/ACL, ${sequences.rows.length} séquence/ACL, ${types.rows.length} type/ACL.`);
  } catch (e) {
    try { await migrateur.query('ROLLBACK'); } catch {}
    throw e;
  }
}

async function main() {
  await migrateur.connect();
  await admin.connect();
  const m = await migrateur.query('SELECT current_user');
  const a = await admin.query('SELECT current_user');
  verifRole(m.rows, 'tracefab_migrator', 'DATABASE_URL');
  verifRole(a.rows, 'neondb_owner', 'TF_ADMIN_URL');

  const worker = await role(admin, 'tracefab_worker');
  const legacy = await role(admin, 'tracefab_worker_legacy');
  if (!worker && !legacy) refuser('Aucun rôle tracefab_worker trouvé.');
  if (etatSeulement) {
    console.log('État initial :');
    const final = await verifierEtat(admin);
    if (!final) {
      console.error(legacy ? 'Préflight partiel ou non conforme.' : 'Préflight Neon requis : ancien worker à isoler.');
      process.exitCode = 2;
    } else {
      console.log('OK — préflight Neon vérifié, aucune écriture effectuée.');
    }
    return;
  }

  if (process.env.TF_ALLOW_WORKER_ROLE_SWAP !== 'oui') refuser('TF_ALLOW_WORKER_ROLE_SWAP=oui requis.');
  if (!legacy) {
    if (!worker) refuser('tracefab_worker absent avant renommage.');
    if (worker.rolcanlogin || worker.rolsuper || worker.rolbypassrls || worker.rolcreaterole || worker.rolcreatedb || worker.rolreplication) {
      refuser('Le rôle worker historique possède des attributs inattendus ; arrêt avant renommage.');
    }
    const ownership = await admin.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE d.classid='pg_catalog.pg_proc'::regclass AND n.nspname='public')::int AS public_functions
         FROM pg_catalog.pg_shdepend d
         LEFT JOIN pg_catalog.pg_proc p ON d.classid='pg_catalog.pg_proc'::regclass AND p.oid=d.objid
         LEFT JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE d.refobjid='tracefab_worker'::regrole AND d.deptype='o'`,
    );
    if (Number(ownership.rows[0].total) !== Number(ownership.rows[0].public_functions)) {
      refuser('Le worker historique possède des objets hors fonctions public ; traitement manuel requis.');
    }
    const aclHorsPublic = await admin.query(
      `SELECT (
          SELECT count(*) FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
          WHERE n.nspname <> 'public' AND a.grantee='tracefab_worker'::regrole
        ) + (
          SELECT count(*) FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE n.nspname <> 'public' AND a.grantee='tracefab_worker'::regrole
        ) + (
          SELECT count(*) FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
          WHERE n.nspname <> 'public' AND a.grantee='tracefab_worker'::regrole
        ) + (
          SELECT count(*) FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
          WHERE n.nspname <> 'public' AND t.typacl IS NOT NULL AND a.grantee='tracefab_worker'::regrole
        ) + (
          SELECT count(*) FROM pg_catalog.pg_default_acl WHERE defaclrole='tracefab_worker'::regrole
        ) + (
          SELECT count(*) FROM pg_catalog.pg_database WHERE datacl::text LIKE '%tracefab_worker%'
        ) + (
          SELECT count(*) FROM pg_catalog.pg_language WHERE lanacl::text LIKE '%tracefab_worker%'
        ) + (
          SELECT count(*) FROM pg_catalog.pg_foreign_server WHERE srvacl::text LIKE '%tracefab_worker%'
        ) + (
          SELECT count(*) FROM pg_catalog.pg_foreign_data_wrapper WHERE fdwacl::text LIKE '%tracefab_worker%'
        ) + (
          SELECT count(*) FROM pg_catalog.pg_largeobject_metadata WHERE lomacl::text LIKE '%tracefab_worker%'
        ) + (
          SELECT count(*) FROM pg_catalog.pg_parameter_acl WHERE paracl::text LIKE '%tracefab_worker%'
        ) AS n`,
    );
    if (Number(aclHorsPublic.rows[0].n) !== 0) {
      refuser('Le worker historique possède des ACL hors public ou des privilèges par défaut ; arrêt avant renommage.');
    }
    const rows = await membership(admin, 'tracefab_migrator', 'tracefab_worker');
    if (!rows.some(x => x.grantor === 'cloud_admin' && x.admin_option && !x.inherit_option && !x.set_option)) {
      refuser("L'appartenance cloud_admin attendue du migrateur n'est pas présente ; arrêt.");
    }
    await migrateur.query('GRANT tracefab_worker TO neondb_owner WITH ADMIN OPTION, INHERIT FALSE, SET FALSE');
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER ROLE tracefab_worker RENAME TO tracefab_worker_legacy');
      await admin.query('CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT');
      await admin.query('ALTER ROLE tracefab_worker_legacy NOINHERIT');
      await admin.query('COMMIT');
    } catch (e) {
      try { await admin.query('ROLLBACK'); } catch {}
      try { await migrateur.query('REVOKE tracefab_worker FROM neondb_owner'); } catch {}
      throw e;
    }
  } else if (!worker) {
    await admin.query('CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT');
  }
  await admin.query('ALTER ROLE tracefab_worker NOINHERIT');
  await admin.query('ALTER ROLE tracefab_worker_legacy NOINHERIT');

  // Relais temporaire : le migrateur peut déléguer l'ancien rôle inerte à
  // l'administrateur, qui accorde ensuite SET au migrateur sans ADMIN OPTION.
  const relay = await membership(migrateur, 'neondb_owner', 'tracefab_worker_legacy');
  if (!relay.some(x => x.grantor === 'tracefab_migrator' && x.admin_option && !x.inherit_option && !x.set_option)) {
    await migrateur.query('GRANT tracefab_worker_legacy TO neondb_owner WITH ADMIN OPTION, INHERIT FALSE, SET FALSE');
  }
  await assurerMembership(admin, 'tracefab_migrator', 'tracefab_worker',
    { admin: false, inherit: false, set: true }, 'neondb_owner');
  await assurerMembership(admin, 'tracefab_migrator', 'tracefab_worker_legacy',
    { admin: false, inherit: false, set: true }, 'neondb_owner');
  await assurerMembership(admin, 'tracefab_worker_legacy', 'tracefab_worker',
    { admin: false, inherit: false, set: true }, 'neondb_owner');

  await copierAclEtTransferrer();

  await admin.query('BEGIN');
  try {
    await admin.query('REVOKE tracefab_worker FROM tracefab_migrator');
    await admin.query('REVOKE tracefab_worker_legacy FROM tracefab_migrator');
    await admin.query('REVOKE tracefab_worker FROM tracefab_worker_legacy');
    await admin.query('COMMIT');
  } catch (e) {
    try { await admin.query('ROLLBACK'); } catch {}
    throw e;
  }
  await migrateur.query('REVOKE tracefab_worker_legacy FROM neondb_owner');

  const ok = await verifierEtat(admin);
  if (!ok) refuser('État final non conforme ; aucune migration applicative ne doit être lancée.');
  console.log('OK — ancien rôle neutralisé, nouveau worker minimal, aucune appartenance permanente du migrateur.');
}

main().catch(e => {
  console.error(`ECHEC — ${e.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try { await migrateur.end(); } catch {}
  try { await admin.end(); } catch {}
});
