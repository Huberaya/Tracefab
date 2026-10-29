#!/usr/bin/env node
/**
 * L'ETAT LU EN PRODUCTION, REPRODUIT, PUIS CORRIGE — sur base jetable.
 *
 * Les lectures du 29/10 sur la branche `production` (base `neondb`, role
 * `neondb_owner`) ont releve trois ecarts P0/P1. Ce test en fait trois choses :
 *
 *   1. il REPRODUIT l'etat lu, en appliquant la chaine SANS les onze migrations
 *      en ecart — si la reproduction ne donne pas les memes constats, c'est que
 *      la lecture et le depot ne parlent pas du meme etat, et il faut le savoir
 *      avant toute correction ;
 *   2. il applique les CINQ correctifs de securite, tels quels, et mesure ce
 *      qu'ils changent reellement — pas ce que leurs commentaires annoncent ;
 *   3. il mesure les ROLES INTERDITS : un correctif qui ferme la porte au role
 *      applicatif mais l'ouvre a PUBLIC n'a rien corrige.
 *
 * UN POINT DE NOMMAGE, RELEVE DANS LES LECTURES
 *
 * La lecture signale « absentes » quatre fonctions :
 *   tracefab_worker_context, tracefab_set_worker_context,
 *   tracefab_current_worker_id, tracefab_is_worker_context_valid
 *
 * Ces quatre noms n'existent NULLE PART dans le depot — ni dans une migration,
 * ni dans le SQL, ni dans la documentation (verifie par balayage). Le correctif
 * reel (`20261028120100`) n'est pas un jeu de fonctions de contexte : c'est un
 * ROLE `tracefab_worker` NOLOGIN, des politiques qui testent `current_user`, et
 * six fonctions nommees possedees par ce role. Conclure « les fonctions
 * attendues sont absentes » sur la foi de ces quatre noms reviendrait a
 * chercher un correctif qui n'a jamais ete ecrit. Ce test mesure donc les
 * objets REELS du depot, et signale explicitement les noms introuvables.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(racine, 'prisma', 'migrations');

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Les onze migrations dont l'historique de production ne porte pas la trace. */
const ECARTS = [
  '20261010120000_publication_explicite',
  '20261017120000_active_tenant_context',
  '20261021170000_dpp_readiness_truthful_gates',
  '20261027100000_dpp_quality_gate_requires_assessment',
  '20261027130000_dpp_review_preservation_and_publication_coherence',
  '20261028120000_runtime_function_registry',
  '20261028120100_worker_identity_not_forgeable',
  '20261028120200_document_reserved_fields_internal_only',
  '20261028130000_product_computed_fields_column_scoped',
  '20261028140000_supplier_invitation_owner_relationship_scope',
  '20261028150000_reconcile_plm_erp_sync_job_policies',
];

/** Les deux annulees, dont les effets sont presents : on les rejoue. */
const ANNULEES = ['20261010120000_publication_explicite', '20261017120000_active_tenant_context'];

/** Les cinq correctifs de securite du mandat, dans l'ordre de la chaine. */
const CORRECTIFS = [
  '20261028120000_runtime_function_registry',
  '20261028120100_worker_identity_not_forgeable',
  '20261028120200_document_reserved_fields_internal_only',
  '20261028130000_product_computed_fields_column_scoped',
  '20261028140000_supplier_invitation_owner_relationship_scope',
];

const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');

async function base() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  // Le role applicatif existe AVANT les migrations : c'est l'ordre de la CI et
  // de la production, et c'est lui qui declenche les blocs de preservation ACL.
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  return db;
}

/** Applique une migration, en transaction, comme Prisma. Rend {ok, message}. */
async function appliquer(db, d) {
  try {
    await db.exec('BEGIN');
    await db.exec(lire(d));
    await db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch { /* deja fermee */ }
    return { ok: false, message: String(e.message ?? e).split('\n')[0] };
  }
}

/** Les privileges de COLONNE que le role applicatif detient sur une table. */
async function droitsColonne(db, table, colonnes) {
  const { rows } = await db.query(
    `SELECT c.column_name AS col,
            pg_catalog.has_column_privilege('tracefab_app', $1, c.column_name, 'UPDATE') AS u,
            pg_catalog.has_column_privilege('tracefab_app', $1, c.column_name, 'INSERT') AS i
       FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = $1
        AND c.column_name = ANY($2)
      ORDER BY 1`,
    [table, colonnes],
  );
  return Object.fromEntries(rows.map((r) => [r.col, { update: r.u === true || r.u === 't', insert: r.i === true || r.i === 't' }]));
}

