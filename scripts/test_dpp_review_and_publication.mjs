#!/usr/bin/env node
/**
 * Non-regression : revue humaine et coherence de la publication publique.
 *
 * Ce que ce test eprouve, et pourquoi
 * -----------------------------------
 * Deux defauts mesures avant la migration 20261027130000 :
 *
 *   - recalculer un dossier revu effacait `reviewed_at` / `reviewed_by` ;
 *   - recalculer un dossier publie le faisait passer de `published` a
 *     `data_ready` en LAISSANT `public_slug`, donc le passeport restait
 *     publiquement accessible.
 *
 * Les cas ci-dessous sont ecrits pour echouer si l'un des deux revient.
 *
 * Regle de revue appliquee : une revue ne survit que si l'empreinte des
 * donnees examinees est identique. Si elle change, la revue est invalidee avec
 * date et motif — jamais conservee silencieusement.
 *
 * Politique de publication appliquee : un passeport publie qui ne satisfait
 * plus les exigences est suspendu atomiquement (slug efface, evenement de cycle
 * de vie, ligne d'audit). Il redevient publiable apres correction, recalcul et
 * nouvelle revue.
 *
 * Usage : DATABASE_URL=... node scripts/test_dpp_review_and_publication.mjs
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

const url = process.env.DATABASE_URL;
if (!url) { console.error('NON EXECUTE — DATABASE_URL obligatoire.'); process.exit(2); }
const hote = new URL(url).hostname;
if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error(`REFUS — ${hote} est la base de production. Sortie 3.`);
  process.exit(3);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false,
});
await client.connect();

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m, d = '') => { echecs += 1; console.error(`  ECHEC ${m}${d ? ` — ${d}` : ''}`); };
const check = (m, c, d = '') => (c ? ok(m) : ko(m, d));

// Identifiants aleatoires par execution : les evenements de cycle de vie sont
// append-only (un declencheur refuse DELETE et UPDATE). C'est une garantie du
// modele, pas une gene : on ne la contourne pas, on prend un tenant neuf.
const ORG = randomUUID();
const USER = randomUUID();
const REF = `NR-${ORG.slice(0, 8).toUpperCase()}`;
const PROFIL = ['textile_readiness_mvp', '1.0'];
const DESC = 'Description suffisamment longue pour depasser trente caracteres.';

/* -- fixtures ------------------------------------------------------------- */
await client.query(`INSERT INTO organizations (id, type, legal_name, country_code)
  VALUES ($1,'brand','Marque de non-regression','FR')`, [ORG]);
await client.query(`INSERT INTO users (id, clerk_user_id, email, full_name)
  VALUES ($1,$2,$3,'Revue')`, [USER, `clerk_nr_${USER.slice(0,8)}`, `nr-${USER.slice(0,8)}@test.invalid`]);
await client.query(`INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
  VALUES (gen_random_uuid(),$1,$2,'owner','active')`, [ORG, USER]);
await client.query("SELECT set_config('tracefab.user_id', $1, false)", [USER]);

const { rows: [prod] } = await client.query(`
  INSERT INTO tracefab_products (id, brand_organization_id, version, reference, name, description,
    category, country_of_manufacture, color_name, size_range, weight_grams, data_readiness, status)
  VALUES (gen_random_uuid(), $1, 1, $3, 'Produit revue', $2,
          'shirt', 'FR', 'Blanc', ARRAY['S','M'], 150, 'not_started', 'active')
  RETURNING id`, [ORG, DESC, REF]);
await client.query(`INSERT INTO product_identifiers (id, product_id, identifier_type, identifier_value, is_primary)
  VALUES (gen_random_uuid(), $1, 'internal', $2, true)`, [prod.id, REF]);
const { rows: [mat] } = await client.query(`INSERT INTO materials
  (id, owner_organization_id, material_type, name, origin_country_code)
  VALUES (gen_random_uuid(), $1, 'fiber', 'Coton', 'FR') RETURNING id`, [ORG]);
await client.query(`INSERT INTO product_materials (product_id, material_id, percentage, product_version)
  VALUES ($1,$2,100,1)`, [prod.id, mat.id]);
const { rows: [doc] } = await client.query(`
  INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
    original_filename, content_type, byte_size, status, visibility)
  VALUES (gen_random_uuid(), $1, 'tracefab-private', $2, 'p.pdf', 'application/pdf', 100,
          'uploaded', 'private') RETURNING id`, [ORG, `${ORG}/nr.pdf`]);
