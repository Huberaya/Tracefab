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
 *
 * SENSIBILITE — CONTROLE NEGATIF PAR MUTATION
 *
 * `TF_MUTATION_SANS_RLS=1` retire la RLS des quatre tables exercees avant les
 * mesures. Meme motif que `scripts/test_isolation_lignes_reelles.mjs` : une
 * variable d'environnement, pas du code a commenter — une sensibilite qu'on
 * annonce sans pouvoir la rejouer est une sensibilite supposee.
 *
 *   TF_MUTATION_SANS_RLS=1 npm run test:preuve:isolation-main-tenant-actif
 *   -> 11 echecs nommes. Sans la variable : 30 controles verts.
 *
 * DEUX COMMANDES POINTENT ICI, ET C'EST VOULU
 *
 * `test:preuve-isolation:main` est citee par
 * `docs/security/2026-11-12-S11-consolidation-pr-et-chaine-migrations.md`
 * (§4.1, §5.3) : la retirer casserait la rejouabilite d'un document date.
 * `test:preuve:isolation-main-tenant-actif` est l'alias de CI, et celui-la seul
 * figure dans la boucle : un doublon y ferait tourner deux fois 30 scenarios
 * pour rien.
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

/*
 * CONTROLE NEGATIF PAR MUTATION — meme motif que
 * `scripts/test_isolation_lignes_reelles.mjs` (variable d'environnement, pas de
 * code a commenter). Desactiver la RLS DOIT faire echouer cette suite ; si elle
 * restait verte, c'est qu'elle ne mesurait pas la RLS.
 *
 *   TF_MUTATION_SANS_RLS=1 node scripts/test_preuve_isolation_main_tenant_actif.mjs
 *
 * Mesures connues, avec leur portee — le chiffre depend de ce qu'on mute, et une
 * sensibilite annoncee sans portee n'est qu'une supposition :
 *   - tracefab_products + materials seules : 7 echecs (2026-11-12, suite a 18
 *     scenarios) ;
 *   - les quatre tables ci-dessous : 11 echecs (2026-11-22, suite a 30
 *     scenarios).
 */
