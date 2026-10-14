#!/usr/bin/env node
/**
 * Privilèges SQL — contrôle des ACL applicatives détenues par le rôle de migration et du rôle runtime.
 *
 * Le contrôle inspecte toutes les fonctions applicatives possédées par le rôle de migration
 * pour éviter qu'une migration future réintroduise EXECUTE PUBLIC. Les fonctions
 * d'extensions possédées par un rôle fournisseur (ex. cloud_admin) sont exclues.
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
      where n.nspname = 'public' and p.proname = $1 and p.prokind IN ('f', 'p')`,
    [name],
  );
  return result.rows[0];
};

try {
  console.log('\\n1. Audit — aucune fonction applicative possédée par le rôle de migration ne doit être exécutable par PUBLIC');
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
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
        AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
  );
  const inventory = allFunctions.rows[0];
  if (inventory.total === 0) fail('catalogue : aucune fonction trouvée dans public');
  else pass(`catalogue : ${inventory.total} fonctions, dont ${inventory.security_definer_count} SECURITY DEFINER`);
  if (inventory.public_execute_count === 0) pass('0 routine applicative détenue par le rôle de migration exécutable par PUBLIC');
  else fail(`${inventory.public_execute_count} routine(s) encore exécutable(s) par PUBLIC`);

  console.log('\\n1 bis. Tables, vues, séquences et schéma — aucun privilège PUBLIC excessif');
  const publicRelations = await client.query(
    `SELECT count(*)::int AS exposed
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND c.relacl IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM aclexplode(c.relacl) acl
           WHERE acl.grantee = 0
        )`,
  );
  if (publicRelations.rows[0].exposed === 0) pass('0 privilège PUBLIC sur les tables, vues et séquences');
  else fail(`${publicRelations.rows[0].exposed} relation(s)/séquence(s) ont encore des privilèges PUBLIC`);

  const publicCreate = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
        WHERE n.nspname = 'public'
          AND acl.grantee = 0
          AND acl.privilege_type = 'CREATE'
     ) AS allowed`,
  );
  if (!publicCreate.rows[0].allowed) pass('PUBLIC ne peut pas créer d’objet dans le schéma public');
  else fail('PUBLIC conserve CREATE sur le schéma public');

  if (roleExists.rowCount > 0) {
    const missingRuntime = await client.query(
      `SELECT count(*)::int AS missing
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND NOT has_function_privilege('tracefab_app', p.oid, 'EXECUTE')`,
    );
    if (missingRuntime.rows[0].missing === 0) pass('tracefab_app : EXECUTE effectif sur toutes les routines applicatives détenues par le rôle de migration');
    else fail(`tracefab_app : ${missingRuntime.rows[0].missing} fonction(s) sans EXECUTE effectif`);

    console.log('\\n1 ter. Le retrait de PUBLIC ne doit pas priver tracefab_app des droits relationnels attendus');
    const requiredTablePrivileges = [
      ['organizations', 'SELECT'], ['organizations', 'INSERT'], ['organizations', 'UPDATE'],
      ['users', 'SELECT'], ['users', 'INSERT'], ['users', 'UPDATE'],
      ['organization_memberships', 'SELECT'], ['organization_memberships', 'INSERT'], ['organization_memberships', 'UPDATE'],
      ['tracefab_products', 'SELECT'], ['tracefab_products', 'INSERT'], ['tracefab_products', 'UPDATE'],
      ['documents', 'SELECT'], ['documents', 'INSERT'], ['documents', 'UPDATE'],
      ['suppliers', 'SELECT'], ['suppliers', 'INSERT'], ['suppliers', 'UPDATE'],
    ];
    for (const [table, privilege] of requiredTablePrivileges) {
      const result = await client.query(
        'SELECT to_regclass($1) IS NOT NULL AS exists, ' +
        'CASE WHEN to_regclass($1) IS NULL THEN false ' +
        'ELSE has_table_privilege($2, to_regclass($1), $3) END AS allowed',
        [`public.${table}`, 'tracefab_app', privilege],
      );
      if (!result.rows[0].exists) fail(`${table}: table absente pour le contrôle runtime`);
      else if (!result.rows[0].allowed) fail(`tracefab_app: privilège ${privilege} perdu sur ${table}`);
      else pass(`tracefab_app: ${privilege} conservé sur ${table}`);
    }
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

  console.log('\\n3. Rôle sans grant — les fonctions applicatives du rôle de migration sont inaccessibles');
  const testRole = `tf_priv_test_${process.pid}`;
  await client.query(`create role ${testRole} nologin nosuperuser nobypassrls`);
  try {
    const leaked = await client.query(
      `SELECT count(*)::int AS allowed
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [testRole],
    );
    if (leaked.rows[0].allowed === 0) pass('rôle sans grant : 0 fonction exécutable');
    else fail(`rôle sans grant : ${leaked.rows[0].allowed} fonction(s) restent exécutables`);

    const relationLeak = await client.query(
      `SELECT count(*)::int AS allowed
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND (
            has_table_privilege($1, c.oid, 'SELECT')
            OR has_table_privilege($1, c.oid, 'INSERT')
            OR has_table_privilege($1, c.oid, 'UPDATE')
            OR has_table_privilege($1, c.oid, 'DELETE')
          )`,
      [testRole],
    );
    if (relationLeak.rows[0].allowed === 0) pass('rôle sans grant : aucune table/vue accessible');
    else fail(`rôle sans grant : ${relationLeak.rows[0].allowed} table(s)/vue(s) accessibles`);

    const sequenceLeak = await client.query(
      `SELECT count(*)::int AS allowed
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
          AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND (
            has_sequence_privilege($1, c.oid, 'USAGE')
            OR has_sequence_privilege($1, c.oid, 'SELECT')
            OR has_sequence_privilege($1, c.oid, 'UPDATE')
          )`,
      [testRole],
    );
    if (sequenceLeak.rows[0].allowed === 0) pass('rôle sans grant : aucune séquence accessible');
    else fail(`rôle sans grant : ${sequenceLeak.rows[0].allowed} séquence(s) accessibles`);

    for (const name of NO_PUBLIC) {
      const result = await client.query(
        `select coalesce(bool_or(has_function_privilege($2, p.oid, 'EXECUTE')), false) as allowed
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1 and p.prokind IN ('f', 'p')`,
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
        where n.nspname = 'public' and p.proname = $1 and p.prokind IN ('f', 'p')`,
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
