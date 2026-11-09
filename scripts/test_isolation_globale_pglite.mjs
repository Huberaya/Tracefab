#!/usr/bin/env node
/**
 * TRACEFAB — isolation globale des acces et du stockage : PREUVE PAR EXECUTION.
 *
 * CE QUE CE TEST N'EST PAS
 * ------------------------
 * Il ne verifie pas la presence d'un helper dans un fichier. Il applique la
 * CHAINE COMPLETE des migrations sur un PostgreSQL jeteable (PGlite), cree de
 * vrais organismes, de vrais produits, de vrais documents, de vrais partages et
 * de vraies relations fournisseur-marque, puis il execute les gardes
 * d'autorisation du depot avec le role applicatif `tracefab_app` et les GUC
 * `tracefab.user_id` / `tracefab.active_organization_id` poses comme le fait
 * `api/_lib/context.ts`.
 *
 * IL MESURE AUSSI LE DEFAUT, PAS SEULEMENT LE CORRECTIF
 * -----------------------------------------------------
 * Avec le tenant A arme, un compte membre de A, B et du fournisseur S voit
 * encore les documents des trois organisations via les politiques RLS, et
 * `tracefab_can_access_document()` repond vrai pour les documents B et S.
 * Les produits sont deja limites au tenant actif par une politique anterieure.
 * Le test distingue ces deux etats avant de verifier les refus (sections B-E).
 *
 * ENVIRONNEMENT : niveau 1 — base jeteable locale, aucune connexion distante,
 * aucune ecriture sur Neon, aucune variable lue depuis l'environnement.
 * Une reussite ici n'est PAS une preuve de Preview ni de Production.
 *
 * Usage : npm run test:isolation:globale
 * Sortie : 0 si toutes les preuves passent, 1 sinon, 2 si PGlite est absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('  NON EXECUTE — @electric-sql/pglite absent : npm ci avant cette suite.');
  process.exit(2);
}

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return true; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const section = (titre) => console.log(`\n${titre}\n${'-'.repeat(titre.length)}`);

/* -------------------------------------------------------------------------- *
 * Identifiants reels : deux marques, une troisieme non liee, un fournisseur
 * travaillant avec A et B, et des comptes multi-organisations.
 * ------------------------------------------------------------------------- */
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const C = 'c0000000-0000-4000-8000-000000000003';
const S = 'd0000000-0000-4000-8000-000000000004';
const S2 = 'e0000000-0000-4000-8000-000000000005';

const U_MULTI = '10000000-0000-4000-8000-000000000001'; // A + B + S
const U_A = '10000000-0000-4000-8000-000000000002';     // A uniquement
const U_B = '10000000-0000-4000-8000-000000000003';     // B uniquement
const U_S = '10000000-0000-4000-8000-000000000004';     // S uniquement
const U_REVOQUE = '10000000-0000-4000-8000-000000000005'; // A, adhesion revoquee
const U_SANS_TENANT = '10000000-0000-4000-8000-000000000006';

const P_A = '20000000-0000-4000-8000-000000000001';
const P_B = '20000000-0000-4000-8000-000000000002';
const P_C = '20000000-0000-4000-8000-000000000003';

const D_A = '30000000-0000-4000-8000-000000000001';       // proprietaire A
const D_B = '30000000-0000-4000-8000-000000000002';       // proprietaire B, prive
const D_S_PRIVE = '30000000-0000-4000-8000-000000000003'; // S, non partage
const D_S_VERS_A = '30000000-0000-4000-8000-000000000004';// S -> partage A
const D_S_VERS_B = '30000000-0000-4000-8000-000000000005';// S -> partage B
const D_A_VERS_S = '30000000-0000-4000-8000-000000000006';// A -> preuve partagee a S via collecte
const D_CERT_S = '30000000-0000-4000-8000-000000000007';  // S, via certification
const D_REPONSE = '30000000-0000-4000-8000-000000000008'; // S, via reponse A<->S

