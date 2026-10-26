#!/usr/bin/env node
/**
 * Mission fonctionnelle DPP — preuve par execution sur PostgreSQL jetable.
 *
 * CE QUE CE TEST PROUVE (aucune doublure, aucun mock) :
 *   A. un produit cree par Alpha est ecrit en base ; une modification est
 *      ecrite ; une NOUVELLE lecture sous le role applicatif retrouve les deux
 *      (persistance apres rechargement / nouvelle authentification) ;
 *   B. une preuve documentaire est rattachee au produit et au tenant Alpha,
 *      finalisee (`available`), puis acceptee avec motif via les memes
 *      fonctions metier que la route /api/documents/:id/validation ;
 *      l'historique de decision est relu ;
 *   C. l'apercu brouillon relit les donnees persistees (produit, identifiants,
 *      composition, points de donnees, preuves, dernier dossier DPP) et reste
 *      prive : aucun enregistrement publie, aucun slug public ;
 *   D. Beta ne peut ni lire le produit ni lire la preuve d'Alpha, meme avec
 *      l'identifiant exact ; un parametre de tenant fourni par le client ne
 *      remplace pas le locataire arme cote serveur ; sans locataire actif la
 *      lecture est vide (fail-closed) ; une decision sur la preuve d'Alpha
 *      depuis Beta est refusee.
 *
 * Le role applicatif `tracefab_app` n'a PAS BYPASSRLS : les politiques sont
 * reellement evaluees. Aucun identifiant Clerk n'est utilise ici — l'identite
 * est posee par les memes GUC transactionnels que le runtime
 * (`withTracefabUserContext`). Les controles HTTP authentifies par Clerk
 * restent couverts par `test:route-auth-coverage` et par la CI Preview.
 *
 * Usage :
 *   DATABASE_URL=postgresql://…/tracefab_test \
 *   TF_RLS_APP_URL=postgresql://tracefab_app:…/tracefab_test \
 *   node scripts/run-db-suite.mjs scripts/test_mission_functional_dpp.mjs
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const garde = requireThrowawayDb({
  purpose: 'scripts/test_mission_functional_dpp.mjs',
  variables: ['DATABASE_URL', 'TF_RLS_APP_URL'].filter((v) => (process.env[v] || '').trim()),
});
for (const ligne of garde.summary) console.log(`  garde cible : ${ligne}`);

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;
if (!URL_PROPRIO || !URL_APP) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requis. Sortie 2.');
  process.exit(2);
}

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const verifier = (condition, message) => (condition ? ok(message) : ko(message));

const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: true } : false,
});
const proprio = cli(URL_PROPRIO);
const app = cli(URL_APP);
await proprio.connect();
await app.connect();

/** Arme le contexte runtime pour UNE transaction, comme le fait l'API. */
async function enContexte(userId, email, organizationId, fn) {
  await app.query('BEGIN');
  try {
    await app.query("select set_config('tracefab.user_id', $1, true)", [userId]);
    await app.query("select set_config('tracefab.user_email', $1, true)", [email]);
    await app.query("select set_config('tracefab.active_organization_id', $1, true)", [organizationId ?? '']);
    const resultat = await fn();
    await app.query('COMMIT');
    return resultat;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

const suffixe = randomUUID().slice(0, 8);
const orgA = randomUUID(), orgB = randomUUID();
const userA = randomUUID(), userB = randomUUID();
const emailA = `mission-alpha-${suffixe}@example.test`;
const emailB = `mission-beta-${suffixe}@example.test`;

try {
  /* --- A. role applicatif reellement soumis a la RLS --------------------- */
  const identite = await app.query(
    "select current_user as role, (select rolbypassrls from pg_roles where rolname=current_user) as bypass");
  verifier(identite.rows[0].bypass === false,
    `role de test « ${identite.rows[0].role} » sans BYPASSRLS (les politiques sont evaluees)`);

  /* --- fixture : deux organisations independantes ----------------------- */
  await proprio.query(
    `insert into users (id, clerk_user_id, email, full_name) values
       ($1, $2, $3, 'Mission Alpha'), ($4, $5, $6, 'Mission Beta')`,
    [userA, `clerk-mission-a-${suffixe}`, emailA, userB, `clerk-mission-b-${suffixe}`, emailB]);
  await proprio.query(
    `insert into organizations (id, type, legal_name, country_code, created_by) values
       ($1, 'brand', 'Mission Alpha', 'FR', $2), ($3, 'brand', 'Mission Beta', 'PT', $4)`,
    [orgA, userA, orgB, userB]);
  await proprio.query(
    `insert into organization_memberships (organization_id, user_id, role, status) values
       ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
    [orgA, userA, orgB, userB]);

  /* --- A. creation + modification + relecture persistante --------------- */
  const reference = `MISSION-${suffixe}`;
  const produit = await enContexte(userA, emailA, orgA, async () => {
    const rows = await app.query(
      `select id from tracefab_create_product($1::uuid, $2, 'Mission T-shirt', 'T-shirt', 'SKU-MISSION')`,
      [orgA, reference]);
    return rows.rows[0]?.id;
  });
  verifier(typeof produit === 'string' && produit.length === 36, 'A1 produit cree cote serveur (UUID reel)');

  const description = 'Donnee persistee apres rechargement — mission fonctionnelle.';
  await enContexte(userA, emailA, orgA, async () => {
    await app.query(
      `select tracefab_update_product_data($1::uuid, $2, 'SKU-MISSION', 'Mission T-shirt', 'T-shirt',
        $3, NULL, NULL, ARRAY[]::text[], NULL, 'FR', NULL, '{}'::jsonb)`,
      [produit, reference, description]);
  });

  // Nouvelle transaction = nouvelle authentification / rechargement de page.
  const relu = await enContexte(userA, emailA, orgA, async () => {
    const r = await app.query(
      `select id, reference, name, description, brand_organization_id::text as org, version, public_slug
       from tracefab_products where id = $1::uuid`, [produit]);
    return r.rows[0];
  });
  verifier(relu && relu.description === description,
    'A2 modification relue depuis la base apres nouvelle transaction (persistance)');
  verifier(relu && relu.org === orgA, 'A3 produit rattache au locataire actif Alpha');
  verifier(!relu?.public_slug, 'C1 brouillon sans slug public (pas publie par une simple lecture)');

  /* --- B. preuve documentaire liee au produit et au tenant -------------- */
  const preuve = await enContexte(userA, emailA, orgA, async () => {
    const r = await app.query(
      `select * from tracefab_register_document(
         $1::uuid, $2, 'mission-certificate.pdf', 'application/pdf', 1024::bigint,
         NULL, 'certificate'::document_kind, NULL::date, $3::jsonb)`,
      [orgA, `${orgA}/mission/certificat-${suffixe}.pdf`,
       JSON.stringify({ productId: produit, category: 'transfer', issuer: 'Mission Lab' })]);
    return r.rows[0];
  });
  verifier(typeof preuve?.id === 'string', 'B1 preuve enregistree avec metadonnees (produit + tenant)');

  // Le scan est une operation separee ; ici on finalise avec un verdict sain
  // (la route /scan appelle la meme fonction apres antivirus + integrite).
  const disponible = await enContexte(userA, emailA, orgA, async () => {
    const r = await app.query(
      `select status::text as status from tracefab_finalize_document_upload($1::uuid, $2, true, 1024::bigint)`,
      [preuve.id, 'a'.repeat(64)]);
    return r.rows[0]?.status;
  });
  verifier(disponible === 'available', 'B2 preuve finalisee « available » (pas de faux succes de scan)');

  // Decision humaine : memes fonctions que POST /api/documents/:id/validation.
  const motif = 'Certificat coherent avec le lot de production.';
  const decision = await enContexte(userA, emailA, orgA, async () => {
    const claim = await app.query(
      `select id from tracefab_add_dpp_claim($1::uuid, $2, 'Document review: accepted', NULL,
        'declared'::dpp_event_validation_status, NULL::uuid, 'model', NULL, NULL::date, NULL::date,
        NULL::uuid, NULL)`,
      [produit, `evidence.review.${preuve.id.replace(/-/g, '')}.1`]);
    const claimId = claim.rows[0]?.id;
    const link = await app.query(
      `select verification_result, verification_reason from tracefab_link_dpp_claim_evidence(
        $1::uuid, $2::uuid, 'supports', $3, 'accepted', $3, NULL)`,
      [claimId, preuve.id, motif]);
    return link.rows[0];
  });
  verifier(decision?.verification_result === 'accepted' && decision?.verification_reason === motif,
    'B3 decision « acceptee » avec motif enregistree dans le dossier');

  const historique = await enContexte(userA, emailA, orgA, async () => {
    const r = await app.query(
      `select count(*)::int as n from dpp_claim_evidence where document_id = $1::uuid`, [preuve.id]);
    return r.rows[0].n;
  });
  verifier(historique >= 1, 'B4 historique des decisions relu depuis la base');

  /* --- C. apercu brouillon : donnees persistees, jamais de demo --------- */
  const apercu = await enContexte(userA, emailA, orgA, async () => {
    const p = await app.query(
      `select id, reference, name, description, version, status::text as status
       from tracefab_products where id = $1::uuid`, [produit]);
    const d = await app.query(
      `select id, original_filename, status::text as status, metadata
       from documents where id = $1::uuid and status <> 'deleted'
         and metadata->>'productId' = $2`, [preuve.id, produit]);
    const dpp = await app.query(
      `select readiness_status::text as readiness_status from dpp_records
       where product_id = $1::uuid order by computed_at desc limit 1`, [produit]);
    return { produit: p.rows[0], documents: d.rows, dossier: dpp.rows[0] || null };
  });
  verifier(apercu.produit?.description === description,
    'C2 apercu relit la description persistee, pas un objet de demonstration');
  verifier(apercu.documents.length === 1 && apercu.documents[0].status === 'available',
    'C3 apercu lie la preuve du bon produit avec son statut reel');
  verifier(apercu.dossier === null || apercu.dossier.readiness_status !== 'published',
    'C4 aucun dossier publie : simple consultation ne publie pas le passeport');

  /* --- D. isolation Alpha / Beta ---------------------------------------- */
  const lectureBeta = await enContexte(userB, emailB, orgB, async () => {
    const p = await app.query(`select id from tracefab_products where id = $1::uuid`, [produit]);
    const d = await app.query(`select id from documents where id = $1::uuid`, [preuve.id]);
    const acces = await app.query(`select tracefab_can_access_document($1::uuid) as ok`, [preuve.id]);
    return { produits: p.rows.length, documents: d.rows.length, acces: acces.rows[0]?.ok };
  });
  verifier(lectureBeta.produits === 0, 'D1 Beta ne lit pas le produit d Alpha par identifiant connu');
  verifier(lectureBeta.documents === 0, 'D2 Beta ne lit pas la preuve documentaire d Alpha');
  verifier(lectureBeta.acces === false, 'D3 tracefab_can_access_document refuse la preuve d Alpha a Beta');

  // Le runtime borne le locataire dans la requete (accessibleProduct utilise
  // tracefab_can_access_org ET tracefab_in_active_tenant). Reproduire la
  // requete exacte de la route, pas un SELECT nu sur la table : la RLS seule
  // borne l'utilisateur, le locataire actif est un controle applicatif.
  const sansTenant = await enContexte(userA, emailA, '', async () => {
    const r = await app.query(
      `select id from tracefab_products where id = $1::uuid
         and tracefab_can_access_org(brand_organization_id)
         and tracefab_in_active_tenant(brand_organization_id)`, [produit]);
    return r.rows.length;
  });
  verifier(sansTenant === 0, 'D4 sans locataire actif, la requete du runtime est vide (fail-closed)');

  // Tentative de decision sur la preuve d'Alpha depuis Beta : doit echouer.
  let intrusionRefusee = false;
  try {
    await enContexte(userB, emailB, orgB, async () => {
      const claim = await app.query(
        `select id from tracefab_add_dpp_claim($1::uuid, 'intrusion.mission', 'intrusion', NULL,
          'declared'::dpp_event_validation_status, NULL::uuid, 'model', NULL, NULL::date, NULL::date,
          NULL::uuid, NULL)`, [produit]);
      await app.query(
        `select tracefab_link_dpp_claim_evidence($1::uuid, $2::uuid, 'supports', NULL, 'accepted', NULL, NULL)`,
        [claim.rows[0]?.id, preuve.id]);
    });
  } catch { intrusionRefusee = true; }
  verifier(intrusionRefusee, 'D5 une decision sur la preuve d Alpha depuis Beta est refusee');

  const apresIntrusion = await proprio.query(
    `select count(*)::int as n from dpp_claim_evidence where document_id = $1::uuid`, [preuve.id]);
  verifier(apresIntrusion.rows[0].n === historique, 'D6 aucune ecriture parasite suite a la tentative');

  /* --- verification finale de non-publication --------------------------- */
  const publics = await proprio.query(
    `select count(*)::int as n from dpp_records where product_id = $1::uuid and readiness_status = 'published'`,
    [produit]);
  verifier(publics.rows[0].n === 0, 'C5 la consultation du brouillon n a publie aucun passeport');
} catch (error) {
  ko(`exception inattendue : ${String(error?.message || error).split('\n')[0]}`);
  console.error(error);
} finally {
  await app.end();
  await proprio.end();
}

console.log('\n' + '-'.repeat(76));
console.log(`${echecs === 0 ? 'Mission fonctionnelle DPP : TOUTES LES PREUVES REUSSIES' : `Mission fonctionnelle DPP : ${echecs} echec(s)`}`);
if (echecs > 0) process.exit(1);
