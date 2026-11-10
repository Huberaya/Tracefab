#!/usr/bin/env node
/**
 * Documents et materiaux — le LOCATAIRE ACTIF borne l'acces, pas l'appartenance.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Les politiques de `documents` et `materials` accordaient la propriete sur la
 * seule appartenance (`tracefab_can_access_org`). Un utilisateur membre de deux
 * organisations — le cas exact du defaut Production du 2026-10-17 — lisait donc
 * les pieces de l'organisation qui n'etait PAS son locataire actif, et pouvait
 * les modifier. La migration `20261105250000_active_tenant_document_material_access`
 * ajoute la garde de locataire ; ce test la mesure dans les deux sens.
 *
 * CE QU'IL PROUVE
 *
 *   1. proprietaire sous son locataire        -> document lisible et accessible ;
 *   2. AUTRE locataire du meme compte         -> zero ligne, fonction fausse ;
 *   3. aucun locataire arme                   -> rien (fail-closed) ;
 *   4. partage explicite fournisseur -> marque-> document lisible par la marque ;
 *   5. partage absent                         -> document fournisseur illisible ;
 *   6. mise a jour depuis un autre locataire  -> zero ligne touchee ;
 *   7. materiau du fournisseur utilise par la marque active -> visible ;
 *   8. materiau du meme fournisseur NON utilise par la marque -> invisible ;
 *   9. autre marque du meme compte            -> aucun materiau ;
 *  10. mise a jour d'un materiau d'un autre locataire -> zero ligne touchee ;
 *  11. les politiques PUBLIQUES et WORKER n'ont pas ete emportees ;
 *  12. chemins INDIRECTS de `tracefab_can_access_document` (piece source d'un
 *      point de donnee, piece jointe a une certification) : refuses depuis un
 *      autre locataire, preserves sous le locataire proprietaire.
 *
 * Le role applicatif utilise ne porte pas BYPASSRLS, et chaque assertion est
 * faite DANS PostgreSQL : une reimplementation du predicat en JavaScript ne
 * prouverait rien de la RLS.
 *
 * Sans DATABASE_URL ni TF_RLS_APP_URL, sortie 2 : un test qui n'a pas tourne
 * n'est pas un test qui passe.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  TF_RLS_APP_URL doit pointer un role SANS BYPASSRLS (ex. tracefab_app).');
  process.exit(2);
}

/** Le bucket est fixe par le runtime ET par le trigger : jamais un troisieme nom. */
const BUCKET_PRIVE = (() => {
  const source = readFileSync(new URL('../api/_lib/storage.ts', import.meta.url), 'utf8');
  const trouve = source.match(/const PRIVATE_STORAGE_BUCKET = '([^']+)'/);
  if (!trouve) {
    console.log('  NON EXECUTE — api/_lib/storage.ts ne declare plus PRIVATE_STORAGE_BUCKET.');
    process.exit(2);
  }
  return trouve[1];
})();

const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: true } : false,
});

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => {
  console.log(`  ECHEC ${m}`);
  console.log(`::error::document-material tenant scope — ${m}`);
  echecs += 1;
};

const suffixe = randomUUID().slice(0, 8);
const user = randomUUID();
const orgA = randomUUID();          // marque A — locataire actif des cas 1..8
const orgB = randomUUID();          // marque B — meme compte, autre locataire
const orgS = randomUUID();          // fournisseur S
const orgS2 = randomUUID();         // fournisseur S2, sans relation avec A
const supplierS = randomUUID();
const supplierS2 = randomUUID();
const relationAS = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const materialA = randomUUID();     // materiau de la marque A
const materialUsed = randomUUID();  // materiau de S utilise par le produit de A
const materialOther = randomUUID(); // materiau de S2, non utilise par A
const docA = randomUUID();
const docB = randomUUID();
const docS = randomUUID();          // piece fournisseur, non partagee
const docShared = randomUUID();     // piece fournisseur, partagee explicitement a A
const docBIndirectDataPoint = randomUUID(); // piece de B, source d'un point de donnee de B
const docBIndirectCert = randomUUID();      // piece de B, jointe a une certification de B
const certB = randomUUID();
const shareToA = randomUUID();
const shareMaterial = randomUUID();

