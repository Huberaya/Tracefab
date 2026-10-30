#!/usr/bin/env node
/**
 * Validation d'une branche de test après application des migrations DPP.
 *
 * Execute :
 *   A. les quatre requetes de controle du §9 de
 *      docs/experience/mission-dpp-2026-10-27/04-ECART-PRODUCTION-CONSTATE.md ;
 *   B. cinq scenarios de calcul DPP, sur des produits synthetiques, avec
 *      verification des treize exigences du profil.
 *
 * GARDE-FOU : refuse la base de production, comme les autres scripts de test.
 *
 * Sur une base protegee par RLS et avec un role non privilegie, les compteurs
 * de la partie A sont partiels : le script le signale.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { exigerCibleEcriture } from './lib/garde_cible_ecriture.mjs';

// GARDE DE CIBLE — remplace la liste noire d'hotes (meme raison que dans
// `test_dpp_role_applicatif.mjs`). La section B cree un tenant de validation et
// ecrit des produits : la cible est classee AVANT toute connexion d'ecriture,
// par defaut refusee, et son cluster peut etre exige par `TF_SYSID_ATTENDU`.
const garde = await exigerCibleEcriture({
  variables: ['DATABASE_URL'],
  purpose: 'valider_branche_dpp — creation d un tenant et de produits',
});
const url = garde.url;

// `--dry-run` : n'execute que les quatre controles du §9, qui sont des SELECT.
// La section B cree un tenant de validation et ecrit des produits : elle est
// donc sautee. Ce mode existe pour pouvoir lire l'etat d'une base sans rien y
// laisser, sans avoir a se souvenir de quelles requetes sont sures.
const LECTURE_SEULE = process.argv.includes('--dry-run');

const client = new pg.Client({
  connectionString: url,
  ssl: sslDepuisUrl(url),
});
await client.connect();

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m, d = '') => { echecs += 1; console.error(`  ECHEC ${m}${d ? ` — ${d}` : ''}`); };
const check = (m, c, d = '') => (c ? ok(m) : ko(m, d));

/* ========================================================================== */
/* A. Les quatre requetes du §9, telles quelles                               */
/* ========================================================================== */
console.log('\nA. Controles du §9\n' + '-'.repeat(40));

// A1 — le profil doit porter 13 exigences.
{
  const { rows } = await client.query(`
SELECT profile_version, status,
       jsonb_array_length(definition -> 'requirements') AS nb_exigences
FROM dpp_requirement_profiles WHERE profile_key = 'textile_readiness_mvp'`);
  console.log('  A1 :', JSON.stringify(rows));
  check('A1 — le profil actif porte 13 exigences',
    rows.some((r) => r.status === 'active' && Number(r.nb_exigences) === 13),
    JSON.stringify(rows));
}

// A2 — la fonction doit porter la correction.
{
  const { rows } = await client.query(`
SELECT array_agg(m[1] ORDER BY m[1]) AS exigences_installees
FROM pg_proc p, regexp_matches(p.prosrc, '''([a-z_]+\\.[a-z_]+)''', 'g') AS m
WHERE p.proname = 'tracefab_dpp_requirement_met'`);
  const cles = rows[0].exigences_installees || [];

  // Les cles du PROFIL font foi ; la fonction peut conserver des branches
  // heritees (product.data_ready, quality.no_blocking_issues) qui ne sont plus
  // evaluees par le profil. Les confondre ferait echouer ce controle a tort :
  // la premiere version de ce script le faisait.
  const { rows: [profil] } = await client.query(`
    SELECT array_agg(e ->> 'key') AS cles
    FROM dpp_requirement_profiles, jsonb_array_elements(definition -> 'requirements') e
    WHERE profile_key = 'textile_readiness_mvp' AND status = 'active'`);
  const clesProfil = profil.cles || [];
  const heritees = cles.filter((k) => !clesProfil.includes(k));
  console.log(`  A2 : ${clesProfil.length} exigence(s) de profil, ${cles.length} cle(s) implantees`);
  if (heritees.length) console.log(`       branches heritees conservees : ${heritees.join(', ')}`);

  check('A2 — les 13 exigences du profil sont toutes implantees',
    clesProfil.length === 13 && clesProfil.every((k) => cles.includes(k)),
    `profil ${clesProfil.length}, implantees ${cles.length}`);
  check('A2 — quality.no_open_issues est presente', cles.includes('quality.no_open_issues'));
  check('A2 — product.data_ready n\'est plus une exigence du profil',
    !clesProfil.includes('product.data_ready'));
}

