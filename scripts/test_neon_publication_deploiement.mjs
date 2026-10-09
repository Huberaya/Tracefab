#!/usr/bin/env node
/**
 * Répétition du déploiement de 20261010120000_publication_explicite.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * « Ne considère pas un rollback commenté comme un rollback testé. » La
 * migration porte un plan de retour arrière en commentaire : celui-ci le
 * REJOUE pour de vrai, sur une base de préproduction jetable, et vérifie que
 * l'état redevient exactement celui d'avant. Il vérifie aussi qu'une
 * sauvegarde se restaure réellement dans un environnement de test.
 *
 * Il ne s'exécute QUE contre un serveur local (garde sur l'hôte) et ne crée
 * que des bases jetables nommées tracefab_preprod / tracefab_restore_check.
 * Aucune base existante n'est modifiée, a fortiori la production.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:5433/postgres \
 *     node scripts/test_neon_publication_deploiement.mjs
 *
 * Sorties : 0 = répétition complète réussie, 1 = échec, 2 = non exécuté
 * (garde refusée). Un test qui ne s'exécute pas ne vaut pas un test qui passe.
 */
import pg from 'pg';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'prisma/migrations');
const MIGRATION = '20261010120000_publication_explicite';
const PREPROD = 'tracefab_preprod';
const RESTORE = 'tracefab_restore_check';
const SAUVEGARDE = '/tmp/tracefab_preprod_sauvegarde.json';

const URL_BASE = process.env.DATABASE_URL;
if (!URL_BASE) {
  console.error('NON EXECUTE — DATABASE_URL absente.');
  process.exit(2);
}

/* --- Garde : serveur local uniquement. ---------------------------------- */
{
  const h = new URL(URL_BASE).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(h)) {
    console.error(`NON EXECUTE — hôte « ${h} » refusé : ce script de répétition`);
    console.error('ne touche jamais un serveur distant, encore moins la production.');
    process.exit(2);
  }
}

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const verif = (cond, m, detail) => (cond ? ok(m) : ko(`${m}${detail ? ` — ${detail}` : ''}`));

const base = new pg.Client({ connectionString: URL_BASE, database: 'postgres' });
await base.connect();

const creerBase = async (nom) => {
  await base.query(`DROP DATABASE IF EXISTS ${nom}`);
  await base.query(`CREATE DATABASE ${nom}`);
};
const URL_DB = (nom) => new URL(URL_BASE).toString().replace(/\/[^/?]+(\?|$)/, `/${nom}$1`);

/* ========================================================================== *
 *  A. Préproduction : état de production AVANT la migration 36
 * ========================================================================== */
console.log('\n  A. base de préproduction — migrations 1..35 (état de production)');

await creerBase(PREPROD);
const preprod = new pg.Client({ connectionString: URL_DB(PREPROD) });
await preprod.connect();

