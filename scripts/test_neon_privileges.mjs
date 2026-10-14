#!/usr/bin/env node
/**
 * Privilèges des fonctions SECURITY DEFINER — preuve par le catalogue.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Une fonction SECURITY DEFINER s'exécute avec les privilèges de son
 * propriétaire : elle contourne la RLS par construction. C'est voulu pour
 * les prédicats des politiques et les gardes des déclencheurs, mais si une
 * telle fonction garde son exécution PUBLIC, n'importe quel rôle de la base
 * peut l'invoquer directement et court-circuiter l'isolation.
 *
 * PostgreSQL accorde EXECUTE à PUBLIC par défaut (proacl NULL). Les
 * migrations historiques ajoutaient en plus des GRANT ... TO PUBLIC
 * explicites. Les migrations 20261014100000 et 20261014110000 révoquent ce
 * droit sur les fonctions sensibles ; ce test prouve que la révocation est
 * effective dans le catalogue, et qu'elle n'a pas cassé ce qui doit rester
 * public (prédicats RLS, gardes de déclencheurs).
 *
 * CE QU'IL VÉRIFIE — 22 assertions
 *
 *   1-6.   Catalogue : les 6 fonctions révoquées n'accordent plus EXECUTE à PUBLIC.
 *   7-12.  Un rôle neuf, sans aucun grant, ne peut exécuter aucune des 6.
 *   13-17. Les 5 prédicats de lecture utilisés par les politiques RLS gardent
 *          PUBLIC EXECUTE — sans eux, les politiques elles-mêmes échouent.
 *   18-22. Les 5 gardes de validation appelés par les déclencheurs gardent
 *          PUBLIC EXECUTE.
 *
 * IL NE PASSE PAS QUAND IL NE PEUT PAS S'EXÉCUTER : sans DATABASE_URL,
 * sortie 2. Un test qui n'a pas tourné n'est pas un test qui passe.
 */
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('  NON EXECUTE — DATABASE_URL manquant.');
  console.error('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

// Fonctions dont les migrations 20261014100000 / 20261014110000 révoquent PUBLIC :
// le détour produit de materials, puis les 5 fonctions de contexte public de
// la migration 20261009180000. tracefab_app reçoit un GRANT explicite.
const REVOQUEES = [
  'tracefab_material_visible_via_product',
  'tracefab_public_context',
  'tracefab_product_is_public',
  'tracefab_material_is_public',
  'tracefab_supplier_site_is_public',
  'tracefab_public_brand',
];

// Prédicats SECURITY DEFINER évalués par les politiques RLS au nom de
// l'appelant : ils doivent rester exécutables par PUBLIC.
const PREDICATS_RLS = [
  'tracefab_can_access_org',
  'tracefab_is_org_member',
  'tracefab_has_org_role',
  'tracefab_can_access_shared_subject',
  'tracefab_can_access_document',
];

// Gardes SECURITY DEFINER invoqués par les déclencheurs de validation.
const GARDES_TRIGGER = [
  'tracefab_validate_subject_ownership',
  'tracefab_validate_membership_mutation',
  'tracefab_validate_relationship_organizations',
  'tracefab_validate_document_location',
  'tracefab_validate_share_relationship',
];

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const cli = new pg.Client({
  connectionString: databaseUrl,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : false,
});
await cli.connect();

// PUBLIC est le pseudo-rôle grantee = 0 dans les ACL. proacl NULL vaut
// « défaut » : EXECUTE accordé à PUBLIC. bool_or couvre les surcharges.
const catalogue = async (nom) => {
  const r = await cli.query(
    `select count(*)::int as nb,
            coalesce(bool_or(p.proacl is null
              or exists (select 1 from aclexplode(p.proacl) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
              false) as public_execute
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`, [nom]);
  return r.rows[0];
};

console.log('\n  1. Catalogue — fonctions révoquées (migrations 20261014100000 / 110000)');
for (const fn of REVOQUEES) {
  const c = await catalogue(fn);
  if (c.nb === 0) ko(`${fn} : fonction introuvable — le test ne mesure rien`);
  else if (c.public_execute) ko(`${fn} : PUBLIC EXECUTE toujours présent malgré la révocation`);
  else ok(`${fn} : PUBLIC EXECUTE révoqué`);
}

console.log('\n  2. Rôle sans aucun droit — les 6 fonctions révoquées lui sont fermées');
const roleTest = `tf_priv_test_${process.pid}`;
await cli.query(`create role ${roleTest} nologin nosuperuser nobypassrls`);
try {
  for (const fn of REVOQUEES) {
    const r = await cli.query(
      `select coalesce(bool_or(has_function_privilege($2, p.oid, 'EXECUTE')), false) as peut
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`, [fn, roleTest]);
    if (r.rows[0].peut) ko(`${fn} : exécutable par un rôle sans aucun grant`);
    else ok(`${fn} : refusée à un rôle sans grant`);
  }
} finally {
  await cli.query(`drop role if exists ${roleTest}`);
}

console.log('\n  3. Prédicats des politiques RLS — PUBLIC EXECUTE doit subsister');
for (const fn of PREDICATS_RLS) {
  const c = await catalogue(fn);
  if (c.nb === 0) ko(`${fn} : fonction introuvable`);
  else if (!c.public_execute) ko(`${fn} : PUBLIC EXECUTE perdu — les politiques RLS qui l'appellent échoueraient`);
  else ok(`${fn} : PUBLIC EXECUTE conservé`);
}

console.log('\n  4. Gardes de déclencheurs — PUBLIC EXECUTE doit subsister');
for (const fn of GARDES_TRIGGER) {
  const c = await catalogue(fn);
  if (c.nb === 0) ko(`${fn} : fonction introuvable`);
  else if (!c.public_execute) ko(`${fn} : PUBLIC EXECUTE perdu — les déclencheurs de validation échoueraient`);
  else ok(`${fn} : PUBLIC EXECUTE conservé`);
}

await cli.end();

const total = REVOQUEES.length * 2 + PREDICATS_RLS.length + GARDES_TRIGGER.length;
console.log(`\n  ${total - echecs}/${total} assertions — privilèges SECURITY DEFINER conformes.`);
process.exit(echecs ? 1 : 0);