await client.query('BEGIN');
await client.query("SELECT set_config('tracefab.internal_document_update','true',true)");
await client.query("UPDATE documents SET status='available' WHERE id=$1", [doc.id]);
await client.query('COMMIT');
for (const [type, m] of [['product', null], ['material', mat.id]]) {
  await client.query(`INSERT INTO supply_chain_nodes
    (id, node_type, product_id, material_id, label, status, source_document_id, graph_product_id)
    VALUES (gen_random_uuid(), $1, $2, $3, 'Noeud', 'documented', $4, $5)`,
    [type, type === 'product' ? prod.id : null, m, doc.id, prod.id]);
}
await client.query(`INSERT INTO supply_chain_links (id, product_id, source_node_id, target_node_id, link_type)
  SELECT gen_random_uuid(), $1,
    (SELECT id FROM supply_chain_nodes WHERE graph_product_id=$1 AND node_type='product' LIMIT 1),
    (SELECT id FROM supply_chain_nodes WHERE graph_product_id=$1 AND node_type='material' LIMIT 1),
    'contains'`, [prod.id]);
await client.query(`INSERT INTO data_points (id, owner_organization_id, product_id, data_key, value,
  data_type, status, source_document_id)
  VALUES (gen_random_uuid(), $1, $2, 'nr.origine', to_jsonb('FR'::text), 'text', 'documented', $3)`,
  [ORG, prod.id, doc.id]);

/* -- helpers -------------------------------------------------------------- */
const recalcul = async () => {
  await client.query("SELECT set_config('tracefab.user_id', $1, false)", [USER]);
  const { rows: [r] } = await client.query(
    'SELECT * FROM tracefab_compute_dpp_readiness($1,$2,$3)', [prod.id, ...PROFIL]);
  return r;
};
const dossier = async () => {
  const { rows: [r] } = await client.query(
    'SELECT * FROM dpp_records WHERE product_id = $1 ORDER BY computed_at DESC LIMIT 1', [prod.id]);
  return r;
};
const slug = async () => {
  const { rows: [p] } = await client.query('SELECT public_slug FROM tracefab_products WHERE id = $1', [prod.id]);
  return p.public_slug;
};
const visiblePubliquement = async () => {
  const { rows: [r] } = await client.query('SELECT tracefab_product_is_public($1) AS v', [prod.id]);
  return r.v;
};
const evenements = async (type) => {
  const { rows } = await client.query(
    `SELECT event_type FROM dpp_lifecycle_events WHERE product_id = $1 AND event_type = $2`,
    [prod.id, type]);
  return rows.length;
};
const revue = async () => {
  const { rows: [r] } = await client.query(
    'SELECT * FROM tracefab_mark_dpp_ready_to_publish($1)', [(await dossier()).id]);
  return r;
};
const publier = async (s) => {
  const { rows: [r] } = await client.query(
    "SELECT * FROM tracefab_set_dpp_publication($1,'publish',$2)", [prod.id, s]);
  return r;
};

console.log('\nA1. Preservation et invalidation de la revue\n' + '-'.repeat(48));

await client.query('SELECT tracefab_refresh_product_data_readiness($1)', [prod.id]);
await client.query('SELECT tracefab_compute_product_quality($1)', [prod.id]);
let r = await recalcul();
check('le produit de reference atteint data_ready', r.readiness_status === 'data_ready', r.readiness_status);

r = await revue();
const empreinteRevue = r.reviewed_basis_fingerprint;
check('la revue renseigne reviewed_at, reviewed_by et fige l\'empreinte',
  Boolean(r.reviewed_at) && Boolean(r.reviewed_by) && Boolean(empreinteRevue));

r = await recalcul();
check('CAS 1 — donnees inchangees : la revue est CONSERVEE', Boolean(r.reviewed_at),
  'reviewed_at perdu');
check('CAS 1 — le statut revu est conserve (pas de retour a data_ready)',
  r.readiness_status === 'ready_to_publish', r.readiness_status);
check('CAS 1 — l\'empreinte figee et celle recalculee sont identiques',
  r.reviewed_basis_fingerprint === r.review_basis_fingerprint);

// CAS 2 : les donnees examinees changent, le produit reste conforme.
await client.query(`UPDATE tracefab_products SET description = $1 WHERE id = $2`,
  [DESC + ' Precision ajoutee apres la revue.', prod.id]);
r = await recalcul();
check('CAS 2 — donnees modifiees : la revue est INVALIDEE', r.reviewed_at === null);
check('CAS 2 — l\'invalidation est horodatee et motivee',
  Boolean(r.review_invalidated_at) && r.review_invalidation_reason === 'source_snapshot_changed',
  String(r.review_invalidation_reason));
check('CAS 2 — le dossier retombe sous data_ready', r.readiness_status === 'data_ready', r.readiness_status);

// On remet la revue en place pour la suite.
await revue();
check('apres nouvelle revue, l\'invalidation est effacee',
  (await dossier()).review_invalidated_at === null);