async function existeFonction(db, nom) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [nom],
  );
  return rows[0].n > 0;
}

async function existeTable(db, nom) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'r'`, [nom],
  );
  return rows[0].n > 0;
}

// =========================================================================
console.log('0. Les quatre noms signales absents existent-ils dans le depot ?');
{
  const cherches = [
    'tracefab_worker_context', 'tracefab_set_worker_context',
    'tracefab_current_worker_id', 'tracefab_is_worker_context_valid',
  ];
  const trouves = [];
  for (const d of dossiers) {
    if (!existsSync(join(MIGRATIONS, d, 'migration.sql'))) continue;
    const sql = lire(d);
    for (const f of cherches) if (sql.includes(f)) trouves.push(`${f} dans ${d}`);
  }
  ok('AUCUNE migration ne cree ces quatre fonctions', trouves.length === 0, JSON.stringify(trouves));
  console.log('      => le correctif attendu n\'est pas un jeu de fonctions de contexte.');
  console.log('         Le correctif REEL de 20261028120100 est : role tracefab_worker');
  console.log('         NOLOGIN + politiques sur current_user + 6 fonctions nommees.');
  // Et les objets reels, eux, doivent etre dans le depot.
  const reel = lire('20261028120100_worker_identity_not_forgeable');
  ok('le correctif reel cree bien le role tracefab_worker', /CREATE ROLE tracefab_worker/.test(reel));
  ok('il reindexe les politiques sur current_user', /current_user = ''tracefab_worker''/.test(reel));
}

// =========================================================================
console.log('\n1. Etat REPRODUIT — la chaine sans les onze ecarts (production)');
let etat = {};
{
  const db = await base();
  const aAppliquer = dossiers.filter((d) => !ECARTS.includes(d) || ANNULEES.includes(d));
  let echec = null;
  for (const d of aAppliquer) {
    const r = await appliquer(db, d);
    if (!r.ok) { echec = `${d.slice(0, 14)} : ${r.message}`; break; }
  }
  ok(`la base « production » se construit (${aAppliquer.length} migrations)`, echec === null, echec ?? '');

  // --- P0 worker --------------------------------------------------------
  ok('registre runtime ABSENT (comme lu en production)',
    !(await existeTable(db, 'tracefab_runtime_function_registry')));
  ok('role tracefab_worker ABSENT (comme lu en production)',
    (await db.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'`)).rows[0].n === 0);

  // --- P0 champs sensibles ---------------------------------------------
  const doc = await droitsColonne(db, 'documents', ['status', 'sha256', 'byte_size']);
  const prod = await droitsColonne(db, 'tracefab_products', ['version', 'data_completion', 'name']);
  console.log(`        documents       : ${JSON.stringify(doc)}`);
  console.log(`        tracefab_products: ${JSON.stringify(prod)}`);
  ok('P0 reproduit — tracefab_app peut UPDATE documents.status',
    doc.status?.update === true, JSON.stringify(doc.status));
  ok('P0 reproduit — tracefab_app peut UPDATE tracefab_products.version',
    prod.version?.update === true, JSON.stringify(prod.version));
  etat = { doc, prod };
  await db.close();
}

