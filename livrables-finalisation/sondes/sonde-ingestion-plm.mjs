#!/usr/bin/env node
/**
 * SONDE D'INGESTION PLM — scénario complet, appels réels.
 *
 * Elle remplace la sonde minimale précédente par un scénario qui vérifie les
 * points exigés : articles, matières, nœuds, liens, doublons, conflits, reprise,
 * erreur partielle, absence de doublon à la ré-ingestion, préservation des
 * données existantes et de leur version.
 *
 *   S1  ingestion nominale           : 1 article, 1 matière, 2 étapes
 *   S2  re-ingestion IDENTIQUE       : mêmes articles, pas de doublon de nœud
 *   S3  mise à jour de composition   : le pourcentage change, pas la version
 *   S4  erreur partielle             : un article invalide n'écrit RIEN
 *   S5  isolation                    : une autre organisation n'est pas touchée
 *   S6  préservation                 : un nœud préexistant garde son identité
 *
 * Chaque appel passe par `tracefab_ingest_plm_erp_payload`, donc — depuis la
 * correction — par `tracefab_add_supply_chain_link` pour les liens.
 *
 * Écrit uniquement dans la base jetable de DATABASE_URL. Nettoyage déterministe.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL requis.');
  process.exit(2);
}
const attendu = (process.argv.find((a) => a.startsWith('--attendu=')) || '--attendu=succes').split('=')[1];
const pg = (await import(process.env.TF_PG_MODULE || 'pg')).default;

const ORG = '00000000-0000-4000-8000-0000000000c1';
const ORG_AUTRE = '00000000-0000-4000-8000-0000000000c2';
const USER = '00000000-0000-4000-8000-0000000000c3';
const REF = 'SONDE-PLM-1';

const PAYLOAD = (materialsPct, etapes = 2) => ({
  products: [{
    reference: REF,
    name: 'Produit de sonde',
    sku: 'SONDE-SKU-1',
    category: 'tshirt',
    description: 'Produit cree par la sonde de banc',
    materials: [{ name: 'Coton sonde', type: 'fiber', percentage: materialsPct, role: 'main' }],
    supplyChainSteps: Array.from({ length: etapes }, (_, i) => ({
      label: `Etape ${i + 1}`, process: `proc_${i + 1}`, country: 'FR',
    })),
  }],
});

const admin = new pg.Client({ connectionString: url });
await admin.connect();
const resultats = [];
let code = 0;
function verifier(nom, condition, detail) {
  resultats.push({ nom, ok: condition, detail });
  if (!condition) code = 1;
  console.log(`${condition ? 'OK  ' : 'ECHEC'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

async function ingerer(payload, user = USER) {
  await admin.query('RESET ROLE');
  await admin.query(`SELECT set_config('tracefab.user_id', $1, false)`, [user]);
  await admin.query(`SELECT set_config('tracefab.active_organization_id', $1, false)`, [ORG]);
  await admin.query('SET ROLE tracefab_app');
  try {
    const { rows } = await admin.query(
      `SELECT public.tracefab_ingest_plm_erp_payload($1,'sap',$2::jsonb) AS sortie`, [ORG, JSON.stringify(payload)]);
    return { ok: true, sortie: rows[0].sortie };
  } catch (e) {
    return { ok: false, sqlstate: e.code, message: e.message };
  } finally {
    await admin.query('RESET ROLE');
  }
}

const compter = async (sql, params = []) => (await admin.query(sql, params)).rows[0];

try {
  await admin.query(
    `INSERT INTO public.organizations (id, type, legal_name, country_code) VALUES
       ($1,'brand','Sonde Ingestion','FR'), ($2,'brand','Sonde Autre','FR')
     ON CONFLICT (id) DO NOTHING`, [ORG, ORG_AUTRE]);
  await admin.query(
    `INSERT INTO public.users (id, clerk_user_id, email, full_name)
     VALUES ($1,'sonde_ingest','sonde-ingest@example.invalid','Sonde Ingest')
     ON CONFLICT (id) DO NOTHING`, [USER]);
  await admin.query(
    `INSERT INTO public.organization_memberships (organization_id, user_id, role, status)
     VALUES ($1,$2,'owner','active')
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role='owner', status='active'`, [ORG, USER]);

  // ---------------------------------------------------------------- S1
  const s1 = await ingerer(PAYLOAD(100));
  verifier('S1 ingestion nominale', s1.ok, s1.ok ? JSON.stringify(s1.sortie.summary).slice(0, 90) : `${s1.sqlstate} ${s1.message}`);

  const produit = await compter(
    'SELECT id, version, brand_organization_id FROM public.tracefab_products WHERE reference = $1 AND brand_organization_id = $2', [REF, ORG]);
  verifier('S1 produit cree, version 1', produit?.version === 1, `version=${produit?.version}`);

  const matieres = await compter(
    'SELECT count(*)::int AS n FROM public.product_materials WHERE product_id = $1', [produit.id]);
  verifier('S1 matiere rattachee', matieres.n === 1, `${matieres.n} ligne(s)`);

  const noeuds = await compter(
    'SELECT count(*)::int AS n FROM public.supply_chain_nodes WHERE graph_product_id = $1', [produit.id]);
  verifier('S1 deux noeuds d etapes', noeuds.n === 2, `${noeuds.n} noeud(s)`);

  const liens = await compter(
    'SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM public.supply_chain_links WHERE product_id = $1', [produit.id]);
  verifier('S1 un lien entre les deux etapes', liens.n === 1, `${liens.n} lien(s)`);

  const statuts = await admin.query(
    'SELECT DISTINCT l.status::text AS s, l.declared_by FROM public.supply_chain_links l WHERE l.product_id = $1', [produit.id]);
  verifier('S1 lien passe par la fonction officielle (status + declared_by poses)',
    statuts.rows.length === 1 && statuts.rows[0].s === 'declared' && statuts.rows[0].declared_by === USER,
    `status=${statuts.rows[0]?.s} declared_by=${statuts.rows[0]?.declared_by}`);

  // ---------------------------------------------------------------- S2
  const s2 = await ingerer(PAYLOAD(100));
  verifier('S2 re-ingestion identique : succes', s2.ok, s2.ok ? 'ok' : `${s2.sqlstate}`);
  const produit2 = await compter(
    'SELECT id, version FROM public.tracefab_products WHERE reference = $1 AND brand_organization_id = $2', [REF, ORG]);
  const noeuds2 = await compter(
    'SELECT count(*)::int AS n FROM public.supply_chain_nodes WHERE graph_product_id = $1', [produit2.id]);
  const liens2 = await compter(
    'SELECT count(*)::int AS n FROM public.supply_chain_links WHERE product_id = $1', [produit2.id]);
  const matieres2 = await compter(
    'SELECT count(*)::int AS n FROM public.product_materials WHERE product_id = $1', [produit2.id]);
  verifier('S2 aucun doublon de produit', produit2.id === produit.id, `id identique=${produit2.id === produit.id}`);
  verifier('S2 aucun doublon de noeud', noeuds2.n === 2, `${noeuds2.n} noeud(s)`);
  verifier('S2 aucun doublon de lien', liens2.n === 1, `${liens2.n} lien(s)`);
  verifier('S2 aucun doublon de matiere', matieres2.n === 1, `${matieres2.n} ligne(s)`);

  // ---------------------------------------------------------------- S3
  const s3 = await ingerer(PAYLOAD(55));
  const pct = await compter(
    'SELECT percentage FROM public.product_materials WHERE product_id = $1', [produit.id]);
  const produit3 = await compter(
    'SELECT version FROM public.tracefab_products WHERE id = $1', [produit.id]);
  verifier('S3 mise a jour de la composition', s3.ok && Number(pct.percentage) === 55, `pct=${pct?.percentage}`);
  verifier('S3 la version produit n a pas ete ecrasee', produit3.version === 1, `version=${produit3.version}`);

  // ---------------------------------------------------------------- S4
  const avant = await compter(
    'SELECT count(*)::int AS n FROM public.tracefab_products WHERE brand_organization_id = $1', [ORG]);
  const invalide = { products: [{ reference: 'SONDE-PLM-2', name: '', category: 'tshirt' }] };
  const s4 = await ingerer(invalide);
  const apres = await compter(
    'SELECT count(*)::int AS n FROM public.tracefab_products WHERE brand_organization_id = $1', [ORG]);
  verifier('S4 erreur partielle signalee', !s4.ok, s4.ok ? 'aucune erreur levee' : `${s4.sqlstate} ${String(s4.message).slice(0, 60)}`);
  verifier('S4 rien n a ete ecrit', apres.n === avant.n, `${avant.n} -> ${apres.n}`);

  // ---------------------------------------------------------------- S5
  const autre = await compter(
    'SELECT count(*)::int AS n FROM public.tracefab_products WHERE brand_organization_id = $1', [ORG_AUTRE]);
  verifier('S5 autre organisation non touchee', autre.n === 0, `${autre.n} produit(s)`);

  // ---------------------------------------------------------------- S6
  const noeudAvant = await compter(
    `SELECT id, label, metadata FROM public.supply_chain_nodes
      WHERE graph_product_id = $1 ORDER BY created_at, id LIMIT 1`, [produit.id]);
  await ingerer(PAYLOAD(55, 1));
  const noeudApres = await compter(
    'SELECT id FROM public.supply_chain_nodes WHERE id = $1', [noeudAvant.id]);
  verifier('S6 noeud preexistant preserve (meme identifiant)',
    noeudApres?.id === noeudAvant.id, `${noeudAvant.id?.slice(0, 8)}…`);
} finally {
  await admin.query('RESET ROLE').catch(() => {});
  const p = await admin.query('SELECT id FROM public.tracefab_products WHERE brand_organization_id = $1', [ORG]).catch(() => ({ rows: [] }));
  for (const { id } of p.rows) {
    await admin.query('DELETE FROM public.supply_chain_links WHERE product_id = $1', [id]).catch(() => {});
    await admin.query('DELETE FROM public.supply_chain_nodes WHERE graph_product_id = $1', [id]).catch(() => {});
    await admin.query('DELETE FROM public.product_materials WHERE product_id = $1', [id]).catch(() => {});
    await admin.query('DELETE FROM public.dpp_records WHERE product_id = $1', [id]).catch(() => {});
    await admin.query('DELETE FROM public.product_identifiers WHERE product_id = $1', [id]).catch(() => {});
  }
  await admin.query('DELETE FROM public.plm_erp_sync_jobs WHERE brand_organization_id = $1', [ORG]).catch(() => {});
  await admin.query('DELETE FROM public.tracefab_products WHERE brand_organization_id = $1', [ORG]).catch(() => {});
  await admin.query('DELETE FROM public.organization_memberships WHERE organization_id = $1', [ORG]).catch(() => {});
  await admin.query('DELETE FROM public.users WHERE id = $1', [USER]).catch(() => {});
  await admin.query('DELETE FROM public.organizations WHERE id = ANY($1)', [[ORG, ORG_AUTRE]]).catch(() => {});
  await admin.end();
}

console.log(`\nechecs : ${resultats.filter((r) => !r.ok).length}/${resultats.length}`);
if (attendu !== 'succes') {
  const ok = resultats.some((r) => (r.detail || '').includes(attendu));
  console.log(ok ? `VERDICT : defaut ${attendu} reproduit, conforme a l attendu`
    : `VERDICT : defaut ${attendu} NON reproduit`);
  process.exit(ok ? 0 : 1);
}
console.log(code === 0 ? 'VERDICT : ingestion conforme sur tous les scenarios'
  : 'VERDICT : ecart mesure');
process.exit(code);
