#!/usr/bin/env node
/**
 * Mesure de l'effet des deux migrations DPP sur un parc de produits.
 *
 * USAGE (base de TEST uniquement)
 *   DATABASE_URL=... node scripts/mesure_effet_migrations_dpp.mjs --avant
 *   (appliquer les migrations)
 *   DATABASE_URL=... node scripts/mesure_effet_migrations_dpp.mjs --apres
 *
 * Le mode `--avant` cree un parc synthetique et enregistre le calcul DPP de
 * chaque produit. Le mode `--apres` recalcule et compare.
 *
 * CE QUE CE SCRIPT NE PRETEND PAS
 *   Les produits sont SYNTHETIQUES : ils reproduisent la structure des donnees
 *   (identifiant, matiere, noeud documente, data point, evaluation qualite),
 *   jamais des valeurs metier reelles. Une marque, une composition ou un
 *   fabricant n'y figurent pas et ne doivent pas y figurer.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

const url = process.env.DATABASE_URL;
if (!url) { console.error('NON EXECUTE — DATABASE_URL obligatoire.'); process.exit(2); }
const hote = new URL(url).hostname;
if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error(`REFUS — ${hote} est la base de production. Ce script n'ecrit que sur une base de test.`);
  process.exit(3);
}

// `--dry-run` : lecture seule. Affiche l'etat du parc et des dossiers DPP, sans
// creer, calculer ni enregistrer quoi que ce soit. C'est le mode a utiliser
// pour regarder une base avant de decider quoi que ce soit.
const dryRun = process.argv.includes('--dry-run');
const mode = process.argv.includes('--apres') ? 'apres'
  : process.argv.includes('--avant') ? 'avant' : null;
if (!mode && !dryRun) { console.error('Preciser --avant, --apres ou --dry-run.'); process.exit(2); }

const client = new pg.Client({
  connectionString: url,
  ssl: sslDepuisUrl(url),
});
await client.connect();

const ORG = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const USER = '1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f';

if (dryRun) {
  const { rows } = await client.query(
    `SELECT p.reference, p.status, d.readiness_status,
            d.reviewed_at IS NOT NULL AS revue,
            d.review_invalidation_reason AS motif
       FROM tracefab_products p
       LEFT JOIN dpp_records d ON d.product_id = p.id
      WHERE p.brand_organization_id = $1
      ORDER BY p.reference`, [ORG]);
  if (rows.length === 0) {
    console.log('Parc de recette absent de cette base : rien a lire.');
  } else {
    console.log(`Parc de recette : ${rows.length} produit(s) — lecture seule`);
    for (const r of rows) {
      console.log(`  ${r.reference}  ${r.status}  ${r.readiness_status || 'sans dossier'}`
        + `${r.revue ? '  revu' : ''}${r.motif ? `  (${r.motif})` : ''}`);
    }
  }
  console.log('\n--dry-run : aucune ecriture effectuee.');
  await client.end();
  process.exit(0);
}

/* ------------------------------------------------------------------------- */
/* Parc synthetique : 18 produits, six profils de completude differents.      */
/* ------------------------------------------------------------------------- */
const PROFILS = [
  { nom: 'complet', nb: 4 },
  { nom: 'sans_evaluation_qualite', nb: 4 },
  { nom: 'sans_description', nb: 3 },
  { nom: 'sans_origine_matiere', nb: 3 },
  { nom: 'sans_document', nb: 2 },
  { nom: 'brouillon', nb: 2 },
];

