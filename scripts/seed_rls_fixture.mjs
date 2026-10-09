#!/usr/bin/env node
/**
 * Prepare une base pour l'epreuve d'isolation RLS.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Le job CI « Base — isolation RLS executee » sautait tout son travail quand
 * le secret DATABASE_URL etait absent, et le depot n'a jamais eu le moindre
 * secret. Il annoncait donc une isolation executee sans rien executer.
 *
 * La reponse n'est pas d'ajouter le secret de production : brancher une base
 * de production sur un CI expose des identifiants a tout workflow, et ferait
 * tourner l'epreuve sur des donnees reelles. La reponse est de rendre le job
 * autonome — un Postgres jetable, monte a chaque execution.
 *
 * Ce script fabrique ce dont l'epreuve a besoin :
 *   1. le role `tracefab_app`, SANS BYPASSRLS, avec les droits applicatifs ;
 *   2. deux locataires complets, chacun avec son utilisateur, son adhesion,
 *      son fournisseur, ses produits et son document.
 *
 * Deux locataires, parce qu'une isolation se prouve par la difference : un
 * seul locataire ne permet pas de distinguer « bien cloisonne » de « tout
 * visible ». Et chacun doit POSSEDER des lignes, sinon comparer deux
 * ensembles vides ne demontre rien.
 *
 * Il s'execute sous le proprietaire de la base (qui contourne la RLS) et il
 * est rejouable : relancer ne duplique rien.
 */
import pg from 'pg';
import crypto from 'node:crypto';

const URL_PROPRIO = process.env.DATABASE_URL;
const MOT_DE_PASSE = process.env.TF_APP_PASSWORD;

if (!URL_PROPRIO) {
  console.error('  DATABASE_URL manquant — il doit pointer le proprietaire de la base.');
  process.exit(2);
}
if (!MOT_DE_PASSE) {
  console.error('  TF_APP_PASSWORD manquant — mot de passe a donner au role tracefab_app.');
  process.exit(2);
}

const avecSsl = /sslmode=(require|verify-full|verify-ca)/.test(URL_PROPRIO);
const db = new pg.Client({
  connectionString: URL_PROPRIO,
  ssl: avecSsl ? { rejectUnauthorized: false } : false,
});
await db.connect();

/* --- 1. le role applicatif ------------------------------------------------ */
const existe = await db.query('select 1 from pg_roles where rolname = $1', ['tracefab_app']);
if (existe.rowCount === 0) {
  await db.query(`CREATE ROLE tracefab_app LOGIN PASSWORD ${quote(MOT_DE_PASSE)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
  console.log('  role tracefab_app cree');
} else {
  await db.query(`ALTER ROLE tracefab_app WITH LOGIN PASSWORD ${quote(MOT_DE_PASSE)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
  console.log('  role tracefab_app deja present, attributs reappliques');
}

const base = (await db.query('select current_database() d')).rows[0].d;
const proprio = (await db.query('select current_user u')).rows[0].u;
for (const sql of [
  `GRANT CONNECT ON DATABASE "${base}" TO tracefab_app`,
  'GRANT USAGE ON SCHEMA public TO tracefab_app',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tracefab_app',
  'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tracefab_app',
  'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tracefab_app',
  `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tracefab_app`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tracefab_app`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE "${proprio}" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO tracefab_app`,
]) {
  await db.query(sql);
}
console.log('  droits applicatifs accordes');

/* --- 2. deux locataires porteurs de donnees -------------------------------- */
// Identifiants deterministes : rejouer le script retombe sur les memes lignes.
const uuid = (graine) => {
  const h = crypto.createHash('sha1').update(`tracefab-rls-${graine}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const locataires = [
  { cle: 'alpha', nom: 'Maison Alpha', pays: 'FR' },
  { cle: 'beta', nom: 'Maison Beta', pays: 'PT' },
];

for (const l of locataires) {
  const orgId = uuid(`org-${l.cle}`);
  const userId = uuid(`user-${l.cle}`);
  const fournisseurId = uuid(`sup-${l.cle}`);

  await db.query(
    `insert into organizations (id, type, legal_name) values ($1, 'brand', $2)
     on conflict (id) do nothing`, [orgId, l.nom]);

  await db.query(
    `insert into users (id, clerk_user_id, email, full_name)
     values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [userId, `clerk_rls_${l.cle}`, `${l.cle}@rls.fixture.test`, `Responsable ${l.nom}`]);

  await db.query(
    `insert into organization_memberships (id, organization_id, user_id, role)
     values ($1, $2, $3, 'owner') on conflict (id) do nothing`,
    [uuid(`mem-${l.cle}`), orgId, userId]);

  await db.query(
    `insert into suppliers (id, organization_id) values ($1, $2)
     on conflict (id) do nothing`, [fournisseurId, orgId]);

  for (const n of [1, 2]) {
    await db.query(
      `insert into tracefab_products (id, brand_organization_id, reference, name)
       values ($1, $2, $3, $4) on conflict (id) do nothing`,
      [uuid(`prod-${l.cle}-${n}`), orgId, `${l.cle.toUpperCase()}-00${n}`,
        `Article ${n} ${l.nom}`]);
  }

  // Le declencheur tracefab_validate_document_location impose le bucket prive,
  // un chemin prefixe par l'organisation proprietaire, une visibilite privee
  // et un statut initial « uploaded ». On respecte l'invariant plutot que de
  // le contourner : la fixture doit ressembler a de vraies donnees.
  await db.query(
    `insert into documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, visibility, status)
     values ($1, $2, 'tracefab-private', $3, $4, 'application/pdf', 1024, 'private', 'uploaded')
     on conflict (id) do nothing`,
    [uuid(`doc-${l.cle}`), orgId, `${orgId}/certificats/${l.cle}.pdf`, `${l.cle}-certificat.pdf`]);

  console.log(`  locataire ${l.nom} : utilisateur, adhesion, fournisseur, 2 produits, 1 document`);
}

const compte = async (t) => (await db.query(`select count(*)::int n from "${t}"`)).rows[0].n;
console.log(`  total : ${await compte('organizations')} organisations · ${await compte('users')} utilisateurs · ${await compte('tracefab_products')} produits`);

await db.end();
console.log('  base prete pour npm run test:neon:rls');

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