// A3 — le registre doit compter 59 migrations.
{
  const { rows } = await client.query(`
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`);
  console.log('  A3 :', rows[0].count, 'migration(s) terminee(s)');
  check('A3 — le registre compte 59 migrations terminees', Number(rows[0].count) === 59, rows[0].count);
  const { rows: ech } = await client.query(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL');
  check('A3 — aucune migration en echec ou inachevee', ech.length === 0,
    ech.map((r) => r.migration_name).join(', '));
}

// A4 — les privileges doivent rester fermes.
{
  const { rows } = await client.query(`
SELECT has_function_privilege('public', 'tracefab_dpp_requirement_met(text, uuid)', 'execute') AS public_peut,
       has_function_privilege('tracefab_app', 'tracefab_dpp_requirement_met(text, uuid)', 'execute') AS app_peut`);
  console.log('  A4 :', JSON.stringify(rows[0]));
  check('A4 — PUBLIC ne peut pas executer la fonction', rows[0].public_peut === false);
  check('A4 — tracefab_app ne peut pas executer la fonction', rows[0].app_peut === false);
}

/* ========================================================================== */
/* B. Cinq scenarios de calcul DPP                                           */
/* ========================================================================== */
if (LECTURE_SEULE) {
  console.log('\nB. Scenarios de calcul — SAUTES (--dry-run : aucune ecriture)');
  console.log('');
  if (echecs) {
    console.error(`Validation : ${echecs} verification(s) en echec (section A seulement).`);
    await client.end();
    process.exit(1);
  }
  console.log('Validation : OK sur la section A seule (--dry-run). Les scenarios n\'ont pas ete joues.');
  await client.end();
  process.exit(0);
}

console.log('\nB. Scenarios de calcul\n' + '-'.repeat(40));

const ORG = '2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a';
const USER = '3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b';

// Rejouable : on efface le tenant de validation de l'execution precedente.
// Uniquement sur une base de test (garde-fou en tete de fichier).
await client.query('DELETE FROM organizations WHERE id = $1', [ORG]);

await client.query(`INSERT INTO organizations (id, type, legal_name, country_code)
  VALUES ($1,'brand','Marque de validation (synthetique)','FR') ON CONFLICT (id) DO NOTHING`, [ORG]);
await client.query(`INSERT INTO users (id, clerk_user_id, email, full_name)
  VALUES ($1,'clerk_validation_dpp','validation@test.invalid','Validation')
  ON CONFLICT (id) DO NOTHING`, [USER]);
await client.query(`INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
  VALUES (gen_random_uuid(),$1,$2,'owner','active') ON CONFLICT DO NOTHING`, [ORG, USER]);
await client.query("SELECT set_config('tracefab.user_id', $1, false)", [USER]);

const PROFIL = ['textile_readiness_mvp', '1.0'];

async function creer({ ref, statut = 'active', description, origine = 'FR', documents = true, qualite = true }) {
  const { rows: [p] } = await client.query(`
    INSERT INTO tracefab_products (id, brand_organization_id, version, reference, name, description,
      category, country_of_manufacture, color_name, size_range, weight_grams, data_readiness, status)
    VALUES (gen_random_uuid(), $1, 1, $2, $3, $4, 'shirt', 'FR', 'Blanc', ARRAY['S','M'], 150,
            'not_started', $5) RETURNING id`,
    [ORG, ref, `Produit ${ref}`, description, statut]);
  await client.query(`INSERT INTO product_identifiers (id, product_id, identifier_type, identifier_value, is_primary)
    VALUES (gen_random_uuid(), $1, 'internal', $2, true)`, [p.id, ref]);
  const { rows: [m] } = await client.query(`INSERT INTO materials
    (id, owner_organization_id, material_type, name, origin_country_code)
    VALUES (gen_random_uuid(), $1, 'fiber', 'Matiere', $2) RETURNING id`, [ORG, origine]);
  await client.query(`INSERT INTO product_materials (product_id, material_id, percentage, product_version)
    VALUES ($1,$2,100,1)`, [p.id, m.id]);

  let doc = null;
  if (documents) {
    const { rows: [d] } = await client.query(`
      INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
        original_filename, content_type, byte_size, status, visibility)
      VALUES (gen_random_uuid(), $1, 'tracefab-private', $2, 'p.pdf', 'application/pdf', 100,
              'uploaded', 'private') RETURNING id`, [ORG, `${ORG}/${ref}.pdf`]);
    await client.query('BEGIN');
    await client.query("SELECT set_config('tracefab.internal_document_update','true',true)");
    await client.query("UPDATE documents SET status='available' WHERE id=$1", [d.id]);
    await client.query('COMMIT');
    doc = d.id;
  }
  for (const [type, mat] of [['product', null], ['material', m.id]]) {
    await client.query(`INSERT INTO supply_chain_nodes
      (id, node_type, product_id, material_id, label, status, source_document_id, graph_product_id)
      VALUES (gen_random_uuid(), $1, $2, $3, 'Noeud', $4, $5, $6)`,
      [type, type === 'product' ? p.id : null, mat, doc ? 'documented' : 'declared', doc, p.id]);
  }
  await client.query(`INSERT INTO supply_chain_links (id, product_id, source_node_id, target_node_id, link_type)
    SELECT gen_random_uuid(), $1,
      (SELECT id FROM supply_chain_nodes WHERE graph_product_id=$1 AND node_type='product' LIMIT 1),
      (SELECT id FROM supply_chain_nodes WHERE graph_product_id=$1 AND node_type='material' LIMIT 1),
      'contains'`, [p.id]);
  if (doc) {
    await client.query(`INSERT INTO data_points (id, owner_organization_id, product_id, data_key, value,
      data_type, status, source_document_id)
      VALUES (gen_random_uuid(), $1, $2, 's.origine', to_jsonb('FR'::text), 'text', 'documented', $3)`,
      [ORG, p.id, doc]);
  }
  await client.query('SELECT tracefab_refresh_product_data_readiness($1)', [p.id]);
  if (qualite) await client.query('SELECT tracefab_compute_product_quality($1)', [p.id]);
  const { rows: [r] } = await client.query('SELECT * FROM tracefab_compute_dpp_readiness($1,$2,$3)',
    [p.id, ...PROFIL]);
  return { produit: p.id, record: r };
}

const exigences = async (productId) => {
  const { rows } = await client.query(`
    SELECT k AS cle, tracefab_dpp_requirement_met(k, $1) AS satisfaite
    FROM unnest(ARRAY['product.reference','product.name','product.description','product.category',
      'product.country_of_manufacture','product.required_attributes','composition.complete',
      'materials.origin_documented','traceability.graph','traceability.documented',
      'quality.no_open_issues','evidence.product_data','product.not_draft']::text[]) AS k`, [productId]);
  return Object.fromEntries(rows.map((r) => [r.cle, r.satisfaite]));
};

const DESCRIPTION_LONGUE = 'Description de validation suffisamment longue pour depasser trente caracteres.';

/* -- S1 : toutes les exigences satisfaites --------------------------------- */
{
  const { record, produit } = await creer({ ref: 'VAL-001', description: DESCRIPTION_LONGUE });
  const e = await exigences(produit);
  const manquantes = Object.entries(e).filter(([, v]) => !v).map(([k]) => k);
  console.log(`  S1 produit complet : statut ${record.readiness_status}, manquantes [${manquantes.join(', ')}]`);
  check('S1 — le produit complet atteint data_ready', record.readiness_status === 'data_ready',
    record.readiness_status);
  check('S1 — les 13 exigences sont satisfaites', manquantes.length === 0, manquantes.join(', '));
}

/* -- S2 : aucune evaluation qualite ---------------------------------------- */
{
  const { record, produit } = await creer({ ref: 'VAL-002', description: DESCRIPTION_LONGUE, qualite: false });
  const e = await exigences(produit);
  console.log(`  S2 sans evaluation qualite : statut ${record.readiness_status}, `
    + `quality.no_open_issues=${e['quality.no_open_issues']}`);
  check('S2 — sans evaluation qualite, la barriere est fermee', e['quality.no_open_issues'] === false);
  check('S2 — le dossier n\'est pas data_ready', record.readiness_status !== 'data_ready',
    record.readiness_status);
}

/* -- S3 : exigence obligatoire manquante (description) --------------------- */
{
  const { record, produit } = await creer({ ref: 'VAL-003', description: 'Court.' });
  const e = await exigences(produit);
  console.log(`  S3 description trop courte : statut ${record.readiness_status}, `
    + `product.description=${e['product.description']}`);
  check('S3 — la description trop courte bloque', e['product.description'] === false);
  check('S3 — le dossier n\'est pas data_ready', record.readiness_status !== 'data_ready',
    record.readiness_status);
}

/* -- S4 : anomalie qualite ouverte ----------------------------------------- */
{
  const { record, produit } = await creer({ ref: 'VAL-004', description: DESCRIPTION_LONGUE });
  const avant = record.readiness_status;
  await client.query(`INSERT INTO data_quality_issues
    (id, owner_organization_id, product_id, rule_key, rule_version, severity, status, message)
    VALUES (gen_random_uuid(), $1, $2, 'val_ouverte', '1', 'blocking', 'open', 'anomalie de validation')`,
    [ORG, produit]);
  const { rows: [apres] } = await client.query('SELECT * FROM tracefab_compute_dpp_readiness($1,$2,$3)',
    [produit, ...PROFIL]);
  const e = await exigences(produit);
  console.log(`  S4 anomalie ouverte : ${avant} -> ${apres.readiness_status}, `
    + `quality.no_open_issues=${e['quality.no_open_issues']}`);
  check('S4 — une anomalie ouverte ferme la barriere', e['quality.no_open_issues'] === false);
  check('S4 — le dossier repasse sous data_ready', apres.readiness_status !== 'data_ready',
    apres.readiness_status);
}

/* -- S5 : preuves et tracabilite incompletes ------------------------------- */
{
  const { record, produit } = await creer({ ref: 'VAL-005', description: DESCRIPTION_LONGUE, documents: false });
  const e = await exigences(produit);
  console.log(`  S5 sans document : statut ${record.readiness_status}, `
    + `traceability.documented=${e['traceability.documented']}, evidence.product_data=${e['evidence.product_data']}`);
  check('S5 — sans document, la tracabilite n\'est pas documentee',
    e['traceability.documented'] === false);
  check('S5 — sans document, la preuve produit manque', e['evidence.product_data'] === false);
  check('S5 — le dossier n\'est pas data_ready', record.readiness_status !== 'data_ready',
    record.readiness_status);
}

/* -- S6 : la revue refuse tout ce qui precede ------------------------------ */
{
  for (const ref of ['VAL-002', 'VAL-003', 'VAL-004', 'VAL-005']) {
    const { rows } = await client.query(`
      SELECT r.id, r.readiness_status::text AS s FROM dpp_records r
      JOIN tracefab_products p ON p.id = r.product_id
      WHERE p.reference = $1 AND p.brand_organization_id = $2`, [ref, ORG]);
    let message = null;
    try {
      await client.query('SELECT * FROM tracefab_mark_dpp_ready_to_publish($1)', [rows[0].id]);
    } catch (error) { message = String(error.message).split('\n')[0]; }
    check(`S6 — la revue est refusee pour ${ref}`, message !== null, `revue acceptee (statut ${rows[0].s})`);
  }
}

/* -- S7 : un produit en brouillon ne peut pas etre revu -------------------- */
{
  const { record, produit } = await creer({ ref: 'VAL-006', statut: 'draft', description: DESCRIPTION_LONGUE })
    .catch(() => ({ record: null, produit: null }));
  const e = produit ? await exigences(produit) : {};
  console.log(`  S7 brouillon : statut ${record?.readiness_status}, product.not_draft=${e['product.not_draft']}`);
  check('S7 — un brouillon ne satisfait pas product.not_draft', e['product.not_draft'] === false);
}

console.log('');
if (echecs) {
  console.error(`Validation : ${echecs} verification(s) en echec.`);
  await client.end();
  process.exit(1);
}
console.log('Validation : OK — §9 et scenarios DPP conformes.');
await client.end();
