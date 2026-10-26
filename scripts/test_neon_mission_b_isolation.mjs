#!/usr/bin/env node
/**
 * Mission B — isolation multi-organisation : surfaces metier non couvertes
 * par les suites existantes, prouvees par execution.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Les suites precedentes prouvent la RLS brute (test_neon_cross_tenant), le
 * locataire actif (test_neon_active_tenant) et les flux qualite legitimes
 * (test_neon_quality_flow). Restent des surfaces precises que les routes
 * exposent et qu'aucune suite n'exerce en acces croise :
 *
 *   - le telechargement de documents, garde par la fonction SECURITY DEFINER
 *     `tracefab_can_access_document` (routes documents + supplier/documents) ;
 *   - les mutations qualite par identifiant (`tracefab_acknowledge_quality_issue`,
 *     `tracefab_waive_quality_issue`) — refus ET absence d'effet persiste ;
 *   - la creation d'identite DPP sur le produit d'autrui
 *     (`tracefab_create_dpp_identity`) — refus ET aucune ligne creee ;
 *   - l'ingestion PLM/ERP (`tracefab_ingest_plm_erp_payload`) : sans contexte
 *     utilisateur elle doit echouer fermee (`authentication_required`), et
 *     avec le contexte de A visant l'organisation B elle doit refuser sans
 *     creer de produit chez B. C'est aussi le test de regression du contexte
 *     propage par la route (le client transactionnel, pas le client global) ;
 *   - la requete d'export catalogue bornee a une organisation etrangere :
 *     zero ligne, alors que la meme requete sur sa propre organisation rend
 *     ses produits (controle positif : « zero » prouve quelque chose) ;
 *   - l'absence totale de contexte (aucun GUC arme) ne rend aucune ligne
 *     tenant : une route qui oublierait d'armer le contexte echoue fermee.
 *
 * METHODE
 *   Deux locataires complets (utilisateur proprietaire, organisation marque,
 *   fournisseur, produit, document `available`, anomalie qualite ouverte),
 *   crees par le proprietaire de la base jetable. Toutes les tentatives sont
 *   jouees avec le role applicatif `tracefab_app` (sans BYPASSRLS, verifie en
 *   assertion 1), arme du contexte de A — exactement ce qu'arment
 *   `withTracefabUserContext`. Chaque refus est suivi d'une relecture par le
 *   proprietaire : un refus qui aurait quand meme persiste une modification
 *   est un echec, pas un succes.
 *
 * IL NE PASSE PAS QUAND IL NE PEUT PAS S'EXECUTER : sans DATABASE_URL
 * (proprietaire, fixture) ou TF_RLS_APP_URL (role soumis a la RLS), sortie 2.
 *
 * Codes de sortie : 0 tout passe · 1 au moins un echec · 2 prerequis manquant.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: true } : false,
});

let echecs = 0;
// Les annotations rendent les echecs lisibles sans telecharger le journal du
// job : l'hote des journaux n'est pas joignable depuis tous les postes
// d'analyse, l'API des annotations l'est.
const ko = (m) => { console.log(`  ECHEC ${m}`); console.log(`::error title=Mission B::${m.replaceAll('::', ':')}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const suffixe = randomUUID().slice(0, 8);
const userA = randomUUID(); const userB = randomUUID();
const orgA = randomUUID(); const orgB = randomUUID();
const supA = randomUUID(); const supB = randomUUID();
const prodA = randomUUID(); const prodB = randomUUID();
const docA = randomUUID(); const docB = randomUUID();
const issueB = randomUUID();

const proprio = cli(URL_PROPRIO);
await proprio.connect();
const app = cli(URL_APP);
await app.connect();

try {
  /* --- fixture : deux locataires porteurs de donnees ---------------------- */
  await proprio.query(
    `insert into users (id, clerk_user_id, email, full_name) values
       ($1, $3, $4, 'Mission B A'), ($2, $5, $6, 'Mission B B')`,
    [userA, userB, `mb_a_${suffixe}`, `mb-a-${suffixe}@example.test`,
     `mb_b_${suffixe}`, `mb-b-${suffixe}@example.test`]);
  await proprio.query(
    `insert into organizations (id, type, legal_name, display_name, status, created_by) values
       ($1, 'brand', 'Mission B A', 'MB A', 'active', $3),
       ($2, 'brand', 'Mission B B', 'MB B', 'active', $4)`,
    [orgA, orgB, userA, userB]);
  await proprio.query(
    `insert into organization_memberships (organization_id, user_id, role, status) values
       ($1, $3, 'owner', 'active'), ($2, $4, 'owner', 'active')`,
    [orgA, orgB, userA, userB]);
  await proprio.query(
    'insert into suppliers (id, organization_id, onboarding_status) values ($1, $3, $5), ($2, $4, $5)',
    [supA, supB, orgA, orgB, 'in_progress']);
  await proprio.query(
    `insert into tracefab_products (id, brand_organization_id, reference, name, status) values
       ($1, $3, $5, 'Produit A', 'draft'), ($2, $4, $6, 'Produit B', 'draft')`,
    [prodA, prodB, orgA, orgB, `MBA-${suffixe}`, `MBB-${suffixe}`]);
  // Les documents naissent `uploaded` (trigger) ; le passage a `available`
  // est un champ gere, ouvert au proprietaire par le GUC interne le temps de
  // la fixture — le meme mecanisme que la finalisation applicative.
  await proprio.query(
    `insert into documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, visibility, status)
     values ($1, $3, 'tracefab-private', $5, 'a.pdf', 'application/pdf', 1024, 'private', 'uploaded'),
            ($2, $4, 'tracefab-private', $6, 'b.pdf', 'application/pdf', 1024, 'private', 'uploaded')`,
    [docA, docB, orgA, orgB, `${orgA}/a.pdf`, `${orgB}/b.pdf`]);
  await proprio.query("select set_config('tracefab.internal_document_update', 'true', false)");
  await proprio.query(
    "update documents set status = 'available', available_at = now() where id in ($1, $2)",
    [docA, docB]);
  await proprio.query("select set_config('tracefab.internal_document_update', 'false', false)");
  await proprio.query(
    `insert into data_quality_issues (id, owner_organization_id, product_id, rule_key,
       rule_version, severity, status, message)
     values ($1, $2, $3, 'mission_b_rule', '1.0', 'blocking', 'open', 'Anomalie du locataire B')`,
    [issueB, orgB, prodB]);

  /* --- 1. le role de test est reellement soumis a la RLS ------------------- */
  const moi = await app.query(
    'select current_user as r, (select rolbypassrls from pg_roles where rolname = current_user) as bypass');
  if (moi.rows[0].bypass) ko(`le role « ${moi.rows[0].r} » porte BYPASSRLS — rien ne serait mesure`);
  else ok(`role de test « ${moi.rows[0].r} », BYPASSRLS=false`);

  await app.query('begin');
  await app.query("select set_config('tracefab.user_id', $1, true)", [userA]);
  await app.query("select set_config('tracefab.user_email', $1, true)", [`mb-a-${suffixe}@example.test`]);
  await app.query("select set_config('tracefab.active_organization_id', $1, true)", [orgA]);

  // Une fonction qui refuse leve : la transaction est avortee. Savepoint
  // avant chaque tentative pour enchainer les assertions.
  const tenter = async (sql, params) => {
    await app.query('savepoint tentative');
    try {
      const r = await app.query(sql, params);
      await app.query('release savepoint tentative');
      return { rows: r.rows };
    } catch (e) {
      await app.query('rollback to savepoint tentative');
      return { refuse: true, message: String(e.message || '') };
    }
  };

  /* --- 2-3. telechargement de documents (fonction d'acces) ----------------- */
  const accesDocB = await tenter('select tracefab_can_access_document($1) as acces', [docB]);
  if (!accesDocB.refuse && accesDocB.rows[0].acces === false) ok('tracefab_can_access_document(document de B) = false pour A');
  else ko(`tracefab_can_access_document(document de B) : ${accesDocB.refuse ? accesDocB.message : accesDocB.rows[0].acces}`);

  const accesDocA = await tenter('select tracefab_can_access_document($1) as acces', [docA]);
  if (!accesDocA.refuse && accesDocA.rows[0].acces === true) ok('tracefab_can_access_document(document de A) = true pour A (controle positif)');
  else ko(`tracefab_can_access_document(document de A) : ${accesDocA.refuse ? accesDocA.message : accesDocA.rows[0].acces}`);

  /* --- 4-5. mutations qualite chez B : refus sans effet persiste ------------ */
  const ack = await tenter('select * from tracefab_acknowledge_quality_issue($1)', [issueB]);
  if (ack.refuse) ok(`acknowledge de l'anomalie de B refuse (${ack.message.split('\n')[0]})`);
  else ko('acknowledge de l\'anomalie de B a reussi — mutation inter-organisations');
  const etatApresAck = (await proprio.query(
    'select status, acknowledged_at from data_quality_issues where id = $1', [issueB])).rows[0];
  if (etatApresAck.status === 'open' && etatApresAck.acknowledged_at === null) {
    ok('aucun effet persiste apres le refus d\'acknowledge (statut toujours open)');
  } else ko(`effet persiste apres refus d'acknowledge : statut=${etatApresAck.status}`);

  const waive = await tenter('select * from tracefab_waive_quality_issue($1, $2)', [issueB, 'tentative inter-organisations']);
  if (waive.refuse) ok(`waive de l'anomalie de B refuse (${waive.message.split('\n')[0]})`);
  else ko('waive de l\'anomalie de B a reussi — mutation inter-organisations');
  const etatApresWaive = (await proprio.query(
    'select status from data_quality_issues where id = $1', [issueB])).rows[0];
  if (etatApresWaive.status === 'open') ok('aucun effet persiste apres le refus de waive');
  else ko(`effet persiste apres refus de waive : statut=${etatApresWaive.status}`);

  /* --- 6. identite DPP sur le produit de B : refus sans ligne creee -------- */
  const identite = await tenter(
    'select * from tracefab_create_dpp_identity($1, $2, $3, $4)',
    [prodB, `mb-intrusion-${suffixe}`, 'model', null]);
  if (identite.refuse) ok(`create_dpp_identity sur le produit de B refuse (${identite.message.split('\n')[0]})`);
  else ko('create_dpp_identity sur le produit de B a reussi — ecriture inter-organisations');
  const nbIdentitesB = (await proprio.query(
    'select count(*)::int as n from dpp_resolvable_identifiers where product_id = $1', [prodB])).rows[0].n;
  if (nbIdentitesB === 0) ok('aucune identite DPP creee chez B apres le refus');
  else ko(`${nbIdentitesB} identite(s) DPP creee(s) chez B malgre le refus`);

  /* --- 7. requete d'export catalogue bornee a B : zero ligne ---------------- */
  const exportB = await tenter(
    'select id from tracefab_products where brand_organization_id = $1', [orgB]);
  if (!exportB.refuse && exportB.rows.length === 0) ok('export borne a B sous contexte A : 0 produit');
  else ko(`export borne a B sous contexte A : ${exportB.refuse ? exportB.message : `${exportB.rows.length} produit(s)`}`);
  const exportA = await tenter(
    'select id from tracefab_products where brand_organization_id = $1', [orgA]);
  if (!exportA.refuse && exportA.rows.some((r) => r.id === prodA)) ok('export borne a A sous contexte A : son produit (controle positif)');
  else ko('export borne a A sous contexte A : produit propre introuvable — le zero de B ne prouverait rien');

  await app.query('commit');

  /* --- 8. ingestion PLM sans contexte : echec ferme -------------------------- */
  await app.query('begin');
  const ingestAnonyme = await tenter(
    'select tracefab_ingest_plm_erp_payload($1, $2, $3::jsonb, null) as s',
    [orgA, 'generic_csv', JSON.stringify([{ reference: `MB-ANON-${suffixe}`, name: 'Anonyme' }])]);
  if (ingestAnonyme.refuse && /authentication_required/.test(ingestAnonyme.message)) {
    ok('ingestion PLM sans contexte utilisateur : authentication_required (fail-closed)');
  } else ko(`ingestion PLM sans contexte : ${ingestAnonyme.refuse ? ingestAnonyme.message : 'a reussi — ecriture sans contexte acceptee'}`);
  await app.query('commit');

  /* --- 9. ingestion PLM avec le contexte de A visant B : refus, rien cree ---- */
  await app.query('begin');
  await app.query("select set_config('tracefab.user_id', $1, true)", [userA]);
  await app.query("select set_config('tracefab.user_email', $1, true)", [`mb-a-${suffixe}@example.test`]);
  const ingestCroise = await tenter(
    'select tracefab_ingest_plm_erp_payload($1, $2, $3::jsonb, null) as s',
    [orgB, 'generic_csv', JSON.stringify([{ reference: `MB-XORG-${suffixe}`, name: 'Intrusion' }])]);
  if (ingestCroise.refuse) ok(`ingestion PLM de A vers B refusee (${ingestCroise.message.split('\n')[0]})`);
  else ko('ingestion PLM de A vers B a reussi — ecriture inter-organisations');
  await app.query('commit');
  const nbIntrusion = (await proprio.query(
    'select count(*)::int as n from tracefab_products where reference = $1', [`MB-XORG-${suffixe}`])).rows[0].n;
  if (nbIntrusion === 0) ok('aucun produit cree chez B apres le refus d\'ingestion');
  else ko(`${nbIntrusion} produit(s) cree(s) chez B malgre le refus d'ingestion`);

  /* --- 10. aucun contexte arme : aucune ligne tenant ------------------------- */
  const sansContexte = await app.query('select id from tracefab_products');
  const visibles = sansContexte.rows.map((r) => r.id);
  if (!visibles.includes(prodA) && !visibles.includes(prodB)) {
    ok('sans contexte arme : ni le produit de A ni celui de B ne sont visibles (fail-closed)');
  } else ko(`sans contexte arme : produits visibles [${visibles.join(', ')}]`);
} catch (e) {
  ko(`erreur inattendue (fixture ou execution) : ${String(e.message || e).split('\n')[0]}`);
} finally {
  await app.end().catch(() => {});
  // Nettoyage complet de la fixture, y compris les lignes qu'un echec aurait
  // pu laisser passer : la preuve d'absence d'effet de bord est faite AVANT.
  await proprio.query('delete from organizations where id in ($1, $2)', [orgA, orgB]).catch(() => {});
  await proprio.query('delete from users where id in ($1, $2)', [userA, userB]).catch(() => {});
  await proprio.end().catch(() => {});
}

console.log(echecs === 0
  ? '\n  Mission B — isolation des surfaces metier : OK.'
  : `\n  Mission B — isolation des surfaces metier : ${echecs} ECHEC(S).`);
console.log(`::notice title=Mission B::assertions_en_echec=${echecs} (0 = toutes les surfaces prouvees)`);
process.exit(echecs === 0 ? 0 : 1);
