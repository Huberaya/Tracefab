#!/usr/bin/env node
/**
 * DEUX migrations correctives coexistent sur `plm_erp_sync_jobs` :
 *
 *   20261028150000_reconcile_plm_erp_sync_job_policies
 *       gardes AVANT les DROP (table, canoniques, forme de l INSERT, nombre et
 *       identite des politiques) puis deux DROP ;
 *   20261029150000_plm_sync_jobs_policy_alignment
 *       deux DROP, puis verification APRES, dans la meme transaction.
 *
 * Elles font le MEME travail. Ce test ne tranche pas laquelle garder — c'est
 * une decision de chef de chantier — il mesure ce que chacune garantit, pour
 * que la decision se prenne sur des faits :
 *
 *   - sur l etat de derive reel (4 politiques), les deux laissent 2 canoniques
 *     et ne touchent pas leurs definitions ;
 *   - en chaine, les deux s'enchainent sans dommage : la seconde est un no-op ;
 *   - elles different sur les etats DEGRADES : la 28150000 refuse avant d agir,
 *     la 29150000 agit puis annule (meme resultat en base, diagnostic plus tardif)
 *     et surtout elle ne CONTROLE PAS le nombre de politiques.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(racine, 'prisma', 'migrations');
const M1 = '20261028150000_reconcile_plm_erp_sync_job_policies';
const M2 = '20261029150000_plm_sync_jobs_policy_alignment';
const CANONIQUES = ['plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org'];
const SURNUMERAIRES = ['plm_erp_sync_jobs_insert_brand', 'plm_erp_sync_jobs_select_brand'];

let verifies = 0; let echecs = 0;
const ok = (l, c, d = '') => {
  verifies += 1;
  if (c) { console.log(`  ok    ${l}`); return; }
  echecs += 1; console.error(`  ECHEC ${l}${d ? ` — ${d}` : ''}`);
};

const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');

async function base({ arreterAvant = null, sauter = [] } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;`);
  for (const d of dossiers) {
    if (arreterAvant && d >= arreterAvant) break;
    if (sauter.includes(d)) continue;
    if (!existsSync(join(MIGRATIONS, d, 'migration.sql'))) continue;
    try {
      await db.exec('BEGIN'); await db.exec(lire(d)); await db.exec('COMMIT');
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch { /* deja fermee */ }
      throw new Error(`${d} : ${String(e.message).split('\n')[0]}`);
    }
  }
  return db;
}

async function politiques(db) {
  try {
    const { rows } = await db.query(`
      SELECT p.polname AS nom, p.polcmd AS cmd,
             pg_catalog.pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
             pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
        FROM pg_catalog.pg_policy p
       WHERE p.polrelid = 'public.plm_erp_sync_jobs'::regclass
       ORDER BY 1`);
    return rows;
  } catch { return []; }
}
const noms = (ps) => ps.map((p) => p.nom).sort();
const sig = (ps) => JSON.stringify([...ps].sort((a, b) => a.nom.localeCompare(b.nom)));
const canoniques = (ps) => ps.filter((p) => CANONIQUES.includes(p.nom));