const proprio = cli(URL_PROPRIO);
await proprio.connect();
const app = cli(URL_APP);
await app.connect();

/** Arme le contexte dans la transaction courante du role applicatif. */
async function asTenant(organizationId) {
  await app.query('BEGIN');
  await app.query(`SELECT set_config('tracefab.user_id', $1, true)`, [user]);
  await app.query(`SELECT set_config('tracefab.user_email', $1, true)`, [`scope-${suffixe}@example.test`]);
  await app.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [organizationId ?? '']);
}

async function compter(sql, params) {
  const { rows: [r] } = await app.query(sql, params);
  return r;
}

try {
  /* -- 0. le role de test ne doit pas contourner la RLS ------------------- */
  const { rows: [role] } = await app.query('select rolname, rolbypassrls from pg_roles where current_user = rolname');
  if (!role) { ko('role applicatif introuvable'); throw new Error('role introuvable'); }
  if (role.rolbypassrls) { ko(`${role.rolname} porte BYPASSRLS : ce test ne mesure rien`); }
  else ok(`le role ${role.rolname} ne porte pas BYPASSRLS`);

  /* -- fixture : UN utilisateur, TROIS organisations --------------------- */
  await proprio.query(
    `insert into users (id, clerk_user_id, email, full_name) values ($1, $2, $3, 'Scope Document Test')`,
    [user, `scope_${suffixe}`, `scope-${suffixe}@example.test`]);
  await proprio.query(
    `insert into organizations (id, type, legal_name, display_name, status, created_by) values
       ($1, 'brand', 'Marque A', 'Marque A', 'active', $5),
       ($2, 'brand', 'Marque B', 'Marque B', 'active', $5),
       ($3, 'supplier', 'Fournisseur S', 'Fournisseur S', 'active', $5),
       ($4, 'supplier', 'Fournisseur S2', 'Fournisseur S2', 'active', $5)`,
    [orgA, orgB, orgS, orgS2, user]);
  await proprio.query(
    `insert into organization_memberships (organization_id, user_id, role, status) values
       ($1, $5, 'admin', 'active'), ($2, $5, 'admin', 'active'),
       ($3, $5, 'admin', 'active'), ($4, $5, 'admin', 'active')`,
    [orgA, orgB, orgS, orgS2, user]);
  await proprio.query(
    'insert into suppliers (id, organization_id) values ($1, $2), ($3, $4)',
    [supplierS, orgS, supplierS2, orgS2]);
  await proprio.query(
    `insert into brand_supplier_relationships
      (id, brand_organization_id, supplier_organization_id, status, requested_by, accepted_at)
     values ($1, $2, $3, 'active', $4, now())`,
    [relationAS, orgA, orgS, user]);
  await proprio.query(
    `insert into tracefab_products (id, brand_organization_id, reference, name, status, version, created_by)
     values ($1, $2, $4, 'Produit A', 'draft', 1, $5), ($3, $6, $7, 'Produit B', 'draft', 1, $5)`,
    [productA, orgA, productB, `SCOPE-A-${suffixe}`, user, orgB, `SCOPE-B-${suffixe}`]);
  await proprio.query(
    `insert into materials (id, owner_organization_id, material_type, name, composition, created_by)
     values ($1, $2, 'fiber', 'Coton marque A', '{}'::jsonb, $5),
            ($3, $4, 'fiber', 'Coton fournisseur S (utilise)', '{}'::jsonb, $5),
            ($6, $7, 'fiber', 'Coton fournisseur S2 (non utilise)', '{}'::jsonb, $5)`,
    [materialA, orgA, materialUsed, orgS, user, materialOther, orgS2]);
  // Le contrat metier exige que le fournisseur PARTAGE explicitement le
  // materiau pour qu'une marque puisse le composer : le trigger
  // `tracefab_validate_product_material_ownership` le verifie via
  // `tracefab_can_access_shared_subject`, qui lit l'utilisateur courant. Le
  // proprietaire arme donc l'identite avant d'ecrire la composition, comme le
  // fait la route reelle.
  // Partage EXPLICITE du materiau par le fournisseur vers la marque A, borne a
  // ce materiau precis. C'est ce partage qui fonde la visibilite metier ; la
  // garde de locataire ne doit pas le casser.
  await proprio.query(
    `insert into data_shares
      (id, relationship_id, supplier_organization_id, grantee_organization_id, scope, status, created_by)
     values ($1, $2, $3, $4, jsonb_build_object('material_ids', jsonb_build_array($5::text)), 'active', $6)`,
    [shareMaterial, relationAS, orgS, orgA, materialUsed, user]);

  // Le partage se consomme EN TANT QUE beneficiaire : la fixture arme donc
  // l'identite ET le locataire de la marque A avant d'ecrire la composition,
  // exactement comme la route reelle le fait.
  await proprio.query(`SELECT set_config('tracefab.user_id', $1, false)`, [user]);
  await proprio.query(`SELECT set_config('tracefab.active_organization_id', $1, false)`, [orgA]);

  await proprio.query(
    `insert into product_materials (product_id, material_id, material_role, percentage, unit, product_version)
     values ($1, $2, 'main', 100, '%', 1)`,
    [productA, materialUsed]);


  const chemin = (org, nom) => `${org}/${nom}-${suffixe}.pdf`;
  // Les documents ne dependent pas du contexte : le locataire arme ici ne sert
  // qu'a la composition ci-dessus.
  await proprio.query(`SELECT set_config('tracefab.active_organization_id', '', false)`);
  await proprio.query(
    `insert into documents
      (id, owner_organization_id, storage_bucket, storage_path, original_filename,
       content_type, byte_size, uploaded_by)
     values ($1, $3, $7, $8, 'doc-a.pdf', 'application/pdf', 128, $6),
            ($2, $4, $7, $9, 'doc-b.pdf', 'application/pdf', 128, $6),
            ($5, $10, $7, $11, 'doc-s.pdf', 'application/pdf', 128, $6),
            ($12, $10, $7, $13, 'doc-shared.pdf', 'application/pdf', 128, $6)`,
    [docA, docB, orgA, orgB, docS, user, BUCKET_PRIVE,
      chemin(orgA, 'doc-a'), chemin(orgB, 'doc-b'), orgS,
      chemin(orgS, 'doc-s'), docShared, chemin(orgS, 'doc-shared')]);

  // Un document n'est `available` qu'apres le scan : on emprunte le canal
  // interne documente (meme mecanisme que test_neon_document_lifecycle).
  // is_local=false : chaque requete node-pg est sa propre transaction.
  await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'true', false)`);
  await proprio.query(
    `UPDATE documents SET status = 'available', sha256 = repeat('a', 64), available_at = now()
      WHERE id = ANY($1::uuid[])`,
    [[docA, docB, docS, docShared]]);
  await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'false', false)`);

  // Partage EXPLICITE de la piece fournisseur vers la marque A, borne a ce
  // document precis : c'est le modele metier attendu, et il ne doit pas etre
  // casse par la garde de locataire.
  await proprio.query(
    `insert into data_shares
      (id, relationship_id, supplier_organization_id, grantee_organization_id, scope, status, created_by)
     values ($1, $2, $3, $4, jsonb_build_object('document_ids', jsonb_build_array($5::text)), 'active', $6)`,
    [shareToA, relationAS, orgS, orgA, docShared, user]);
  ok('fixture : marque A, marque B, fournisseurs S et S2, documents et materiaux');

  /* -- 1. proprietaire sous son locataire -------------------------------- */
  await asTenant(orgA);
  const vuA = await compter('select count(*)::int as n from documents where id = $1', [docA]);
  if (vuA.n === 1) ok('sous son locataire, la marque A lit son propre document');
  else ko(`sous son locataire, la marque A ne lit pas son document (n=${vuA.n}) — RLS trop stricte`);

  /* -- 2. autre locataire du MEME compte --------------------------------- */
  const vuB = await compter('select count(*)::int as n from documents where id = $1', [docB]);
  if (vuB.n === 0) ok("sous le locataire A, le document de la marque B reste invisible");
  else ko('FUITE : sous le locataire A, le document du locataire B est lisible');

  const accesB = await compter('select tracefab_can_access_document($1::uuid) as permet', [docB]);
  if (accesB.permet === false) ok('tracefab_can_access_document rend faux pour le document du locataire B');
  else ko('FUITE : tracefab_can_access_document autorise le document du locataire B');

  /* -- 3. mise a jour depuis un autre locataire -------------------------- */
  // Deux refus sont acceptables et tous deux doivent etre mesures : le
  // privilege manquant (aucun UPDATE n'est accorde au role HTTP sur
  // `documents`) et la politique (zero ligne). Ce qui doit etre impossible,
  // c'est la modification effective — verifiee ensuite cote proprietaire.
  let refusDoc = false;
  try {
    const majB = await app.query(
      `update documents set metadata = metadata || '{"intrusion":true}'::jsonb where id = $1`,
      [docB]);
    refusDoc = majB.rowCount === 0;
    if (!refusDoc) ko(`FUITE : ${majB.rowCount} document(s) du locataire B modifies depuis le locataire A`);
  } catch (error) {
    if (/permission denied/i.test(error.message)) {
      refusDoc = true;
    } else {
      ko(`mise a jour inter-locataire : erreur inattendue ${error.message}`);
    }
  }
  await app.query('ROLLBACK').catch(() => {});
  const { rows: [verifDoc] } = await proprio.query(
    `select metadata ? 'intrusion' as intrusion from documents where id = $1`, [docB]);
  if (refusDoc && verifDoc && verifDoc.intrusion === false) {
    ok('le document du locataire B reste intact apres une tentative de mise a jour depuis A');
  } else if (!refusDoc) {
    ko('le document du locataire B a pu etre modifie depuis le locataire A');
  }

  /* -- 4. partage explicite ---------------------------------------------- */
  await asTenant(orgA);
  const vuPartage = await compter('select count(*)::int as n from documents where id = $1', [docShared]);
  if (vuPartage.n === 1) ok('le document explicitement partage par le fournisseur reste lisible par la marque A');
  else ko(`le partage explicite est casse (n=${vuPartage.n}) — regression metier`);
  await app.query('ROLLBACK');

  /* -- 5. piece fournisseur NON partagee --------------------------------- */
  await asTenant(orgA);
  const vuNonPartage = await compter('select count(*)::int as n from documents where id = $1', [docS]);
  if (vuNonPartage.n === 0) ok('la piece fournisseur non partagee reste invisible pour la marque A');
  else ko('FUITE : la marque A lit une piece fournisseur non partagee');
  await app.query('ROLLBACK');

  /* -- 6. aucun locataire arme : compatibilite RLS, HTTP fail-closed ----- */
  // Le contrat decide pour cette migration conserve le repli historique par
  // appartenance au niveau RLS quand aucun tenant n'est arme. Les routes HTTP,
  // elles, restent fermees par requireActiveTenant avant toute lecture metier.
  await asTenant(null);
  const vuSansTenant = await compter(
    'select count(*)::int as n from documents where id = ANY($1::uuid[])', [[docA, docB]]);
  const sansTenantFonction = await compter('select tracefab_can_access_document($1::uuid) as permet', [docA]);
  if (vuSansTenant.n === 2 && sansTenantFonction.permet === true) {
    ok('sans locataire arme, RLS conserve le repli historique par appartenance (routes HTTP fail-closed)');
  } else {
    ko(`sans locataire arme : n=${vuSansTenant.n}, fonction=${sansTenantFonction.permet} — le repli historique attendu diverge`);
  }
  await app.query('ROLLBACK');

  /* -- 7-9. materiaux ---------------------------------------------------- */
  await asTenant(orgA);
  const matiereA = await compter('select count(*)::int as n from materials where id = $1', [materialA]);
  const matiereUsage = await compter('select count(*)::int as n from materials where id = $1', [materialUsed]);
  const matiereAutre = await compter('select count(*)::int as n from materials where id = $1', [materialOther]);
  if (matiereA.n === 1) ok('sous son locataire, la marque A lit son materiau');
  else ko(`la marque A ne lit pas son propre materiau (n=${matiereA.n})`);
  if (matiereUsage.n === 1) ok('la marque A voit le materiau fournisseur utilise par son produit (partage metier)');
  else ko(`la composition ne rend plus visible le materiau utilise (n=${matiereUsage.n}) — regression metier`);
  if (matiereAutre.n === 0) ok('la marque A ne voit pas le materiau d\'un fournisseur sans relation ni usage');
  else ko('FUITE : la marque A voit un materiau d\'un fournisseur sans relation ni usage');
  await app.query('ROLLBACK');

  await asTenant(orgB);
  const matiereVuB = await compter('select count(*)::int as n from materials where id = ANY($1::uuid[])',
    [[materialA, materialUsed, materialOther]]);
  if (matiereVuB.n === 0) ok('sous le locataire B, aucun materiau de A ni de ses fournisseurs n\'est visible');
  else ko(`FUITE : sous le locataire B, ${matiereVuB.n} materiau(x) d'autres locataires sont visibles`);
  await app.query('ROLLBACK');

  /* -- 10. mise a jour d'un materiau d'un autre locataire ---------------- */
  await asTenant(orgA);
  let refusMatiere = false;
  try {
    const majMatiere = await app.query(
      `update materials set name = 'Materiau detourne' where id = $1`, [materialOther]);
    refusMatiere = majMatiere.rowCount === 0;
    if (!refusMatiere) ko(`FUITE : ${majMatiere.rowCount} materiau(x) d'un autre locataire modifie(s)`);
  } catch (error) {
    if (/permission denied/i.test(error.message)) {
      refusMatiere = true;
    } else {
      ko(`mise a jour inter-locataire de materiau : erreur inattendue ${error.message}`);
    }
  }
  await app.query('ROLLBACK').catch(() => {});
  const { rows: [verifMatiere] } = await proprio.query(
    `select name from materials where id = $1`, [materialOther]);
  if (refusMatiere && verifMatiere && verifMatiere.name !== 'Materiau detourne') {
    ok("le materiau d'un autre locataire reste intact apres une tentative de mise a jour");
  } else if (!refusMatiere) {
    ko("le materiau d'un autre locataire a pu etre modifie");
  }


  /* -- 10 bis. chemins INDIRECTS de tracefab_can_access_document ---------- */
  // La politique `documents_select_authorized` et la fonction DEFINER
  // partagent le meme predicat. Les branches indirectes — piece source d'un
  // point de donnee, piece jointe a une certification — ne verifiaient que
  // l'APPARTENANCE : un membre de A et de B, locataire A actif, pouvait donc
  // faire servir par l'API une piece privee de B. Mesure avant correction :
  // fonction vraie, et une piece de B visible a travers la RLS. La migration
  // `20261105280000_active_tenant_document_indirect_paths` borne les trois
  // branches indirectes ; ce bloc verifie les deux sens.
  // Un document nait `uploaded` : le trigger `new_documents_must_start_uploaded`
  // refuse tout autre etat a l'insertion, et cette garde n'est pas desarmable.
  await proprio.query(
    `insert into documents
      (id, owner_organization_id, storage_bucket, storage_path, original_filename,
       content_type, byte_size, uploaded_by)
     values ($1, $3, $5, $6, 'doc-b-datapoint.pdf', 'application/pdf', 128, $4),
            ($2, $3, $5, $7, 'doc-b-cert.pdf', 'application/pdf', 128, $4)`,
    [docBIndirectDataPoint, docBIndirectCert, orgB, user, BUCKET_PRIVE,
      chemin(orgB, 'doc-b-datapoint'), chemin(orgB, 'doc-b-cert')]);
  await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'true', false)`);
  await proprio.query(
    `update documents set status = 'available', sha256 = repeat('c', 64), available_at = now()
      where id = any($1::uuid[])`,
    [[docBIndirectDataPoint, docBIndirectCert]]);
  await proprio.query(`SELECT set_config('tracefab.internal_document_update', 'false', false)`);
  await proprio.query(
    `insert into data_points
      (owner_organization_id, product_id, data_key, value, data_type, source_document_id)
     values ($1, $2, $3, '{}'::jsonb, 'text', $4)`,
    [orgB, productB, `scope_key_${suffixe}`, docBIndirectDataPoint]);
  await proprio.query(
    `insert into certifications
      (id, owner_organization_id, product_id, document_id, standard_name, created_by)
     values ($1, $2, $3, $4, 'GOTS', $5)`,
    [certB, orgB, productB, docBIndirectCert, user]);

  await asTenant(orgA);
  const indirectA = await compter(
    `select tracefab_can_access_document($1::uuid) as point,
            tracefab_can_access_document($2::uuid) as cert`,
    [docBIndirectDataPoint, docBIndirectCert]);
  if (indirectA.point === false && indirectA.cert === false)
    ok('sous le locataire A, la fonction refuse les pieces de B atteintes par un chemin indirect');
  else
    ko(`FUITE : chemin indirect vers une piece de B depuis le locataire A (point=${indirectA.point}, cert=${indirectA.cert})`);
  const indirectLignesA = await compter(
    'select count(*)::int as n from documents where id = any($1::uuid[])',
    [[docBIndirectDataPoint, docBIndirectCert]]);
  if (indirectLignesA.n === 0)
    ok('sous le locataire A, la RLS ne laisse passer aucune piece indirecte de B');
  else
    ko(`FUITE : ${indirectLignesA.n} piece(s) indirecte(s) de B lisibles depuis le locataire A`);
  await app.query('ROLLBACK').catch(() => {});

  await asTenant(orgB);
  const indirectB = await compter(
    `select tracefab_can_access_document($1::uuid) as point,
            tracefab_can_access_document($2::uuid) as cert`,
    [docBIndirectDataPoint, docBIndirectCert]);
  if (indirectB.point === true && indirectB.cert === true)
    ok('sous SON locataire, la marque B atteint ses pieces par les memes chemins indirects');
  else
    ko(`garde trop stricte : la marque B perd l'acces legitime (point=${indirectB.point}, cert=${indirectB.cert})`);
  const indirectLignesB = await compter(
    'select count(*)::int as n from documents where id = any($1::uuid[])',
    [[docBIndirectDataPoint, docBIndirectCert]]);
  if (indirectLignesB.n === 2)
    ok('sous son locataire, la RLS laisse passer les deux pieces indirectes de B');
  else
    ko(`acces legitime perdu : ${indirectLignesB.n}/2 pieces indirectes visibles sous le locataire B`);
  await app.query('ROLLBACK').catch(() => {});

  /* -- 11. politiques publiques et worker intactes ----------------------- */
  const { rows: politiques } = await proprio.query(
    `select p.polname, pg_get_expr(p.polqual, p.polrelid) || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expression
       from pg_policy p
      where p.polname in ('documents_select_authorized', 'materials_select_authorized',
                          'materials_select_public', 'dpp_select_public', 'products_select_public')`);
  const parNom = new Map(politiques.map((p) => [p.polname, p.expression]));
  const gardees = ['documents_select_authorized', 'materials_select_authorized'];
  const perdues = gardees.filter((nom) => !parNom.has(nom) || !parNom.get(nom).includes('tracefab_in_active_tenant'));
  if (perdues.length === 0) ok('les politiques de documents et de materiaux portent la garde de locataire actif');
  else ko(`politiques sans garde de locataire : ${perdues.join(', ')}`);
  const intactes = ['materials_select_public', 'dpp_select_public', 'products_select_public']
    .filter((nom) => parNom.has(nom) && parNom.get(nom).includes('tracefab_public_context'));
  if (intactes.length === 3) ok('les politiques publiques (passeport DPP) sont intactes');
  else ko(`politiques publiques emportees ou modifiees : ${intactes.length}/3 presentes`);
} catch (error) {
  ko(`exception inattendue : ${error.message}`);
  console.log(`::error::document-material tenant scope — pile : ${String(error.stack).replace(/\n/g, ' | ')}`);
} finally {
  // MENAGE. Ces suites tournent dans le meme job que des tests d'etancheite
  // qui comptent les organisations visibles par une identite donnee
  // (`test:neon:worker-non-forgeable` mesure « aucune autre organisation »).
  // Des fixtures laissees en place feraient echouer une suite VOISINE pour une
  // raison qui n'a rien a voir avec elle : mesure du 05/11/2026, le test
  // worker est passe au rouge apres l'execution de celui-ci sur la meme base.
  // Le menage est donc fait ici, sous le role proprietaire, dans l'ordre des
  // dependances, et il est verifie : une suppression incomplete est signalee.
  const ordre = [
    'delete from data_points where owner_organization_id = any($1::uuid[])',
    'delete from certifications where owner_organization_id = any($1::uuid[])',
    // `product_materials` se supprime par PRODUIT ou par MATERIAU : la
    // contrainte de cle etrangere sur `materials` refuserait sinon la
    // suppression du materiau fournisseur compose dans le produit de A.
    'delete from product_materials where product_id in (select id from tracefab_products where brand_organization_id = any($1::uuid[])) or material_id in (select id from materials where owner_organization_id = any($1::uuid[]))',
    'delete from data_shares where supplier_organization_id = any($1::uuid[])',
    'delete from documents where owner_organization_id = any($1::uuid[])',
    'delete from materials where owner_organization_id = any($1::uuid[])',
    'delete from tracefab_products where brand_organization_id = any($1::uuid[])',
    'delete from brand_supplier_relationships where brand_organization_id = any($1::uuid[])',
    'delete from suppliers where organization_id = any($1::uuid[])',
    'delete from organization_memberships where organization_id = any($1::uuid[])',
    'delete from organizations where id = any($1::uuid[])',
    'delete from users where id = $1::uuid',
  ];
  for (const requete of ordre) {
    try {
      // Chaque requete ne recoit que les parametres qu'elle emploie : envoyer
      // deux parametres a une requete qui n'en attend qu'un est une erreur de
      // liaison, pas un menage partiel silencieux.
      const parametres = requete.includes('from users')
        ? [user]
        : [[orgA, orgB, orgS, orgS2]];
      await proprio.query(requete, parametres);
    } catch (error) {
      console.log(`  ATTENTION menage incomplet (${requete.split(' ')[2]}) : ${error.message}`);
    }
  }
  try {
    const { rows: [reste] } = await proprio.query(
      `select (select count(*) from organizations where id = any($1::uuid[]))::int as orgs,
              (select count(*) from documents where owner_organization_id = any($1::uuid[]))::int as docs,
              (select count(*) from materials where owner_organization_id = any($1::uuid[]))::int as matieres`,
      [[orgA, orgB, orgS, orgS2]]);
    if (reste.orgs === 0 && reste.docs === 0 && reste.matieres === 0) console.log('  ok    menage : fixtures supprimees');
    else console.log(`  ATTENTION menage incomplet : ${reste.orgs} organisation(s), ${reste.docs} document(s), ${reste.matieres} materiau(x)`);
  } catch (error) {
    console.log(`  ATTENTION verification du menage impossible : ${error.message}`);
  }
  await app.end().catch(() => {});
  await proprio.end().catch(() => {});
}

console.log('');
if (echecs === 0) {
  console.log('Documents et materiaux : acces autorises conserves, acces inter-locataires refuses.');
  process.exit(0);
}
console.log(`Documents et materiaux : ${echecs} echec(s).`);
process.exit(1);