const REL_AS = '40000000-0000-4000-8000-000000000001';
const REL_BS = '40000000-0000-4000-8000-000000000002';
const SHARE_SA = '50000000-0000-4000-8000-000000000001';
const SHARE_SB = '50000000-0000-4000-8000-000000000002';
const SUPPLIER_PROFILE = '60000000-0000-4000-8000-000000000001';
const CERT_S = '70000000-0000-4000-8000-000000000001';
const REQ_AS = '80000000-0000-4000-8000-000000000001';
const ITEM_AS = '80000000-0000-4000-8000-000000000002';
const RESP_AS = '80000000-0000-4000-8000-000000000003';
const CERT_A_TO_S = '70000000-0000-4000-8000-000000000002';

/* -------------------------------------------------------------------------- *
 * Montage : chaine complete, puis fixture metier.
 * ------------------------------------------------------------------------- */
const dossiers = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
  .sort();
// La 70e migration porte le correctif. On l'applique APRES avoir mesure le
// defaut sur la chaine historique : la section A n'est pas une simulation, ce
// sont les politiques RLS reelles avant le correctif qui fuient.
// Le baseline s'arrete juste AVANT le correctif. Exclure uniquement cette
// migration tout en rejouant les suivantes reproduit un schema deja durci.
// Les fixtures sont peuplees avant d'appliquer le correctif et toute sa suite.
const DOSSIER_CORRECTIF = '20261106010000_active_tenant_access_guards';
const MIGRATION_TIMESTAMP_COLLISION_ORIGIN = '20261105180000_active_tenant_tc_registration_guard';
if (!dossiers.includes(DOSSIER_CORRECTIF) || !dossiers.includes(MIGRATION_TIMESTAMP_COLLISION_ORIGIN)) {
  console.error('  ECHEC — la migration corrective doit conserver un horodatage unique apres la migration TC existante');
  process.exit(1);
}
const avant = dossiers.filter((d) => d < DOSSIER_CORRECTIF);
const apres = dossiers.filter((d) => d >= DOSSIER_CORRECTIF);
const correctif = dossiers.filter((d) => d === DOSSIER_CORRECTIF);
if (correctif.length !== 1 || apres[0] !== DOSSIER_CORRECTIF) {
  console.error('  ECHEC — migration de correctif introuvable, dupliquee ou hors ordre');
  process.exit(1);
}

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
`);
for (const d of avant) {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
}
console.log(`  base jeteable : ${avant.length} migrations historiques appliquees, correctif NON applique, role tracefab_app provisionne`);

const doc = (id, owner, name) =>
  `('${id}','${owner}','tracefab-private','${owner}/${name}.pdf','${name}.pdf','application/pdf',10,'uploaded')`;

await db.exec(`
  INSERT INTO organizations (id,type,legal_name,status) VALUES
    ('${A}','brand','Marque A','active'),
    ('${B}','brand','Marque B','active'),
    ('${C}','brand','Marque C','active'),
    ('${S}','supplier','Fournisseur S','active'),
    ('${S2}','supplier','Fournisseur S2','active');

  INSERT INTO users (id,clerk_user_id,email,full_name) VALUES
    ('${U_MULTI}','clerk_multi','multi@example.test','Compte multi'),
    ('${U_A}','clerk_a','a@example.test','Compte A'),
    ('${U_B}','clerk_b','b@example.test','Compte B'),
    ('${U_S}','clerk_s','s@example.test','Compte S'),
    ('${U_REVOQUE}','clerk_revoque','revoque@example.test','Compte revoque'),
    ('${U_SANS_TENANT}','clerk_sans','sans@example.test','Sans tenant');

  INSERT INTO organization_memberships (organization_id,user_id,role,status) VALUES
    ('${A}','${U_MULTI}','admin','active'),
    ('${B}','${U_MULTI}','admin','active'),
    ('${S}','${U_MULTI}','admin','active'),
    ('${A}','${U_A}','admin','active'),
    ('${B}','${U_B}','admin','active'),
    ('${S}','${U_S}','admin','active'),
    ('${A}','${U_REVOQUE}','viewer','revoked');

  INSERT INTO tracefab_products (id,brand_organization_id,reference,name,status) VALUES
    ('${P_A}','${A}','REF-A','Produit prive A','draft'),
    ('${P_B}','${B}','REF-B','Produit prive B','draft'),
    ('${P_C}','${C}','REF-C','Produit prive C','draft');

  INSERT INTO suppliers (id,organization_id,onboarding_status) VALUES
    ('${SUPPLIER_PROFILE}','${S}','approved');

  INSERT INTO brand_supplier_relationships (id,brand_organization_id,supplier_organization_id,status,accepted_at) VALUES
    ('${REL_AS}','${A}','${S}','active',now()),
    ('${REL_BS}','${B}','${S}','active',now());

  INSERT INTO documents (id,owner_organization_id,storage_bucket,storage_path,original_filename,content_type,byte_size,status) VALUES
    ${[
      doc(D_A, A, 'da'), doc(D_B, B, 'db'), doc(D_S_PRIVE, S, 'ds-prive'),
      doc(D_S_VERS_A, S, 'ds-vers-a'), doc(D_S_VERS_B, S, 'ds-vers-b'),
      doc(D_A_VERS_S, A, 'da-vers-s'), doc(D_CERT_S, S, 'ds-cert'),
      doc(D_REPONSE, S, 'ds-reponse'),
    ].join(',\n    ')};
  SELECT set_config('tracefab.internal_document_update','true',false);
  UPDATE documents SET status='available', available_at=now();
  SELECT set_config('tracefab.internal_document_update','false',false);

  INSERT INTO data_shares (id,relationship_id,supplier_organization_id,grantee_organization_id,scope,status,starts_at) VALUES
    ('${SHARE_SA}','${REL_AS}','${S}','${A}',
      jsonb_build_object(
        'document_ids', jsonb_build_array('${D_S_VERS_A}'::text),
        'subject_ids', jsonb_build_array('${D_S_VERS_A}'::text)
      ),'active',now()),
    ('${SHARE_SB}','${REL_BS}','${S}','${B}',
      jsonb_build_object(
        'document_ids', jsonb_build_array('${D_S_VERS_B}'::text),
        'subject_ids', jsonb_build_array('${D_S_VERS_B}'::text)
      ),'active',now());

  INSERT INTO certifications (id,owner_organization_id,supplier_id,standard_name,document_id,status) VALUES
    ('${CERT_S}','${S}','${SUPPLIER_PROFILE}','GOTS','${D_CERT_S}','verified_by_reviewer');

  INSERT INTO data_requests (id,brand_organization_id,supplier_organization_id,title,questionnaire_key,questionnaire_version,status,relationship_id) VALUES
    ('${REQ_AS}','${A}','${S}','Collecte A','textile_base','1.0','submitted','${REL_AS}');
  INSERT INTO data_request_items (id,data_request_id,field_key,label,data_type) VALUES
    ('${ITEM_AS}','${REQ_AS}','composition','Composition','document');
  INSERT INTO data_responses (id,data_request_item_id,value,data_type,status,source_document_id) VALUES
    ('${RESP_AS}','${ITEM_AS}','"preuve"'::jsonb,'document','documented','${D_REPONSE}');

  -- Certificat emis par la marque A au nom du fournisseur S : voie de partage
  -- metier explicite, bornee au tenant fournisseur designe.
  INSERT INTO certifications (id,owner_organization_id,supplier_id,standard_name,document_id,status) VALUES
    ('${CERT_A_TO_S}','${A}','${SUPPLIER_PROFILE}','AUDIT-A','${D_A_VERS_S}','verified_by_reviewer');