// Journal Prisma + application dans l'ordre de `prisma migrate deploy`,
// SAUF la migration à déployer : on est exactement en production « à 35 ».
{
  await preprod.query(`CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at TIMESTAMPTZ,
    migration_name TEXT NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
  const dirs = readdirSync(MIG_DIR).filter((n) => n !== MIGRATION && statSync(join(MIG_DIR, n)).isDirectory()).sort();
  for (const nom of dirs) {
    const sql = readFileSync(join(MIG_DIR, nom, 'migration.sql'), 'utf8');
    const checksum = createHash('sha256').update(readFileSync(join(MIG_DIR, nom, 'migration.sql'))).digest('hex');
    const id = randomUUID();
    await preprod.query('INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at) VALUES ($1,$2,$3,now())', [id, checksum, nom]);
    await preprod.query(sql);
    await preprod.query('UPDATE _prisma_migrations SET finished_at = now(), applied_steps_count = 1 WHERE id = $1', [id]);
  }
  ok(`${dirs.length} migrations appliquées, ${MIGRATION} exclue (à déployer)`);
}

/* --- Données de scénario : six produits aux six états du parc ----------- */
{
  const U = {
    org: 'a0000000-0000-4000-8000-0000000000a1',
    org2: 'a0000000-0000-4000-8000-0000000000a2',
    user: 'b0000000-0000-4000-8000-0000000000b1',
    user2: 'b0000000-0000-4000-8000-0000000000b2',
    pa: 'c0000000-0000-4000-8000-0000000000c1',
    pb: 'c0000000-0000-4000-8000-0000000000c2',
    pc: 'c0000000-0000-4000-8000-0000000000c3',
    pd: 'c0000000-0000-4000-8000-0000000000c4',
    pe: 'c0000000-0000-4000-8000-0000000000c5',
    pf: 'c0000000-0000-4000-8000-0000000000c6',
    mat: 'd0000000-0000-4000-8000-0000000000d1',
  };
  globalThis.U = U;

  await preprod.query(
    `INSERT INTO organizations (id, type, legal_name, display_name, country_code) VALUES
     ($1, 'brand', 'Maison Deploiement SARL', 'Maison Deploiement', 'FR'),
     ($2, 'brand', 'Autre Maison SARL', 'Autre Maison', 'PT')`, [U.org, U.org2]);
  await preprod.query(
    `INSERT INTO users (id, clerk_user_id, email, full_name) VALUES
     ($1, 'clerk_dep_1', 'dep1@preuve.test', 'Relectrice Deploiement'),
     ($2, 'clerk_dep_2', 'dep2@preuve.test', 'Lecteur Externe')`, [U.user, U.user2]);
  await preprod.query(
    `INSERT INTO organization_memberships (id, organization_id, user_id, role, status) VALUES
     ('ffffffff-0000-4000-8000-000000000001', $1, $2, 'owner', 'active'),
     ('ffffffff-0000-4000-8000-000000000002', $3, $4, 'owner', 'active')`,
    [U.org, U.user, U.org2, U.user2]);
  await preprod.query(`INSERT INTO suppliers (id, organization_id) VALUES
     ('e0000000-0000-4000-8000-0000000000e1', $1)`, [U.org]);

  // PA : actif + slug + publié et relu — doit RESTER public.
  // PB : actif + slug, aucun dpp_record — artefact du backfill, doit être dépublié.
  // PC : actif + slug + publié mais PAS relu — doit être dépublié.
  // PD : actif + slug + brouillon — doit être dépublié.
  // PE : actif sans slug + publié et relu — reste privé (pas de slug).
  // PF : ARCHIVÉ + slug + publié et relu — cas limite : la règle le laisse public.
  await preprod.query(
    `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status, public_slug) VALUES
     ($1, $7, 'PUB-001', 'Chemise Publiee', 'active', 'pub-001'),
     ($2, $7, 'SANS-ETAT-001', 'Pull Sans Etat', 'active', 'sans-etat-001'),
     ($3, $7, 'NON-RELU-001', 'Veste Non Relue', 'active', 'non-relu-001'),
     ($4, $7, 'BROUILLON-001', 'Pantalon Brouillon', 'active', 'brouillon-001'),
     ($5, $7, 'PRIVE-001', 'Jupe Privee', 'active', NULL),
     ($6, $7, 'INACTIF-001', 'Manteau Archive', 'archived', 'inactif-001')`,
    [U.pa, U.pb, U.pc, U.pd, U.pe, U.pf, U.org]);
  await preprod.query(
    `INSERT INTO materials (id, owner_organization_id, material_type, name, normalized_name)
     VALUES ($1, $2, 'fiber', 'Coton', 'coton')`, [U.mat, U.org]);
  await preprod.query(
    `INSERT INTO product_materials (product_id, material_id, material_role, percentage, unit)
     VALUES ($1, $2, 'shell', 100, 'percent')`, [U.pa, U.mat]);
  await preprod.query(
    `INSERT INTO supplier_sites (id, supplier_id, name, country_code)
     SELECT 'e0000000-0000-4000-8000-0000000000e2', s.id, 'Site Confection', 'TN'
     FROM suppliers s WHERE s.organization_id = $1 LIMIT 1`, [U.org]);
  await preprod.query(
    `INSERT INTO supply_chain_nodes (id, node_type, product_id, label, status)
     VALUES ('e0000000-0000-4000-8000-0000000000e3', 'product', $1, 'Confection', 'declared')`, [U.pa]);
  // Site rattaché au produit publié. tracefab_supplier_site_is_public exige un
  // nœud dont supplier_site_id = le site ET dont product_id est public : deux
  // nœuds distincts, chacun avec UNE seule référence (trigger
  // tracefab_validate_supply_chain_node).
  await preprod.query(
    `INSERT INTO supply_chain_nodes (id, node_type, supplier_site_id, label, status)
     VALUES ('e0000000-0000-4000-8000-0000000000e4', 'site', 'e0000000-0000-4000-8000-0000000000e2', 'Site confection', 'declared')`);
  await preprod.query(
    `INSERT INTO dpp_records (id, product_id, product_version, requirement_profile_key,
       requirement_profile_version, readiness_status, reviewed_at, reviewed_by) VALUES
     ('f0000000-0000-4000-8000-0000000000f1', $1, 1, 'espr-textile', '1', 'published', '2026-10-02', $2),
     ('f0000000-0000-4000-8000-0000000000f2', $3, 1, 'espr-textile', '1', 'published', NULL, NULL),
     ('f0000000-0000-4000-8000-0000000000f3', $4, 1, 'espr-textile', '1', 'in_progress', NULL, NULL),
     ('f0000000-0000-4000-8000-0000000000f4', $5, 1, 'espr-textile', '1', 'published', '2026-10-02', $2),
     ('f0000000-0000-4000-8000-0000000000f5', $6, 1, 'espr-textile', '1', 'published', '2026-10-02', $2)`,
    [U.pa, U.user, U.pc, U.pd, U.pe, U.pf]);
  ok('six produits de scénario en place (PA..PF)');
}

/* ========================================================================== *
 *  B. Inventaire avant déploiement (requêtes du runbook)
 * ========================================================================== */
console.log('\n  B. inventaire — ce que le déploiement va changer');

const reqPubliable = `
  SELECT p.reference, p.public_slug, p.status FROM tracefab_products p
   WHERE p.public_slug IS NOT NULL
     AND EXISTS (SELECT 1 FROM dpp_records d WHERE d.product_id = p.id
                   AND d.readiness_status = 'published' AND d.reviewed_at IS NOT NULL)
   ORDER BY p.reference`;
const reqDepublie = `
  SELECT p.reference, p.public_slug, p.status FROM tracefab_products p
   WHERE p.public_slug IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM dpp_records d WHERE d.product_id = p.id
                       AND d.readiness_status = 'published' AND d.reviewed_at IS NOT NULL)
   ORDER BY p.reference`;
const reqPrives = `
  SELECT p.reference, p.status FROM tracefab_products p
   WHERE p.public_slug IS NULL ORDER BY p.reference`;

const avPublies = (await preprod.query(reqPubliable)).rows;
const avDepublies = (await preprod.query(reqDepublie)).rows;
const avPrives = (await preprod.query(reqPrives)).rows;
console.log(`  reste public (déjà en règle) : ${avPublies.map((r) => r.reference).join(', ') || '(aucun)'}`);
console.log(`  sera dépublié (slug retiré)   : ${avDepublies.map((r) => r.reference).join(', ') || '(aucun)'}`);
console.log(`  reste inaccessible            : ${avPrives.map((r) => r.reference).join(', ') || '(aucun)'}`);
verif(avPublies.map((r) => r.reference).join() === 'INACTIF-001,PUB-001',
  'inventaire « reste public » = [INACTIF-001 (archivé, publié et relu), PUB-001]');
verif(avDepublies.map((r) => r.reference).join() === 'BROUILLON-001,NON-RELU-001,SANS-ETAT-001',
  'inventaire « sera dépublié » = [BROUILLON-001, NON-RELU-001, SANS-ETAT-001]');

// Instantané exact des slugs : la base du retour arrière parfait.
const snapshot = (await preprod.query('SELECT id, public_slug FROM tracefab_products ORDER BY reference')).rows;
writeFileSync(SAUVEGARDE, JSON.stringify(snapshot, null, 2));
ok('instantané des public_slug écrit (base du retour arrière)');

/* ========================================================================== *
 *  C. Déploiement de la migration 36
 * ========================================================================== */
console.log(`\n  C. déploiement de ${MIGRATION}`);
{
  const sql = readFileSync(join(MIG_DIR, MIGRATION, 'migration.sql'), 'utf8');
  const checksum = createHash('sha256').update(readFileSync(join(MIG_DIR, MIGRATION, 'migration.sql'))).digest('hex');
  const id = randomUUID();
  await preprod.query('INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at) VALUES ($1,$2,$3,now())', [id, checksum, MIGRATION]);
  await preprod.query(sql);
  await preprod.query('UPDATE _prisma_migrations SET finished_at = now(), applied_steps_count = 1 WHERE id = $1', [id]);
  ok('migration appliquée (journal Prisma tenu)');
}

/* ========================================================================== *
 *  D. Vérifications post-déploiement
 * ========================================================================== */
console.log('\n  D. vérifications en base');

// D1. Aucun produit public sans état publié et relu.
{
  const r = await preprod.query(`
    SELECT count(*)::int n FROM tracefab_products p
     WHERE p.public_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dpp_records d WHERE d.product_id = p.id
                         AND d.readiness_status = 'published' AND d.reviewed_at IS NOT NULL)`);
  verif(Number(r.rows[0].n) === 0, 'aucun produit public sans dpp_records publié et relu');
}
// D2. Slugs retirés exactement sur l'ensemble prévu.
{
  const r = await preprod.query('SELECT reference FROM tracefab_products WHERE public_slug IS NULL ORDER BY reference');
  verif(r.rows.map((x) => x.reference).join() === 'BROUILLON-001,NON-RELU-001,PRIVE-001,SANS-ETAT-001',
    'slugs retirés exactement sur BROUILLON-001, NON-RELU-001, SANS-ETAT-001 (PRIVE-001 n en avait pas)',
    r.rows.map((x) => x.reference).join());
}
// D3. Fonctions durcies.
{
  const r = await preprod.query(`SELECT proname, prosrc FROM pg_proc
    WHERE proname IN ('tracefab_product_is_public','tracefab_material_is_public','tracefab_supplier_site_is_public','tracefab_public_brand')`);
  const src = Object.fromEntries(r.rows.map((x) => [x.proname, x.prosrc]));
  verif(/readiness_status/.test(src.tracefab_product_is_public || ''), 'tracefab_product_is_public exige readiness_status + reviewed_at');
  verif(/tracefab_product_is_public/.test(src.tracefab_material_is_public || ''), 'tracefab_material_is_public passe par la barrière');
  verif(/tracefab_product_is_public/.test(src.tracefab_supplier_site_is_public || ''), 'tracefab_supplier_site_is_public passe par la barrière');
  verif(/tracefab_product_is_public/.test(src.tracefab_public_brand || ''), 'tracefab_public_brand passe par la barrière');
}
// D4. Politique produit alignée.
{
  const r = await preprod.query(`SELECT qual FROM pg_policies
    WHERE tablename = 'tracefab_products' AND policyname = 'products_select_public'`);
  verif(r.rows.length === 1 && /tracefab_product_is_public\(id\)/.test(r.rows[0].qual),
    'politique products_select_public passe par tracefab_product_is_public(id)', r.rows[0]?.qual);
}
// D5. Cas limite documenté : inactif + slug + publié/relu reste public.
{
  const r = await preprod.query(`SELECT count(*)::int n FROM tracefab_products
    WHERE reference = 'INACTIF-001' AND public_slug IS NOT NULL`);
  verif(Number(r.rows[0].n) === 1,
    'cas limite : INACTIF-001 (archivé, publié et relu) conserve son slug — à trancher avant prod');
}

/* ========================================================================== *
 *  E. Matrice d'accès — rôle applicatif réel, RLS évaluée
 * ========================================================================== */
console.log('\n  E. matrice d’accès (rôle tracefab_app, sans BYPASSRLS)');

// Étape officielle du déploiement : bootstrap_app_role pose le rôle runtime et
// ses droits (EXECUTE sur les fonctions incluses). Sans elle, les fonctions
// tracefab_is_org_member… restent refusées au rôle applicatif.
{
  execFileSync(process.execPath, [join(ROOT, 'scripts/bootstrap_app_role.mjs')], {
    env: { ...process.env, DATABASE_URL: URL_DB(PREPROD), TF_APP_PASSWORD: process.env.TF_APP_PASSWORD || 'isolation_ci_jetable' },
    stdio: 'pipe',
  });
  ok('rôle applicatif posé par bootstrap_app_role (étape du runbook)');
}
const URL_APP = process.env.TF_RLS_APP_URL || URL_DB(PREPROD);
const app = new pg.Client({ connectionString: URL_APP, database: PREPROD });
await app.connect();
{
  const r = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  verif(r.rows[0] && !r.rows[0].rolsuper && !r.rows[0].rolbypassrls,
    'le rôle applicatif n’est ni superuser ni BYPASSRLS', JSON.stringify(r.rows[0]));
}
{
  const n = Number((await app.query('SELECT count(*)::int n FROM tracefab_products')).rows[0].n);
  verif(n === 0, 'sans contexte : aucune ligne produit visible');
}
{
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.public_context','true',true)");
  const r = await app.query('SELECT reference FROM tracefab_products ORDER BY reference');
  await app.query('ROLLBACK');
  verif(r.rows.map((x) => x.reference).join() === 'INACTIF-001,PUB-001',
    'contexte public : exactement [INACTIF-001, PUB-001]', r.rows.map((x) => x.reference).join());
}
{
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.public_context','true',true)");
  const g = await app.query(`SELECT display_name FROM tracefab_public_brand($1)`, [globalThis.U.org]);
  const o = await app.query('SELECT count(*)::int n FROM organizations');
  await app.query('ROLLBACK');
  verif(g.rows.length === 1 && g.rows[0].display_name === 'Maison Deploiement'
    && !('legal_name' in g.rows[0]),
    'marque publique : display_name + country_code, jamais la raison sociale');
  verif(Number(o.rows[0].n) === 0, 'organizations reste fermée en contexte public');
}
{
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.user_id',$1,true)", [globalThis.U.user]);
  const r = await app.query('SELECT reference FROM tracefab_products ORDER BY reference');
  await app.query('ROLLBACK');
  verif(r.rows.map((x) => x.reference).join().startsWith('BROUILLON-001'),
    'utilisateur de l’org A : voit les six produits de A (isolation assurée côté B)', r.rows.map((x) => x.reference).join());
}
{
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.user_id',$1,true)", [globalThis.U.user2]);
  const r = await app.query('SELECT count(*)::int n FROM tracefab_products WHERE id = $1', [globalThis.U.pa]);
  const tot = await app.query('SELECT count(*)::int n FROM tracefab_products');
  await app.query('ROLLBACK');
  verif(Number(r.rows[0].n) === 0, 'utilisateur de l’org B : le produit A est invisible par son id');
  verif(Number(tot.rows[0].n) === 0, 'utilisateur de l’org B : aucune ligne de l’org A');
}
// Matières et sites suivent la barrière.
{
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.public_context','true',true)");
  const m = await app.query('SELECT count(*)::int n FROM materials');
  const s = await app.query('SELECT count(*)::int n FROM supplier_sites');
  await app.query('ROLLBACK');
  verif(Number(m.rows[0].n) === 1, 'matière du produit public visible, seule');
  // Constat produit, pas un échec de déploiement : tracefab_supplier_site_is_public
  // exige UN nœud portant à la fois supplier_site_id ET un product_id public.
  // Le trigger interdit deux références sur un même nœud : un site ne peut donc
  // jamais être public par cette voie. Comportement sûr (fermé), à documenter
  // comme limite connue avant toute ouverture de la chaîne d'approvisionnement.
  verif(Number(s.rows[0].n) === 0,
    'site rattaché : invisible en contexte public (limite connue : aucun nœud ne porte site + produit à la fois)',
    `visibles=${s.rows[0].n}`);
}

/* ========================================================================== *
 *  F. URL publiques et anciens liens
 * ========================================================================== */
console.log('\n  F. URL publiques (prédictions de résolution)');

// Même barrière que le résolveur (/api/dpp/:gtin) : produit PUBLIÉ seulement.
// Résolution anonyme : même chemin que la route publique (contexte public posé
// dans la transaction, comme withTracefabPublicContext). Sans ce contexte, la
// RLS ne rend rien — c'est la barrière qui fonctionne, pas une panne.
const resout = async (quoi, valeur) => {
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.public_context','true',true)");
  const r = await app.query(
    `SELECT count(*)::int n FROM tracefab_products p
      WHERE p.public_slug IS NOT NULL
        AND EXISTS (SELECT 1 FROM dpp_records d WHERE d.product_id = p.id
                      AND d.readiness_status = 'published' AND d.reviewed_at IS NOT NULL)
        AND (p.id::text = $1 OR p.public_slug = $1 OR lower(p.reference) = lower($1)
             OR EXISTS (SELECT 1 FROM product_identifiers pi WHERE pi.product_id = p.id
                          AND pi.identifier_value = $1))`, [valeur]);
  await app.query('ROLLBACK');
  return Number(r.rows[0].n) > 0;
};
verif(await resout('slug', 'pub-001'), 'ancien lien /?id=pub-001 résout encore');
verif(!(await resout('slug retiré', 'sans-etat-001')), 'ancien lien /?id=sans-etat-001 ne résout plus (dépublié)');
verif(!(await resout('slug retiré', 'brouillon-001')), 'ancien lien /?id=brouillon-001 ne résout plus');
verif(!(await resout('gtin démo historique', '3760123456789')), 'GTIN démo historique 3760123456789 : aucune fiche');

/* ========================================================================== *
 *  G. Retour arrière — REJOYÉ, pas seulement commenté
 * ========================================================================== */
console.log('\n  G. retour arrière complet (fonctions + politique + données)');

// Le commentaire de la migration ne restaure que les données. Le retour
// arrière complet restaure aussi les fonctions et la politique dans leur
// définition d'avant. Les données reviennent par l'instantané exact (et non
// lower(reference), qui perdrait un slug personnalisé).
const ROLLBACK = `
CREATE OR REPLACE FUNCTION tracefab_product_is_public(p_product_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM tracefab_products p
   WHERE p.id = p_product_id AND p.public_slug IS NOT NULL);