// =========================================================================
console.log('\n2. Les CINQ correctifs, appliques tels quels');
{
  const db = await base();
  for (const d of dossiers) {
    if (ECARTS.includes(d) && !ANNULEES.includes(d) && !CORRECTIFS.includes(d)) continue;
    const r = await appliquer(db, d);
    if (!r.ok) { console.error(`  ECHEC construction a ${d.slice(0, 14)} : ${r.message}`); process.exit(1); }
  }

  // --- P0 worker, objets REELS du depot --------------------------------
  console.log('  2.a Identite worker');
  ok('le role tracefab_worker existe', (await db.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'`)).rows[0].n === 1);
  const w = (await db.query(
    `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'`)).rows[0];
  ok('il ne peut pas se connecter (NOLOGIN) : aucun mot de passe a faire fuiter', w.rolcanlogin === false);
  ok('il n est ni superutilisateur ni BYPASSRLS', w.rolsuper === false && w.rolbypassrls === false);
  ok('tracefab_app ne peut PAS endosser le worker (aucune appartenance)',
    (await db.query(`SELECT pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') AS m`)).rows[0].m === false);
  ok('le registre runtime existe', await existeTable(db, 'tracefab_runtime_function_registry'));
  for (const f of ['tracefab_upsert_clerk_user', 'tracefab_ensure_clerk_user',
    'tracefab_soft_delete_clerk_user', 'tracefab_clerk_organization_uuid',
    'tracefab_archive_clerk_organization', 'tracefab_notification_outbox_health']) {
    ok(`fonction du worker presente : ${f}`, await existeFonction(db, f));
  }

  // --- P0 champs sensibles ---------------------------------------------
  console.log('  2.b Champs sensibles');
  const docApres = await droitsColonne(db, 'documents', ['status', 'sha256', 'byte_size']);
  const prodApres = await droitsColonne(db, 'tracefab_products', ['version', 'data_completion', 'name']);
  console.log(`        documents        : ${JSON.stringify(docApres)}`);
  console.log(`        tracefab_products: ${JSON.stringify(prodApres)}`);
  ok('documents.status n est plus modifiable par le role applicatif', docApres.status?.update === false);
  ok('documents.sha256 non plus', docApres.sha256?.update === false);
  ok('tracefab_products.version n est plus modifiable', prodApres.version?.update === false);
  ok('tracefab_products.data_completion n est plus modifiable', prodApres.data_completion?.update === false);
  ok('mais les colonnes metier le restent (le parcours legitime survit)',
    prodApres.name?.update === true, JSON.stringify(prodApres.name));

  // Le changement est-il bien un EFFET des correctifs, et non un etat de depart ?
  ok('le changement est un effet, pas un etat initial (comparaison avec la section 1)',
    etat.doc.status.update === true && docApres.status.update === false
    && etat.prod.version.update === true && prodApres.version.update === false);

  // --- Une ecriture reelle echoue-t-elle, ou seulement le catalogue ? ---
  console.log('  2.c L ecriture reelle, pas seulement le catalogue');
  await db.exec('SET ROLE tracefab_app;');
  let refus = null;
  try {
    await db.exec(`UPDATE documents SET status = 'available' WHERE false`);
    refus = 'accepte';
  } catch (e) { refus = e.code ?? 'refus'; }
  await db.exec('RESET ROLE;');
  ok('UPDATE documents.status est REFUSE en execution (42501)', refus === '42501', String(refus));

  await db.exec('SET ROLE tracefab_app;');
  let refus2 = null;
  try {
    await db.exec(`UPDATE tracefab_products SET version = version + 1 WHERE false`);
    refus2 = 'accepte';
  } catch (e) { refus2 = e.code ?? 'refus'; }
  await db.exec('RESET ROLE;');
  ok('UPDATE tracefab_products.version est REFUSE en execution (42501)', refus2 === '42501', String(refus2));

  // --- Les roles INTERDITS ne doivent pas avoir gagne ce qu'on a retire ---
  console.log('  2.d Les roles interdits n ont rien gagne');
  for (const [table, col] of [['documents', 'status'], ['tracefab_products', 'version']]) {
    const pub = (await db.query(
      `SELECT pg_catalog.has_column_privilege('public', $1, $2, 'UPDATE') AS p`, [table, col])).rows[0].p;
    ok(`PUBLIC n a pas UPDATE sur ${table}.${col} (le droit n a pas bouge, il a disparu)`,
      pub === false || pub === 'f', String(pub));
  }

  await db.close();
}

// =========================================================================
console.log('\n3. La politique PLM, dans le meme mouvement');
{
  const db = await base();
  for (const d of dossiers) {
    const r = await appliquer(db, d);
    if (!r.ok) { console.error(`  ECHEC a ${d.slice(0, 14)} : ${r.message}`); process.exit(1); }
  }
  const pols = (await db.query(
    `SELECT polname FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass ORDER BY 1`)).rows.map((r) => r.polname);
  ok('la chaine complete laisse DEUX politiques sur plm_erp_sync_jobs',
    pols.length === 2, JSON.stringify(pols));
  const ins = (await db.query(
    `SELECT pg_catalog.pg_get_expr(polwithcheck, polrelid) AS c FROM pg_catalog.pg_policy
      WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass AND polname = 'plm_sync_jobs_insert_brand'`)).rows[0];
  ok('la canonique INSERT ne mentionne pas contributor',
    ins && !/contributor/.test(ins.c ?? ''), ins?.c);
  await db.close();
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Etat lu reproduit, cinq correctifs mesures, roles interdits verifies.');