/** Etat de production : les 2 canoniques + les 2 surnumeraires. */
async function deriver(db, variante = 'true') {
  const using = variante === 'duplicata' ? 'tracefab_is_org_member(brand_organization_id)' : 'true';
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (${using});`);
}

async function jouer(db, dossier) {
  try { await db.exec(lire(dossier)); return { ok: true }; }
  catch (e) {
    const message = String(e.message).split('\n')[0];
    try { await db.exec('ROLLBACK'); } catch { /* deja fermee */ }
    return { ok: false, message };
  }
}

// =========================================================================
console.log('1. Chaine complete (66 migrations) sur base neuve  [MESURE]');
{
  const db = await base();
  const ps = await politiques(db);
  ok('la chaine entiere passe', true);
  ok('elle se termine sur les 2 canoniques', noms(ps).length === 2
    && JSON.stringify(noms(ps)) === JSON.stringify([...CANONIQUES].sort()),
    JSON.stringify(noms(ps)));
  ok('aucun surnumeraire ne subsiste', SURNUMERAIRES.every((n) => !noms(ps).includes(n)));
  await db.close();
}

// =========================================================================
console.log('\n2. Chacune SEULE sur l etat de derive (4 politiques)  [MESURE]');
for (const [libelle, mig] of [['20261028150000', M1], ['20261029150000', M2]]) {
  for (const variante of ['true', 'duplicata']) {
    const db = await base({ arreterAvant: M1 });
    await deriver(db, variante);
    const avant = await politiques(db);
    ok(`[${libelle}/${variante}] etat de depart : 4 politiques`, avant.length === 4,
      JSON.stringify(noms(avant)));
    const sigCanoniquesAvant = sig(canoniques(avant));

    const r = await jouer(db, mig);
    ok(`[${libelle}/${variante}] la migration passe`, r.ok, r.message);
    const apres = await politiques(db);
    ok(`[${libelle}/${variante}] 2 politiques, les canoniques`,
      JSON.stringify(noms(apres)) === JSON.stringify([...CANONIQUES].sort()),
      JSON.stringify(noms(apres)));
    ok(`[${libelle}/${variante}] les canoniques sont INCHANGEES, definition identique`,
      sig(canoniques(apres)) === sigCanoniquesAvant);
    await db.close();
  }
}

// =========================================================================
console.log('\n3. En chaine : la seconde est-elle un no-op ?  [MESURE]');
{
  const db = await base({ arreterAvant: M1 });
  await deriver(db);
  const r1 = await jouer(db, M1);
  ok('1er passage (28150000) accepte', r1.ok, r1.message);
  const apres1 = await politiques(db);
  const r2 = await jouer(db, M2);
  ok('2e passage (29150000) accepte aussi : etat deja propre', r2.ok, r2.message);
  const apres2 = await politiques(db);
  ok('aucun changement entre les deux : la seconde ne peut rien retirer',
    sig(apres2) === sig(apres1), `${noms(apres1)} -> ${noms(apres2)}`);
  ok('toujours 2 canoniques', apres2.length === 2);
  await db.close();
}

// =========================================================================
console.log('\n4. Ordre inverse, et rejeu de chacune  [MESURE]');
{
  const db = await base({ arreterAvant: M1 });
  await deriver(db);
  const r2 = await jouer(db, M2);
  ok('29150000 d abord : accepte', r2.ok, r2.message);
  const r1 = await jouer(db, M1);
  ok('28150000 ensuite : accepte (etat a 2 = autorise par son garde)', r1.ok, r1.message);
  ok('2 politiques', (await politiques(db)).length === 2);
  await db.close();

  for (const mig of [M1, M2]) {
    const db = await base({ arreterAvant: M1 });
    await deriver(db);
    const a = await jouer(db, mig);
    const b = await jouer(db, mig);
    ok(`${mig.slice(0, 14)} est idempotente (deux executions)`, a.ok && b.ok,
      `${a.message ?? ''} ${b.message ?? ''}`);
    await db.close();
  }
}

// =========================================================================
console.log('\n5. Etats DEGRADES : ce que chacune garantit  [MESURE]');
{
  // 5.1 canonique INSERT absente -> les deux doivent echouer, et ne rien laisser casse.
  for (const [libelle, mig] of [['28150000', M1], ['29150000', M2]]) {
    const db = await base({ arreterAvant: M1 });
    await deriver(db);
    await db.exec(`DROP POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;`);
    const r = await jouer(db, mig);
    ok(`[${libelle}] canonique absente : REFUS`, !r.ok, r.message);
    const apres = await politiques(db);
    ok(`[${libelle}] canonique absente : les 2 surnumeraires sont INTACTES`,
      SURNUMERAIRES.every((n) => apres.some((p) => p.nom === n)), JSON.stringify(noms(apres)));
    await db.close();
  }

  // 5.2 une 5e politique inattendue -> DIVERGENCE DE GARANTIE entre les deux.
  const resultats = {};
  for (const [libelle, mig] of [['28150000', M1], ['29150000', M2]]) {
    const db = await base({ arreterAvant: M1 });
    await deriver(db);
    await db.exec(`
      CREATE POLICY plm_erp_sync_jobs_archive_select ON public.plm_erp_sync_jobs
        FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id)
                                    AND job_reference LIKE 'archive-%');`);
    const r = await jouer(db, mig);
    const apres = await politiques(db);
    resultats[libelle] = { passe: r.ok, reste: apres.length, noms: noms(apres) };
    await db.close();
  }
  ok('5e politique : 28150000 REFUSE (garde de nombre)', resultats['28150000'].passe === false,
    JSON.stringify(resultats['28150000']));
  ok('5e politique : 29150000 PASSE — elle ne compte pas les politiques',
    resultats['29150000'].passe === true, JSON.stringify(resultats['29150000']));
  ok('5e politique : et laisse 3 politiques au lieu de 2',
    resultats['29150000'].reste === 3, JSON.stringify(resultats['29150000'].noms));
  console.log('  --    ce n est pas un defaut du test : c est la difference de');
  console.log('  --    garantie entre les deux migrations, et l argument pour conserver');
  console.log('  --    28150000 (ou pour doter 29150000 du meme garde).');
}

// =========================================================================
console.log('\n6. Temoins : ces controles savent-ils echouer ?  [MESURE]');
{
  // Un test qui ne peut pas echouer ne prouve rien. On injecte deux derives
  // volontaires et on verifie que la mesure les voit.
  const db = await base({ arreterAvant: M1 });
  await deriver(db);
  const avant = await politiques(db);
  ok('temoin : l etat a 4 est bien 4 (si ceci tombait, tout le reste serait faux)',
    avant.length === 4);
  await db.exec('DROP POLICY plm_sync_jobs_select_org ON public.plm_erp_sync_jobs;');
  const sansSelect = await politiques(db);
  ok('temoin : retirer une canonique fait bien tomber le compte a 3',
    sansSelect.length === 3, JSON.stringify(noms(sansSelect)));
  const r = await jouer(db, M1);
  ok('temoin : la migration voit cette disparition et refuse', !r.ok, r.message);
  await db.close();
}

console.log('\n--------------------------------------------');
if (echecs === 0) {
  console.log(`${verifies} verifications passees.`);
  console.log('Les deux migrations correctives font bien le meme travail sur l etat');
  console.log('reel, laissent les canoniques intactes, et sont idempotentes. Elles');
  console.log('different sur un seul point, mesure : le garde de NOMBRE.');
  process.exit(0);
}
console.error(`${echecs} echec(s) sur ${verifies} verifications.`);
process.exit(1);