`);

/* -------------------------------------------------------------------------- *
 * Contexte de session : exactement ce que pose `withTracefab*Context`.
 * ------------------------------------------------------------------------- */
await db.exec('SET ROLE tracefab_app');

async function contexte(userId, tenantId) {
  await db.query(`SELECT set_config('tracefab.user_id',$1,false)`, [userId ?? '']);
  await db.query(`SELECT set_config('tracefab.user_email','isolation@example.test',false)`);
  await db.query(`SELECT set_config('tracefab.active_organization_id',$1,false)`, [tenantId ?? '']);
  await db.query(`SELECT set_config('tracefab.identity','',false)`);
  // En mode permissif (aucune cle HMAC dans cette base jetable), l'identite
  // vient du GUC : c'est exactement le contexte de deploiement progressif P10.5.
}

const scalar = async (sql, params = []) => {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
};
const guardDoc = (documentId) => scalar(
  `SELECT tracefab_document_accessible_in_active_tenant($1::uuid)`, [documentId]);
const guardProduit = (productId) => scalar(
  `SELECT tracefab_product_accessible_in_active_tenant($1::uuid)`, [productId]);
const legacyDoc = (documentId) => scalar(
  `SELECT tracefab_can_access_document($1::uuid)`, [documentId]);
const produitsVisibles = async () => {
  const r = await db.query(`SELECT id FROM tracefab_products ORDER BY id`);
  return r.rows.map((x) => x.id);
};
const documentsVisibles = async () => {
  const r = await db.query(`SELECT id FROM documents ORDER BY id`);
  return r.rows.map((x) => x.id);
};
/** Reproduit exactement la requete de `accessibleProduct` (api/_lib/quality.ts). */
const accessibleProduct = async (productId) => {
  const r = await db.query(
    `SELECT id FROM tracefab_products
      WHERE id = $1::uuid AND tracefab_product_accessible_in_active_tenant(id)
      LIMIT 1`, [productId]);
  return r.rows.length === 1;
};

/* ========================================================================== *
 * A. Le defaut mesure : les politiques RLS bornent l'utilisateur, pas le tenant
 * ========================================================================== */
section('A. Defaut MESURE sur la chaine historique, avant le correctif');
await contexte(U_MULTI, A);
const visibles = await produitsVisibles();
ok('AVANT : la RLS produit historique masque deja le produit B au tenant A',
  visibles.includes(P_A) && !visibles.includes(P_B), `${visibles.length} produit(s) visibles`);
const docsAvant = await documentsVisibles();
ok('AVANT : les documents de A, B et S sont visibles avec le tenant A arme',
  [D_A, D_B, D_S_PRIVE].every((id) => docsAvant.includes(id)),
  `${docsAvant.length} documents visibles`);
ok('AVANT : tracefab_can_access_document(document de B) = vrai avec le tenant A',
  await legacyDoc(D_B) === true);
ok('AVANT : tracefab_can_access_document(document prive de S) = vrai avec le tenant A',
  await legacyDoc(D_S_PRIVE) === true);

/* --- Application du correctif et de toutes les migrations suivantes --- */
await db.exec('RESET ROLE');
for (const d of apres) {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
}
await db.exec('SET ROLE tracefab_app');
await contexte(U_MULTI, A);

section('A2. Meme mesure APRES le correctif : la fuite RLS est fermee');
const docsApres = await documentsVisibles();
ok('APRES : le document prive de B n est plus visible depuis le tenant A',
  !docsApres.includes(D_B), `${docsApres.length} documents visibles`);
ok('APRES : le document prive de S n est plus visible depuis le tenant A',
  !docsApres.includes(D_S_PRIVE), `${docsApres.length} documents visibles`);
ok('APRES : le document possede par A reste visible',
  docsApres.includes(D_A));
ok('APRES : tracefab_can_access_document(document de B) = faux avec le tenant A',
  await legacyDoc(D_B) === false);
ok('APRES : tracefab_can_access_document(document prive de S) = faux avec le tenant A',
  await legacyDoc(D_S_PRIVE) === false);
ok('LE GARDE LIE AU TENANT refuse le document de B', await guardDoc(D_B) === false);
ok('LE GARDE LIE AU TENANT refuse le document prive de S', await guardDoc(D_S_PRIVE) === false);
ok('LE GARDE LIE AU TENANT accepte le document possede par A', await guardDoc(D_A) === true);
ok('APRES : le garde produit refuse le produit de B', await guardProduit(P_B) === false);
ok('APRES : le garde produit accepte le produit de A', await guardProduit(P_A) === true);

section('A3. Non-regression RLS : partages fournisseur et contexts sans tenant');
await contexte(U_A, A);
const rlsA = await documentsVisibles();
ok('RLS tenant A : le document partage S->A reste visible', rlsA.includes(D_S_VERS_A));
ok('RLS tenant A : le document partage S->B reste refuse', !rlsA.includes(D_S_VERS_B));
await contexte(U_B, B);
const rlsB = await documentsVisibles();
ok('RLS tenant B : le document partage S->B reste visible', rlsB.includes(D_S_VERS_B));
// Le partage S->A est visible depuis A (assertion precedente) mais PAS depuis
// B : c'est exactement la separation des deux relations fournisseur-marque.
ok('RLS tenant B : le document partage S->A reste refuse', !rlsB.includes(D_S_VERS_A));
await contexte(U_S, S);
const rlsS = await documentsVisibles();
ok('RLS tenant S : ses propres documents restent visibles dans tous les etats',
  rlsS.includes(D_S_PRIVE) && rlsS.includes(D_S_VERS_A));
ok('RLS tenant S : le document prive de A reste refuse', !rlsS.includes(D_A));
ok('RLS tenant S : le certificat explicitement emis par A a son nom reste visible',
  rlsS.includes(D_A_VERS_S));
ok('RLS tenant B : ce meme certificat A->S reste refuse', !rlsB.includes(D_A_VERS_S));
await contexte(U_MULTI, null);
const rlsSansTenant = await documentsVisibles();
ok('tracefab_app sans tenant actif : aucune ligne documentaire visible (fail-closed)',
  rlsSansTenant.length === 0, `${rlsSansTenant.length} document(s) visibles`);
await contexte(U_MULTI, A);

/* ========================================================================== *
 * B. Matrice d'autorisation : les dix scenarios metier de la mission
 * ========================================================================== */
section('B. Matrice proprietaire / tenant actif / relation / partage');

// 1. Une marque accede a ses propres produits.
await contexte(U_A, A);
ok('1. marque A : son produit est accessible', await guardProduit(P_A) === true);
ok('1. marque A : la requete de la route (accessibleProduct) le retrouve',
  await accessibleProduct(P_A) === true);

// 2. Une marque ne peut pas consulter les produits prives d'une autre marque.
ok('2. marque A : produit de B refuse par ID exact', await guardProduit(P_B) === false);
ok('2. marque A : produit de C refuse', await guardProduit(P_C) === false);
ok('2. marque A : la route ne retrouve pas le produit de B',
  await accessibleProduct(P_B) === false);

// 3. Un fournisseur accede aux donnees explicitement partagees par la marque A
//    (certificat emis par A au nom de S).
await contexte(U_S, S);
ok('3. fournisseur S : certificat partage par la marque A accessible',
  await guardDoc(D_A_VERS_S) === true);
ok('3. marque B : le meme certificat, hors de sa relation, reste inaccessible',
  await (async () => { await contexte(U_B, B); return guardDoc(D_A_VERS_S); })() === false);
await contexte(U_S, S);

// 4. Le meme fournisseur ne peut pas acceder aux donnees privees de la marque B.
ok('4. fournisseur S : document prive de B refuse', await guardDoc(D_B) === false);

// 5. Un fournisseur travaillant avec deux marques ne peut pas melanger leurs donnees.
ok('5. fournisseur S : son propre document reste accessible (propriete)',
  await guardDoc(D_S_VERS_B) === true);
ok('5. fournisseur S : donnee privee de la marque B inaccessible',
  await guardDoc(D_B) === false);
ok('5. fournisseur S : donnee privee de la marque A inaccessible',
  await guardDoc(D_A) === false);
ok('5. fournisseur S : seule la piece explicitement partagee par A est visible',
  await guardDoc(D_A_VERS_S) === true);
ok('5. fournisseur S : son propre document non partage reste accessible',
  await guardDoc(D_S_PRIVE) === true);
await contexte(U_MULTI, A);
ok('5. marque A avec relation A<->S : document partage a A accessible',
  await guardDoc(D_S_VERS_A) === true);
ok('5. marque A : document partage a B uniquement refuse',
  await guardDoc(D_S_VERS_B) === false);

// 6. Utilisateur membre de plusieurs marques : seulement le tenant actif,
//    sauf partage metier explicite.
await contexte(U_MULTI, A);
ok('6. compte multi, tenant A : produit A autorise', await guardProduit(P_A) === true);
ok('6. compte multi, tenant A : produit B refuse', await guardProduit(P_B) === false);
ok('6. compte multi, tenant A : document de B refuse', await guardDoc(D_B) === false);
await contexte(U_MULTI, B);
ok('6. compte multi, tenant B : produit B autorise', await guardProduit(P_B) === true);
ok('6. compte multi, tenant B : produit A refuse', await guardProduit(P_A) === false);
ok('6. compte multi, tenant B : document de A refuse', await guardDoc(D_A) === false);
ok('6. compte multi, tenant B : partage metier explicite S->B accessible',
  await guardDoc(D_S_VERS_B) === true);

// 7. Revocation d'une relation fournisseur-marque : droits retires immediatement.
await contexte(U_MULTI, A);
ok('7. avant revocation : partage S->A actif', await guardDoc(D_S_VERS_A) === true);
ok('7. avant revocation : certificat fournisseur via relation active',
  await guardDoc(D_CERT_S) === true);
ok('7. avant revocation : preuve de collecte A<->S', await guardDoc(D_REPONSE) === true);
await db.exec('RESET ROLE');
await db.exec(`UPDATE brand_supplier_relationships SET status='ended', ended_at=now() WHERE id='${REL_AS}'`);
await db.exec('SET ROLE tracefab_app');
await contexte(U_MULTI, A);
ok('7. apres revocation de la relation A<->S : partage retire',
  await guardDoc(D_S_VERS_A) === false);
ok('7. apres revocation : certificat fournisseur retire',
  await guardDoc(D_CERT_S) === false);
ok('7. apres revocation : preuve de collecte retiree',
  await guardDoc(D_REPONSE) === false);
ok('7. la relation B<->S, elle, reste active (pas de retrait global)',
  (await (async () => { await contexte(U_MULTI, B); return guardDoc(D_S_VERS_B); })()) === true);
await db.exec('RESET ROLE');
await db.exec(`UPDATE brand_supplier_relationships SET status='active', ended_at=NULL WHERE id='${REL_AS}'`);
await db.exec('SET ROLE tracefab_app');

// 8. Un document partage reste accessible dans le perimetre du partage.
await contexte(U_A, A);
ok('8. marque A : document du fournisseur partage a A accessible',
  await guardDoc(D_S_VERS_A) === true);
ok('8. marque A : document du fournisseur partage a B uniquement refuse',
  await guardDoc(D_S_VERS_B) === false);

// 9. Un document non partage reste inaccessible, meme avec son identifiant exact.
ok('9. marque A : document prive du fournisseur refuse par ID exact',
  await guardDoc(D_S_PRIVE) === false);
ok('9. marque A : document prive de B refuse par ID exact',
  await guardDoc(D_B) === false);
ok('9. document supprime logiquement : refuse',
  await (async () => {
    await db.exec('RESET ROLE');
    await db.exec(`SELECT set_config('tracefab.internal_document_update','true',false);
      UPDATE documents SET deleted_at=now(), status='deleted' WHERE id='${D_A}';
      SELECT set_config('tracefab.internal_document_update','false',false);`);
    await db.exec('SET ROLE tracefab_app');
    await contexte(U_A, A);
    const res = await guardDoc(D_A);
    await db.exec('RESET ROLE');
    await db.exec(`SELECT set_config('tracefab.internal_document_update','true',false);
      UPDATE documents SET deleted_at=NULL, status='available' WHERE id='${D_A}';
      SELECT set_config('tracefab.internal_document_update','false',false);`);
    await db.exec('SET ROLE tracefab_app');
    return res;
  })() === false);

// 10. Changement de tenant : aucun droit herite du tenant precedent.
await contexte(U_MULTI, A);
ok('10. tenant A : document A autorise', await guardDoc(D_A) === true);
await contexte(U_MULTI, B);
ok('10. bascule vers B : document A devient inaccessible', await guardDoc(D_A) === false);
ok('10. bascule vers B : produit A devient inaccessible', await guardProduit(P_A) === false);
await contexte(U_MULTI, A);
ok('10. retour vers A : aucun droit sur B n a ete conserve', await guardDoc(D_B) === false);

/* ========================================================================== *
 * C. Contextes absents, invalides, falsifies, adhesions revoquees
 * ========================================================================== */
section('C. Refus fermes : tenant absent, falsifie, adhesion revoquee');

await contexte(U_MULTI, null);
ok('aucun tenant actif : garde documentaire faux', await guardDoc(D_A) === false);
ok('aucun tenant actif : garde produit faux', await guardProduit(P_A) === false);
ok('aucun tenant actif : requete de route ne retrouve aucun produit',
  await accessibleProduct(P_A) === false);

await contexte(null, A);
ok('identite absente : garde documentaire faux', await guardDoc(D_A) === false);

await contexte(U_A, C);
ok('tenant falsifie (C, sans adhesion) : garde documentaire faux',
  await guardDoc(D_A) === false);
ok('tenant falsifie (C, sans adhesion) : garde produit faux',
  await guardProduit(P_C) === false);

await contexte(U_SANS_TENANT, A);
ok('utilisateur sans adhesion : garde faux', await guardProduit(P_A) === false);

await contexte(U_REVOQUE, A);
ok('adhesion revoquee : garde documentaire faux', await guardDoc(D_A) === false);
ok('adhesion revoquee : garde produit faux', await guardProduit(P_A) === false);

/* ========================================================================== *
 * D. Stockage : la cle n'est jamais un mecanisme d'autorisation
 * ========================================================================== */
section('D. Stockage prive et cycle documentaire');
await db.exec('RESET ROLE');
let pathRefus = false;
try {
  await db.query(`
    INSERT INTO documents (id,owner_organization_id,storage_bucket,storage_path,original_filename,content_type,byte_size,status)
    VALUES ($1,$2,'tracefab-private',$3,'vol.pdf','application/pdf',10,'uploaded')`,
    ['30000000-0000-4000-8000-000000000099', A, `${B}/vol.pdf`]);
} catch (error) {
  pathRefus = /document_path_must_be_tenant_scoped/.test(String(error.message));
}
ok('une cle de stockage non prefixee par le tenant proprietaire est refusee par la base',
  pathRefus);
const chemins = await db.query(`SELECT count(*)::int AS n FROM documents WHERE storage_path NOT LIKE owner_organization_id::text || '/%'`);
ok('tous les documents de la fixture ont une cle bornee a leur proprietaire',
  chemins.rows[0].n === 0);
await db.exec('SET ROLE tracefab_app');

/* ========================================================================== *
 * E. Catalogue des fonctions SECURITY DEFINER (proprietaire, search_path, ACL)
 * ========================================================================== */
section('E. Fonctions SECURITY DEFINER : inventaire par catalogue');
const secdef = await db.query(`
  SELECT p.proname AS name,
         pg_catalog.pg_get_userbyid(p.proowner) AS owner,
         p.proconfig AS config,
         EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(
             COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
         ) AS public_execute
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
   ORDER BY 1`);
const sansSearchPath = secdef.rows.filter((f) => !f.config?.some((c) => c.startsWith('search_path=')));
const publicExecute = secdef.rows.filter((f) => f.public_execute);
const proprietaireInconnu = secdef.rows.filter((f) => !['postgres', 'tracefab_worker'].includes(f.owner));
ok(`${secdef.rows.length} fonctions SECURITY DEFINER inventoriees`, secdef.rows.length > 0);
ok('toutes ont un search_path epingle', sansSearchPath.length === 0,
  sansSearchPath.map((f) => f.name).join(', '));
ok('aucune n est executable par PUBLIC', publicExecute.length === 0,
  publicExecute.map((f) => f.name).join(', '));
ok('proprietaires limites au role de migration et a tracefab_worker',
  proprietaireInconnu.length === 0, proprietaireInconnu.map((f) => `${f.name}:${f.owner}`).join(', '));
const gardes = secdef.rows.filter((f) => f.name.endsWith('_accessible_in_active_tenant'));
ok('les deux gardes de tenant sont SECURITY DEFINER et epingles', gardes.length === 2
  && gardes.every((f) => f.config?.some((c) => c.startsWith('search_path='))),
  gardes.map((f) => f.name).join(', '));

/* -------------------------------------------------------------------------- *
 * Resultat
 * ------------------------------------------------------------------------- */
await db.close();
console.log(`\nIsolation globale (base jetable) : ${verifies} controles, ${echecs} echec(s).`);
if (echecs === 0) {
  console.log('Rappel : ceci est une preuve de NIVEAU 1. Elle ne valide ni Preview ni Production.');
}
process.exit(echecs === 0 ? 0 : 1);