// CAS 7 : revue ANTERIEURE a la migration, sans empreinte de revue figee.
// Piege reel, trouve en testant la migration sur une base restee a 58 : les
// deux empreintes n'ont pas le meme algorithme, donc comparer l'ancienne a la
// nouvelle invaliderait TOUTES les revues existantes au premier recalcul —
// y compris celles dont le contenu n'a pas bouge. On applique l'ancienne regle
// (egalite de `input_fingerprint`), plus stricte, puis on met la ligne a niveau.
await client.query(
  'UPDATE dpp_records SET reviewed_basis_fingerprint = NULL WHERE product_id = $1', [prod.id]);
r = await recalcul();
check('CAS 7 — revue anterieure, contenu inchange : la revue SURVIT', Boolean(r.reviewed_at),
  'revue perdue au premier recalcul apres migration');
check('CAS 7 — la revue est mise a niveau (empreinte de contenu figee)',
  r.reviewed_basis_fingerprint === r.review_basis_fingerprint,
  String(r.reviewed_basis_fingerprint));

// CAS 8 : meme revue anterieure, contenu modifie : elle doit tomber.
await client.query(
  'UPDATE dpp_records SET reviewed_basis_fingerprint = NULL WHERE product_id = $1', [prod.id]);
await client.query('UPDATE tracefab_products SET description = $1 WHERE id = $2',
  [DESC + ' Deuxieme precision.', prod.id]);
r = await recalcul();
check('CAS 8 — revue anterieure, contenu modifie : la revue est INVALIDEE',
  r.reviewed_at === null && r.review_invalidation_reason === 'source_snapshot_changed',
  String(r.review_invalidation_reason));
await revue();

console.log('\nA2. Coherence de la publication publique\n' + '-'.repeat(48));

r = await publier(`nr-${ORG.slice(0,8)}-001`);
check('publication : statut published', r.readiness_status === 'published', r.readiness_status);
check('publication : slug pose et produit publiquement visible',
  (await slug()) === `nr-${ORG.slice(0,8)}-001` && (await visiblePubliquement()) === true);

// CAS 3 : recalcul d'un passeport publie toujours conforme.
r = await recalcul();
check('CAS 3 — publie et conforme : le statut RESTE published', r.readiness_status === 'published',
  r.readiness_status);
check('CAS 3 — le slug est conserve', (await slug()) === `nr-${ORG.slice(0,8)}-001`);
check('CAS 3 — la revue est conservee', Boolean(r.reviewed_at));
check('CAS 3 — toujours visible publiquement', (await visiblePubliquement()) === true);

// CAS 4 : le produit ne satisfait plus une exigence (origine matiere effacee).
await client.query(`UPDATE materials SET origin_country_code = NULL WHERE id = $1`, [mat.id]);
r = await recalcul();
check('CAS 4 — publie et non conforme : le dossier est SUSPENDU',
  r.readiness_status !== 'published', r.readiness_status);
check('CAS 4 — le slug est efface', (await slug()) === null, String(await slug()));
check('CAS 4 — le produit n\'est plus publiquement visible', (await visiblePubliquement()) === false);
check('CAS 4 — un evenement publication_suspended est trace', (await evenements('publication_suspended')) === 1);
check('CAS 4 — la revue est invalidee avec le motif de suspension',
  r.reviewed_at === null && r.review_invalidation_reason === 'publication_suspended_nonconforming',
  String(r.review_invalidation_reason));

const { rows: audits } = await client.query(
  "SELECT count(*)::int n FROM audit_logs WHERE action = 'dpp.publication_auto_suspended' AND organization_id = $1", [ORG]);
check('CAS 4 — l\'audit enregistre la suspension automatique', audits[0].n >= 1, String(audits[0].n));

// CAS 5 : correction puis republication.
await client.query(`UPDATE materials SET origin_country_code = 'FR' WHERE id = $1`, [mat.id]);
r = await recalcul();
check('CAS 5 — apres correction, le dossier redevient data_ready',
  r.readiness_status === 'data_ready', r.readiness_status);
check('CAS 5 — le slug reste absent tant qu\'aucune publication n\'a eu lieu', (await slug()) === null);

let publieSansRevue = null;
try { await publier(`nr-${ORG.slice(0,8)}-002`); } catch (e) { publieSansRevue = e.message; }
check('CAS 5 — republier sans nouvelle revue est refuse', publieSansRevue !== null,
  'publication acceptee sans revue');

await revue();
r = await publier(`nr-${ORG.slice(0,8)}-002`);
check('CAS 5 — republication apres correction : published', r.readiness_status === 'published');
check('CAS 5 — nouveau slug pose et visible', (await slug()) === `nr-${ORG.slice(0,8)}-002`
  && (await visiblePubliquement()) === true);