if (process.env.TF_MUTATION_SANS_RLS === '1') {
  for (const table of ['tracefab_products', 'materials', 'data_requests', 'tracefab_schema_bindings']) {
    await db.exec(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`).catch(() => {});
  }
  console.log('  MUTATION ACTIVE : RLS retiree sur 4 tables — la suite DOIT echouer\n');
}

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

// ---- H. Chaine Chantier 1A : demandes de donnees et liaisons de schemas ---
await db.exec('RESET ROLE');
const SUP_ID = '66666666-6666-6666-6666-666666666666';
const REL_A = '81111111-1111-1111-1111-111111111111';
const REL_B = '82222222-2222-2222-2222-222222222222';
const REQ_A = '91111111-1111-1111-1111-111111111111';
const REQ_B = '92222222-2222-2222-2222-222222222222';
await db.exec(`
  INSERT INTO suppliers (id, organization_id)
    VALUES ('${SUP_ID}', '${S}');
  INSERT INTO brand_supplier_relationships (id, brand_organization_id, supplier_organization_id, status)
    VALUES
      ('${REL_A}', '${A}', '${S}', 'active'),
      ('${REL_B}', '${B}', '${S}', 'active');
  INSERT INTO data_requests (id, brand_organization_id, supplier_organization_id, relationship_id, title, questionnaire_key, questionnaire_version, status)
    VALUES
      ('${REQ_A}', '${A}', '${S}', '${REL_A}', 'Demande Marque A', 'supplier.onboarding', '1.0.0', 'sent'),
      ('${REQ_B}', '${B}', '${S}', '${REL_B}', 'Demande Marque B', 'supplier.onboarding', '1.0.0', 'sent');
  INSERT INTO tracefab_schema_catalog (schema_key, schema_version, title, subject_types)
    VALUES ('product.core.test', '1.0.0', 'Product Core Test', ARRAY['product'])
    ON CONFLICT (schema_key, schema_version) DO NOTHING;
  INSERT INTO tracefab_schema_bindings (id, schema_key, schema_version, product_id)
    VALUES
      ('93333333-3333-3333-3333-333333333333', 'product.core.test', '1.0.0', '${P_A}'),
      ('94444444-4444-4444-4444-444444444444', 'product.core.test', '1.0.0', '${P_B}');
`);
await db.exec('SET ROLE tracefab_app');

attendre(
  (await scenario(null, () => compter('SELECT count(*)::int AS n FROM tracefab_schema_bindings'))) === 0,
  'H. sans tenant actif : 0 liaison de schema visible malgre les adhesions A et B',
);
attendre(
  (await scenario(A, () => compter(`SELECT count(*)::int AS n FROM tracefab_schema_bindings WHERE product_id = '${P_A}'`))) === 1
    && (await scenario(A, () => compter(`SELECT count(*)::int AS n FROM tracefab_schema_bindings WHERE product_id = '${P_B}'`))) === 0,
  'H. tenant A arme : seule la liaison de schema du produit A est visible (B invisible)',
);
attendre(
  (await scenario(B, () => compter(`SELECT count(*)::int AS n FROM tracefab_schema_bindings WHERE product_id = '${P_B}'`))) === 1,
  'H. tenant B arme : la liaison de schema du produit B redevient visible',
);
attendre(
  (await scenario(null, () => compter('SELECT count(*)::int AS n FROM data_requests'))) === 0,
  'H. sans tenant actif : 0 demande de donnees visible malgre les adhesions A, B et S',
);
attendre(
  (await scenario(A, () => compter(`SELECT count(*)::int AS n FROM data_requests WHERE id = '${REQ_A}'`))) === 1
    && (await scenario(A, () => compter(`SELECT count(*)::int AS n FROM data_requests WHERE id = '${REQ_B}'`))) === 0,
  'H. tenant A arme : seule la demande de Marque A est visible (demande de Marque B invisible)',
);
attendre(
  (await scenario(S, () => compter('SELECT count(*)::int AS n FROM data_requests'))) === 2,
  'H. tenant fournisseur S arme : les 2 demandes envoyees a S sont visibles cote fournisseur',
);

// ---- I. Phase 2 : documents, tracefab_can_access_document et tracefab_register_document
await db.exec('RESET ROLE');
const DOC_A = '95555555-5555-5555-5555-555555555555';
const DOC_S = '96666666-6666-6666-6666-666666666666';
const ITEM_A = '97777777-7777-7777-7777-777777777777';
const RESP_A = '98888888-8888-8888-8888-888888888888';
await db.exec(`
  INSERT INTO documents (
    id, owner_organization_id, storage_bucket, storage_path,
    original_filename, content_type, byte_size, kind, status, visibility
  ) VALUES
    ('${DOC_A}', '${A}', 'tracefab-private', '${A}/brand-spec.pdf', 'brand-spec.pdf', 'application/pdf', 1024, 'other', 'uploaded', 'private'),
    ('${DOC_S}', '${S}', 'tracefab-private', '${S}/supplier-cert.pdf', 'supplier-cert.pdf', 'application/pdf', 2048, 'certificate', 'uploaded', 'private');
  BEGIN;
  SELECT set_config('tracefab.internal_document_update', 'true', true);
  UPDATE documents
     SET status = 'available',
         sha256 = repeat('a', 64),
         available_at = now()
   WHERE id IN ('${DOC_A}', '${DOC_S}');
  COMMIT;
  INSERT INTO data_request_items (id, data_request_id, field_key, label, data_type, required)
    VALUES ('${ITEM_A}', '${REQ_A}', 'gots_cert', 'Certificat GOTS', 'document', true);
  INSERT INTO data_responses (id, data_request_item_id, value, data_type, status, source_document_id)
    VALUES ('${RESP_A}', '${ITEM_A}', '{"documentId":"${DOC_S}"}'::jsonb, 'document', 'documented', '${DOC_S}');
`);
await db.exec('SET ROLE tracefab_app');

const peutAccederDoc = async (docId) =>
  (await db.query(`SELECT tracefab_can_access_document('${docId}'::uuid) AS ok`)).rows[0].ok;

attendre(
  (await scenario(null, () => compter('SELECT count(*)::int AS n FROM documents'))) === 0
    && (await scenario(null, () => peutAccederDoc(DOC_A))) === false
    && (await scenario(null, () => peutAccederDoc(DOC_S))) === false,
  'I. sans tenant actif : 0 document visible et tracefab_can_access_document = FAUX malgre les adhesions A, B et S',
);
attendre(
  (await scenario(A, () => peutAccederDoc(DOC_A))) === true
    && (await scenario(A, () => peutAccederDoc(DOC_S))) === true
    && (await scenario(A, () => compter(`SELECT count(*)::int AS n FROM documents WHERE id IN ('${DOC_A}', '${DOC_S}')`))) === 2,
  'I. tenant marque A arme : acces au document proprietaire DOC_A et au document fournisseur DOC_S transmis sur REQ_A',
);
attendre(
  (await scenario(B, () => peutAccederDoc(DOC_A))) === false
    && (await scenario(B, () => peutAccederDoc(DOC_S))) === false
    && (await scenario(B, () => compter(`SELECT count(*)::int AS n FROM documents WHERE id IN ('${DOC_A}', '${DOC_S}')`))) === 0,
  'I. tenant marque B arme : ni DOC_A ni DOC_S (transmis uniquement a A) ne sont accessibles ou visibles',
);
attendre(
  (await scenario(S, () => peutAccederDoc(DOC_S))) === true
    && (await scenario(S, () => peutAccederDoc(DOC_A))) === false,
  'I. tenant fournisseur S arme : acces au document proprietaire DOC_S mais refus de DOC_A',
);

let refusRegisterSansTenant = false;
try {
  await scenario(null, () => db.exec(`
    SELECT * FROM tracefab_register_document(
      '${S}'::uuid, '${S}/sans-tenant.pdf', 'sans-tenant.pdf', 'application/pdf',
      512::bigint, NULL, 'certificate'::document_kind, NULL, '{}'::jsonb
    )
  `));
} catch (e) { refusRegisterSansTenant = /active_tenant_mismatch/i.test(e.message); }
attendre(
  refusRegisterSansTenant,
  'I. tracefab_register_document sans tenant actif -> active_tenant_mismatch (fail-closed)',
);

let refusRegisterMauvaisTenant = false;
try {
  await scenario(A, () => db.exec(`
    SELECT * FROM tracefab_register_document(
      '${S}'::uuid, '${S}/mauvais-tenant.pdf', 'mauvais-tenant.pdf', 'application/pdf',
      512::bigint, NULL, 'certificate'::document_kind, NULL, '{}'::jsonb
    )
  `));
} catch (e) { refusRegisterMauvaisTenant = /active_tenant_mismatch/i.test(e.message); }
attendre(
  refusRegisterMauvaisTenant,
  'I. tracefab_register_document avec tenant A pour proprietaire S -> active_tenant_mismatch',
);

const docEnregistreS = await scenario(S, async () => {
  const r = await db.query(`
    SELECT id FROM tracefab_register_document(
      '${S}'::uuid, '${S}/upload-intent-ok.pdf', 'upload-intent-ok.pdf', 'application/pdf',
      512::bigint, NULL, 'certificate'::document_kind, NULL, '{}'::jsonb
    )
  `);
  return r.rows[0]?.id ?? null;
});
attendre(
  typeof docEnregistreS === 'string' && docEnregistreS.length === 36,
  'I. tracefab_register_document avec tenant fournisseur S arme -> succes',
);

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
