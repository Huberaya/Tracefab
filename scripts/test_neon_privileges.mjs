#!/usr/bin/env node
/**
 * Privileges des fonctions SQL sensibles — contrôle des ACL et du rôle runtime.
 *
 * Les politiques RLS évaluent leurs fonctions au nom du rôle qui exécute la
 * requête. Elles ont donc besoin d'un GRANT EXECUTE explicite à tracefab_app,
 * pas d'un EXECUTE PUBLIC. Les fonctions de déclencheur, elles, n'ont pas besoin
 * d'être appelables directement par PUBLIC : PostgreSQL vérifie les droits lors
 * de la création du trigger, pas à chaque déclenchement.
 *
 * Ce test s'exécute après les migrations et AVANT le seed applicatif, sur une
 * base PostgreSQL jetable. Le rôle tracefab_app doit donc déjà exister pour
 * tester réellement les GRANT conditionnels des migrations.
 *
 * Sans DATABASE_URL ou si les fonctions/permissions ne sont pas mesurables,
 * le test échoue : une absence de preuve n'est pas un succès.
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

const RLS_PREDICATES = [
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

const catalogue = async (name) => {
  const result = await client.query(
    `select count(*)::int as count,
            coalesce(bool_or(p.proacl is null
              or exists (select 1 from aclexplode(p.proacl) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
              false) as public_execute,
            coalesce(bool_and(p.prosecdef), false) as all_security_definer
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
    [name],
  );
  return result.rows[0];
};

try {
  console.log('\n1. Catalogue — fonctions sensibles présentes, sans EXECUTE PUBLIC');
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

  console.log('\n2. Rôle sans grant — les fonctions sensibles sont inaccessibles');
  const testRole = `tf_priv_test_${process.pid}`;
  await client.query(`create role ${testRole} nologin nosuperuser nobypassrls`);
  try {
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

  console.log('\n3. Rôle applicatif — les prédicats RLS ont un GRANT explicite');
  for (const name of RLS_PREDICATES) {
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

  console.log('\n4. Fonctions de déclencheur — présentes et non exposées à PUBLIC');
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

console.log(`\n${assertions - failures}/${assertions} assertions — ACL des fonctions sensibles contrôlées.`);
process.exit(failures ? 1 : 0);