if (mode === 'avant') {
  await client.query(`INSERT INTO organizations (id, type, legal_name, country_code)
    VALUES ($1, 'brand', 'Marque de recette (synthetique)', 'FR') ON CONFLICT (id) DO NOTHING`, [ORG]);
  await client.query(`INSERT INTO users (id, clerk_user_id, email, full_name)
    VALUES ($1, 'clerk_mesure_dpp', 'mesure@test.invalid', 'Recette Mesure')
    ON CONFLICT (id) DO NOTHING`, [USER]);
  await client.query(`INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
    VALUES (gen_random_uuid(), $1, $2, 'owner', 'active') ON CONFLICT DO NOTHING`, [ORG, USER]);

  let n = 0;
  for (const profil of PROFILS) {
    for (let i = 0; i < profil.nb; i += 1) {
      n += 1;
      const ref = `RECETTE-${String(n).padStart(3, '0')}`;
      const complet = profil.nom === 'complet';
      const sansDescription = profil.nom === 'sans_description';
      const sansOrigine = profil.nom === 'sans_origine_matiere';
      const sansDocument = profil.nom === 'sans_document';
      const brouillon = profil.nom === 'brouillon';

      const { rows: [p] } = await client.query(`
        INSERT INTO tracefab_products
          (id, brand_organization_id, version, reference, name, description, category,
           country_of_manufacture, color_name, size_range, weight_grams,
           data_readiness, status)
        VALUES (gen_random_uuid(), $1, 1, $2, $3, $4, 'shirt', 'FR', 'Blanc',
                ARRAY['S','M'], 150, 'not_started', $5)
        RETURNING id`,
        [ORG, ref, `Produit de recette ${n}`,
         sansDescription ? 'Trop court.' :
           'Description de recette suffisamment longue pour depasser trente caracteres.',
         brouillon ? 'draft' : 'active']);

      // Identifiant : une donnee incomplete ne doit pas ressembler a une preuve.
      if (!brouillon) {
        await client.query(`INSERT INTO product_identifiers
          (id, product_id, identifier_type, identifier_value, is_primary)
          VALUES (gen_random_uuid(), $1, 'internal', $2, true)`, [p.id, ref]);
      }

      const { rows: [m] } = await client.query(`
        INSERT INTO materials (id, owner_organization_id, material_type, name, origin_country_code)
        VALUES (gen_random_uuid(), $1, 'fiber', 'Matiere de recette', $2) RETURNING id`,
        [ORG, sansOrigine ? null : 'FR']);
      await client.query(`INSERT INTO product_materials
        (product_id, material_id, percentage, product_version)
        VALUES ($1, $2, 100, 1)`, [p.id, m.id]);

      let documentId = null;
      if (!sansDocument) {
        const { rows: [d] } = await client.query(`
          INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
            original_filename, content_type, byte_size, status, visibility)
          VALUES (gen_random_uuid(), $1, 'tracefab-private', $2, 'recette.pdf',
                  'application/pdf', 128, 'uploaded', 'private') RETURNING id`,
          [ORG, `${ORG}/recette/${n}.pdf`]);
        await client.query('BEGIN');
        await client.query("SELECT set_config('tracefab.internal_document_update','true',true)");
        await client.query("UPDATE documents SET status='available' WHERE id=$1", [d.id]);
        await client.query('COMMIT');
        documentId = d.id;
      }

      for (const [type, materialId] of [['product', null], ['material', m.id]]) {
        await client.query(`INSERT INTO supply_chain_nodes
          (id, node_type, product_id, material_id, label, status, source_document_id, graph_product_id)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
          [type, type === 'product' ? p.id : null, materialId,
           type === 'product' ? 'Produit documente' : 'Matiere documentee',
           documentId ? 'documented' : 'declared', documentId, p.id]);
      }
      await client.query(`INSERT INTO supply_chain_links
        (id, product_id, source_node_id, target_node_id, link_type)
        SELECT gen_random_uuid(), $1,
               (SELECT id FROM supply_chain_nodes WHERE graph_product_id=$1 AND node_type='product' LIMIT 1),
               (SELECT id FROM supply_chain_nodes WHERE graph_product_id=$1 AND node_type='material' LIMIT 1),
               'contains'`, [p.id]);

      if (documentId) {
        await client.query(`INSERT INTO data_points
          (id, owner_organization_id, product_id, data_key, value, data_type, status, source_document_id)
          VALUES (gen_random_uuid(), $1, $2, 'recette.origine', to_jsonb('FR'::text),
                  'text', 'documented', $3)`, [ORG, p.id, documentId]);
      }

      // Completude produit (7 exigences) puis qualite, sauf pour le profil
      // « sans evaluation » : c'est precisement le cas que la migration cible.
      await client.query("SELECT set_config('tracefab.user_id', $1, false)", [USER]);
      await client.query('SELECT tracefab_refresh_product_data_readiness($1)', [p.id]);
      if (profil.nom !== 'sans_evaluation_qualite' && !brouillon) {
        await client.query('SELECT tracefab_compute_product_quality($1)', [p.id]);
      }
      if (complet) {
        // rien de plus : le produit doit passer toutes les exigences seul
      }

      await client.query("SELECT set_config('tracefab.user_id', $1, false)", [USER]);
      await client.query('SELECT tracefab_compute_dpp_readiness($1, $2, $3)',
        [p.id, 'textile_readiness_mvp', '1.0']);
    }
  }
  console.log(`${n} produit(s) synthetique(s) cree(s), calcul DPP enregistre.`);
}

/* ------------------------------------------------------------------------- */
/* Recalcul officiel (mode --apres)                                          */
/*                                                                            */
/* On utilise la fonction que la console appelle (POST .../dpp). Elle est     */
/* idempotente en nombre de lignes (UPSERT sur produit + version + profil),   */
/* mais elle REMET reviewed_at / reviewed_by a NULL : recalculer un dossier   */
/* revu lui fait perdre sa revue. Ce n'est pas anodin et c'est documente.     */
/* ------------------------------------------------------------------------- */
if (mode === 'apres') {
  const { rows: produits } = await client.query(
    `SELECT id, reference FROM tracefab_products WHERE brand_organization_id = $1 ORDER BY reference`,
    [ORG],
  );
  await client.query("SELECT set_config('tracefab.user_id', $1, false)", [USER]);
  for (const p of produits) {
    await client.query('SELECT tracefab_compute_dpp_readiness($1, $2, $3)',
      [p.id, 'textile_readiness_mvp', '1.0']);
  }
  console.log(`${produits.length} dossier(s) recalcule(s) avec le mecanisme officiel.`);
}

/* ------------------------------------------------------------------------- */
/* Comparaison : on relit ce que le calcul a reellement produit.              */
/* ------------------------------------------------------------------------- */
const { rows } = await client.query(`
  SELECT p.reference,
         p.status::text AS statut_produit,
         r.readiness_status::text AS statut_dpp,
         jsonb_array_length(COALESCE(r.source_snapshot -> 'requirement_results', '[]'::jsonb)) AS exigences_evaluees,
         (SELECT count(*) FROM jsonb_array_elements(COALESCE(r.source_snapshot -> 'requirement_results','[]'::jsonb)) e
            WHERE (e ->> 'met')::boolean) AS exigences_satisfaites,
         COALESCE(jsonb_array_length(r.blocking_issues), 0) AS blocages,
         jsonb_array_length(COALESCE(r.missing_fields, '[]'::jsonb)) AS manquants
  FROM dpp_records r
  JOIN tracefab_products p ON p.id = r.product_id
  WHERE p.brand_organization_id = $1
    AND r.id IN (SELECT DISTINCT ON (product_id) id FROM dpp_records
                 WHERE product_id = r.product_id ORDER BY product_id, computed_at DESC)
  ORDER BY p.reference`, [ORG]);

const suffixe = mode === 'avant' ? 'avant' : 'apres';
writeFileSync(`/tmp/dpp_${suffixe}.json`, JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} produit(s) mesure(s) — detail enregistre dans /tmp/dpp_${suffixe}.json`);

if (mode === 'apres' && existsSync('/tmp/dpp_avant.json')) {
  const avant = JSON.parse(readFileSync('/tmp/dpp_avant.json', 'utf8'));
  const parRef = new Map(avant.map((r) => [r.reference, r]));
  console.log('\nref        | statut produit | avant (score/statut)      | apres (score/statut)');
  console.log('-----------+----------------+---------------------------+---------------------------');
  for (const a of rows) {
    const b = parRef.get(a.reference) || {};
    const scoreAvant = b.exigences_evaluees
      ? Math.round((Number(b.exigences_satisfaites) / Number(b.exigences_evaluees)) * 100) : null;
    const scoreApres = a.exigences_evaluees
      ? Math.round((Number(a.exigences_satisfaites) / Number(a.exigences_evaluees)) * 100) : null;
    console.log(`${a.reference.padEnd(11)}| ${String(a.statut_produit).padEnd(15)}| `
      + `${String(scoreAvant).padStart(3)} % ${String(b.statut_dpp).padEnd(16)}| `
      + `${String(scoreApres).padStart(3)} % ${a.statut_dpp}`);
  }
}

await client.end();
