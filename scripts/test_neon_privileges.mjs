#!/usr/bin/env node
/**
 * Privilèges des fonctions SQL — contrôle intégral des ACL et du rôle runtime.
 *
 * Le contrôle inspecte toutes les fonctions du schéma public pour éviter
 * qu'une migration future réintroduise EXECUTE PUBLIC sur une fonction.
 * Exécution après migrations et avant le seed, sur PostgreSQL jetable.
 */
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('NON EXECUTE — DATABASE_URL manquant.');
  process.exit(2);
}

const NO_PUBLIC = [
  'tracefab_material_visible_via_product',
  'tracefab_public_context',
  'tracefab_product_is_public',
  'tracefab_material_is_public',
  'tracefab_supplier_site_is_public',
  'tracefab_public_brand',
  'tracefab_can_access_org',
  'tracefab_is_org_member',
  'tracefab_has_org_role',
  'tracefab_can_access_shared_subject',
  'tracefab_can_access_document',
  'tracefab_validate_subject_ownership',
  'tracefab_validate_membership_mutation',
  'tracefab_validate_relationship_organizations',
  'tracefab_validate_document_location',
  'tracefab_validate_share_relationship',
];
const SECURITY_DEFINER = NO_PUBLIC.filter((name) => name !== 'tracefab_public_context');
const APP_EXECUTE_REQUIRED = [
  'tracefab_material_visible_via_product',
  'tracefab_public_context',
  'tracefab_product_is_public',
  'tracefab_material_is_public',
  'tracefab_supplier_site_is_public',
  'tracefab_public_brand',
  'tracefab_can_access_org',
  'tracefab_is_org_member',
  'tracefab_has_org_role',
  'tracefab_can_access_shared_subject',
  'tracefab_can_access_document',
];
const TRIGGER_GUARDS = [
  'tracefab_validate_subject_ownership',
  'tracefab_validate_membership_mutation',
  'tracefab_validate_relationship_organizations',
  'tracefab_validate_document_location',
  'tracefab_validate_share_relationship',
];

let failures = 0;
let assertions = 0;
const fail = (message) => { failures += 1; assertions += 1; console.log(`  ECHEC ${message}`); };
const pass = (message) => { assertions += 1; console.log(`  ok    ${message}`); };
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : false,
});
await client.connect();

const roleExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app'");
if (roleExists.rowCount === 0) fail('tracefab_app : rôle runtime absent avant le test des privilèges');

const catalogue = async (name) => {
  const result = await client.query(
    `select count(*)::int as count,
            coalesce(bool_or(exists (
              select 1 from aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'
            )), false) as public_execute,
            coalesce(bool_and(p.prosecdef), false) as all_security_definer
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
    [name],
  );
  return result.rows[0];
};

try {
  console.log('\\n1. Audit exhaustif — aucune fonction du schéma public ne doit être exécutable par PUBLIC');
  const allFunctions = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1
                FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
               WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ))::int AS public_execute_count,
            count(*) FILTER (WHERE p.prosecdef)::int AS security_definer_count
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'`,
  );
  const inventory = allFunctions.rows[0];
  if (inventory.total === 0) fail('catalogue : aucune fonction trouvée dans public');
  else pass(`catalogue : ${inventory.total} fonctions, dont ${inventory.security_definer_count} SECURITY DEFINER`);
  if (inventory.public_execute_count === 0) pass('0 fonction du schéma public exécutable par PUBLIC');
  else fail(`${inventory.public_execute_count} fonction(s) encore exécutable(s) par PUBLIC`);

  if (roleExists.rowCount > 0) {
    const missingRuntime = await client.query(
      `SELECT count(*)::int AS missing
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND NOT has_function_privilege('tracefab_app', p.oid, 'EXECUTE')`,
    );
    if (missingRuntime.rows[0].missing === 0) pass('tracefab_app : EXECUTE effectif sur toutes les fonctions du schéma public');
    else fail(`tracefab_app : ${missingRuntime.rows[0].missing} fonction(s) sans EXECUTE effectif`);
  }

  console.log('\\n2. Fonctions sensibles connues — contrôle ciblé de non-régression');
  for (const name of NO_PUBLIC) {
    const info = await catalogue(name);
    if (info.count === 0) {
      fail(`${name} : fonction absente`);
      continue;
    }
    if (info.public_execute) fail(`${name} : EXECUTE PUBLIC est encore accordé`);
    else pass(`${name} : EXECUTE PUBLIC révoqué`);
    if (SECURITY_DEFINER.includes(name)) {
      if (info.all_security_definer) pass(`${name} : SECURITY DEFINER confirmé`);
      else fail(`${name} : signature attendue SECURITY DEFINER non confirmée`);
    }
  }

  console.log('\\n3. Rôle sans grant — toutes les fonctions sont inaccessibles');
  const testRole = `tf_priv_test_${process.pid}`;
  await client.query(`create role ${testRole} nologin nosuperuser nobypassrls`);
  try {
    const leaked = await client.query(
      `SELECT count(*)::int AS allowed
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [testRole],
    );
    if (leaked.rows[0].allowed === 0) pass('rôle sans grant : 0 fonction exécutable');
    else fail(`rôle sans grant : ${leaked.rows[0].allowed} fonction(s) restent exécutables`);
    for (const name of NO_PUBLIC) {
      const result = await client.query(
        `select coalesce(bool_or(has_function_privilege($2, p.oid, 'EXECUTE')), false) as allowed
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
        [name, testRole],
      );
      if (result.rows[0].allowed) fail(`${name} : exécutable par un rôle sans grant`);
      else pass(`${name} : refusée à un rôle sans grant`);
    }
  } finally {
    await client.query(`drop role if exists ${testRole}`);
  }

  console.log('\\n4. Rôle applicatif — les politiques et routes conservent EXECUTE');
  for (const name of APP_EXECUTE_REQUIRED) {
    const result = await client.query(
      `select count(*)::int as count,
              coalesce(bool_and(has_function_privilege('tracefab_app', p.oid, 'EXECUTE')), false) as allowed
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
      [name],
    );
    if (result.rows[0].count === 0) fail(`${name} : fonction absente`);
    else if (!result.rows[0].allowed) fail(`${name} : tracefab_app n'a pas EXECUTE — la politique RLS serait cassée`);
    else pass(`${name} : EXECUTE accordé à tracefab_app sans dépendre de PUBLIC`);
  }

  console.log('\\n5. Fonctions de déclencheur — présentes et non exposées à PUBLIC');
  for (const name of TRIGGER_GUARDS) {
    const info = await catalogue(name);
    if (info.count === 0) fail(`${name} : fonction de déclencheur absente`);
    else if (!info.all_security_definer) fail(`${name} : SECURITY DEFINER non confirmé`);
    else if (info.public_execute) fail(`${name} : fonction de déclencheur encore exposée à PUBLIC`);
    else pass(`${name} : garde SECURITY DEFINER présente et non publique`);
  }
} finally {
  await client.end();
}

console.log(`\\n${assertions - failures}/${assertions} assertions — ACL des fonctions SQL contrôlées.`);
process.exit(failures ? 1 : 0);