check('CAS 5 — l\'historique conserve les deux publications', (await evenements('published')) >= 2,
  String(await evenements('published')));

// CAS 6 : suspension manuelle puis retrait : le slug disparait aussi.
await client.query("SELECT tracefab_set_dpp_publication($1,'suspend',NULL)", [prod.id]);
check('CAS 6 — suspension manuelle : plus de slug', (await slug()) === null);
check('CAS 6 — suspension manuelle : plus de visibilite publique', (await visiblePubliquement()) === false);
await publier(`nr-${ORG.slice(0,8)}-003`);
await client.query("SELECT tracefab_set_dpp_publication($1,'withdraw',NULL)", [prod.id]);
check('CAS 6 — retrait : plus de slug ni de visibilite',
  (await slug()) === null && (await visiblePubliquement()) === false);

console.log('\nA3. Idempotence complete\n' + '-'.repeat(48));

// Apres un retrait, le dossier reste `ready_to_publish` et garde sa revue :
// c'est exactement l'etat qui permet de republier sans nouvelle revue.
check('CAS 6 — le retrait laisse le dossier revu et republicable',
  (await dossier()).readiness_status === 'ready_to_publish' && Boolean((await dossier()).reviewed_at));
await publier(`nr-${ORG.slice(0,8)}-004`);
const instantane = async () => {
  const d = await dossier();
  const { rows: [c] } = await client.query(
    `SELECT count(*)::int lignes,
            (SELECT count(*)::int FROM dpp_lifecycle_events WHERE product_id = $1) AS evenements,
            (SELECT count(*)::int FROM audit_logs WHERE entity_id = $2) AS audits
     FROM dpp_records WHERE product_id = $1`, [prod.id, d.id]);
  return {
    statut: d.readiness_status,
    score: `${(d.source_snapshot.requirement_results || []).filter((x) => x.met).length}`
      + `/${(d.source_snapshot.requirement_results || []).length}`,
    empreinte: d.input_fingerprint,
    revu_le: d.reviewed_at ? d.reviewed_at.toISOString() : null,
    revu_par: d.reviewed_by,
    empreinte_revue: d.reviewed_fingerprint,
    invalide_le: d.review_invalidated_at ? d.review_invalidated_at.toISOString() : null,
    slug: await slug(),
    visible: await visiblePubliquement(),
    lignes: c.lignes, evenements: c.evenements, audits: c.audits,
  };
};
const avant = await instantane();
await recalcul();
const apres1 = await instantane();
await recalcul();
const apres2 = await instantane();

check('un recalcul ne cree aucune ligne supplementaire',
  apres1.lignes === avant.lignes && apres2.lignes === avant.lignes,
  `${avant.lignes} -> ${apres1.lignes} -> ${apres2.lignes}`);
check('un recalcul ne produit aucun evenement ni audit supplementaire',
  apres1.evenements === avant.evenements && apres2.evenements === avant.evenements
  && apres1.audits === avant.audits && apres2.audits === avant.audits,
  `${avant.evenements}/${avant.audits} -> ${apres2.evenements}/${apres2.audits}`);
const sansEmpreinte = (o) => { const { empreinte, ...reste } = o; return JSON.stringify(reste); };
const complet = (o) => JSON.stringify(o);

// Deux exigences distinctes, et il faut les separer :
//  - le SECOND recalcul ne doit rien changer du tout (idempotence vraie) ;
//  - le PREMIER peut legitimement rafraichir `input_fingerprint`, qui contient
//    `product.updated_at` — or publier ecrit ce champ. C'est une valeur
//    technique, pas un changement de contenu : l'empreinte de revue, elle,
//    ne bouge pas, et c'est ce qui compte.
check('le second recalcul ne change STRICTEMENT rien',
  complet(apres1) === complet(apres2),
  `${complet(apres1)} vs ${complet(apres2)}`);
check('le premier recalcul ne change que l\'empreinte technique',
  sansEmpreinte(avant) === sansEmpreinte(apres1),
  `${sansEmpreinte(avant)} vs ${sansEmpreinte(apres1)}`);
check('la revue survit aux deux passages',
  avant.revu_le === apres2.revu_le && avant.revu_par === apres2.revu_par && apres2.revu_le !== null);
check('le slug et la visibilite publique sont inchanges',
  avant.slug === apres2.slug && avant.visible === apres2.visible,
  `${avant.slug}/${avant.visible} -> ${apres2.slug}/${apres2.visible}`);

console.log('');
if (echecs) {
  console.error(`Revue et publication : ${echecs} verification(s) en echec.`);
  await client.end();
  process.exit(1);
}
console.log('Revue et publication : OK — revue preservee ou invalidee a bon droit, publication coherente, recalcul idempotent.');
await client.end();