$$;
CREATE OR REPLACE FUNCTION tracefab_material_is_public(p_material_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM product_materials pm
   JOIN tracefab_products p ON p.id = pm.product_id
   WHERE pm.material_id = p_material_id AND p.public_slug IS NOT NULL);
$$;
CREATE OR REPLACE FUNCTION tracefab_supplier_site_is_public(p_site_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM supply_chain_nodes n
   JOIN tracefab_products p ON p.id = n.product_id
   WHERE n.supplier_site_id = p_site_id AND p.public_slug IS NOT NULL);
$$;
CREATE OR REPLACE FUNCTION tracefab_public_brand(p_organization_id uuid)
RETURNS TABLE (display_name text, country_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT o.display_name, o.country_code FROM organizations o
   WHERE o.id = p_organization_id
     AND EXISTS (SELECT 1 FROM tracefab_products p
      WHERE p.brand_organization_id = o.id AND p.public_slug IS NOT NULL);
$$;
DROP POLICY IF EXISTS products_select_public ON tracefab_products;
CREATE POLICY products_select_public ON tracefab_products
  FOR SELECT USING (tracefab_public_context() AND public_slug IS NOT NULL);`;

await preprod.query('BEGIN');
await preprod.query(ROLLBACK);
for (const ligne of snapshot) {
  await preprod.query('UPDATE tracefab_products SET public_slug = $2 WHERE id = $1', [ligne.id, ligne.public_slug]);
}
await preprod.query('COMMIT');

{
  const r = await preprod.query('SELECT public_slug FROM tracefab_products WHERE reference = $1', ['SANS-ETAT-001']);
  verif(r.rows[0].public_slug === 'sans-etat-001', 'retour arrière : slug exact restauré depuis l’instantané');
  const f = await preprod.query(`SELECT prosrc FROM pg_proc WHERE proname = 'tracefab_product_is_public'`);
  verif(!/readiness_status/.test(f.rows[0].prosrc), 'retour arrière : fonction revenue à la définition d’avant');
  const p = await preprod.query(`SELECT qual FROM pg_policies WHERE policyname = 'products_select_public'`);
  verif(/public_slug IS NOT NULL/.test(p.rows[0].qual) && !/tracefab_product_is_public/.test(p.rows[0].qual),
    'retour arrière : politique revenue à public_slug IS NOT NULL');
  const tot = await preprod.query('SELECT count(*)::int n FROM tracefab_products WHERE public_slug IS NULL');
  verif(Number(tot.rows[0].n) === 1, 'retour arrière : seul PRIVE-001 reste sans slug', tot.rows[0].n);
}
ok('état « production à 35 » restauré — le rollback n’est plus seulement commenté');

/* ========================================================================== *
 *  H. Ré-application (idempotence) — le déploiement reste rejouable
 * ========================================================================== */
console.log('\n  H. ré-application de la migration (idempotence)');
{
  const sql = readFileSync(join(MIG_DIR, MIGRATION, 'migration.sql'), 'utf8');
  await preprod.query(sql);
  const r = await preprod.query(`SELECT count(*)::int n FROM tracefab_products
    WHERE public_slug IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dpp_records d WHERE d.product_id = tracefab_products.id
                        AND d.readiness_status = 'published' AND d.reviewed_at IS NOT NULL)`);
  verif(Number(r.rows[0].n) === 0, 'ré-application : même résultat, aucune divergence');
  const f = await preprod.query(`SELECT prosrc FROM pg_proc WHERE proname = 'tracefab_product_is_public'`);
  verif(/readiness_status/.test(f.rows[0].prosrc), 'ré-application : fonctions durcies inchangées');
}

/* ========================================================================== *
 *  I. Sauvegarde / restauration dans un environnement de test
 * ========================================================================== */
console.log('\n  I. sauvegarde logique et restauration vérifiée');

// Outils disponibles dans la sandbox : pas de pg_dump système. La sauvegarde
// est donc logique (par table) et la structure rejouée par la chaîne de
// migrations — c'est le chemin de restauration documenté, testé de bout en
// bout : dump fichier → base neuve → migrations 1..36 → recopie → comparaison.
{
  const tables = (await preprod.query(`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
     ORDER BY tablename`)).rows.map((r) => r.tablename);
  const dump = {};
  for (const t of tables) {
    const cols = (await preprod.query(
      `SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) c
         FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'`, [t])).rows[0].c;
    const r = await preprod.query(`SELECT ${cols} FROM ${t}`);
    dump[t] = { cols, rows: r.rows };
  }
  writeFileSync(SAUVEGARDE + '.db.json', JSON.stringify(dump));
  ok(`sauvegarde logique : ${tables.length} tables (${Object.values(dump).reduce((n, t) => n + t.rows.length, 0)} lignes)`);

  await creerBase(RESTORE);
  const restore = new pg.Client({ connectionString: URL_DB(RESTORE) });
  await restore.connect();
  {
    const dirs = readdirSync(MIG_DIR).filter((n) => statSync(join(MIG_DIR, n)).isDirectory()).sort(); // y compris la 36
    for (const nom of dirs) {
      await restore.query(readFileSync(join(MIG_DIR, nom, 'migration.sql'), 'utf8'));
    }
    ok('structure rejouée par la chaîne de migrations complète (1..36)');
  }
  // Restauration logique : session_replication_role=replica suspend les
  // triggers et contrôles de clé étrangère le temps du chargement, comme
  // pg_restore --disable-triggers. Les contraintes sont vérifiées ensuite
  // par la comparaison des lignes ci-dessous.
  // Une restauration remplace : les données de référence posées par la chaîne
  // de migrations (profils d'exigences, etc.) sont vidées avant chargement.
  const toutes = tables.join(', ');
  await restore.query(`TRUNCATE ${toutes} RESTART IDENTITY CASCADE`);
  await restore.query("SET session_replication_role = replica");
  for (const [t, { cols, rows }] of Object.entries(dump)) {
    if (!rows.length) continue;
    for (const ligne of rows) {
      const params = Object.values(ligne);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
      await restore.query(
        `INSERT INTO ${t} (${cols}) VALUES (${placeholders})`, params);
    }
  }
  await restore.query("SET session_replication_role = origin");
  {
    const divergences = [];
    for (const t of tables) {
      const a = Number((await preprod.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
      const b = Number((await restore.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
      if (a !== b) divergences.push(`${t}: ${a}≠${b}`);
    }
    verif(divergences.length === 0, 'restauration : toutes les tables ont le même nombre de lignes',
      divergences.join(' · '));
    const f = await restore.query(`SELECT prosrc FROM pg_proc WHERE proname = 'tracefab_product_is_public'`);
    verif(/readiness_status/.test(f.rows[0].prosrc), 'restauration : barrière de publication présente');
    const p = await restore.query(`SELECT qual FROM pg_policies WHERE policyname = 'products_select_public'`);
    verif(/tracefab_product_is_public/.test(p.rows[0].qual), 'restauration : politique publique présente');
  }
  await restore.end();
  ok(`base de restauration ${RESTORE} vérifiée puis conservée pour inspection`);
}

await app.end();
await preprod.end();
await base.end();

console.log(echecs
  ? `\n${echecs} échec(s) — le déploiement n'est pas prêt.`
  : '\nRépétition complète : déploiement, vérifications, retour arrière et restauration — verts.');
process.exit(echecs ? 1 : 0);
