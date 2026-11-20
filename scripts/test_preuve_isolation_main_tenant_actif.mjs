#!/usr/bin/env node
/**
 * TRACEFAB — PREUVE D'ISOLATION DU TENANT ACTIF SUR `main` (par execution).
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Les suites d'isolation de #113/#120 ne sont pas executables telles quelles sur
 * `main` : elles exigent une migration corrective
 * (`20261106010000_active_tenant_access_guards`) et des helpers
 * (`documentAccessibleFromTenant`) qui n'existent pas dans `main`. Les faire
 * tourner sans eux produit des « echecs » qui mesurent une ABSENCE DE CODE,
 * pas une FUITE : ce serait une fausse preuve negative.
 *
 * Cette suite-ci ne suppose rien : elle applique la CHAINE REELLE de `main`
 * (les 100 migrations du depot, dans l'ordre, avec le protocole worker du
 * runner), cree de vrais organismes, puis EXERCE les gardes sous le role
 * applicatif `tracefab_app` (NOSUPERUSER NOBYPASSRLS) avec les GUC poses
 * exactement comme `api/_lib/context.ts` les pose : `is_local = true`, donc
 * DANS une transaction.
 *
 * CE QU'ELLE PROUVE
 * -----------------
 *  A. Sans tenant actif : aucune ligne metier d'autrui n'est lisible, meme pour
 *     une organisation dont l'utilisateur est membre actif. Fail-closed.
 *  B. Tenant A arme : les lignes de A sont lisibles (positif).
 *  C. Tenant A arme : les lignes de B sont INVISIBLES, alors que l'utilisateur
 *     est membre actif de B. C'est le coeur de la fermeture : l'union des
 *     adhesions ne suffit plus.
 *  D. Controle negatif : sous un role sans RLS, les memes requetes voient tout.
 *     L'isolement vient donc de la POLITIQUE, pas du filtre applicatif.
 *  E. Ecriture : le WITH CHECK refuse une ligne hors tenant actif et accepte
 *     une ligne dans le tenant actif, sur une table reellement inscriptible par
 *     le role applicatif (`materials`).
 *  F. `tracefab_in_active_tenant` est fail-closed et TOTALE (jamais NULL).
 *  G. Defense en profondeur : le role applicatif n'a pas le droit d'ecrire dans
 *     `tracefab_products` (les produits passent par des fonctions
 *     SECURITY DEFINER). L'absence de privilege precede la RLS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { executerMigrationPglite } from './lib/pglite-worker-runner.mjs';

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const S = '33333333-3333-3333-3333-333333333333';
const U = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P_A = '44444444-4444-4444-4444-444444444444';
const P_B = '55555555-5555-5555-5555-555555555555';

let echecs = 0;
const ok = (m) => console.log(`  ok     ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC  ${m}`); };
const attendre = (cond, m) => (cond ? ok(m) : ko(m));

console.log('Preuve isolation tenant actif — chaine REELLE de main\n');

// ---- Montage : la chaine complete, avec le protocole worker du runner ------
const dossiers = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
  .sort();

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
`);
for (const d of dossiers) {
  await executerMigrationPglite(db, d, fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
}
console.log(`  base jetable : ${dossiers.length} migrations appliquees, role tracefab_app (NOBYPASSRLS)\n`);

// ---- Fixtures --------------------------------------------------------------
await db.exec(`
  INSERT INTO organizations (id,type,legal_name,status) VALUES
    ('${A}','brand','Marque A','active'),
    ('${B}','brand','Marque B','active'),
    ('${S}','supplier','Fournisseur S','active');
  INSERT INTO users (id,clerk_user_id,email,full_name) VALUES
    ('${U}','clerk_multi','multi@example.test','Compte multi-organisations');
  INSERT INTO organization_memberships (organization_id,user_id,role,status) VALUES
    ('${A}','${U}','admin','active'),
    ('${B}','${U}','admin','active'),
    ('${S}','${U}','admin','active');
  INSERT INTO tracefab_products (id,brand_organization_id,reference,name,status) VALUES
    ('${P_A}','${A}','REF-A','Produit prive A','draft'),
    ('${P_B}','${B}','REF-B','Produit prive B','draft');
  INSERT INTO materials (id,owner_organization_id,material_type,name) VALUES
    ('77777777-7777-7777-7777-777777777777','${A}','metal','Acier A'),
    ('88888888-8888-8888-8888-888888888888','${B}','metal','Acier B');
`);
ok('fixtures : 3 organisations, 1 compte membre actif des TROIS, 2 produits, 2 matieres');

// `context.ts` pose les GUC avec is_local = true : ils ne valent que DANS la
// transaction. Mesurer hors transaction ne prouverait rien (le GUC retombe a
// vide et tout parait ferme pour une mauvaise raison). Chaque scenario est donc
// execute dans une transaction explicite, comme l'API.
const scenario = async (orgId, corps) => {
  await db.exec('BEGIN');
  try {
    await db.query(
      `SELECT set_config('tracefab.user_id', $1, true),
              set_config('tracefab.active_organization_id', $2, true)`,
      [U, orgId ?? ''],
    );
    return await corps();
  } finally {
    await db.exec('ROLLBACK');
  }
};
const compter = async (sql) => (await db.query(sql)).rows[0].n;
const produits = 'SELECT count(*)::int AS n FROM tracefab_products';
const matieres = 'SELECT count(*)::int AS n FROM materials';

await db.exec('SET ROLE tracefab_app');

// ---- A. Fail-closed : aucun tenant arme -----------------------------------
attendre(
  (await scenario(null, () => compter(produits))) === 0,
  'A. sans tenant actif : 0 produit visible, malgre une adhesion active a A et B',
);
attendre(
  (await scenario(null, () => compter(matieres))) === 0,
  'A. sans tenant actif : 0 matiere visible',
);

// ---- B. Positif : tenant A arme -------------------------------------------
const bProduits = await scenario(A, () => compter(produits));
const bIds = await scenario(A, async () =>
  (await db.query('SELECT id FROM tracefab_products')).rows.map((r) => r.id));
attendre(bProduits === 1 && bIds[0] === P_A,
  `B. tenant A arme : seul le produit de A est visible (mesure ${bProduits})`);

// ---- C. Negatif croise : B invisible malgre une adhesion active -----------
attendre(
  (await scenario(A, () => compter(
    `SELECT count(*)::int AS n FROM tracefab_products WHERE id = '${P_B}'`))) === 0,
  'C. tenant A arme : le produit de B est INVISIBLE malgre une adhesion active a B',
);
attendre(
  (await scenario(A, () => compter(
    `SELECT count(*)::int AS n FROM materials WHERE id = '88888888-8888-8888-8888-888888888888'`))) === 0,
  'C. tenant A arme : la matiere de B est INVISIBLE',
);
// La meme ligne redevient visible quand B est le tenant actif : ce n'est donc
// pas une suppression, c'est bien le tenant actif qui decoupe la lecture.
attendre(
  (await scenario(B, () => compter(
    `SELECT count(*)::int AS n FROM materials WHERE id = '88888888-8888-8888-8888-888888888888'`))) === 1,
  'C. tenant B arme : la matiere de B REDEVIENT visible (meme ligne, autre tenant)',
);

// ---- E. Ecriture : WITH CHECK dans les deux sens -------------------------
const ecrireMatiere = (orgId) => scenario(A, () => db.exec(
  `INSERT INTO materials (owner_organization_id,material_type,name)
   VALUES ('${orgId}','metal','Essai')`));

let refus = false;
try { await ecrireMatiere(B); } catch { refus = true; }
attendre(refus, 'E. tenant A arme : ecrire une matiere dans B est REFUSE (WITH CHECK)');

let accepte = false;
try { await ecrireMatiere(A); accepte = true; } catch { accepte = false; }
attendre(accepte, 'E. tenant A arme : ecrire une matiere dans A est ACCEPTE (positif)');

// ---- F. Helpers fail-closed et totaux -------------------------------------
const f1 = await scenario(A, async () =>
  (await db.query(`SELECT tracefab_in_active_tenant('${A}') AS v`)).rows[0].v);
const f2 = await scenario(null, async () =>
  (await db.query(`SELECT tracefab_in_active_tenant('${A}') AS v`)).rows[0].v);
const f3 = await scenario(null, async () =>
  (await db.query(`SELECT tracefab_in_active_tenant(NULL) AS v`)).rows[0].v);
const f4 = await scenario(null, async () =>
  (await db.query('SELECT tracefab_active_organization_id() AS v')).rows[0].v);
attendre(f1 === true, 'F. tenant A arme : tracefab_in_active_tenant(A) = VRAI');
attendre(f2 === false, 'F. sans tenant arme : tracefab_in_active_tenant(A) = FAUX (fail-closed)');
attendre(f3 === false, 'F. entree NULL : FAUX, jamais NULL (booleen TOTAL)');
attendre(f4 === null, 'F. sans tenant arme : tracefab_active_organization_id() = NULL');

// ---- G. Defense en profondeur : pas de privilege d'ecriture directe -------
let sansPrivilege = false;
try {
  await scenario(A, () => db.exec(
    `INSERT INTO tracefab_products (brand_organization_id,reference,name,status)
     VALUES ('${A}','REF-DIRECT','Ecriture directe','draft')`));
} catch (e) { sansPrivilege = /permission denied/i.test(e.message); }
attendre(sansPrivilege,
  'G. le role applicatif N A PAS le droit d ecrire dans tracefab_products (SECURITY DEFINER obligatoire)');

// ---- D. Controle negatif : sans la RLS, tout est visible -----------------
await db.exec('RESET ROLE');
const dProduits = await compter(produits);
const dOrgs = await compter('SELECT count(*)::int AS n FROM organizations');
attendre(dProduits === 2,
  `D. controle negatif (proprietaire, sans RLS, sans tenant) : 2 produits visibles (mesure ${dProduits})`);
attendre(dOrgs === 3,
  `D. controle negatif : 3 organisations visibles (mesure ${dOrgs})`);
attendre(dProduits > bProduits,
  'D. l isolement vient bien de la POLITIQUE RLS, pas du filtre de la requete');

// ---- Verdict ---------------------------------------------------------------
console.log('');
if (echecs === 0) {
  console.log('Preuve isolation tenant actif : OK — tous les scenarios sont passes sur la chaine de main.');
  process.exit(0);
}
console.log(`Preuve isolation tenant actif : ${echecs} echec(s).`);
process.exit(1);
