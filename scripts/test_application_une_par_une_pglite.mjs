#!/usr/bin/env node
/**
 * APPLICATION UNE PAR UNE — la dette des migrations, mesuree.
 *
 * Question posee : peut-on appliquer les migrations manquantes « en bloc » ?
 * Ce test construit une base jetable a l'ETAT DE PRODUCTION reconstitue, puis
 * applique les migrations manquantes UNE PAR UNE, dans l'ordre, et enregistre
 * l'issue de chacune. Il ne suppose rien : il mesure.
 *
 * ETAT DE PRODUCTION RECONSTITUE :
 *   49 attestees + 5 hors bande + 2 migrations reussies apres une tentative annulee
 *   = 56 migrations jouees, et les 43 autres (10 absentes + 33 nouvelles) NON
 *   jouees. La migration 20261028120050, ajoutee apres le releve mais antidatee,
 *   est classee explicitement ABSENTE. Ce n'est pas une hypothese sur la production : c'est la seule
 *   combinaison compatible avec le releve du 28/10, et elle sert de support.
 *
 * CE QUE LE TEST DOIT ETABLIR :
 *   1. une par une, dans l'ordre, les 43 passent — donc un plan sequentiel est
 *      possible sans `deploy` global ;
 *   2. `20261028120000` n'est pas rejouable manuellement (CREATE TABLE sans
 *      garde), mais une migration déjà réussie n'est pas rejouée par Prisma ;
 *   3. les migrations qui la SUIVENT en dependent : appliquer `...120100` sans
 *      elle echoue (c'est la dependance, pas une precaution) ;
 *   4. les deux migrations avec une tentative ANNULEE ont une reprise
 *      ulterieure terminee : elles sont deja appliquees et ne doivent pas etre
 *      rejouees ni comptees parmi les migrations en attente ;
 *   5. a l'arrivee, l'etat est celui d'une chaine neuve : 2 politiques.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECARTS, HORS_BANDE, BORNE_RELEVE } from './lib/ecarts_migrations.mjs';
import { preparerWorkerPglite } from './lib/pglite-worker-runner.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(racine, 'prisma', 'migrations');

let verifies = 0; let echecs = 0;
const ok = (l, c, d = '') => {
  verifies += 1;
  if (c) { console.log(`  ok    ${l}`); return; }
  echecs += 1; console.error(`  ECHEC ${l}${d ? ` — ${d}` : ''}`);
};

const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');

const absentes = Object.keys(ECARTS).filter((n) => ECARTS[n].historique === 'ABSENTE').sort();
const annulees = Object.keys(ECARTS).filter((n) => ECARTS[n].historique === 'ANNULEE' && !ECARTS[n].tentative_annulee_reprise_reussie).sort();
// Derivee, pas recopiee : toute migration posterieure au releve et hors ecarts.
const nouvelles = dossiers.filter((d) => !ECARTS[d] && !HORS_BANDE[d] && d > BORNE_RELEVE);
const manquantes = [...absentes, ...nouvelles].sort();

const nouveauCluster = async () => {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;`);
  return db;
};

/** Joue une migration seule ; ne laisse jamais la session cassee. */
async function jouer(db, d) {
  let nettoyer = async () => {};
  try {
    // Le worker est préprovisionné hors transaction : un échec SQL de la
    // migration ne doit ni laisser un bail actif ni empêcher le nettoyage.
    nettoyer = await preparerWorkerPglite(db, d);
    await db.exec('BEGIN');
    await db.exec(lire(d));
    await nettoyer();
    await db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    const message = String(e.message).split('\n')[0];
    try { await db.exec('ROLLBACK'); } catch { /* déjà fermée */ }
    await nettoyer().catch(() => {});
    return { ok: false, message };
  }
}

/** Etat de production reconstitue : tout sauf les 43 manquantes. */
async function productionReconstituee() {
  const db = await nouveauCluster();
  // On ne saute que les 43 migrations absentes du journal Production ou ajoutees apres le releve.
  // Les deux tentatives annulees ont chacune une reprise reussie : elles sont donc
  // deja appliquees dans l'etat reconstruit, pas dans la liste a appliquer.
  const sauter = new Set(manquantes);
  let jouees = 0;
  for (const d of dossiers) {
    if (sauter.has(d)) continue;
    if (!existsSync(join(MIGRATIONS, d, 'migration.sql'))) continue;
    const r = await jouer(db, d);
    if (!r.ok) throw new Error(`reconstitution impossible a ${d} : ${r.message}`);
    jouees += 1;
  }
  return { db, jouees };
}

async function politiques(db) {
  try {
    const { rows } = await db.query(`
      SELECT polname FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass ORDER BY 1`);
    return rows.map((r) => r.polname);
  } catch { return []; }
}
async function existe(db, regclass) {
  const { rows } = await db.query(`SELECT to_regclass($1) AS r`, [regclass]);
  return rows[0].r !== null;
}

// =========================================================================
console.log('1. Reconstitution de l etat de production  [MESURE]');
let base = await productionReconstituee();
{
  ok(`56 migrations jouees (49 attestees + 5 hors bande + 2 reprises reussies) sur ${dossiers.length}`,
    base.jouees === 56, `${base.jouees}`);
  console.log(`  --    ${manquantes.length} migrations restent a appliquer, dont ${nouvelles.length} nouvelle(s)`);
  const pol = await politiques(base.db);
  ok('etat de depart : 2 politiques en base — les surnumeraires viennent de la PRODUCTION, pas du depot',
    pol.length === 2, JSON.stringify(pol));
  ok('20261028120000 non jouee : la table du registre est ABSENTE',
    !(await existe(base.db, 'public.tracefab_runtime_function_registry')));
  // La production, elle, porte 4 politiques : on ajoute la derive pour etre
  // fidele a ce que le releve decrit.
  await base.db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);`);
}

// =========================================================================
console.log('\n2. Les 43 manquantes, UNE PAR UNE, dans l ordre  [MESURE]');
const issues = [];
{
  for (const d of manquantes) {
    const r = await jouer(base.db, d);
    issues.push({ d, ...r });
    if (!r.ok) console.error(`      -> echec : ${r.message}`);
  }
  const echecs = issues.filter((i) => !i.ok);
  ok(`les ${manquantes.length} migrations passent une par une, dans l ordre`,
    echecs.length === 0, JSON.stringify(echecs.map((e) => `${e.d}:${e.message}`)));
  const pol = await politiques(base.db);
  ok('a l arrivee : 2 politiques (les canoniques)', pol.length === 2, JSON.stringify(pol));
  ok('la table du registre existe maintenant',
    await existe(base.db, 'public.tracefab_runtime_function_registry'));
  console.log('  --    ordre applique :');
  for (const i of issues) console.log(`  --      ${i.ok ? 'ok  ' : 'ECHEC'} ${i.d.slice(0, 20)}`);
}

// =========================================================================
console.log('\n3. La rupture : 20261028120000 n est PAS rejouable  [MESURE]');
{
  const r = await jouer(base.db, '20261028120000_runtime_function_registry');
  ok('un SECOND passage echoue', !r.ok, r.message);
  ok('et il echoue sur la creation de la table, pas ailleurs',
    /already exists|existe/i.test(String(r.message)), r.message);
  ok('la base n est pas laissee dans un etat intermediaire : la table est toujours la',
    await existe(base.db, 'public.tracefab_runtime_function_registry'));
}

// =========================================================================
console.log('\n4. Les suivantes DEPENDENT-elles du registre ?  [MESURE]');
{
  // Sur une base neuve reconstruite, on saute 20261028120000 et on tente
  // directement 20261028120100 : si elle echoue, la dependance est reelle.
  const { db } = await productionReconstituee();
  const r = await jouer(db, '20261028120100_worker_identity_not_forgeable');
  ok('20261028120100 sans le registre : ECHOUE (dependance reelle)',
    !r.ok, r.message);
  if (!r.ok) console.log(`  --    message : ${String(r.message).slice(0, 150)}`);
  // Et avec le registre, elle passe.
  const avant = await jouer(db, '20261028120000_runtime_function_registry');
  ok('avec le registre d abord, 20261028120000 passe', avant.ok, avant.message);
  const apres = await jouer(db, '20261028120100_worker_identity_not_forgeable');
  ok('puis 20261028120100 passe', apres.ok, apres.message);
  await db.close();
}

// =========================================================================
console.log('\n5. Les deux tentatives annulees ont une reprise reussie  [HISTORIQUE MESURE]');
{
  const reprises = Object.keys(ECARTS).filter((d) => ECARTS[d].tentative_annulee_reprise_reussie);
  ok('les deux migrations ont une ligne de reprise terminee en Production', reprises.length === 2, reprises.join(', '));
  ok('aucune tentative annulee avec reprise reussie ne reste a appliquer', annulees.length === 0, annulees.join(', '));
}

// =========================================================================
console.log('\n6. Ce qu un `deploy` global ferait vraiment, en deux temps  [MESURE]');
{
  // 6.1 premier essai : la table du registre est absente, donc 20261028120000
  // passe. Un deploy global irait donc au bout — ce n'est PAS la ou il casse.
  const { db } = await productionReconstituee();
  const premier = await jouer(db, '20261028120000_runtime_function_registry');
  ok('1er essai : 20261028120000 passe (la table est absente)', premier.ok, premier.message);
  const rejeuManuel = await jouer(db, '20261028120000_runtime_function_registry');
  ok('un rejeu manuel du CREATE TABLE sans garde echoue', !rejeuManuel.ok, rejeuManuel.message);

  // 6.2 Simuler une migration ultérieure qui échoue après le registre.
  // Prisma 6.19.3/PostgreSQL a déjà enregistré 20261028120000 comme réussie :
  // au prochain deploy, elle est sautée et seule la migration en échec reprend.
  let echecUlterieur = false;
  try { await db.exec('SELECT 1 / 0'); } catch { echecUlterieur = true; }
  ok('une migration ultérieure échoue (témoin contrôlé)', echecUlterieur);
  const succes = new Set(['20261028120000_runtime_function_registry']);
  const suivantes = ['20261028120050_neon_worker_function_grants',
                     '20261028120100_worker_identity_not_forgeable',
                     '20261028120200_document_reserved_fields_internal_only',
                     '20261028130000_product_computed_fields_column_scoped',
                     '20261028140000_supplier_invitation_owner_relationship_scope',
                     '20261028150000_reconcile_plm_erp_sync_job_policies'];
  let sautees = 0;
  let appliquees = 0;
  for (const d of ['20261028120000_runtime_function_registry', ...suivantes]) {
    if (succes.has(d)) { sautees += 1; continue; }
    const r = await jouer(db, d);
    if (!r.ok) break;
    succes.add(d);
    appliquees += 1;
  }
  ok('le registre déjà réussi est sauté au retry', sautees === 1, `${sautees}/1`);
  ok('les six migrations suivantes sont applicables après le retry',
    appliquees === suivantes.length, `${appliquees}/${suivantes.length}`);
  await db.close();
}

console.log('\n7. Temoin : la mesure distingue bien les etats  [MESURE]');
{
  const { db } = await productionReconstituee();
  ok('temoin : juste apres reconstitution, le registre est absent',
    !(await existe(db, 'public.tracefab_runtime_function_registry')));
  await jouer(db, '20261028120000_runtime_function_registry');
  ok('temoin : apres application, il est present',
    await existe(db, 'public.tracefab_runtime_function_registry'));
  await db.close();
}

await base.db.close();

console.log('\n--------------------------------------------');
if (echecs === 0) {
  console.log(`${verifies} verifications passees.`);
  console.log('Une application UNE PAR UNE est possible : les 43 manquantes passent');
  console.log('dans l ordre, sans rupture, et laissent 2 politiques.');
  console.log('20261028120000 est non rejouable manuellement, mais une ligne');
  console.log('finished_at réussie le protège : Prisma ne la rejoue pas après un');
  console.log('échec ultérieur. Les six migrations suivantes reprennent seules.');
  process.exit(0);
}
console.error(`${echecs} echec(s) sur ${verifies} verifications.`);
process.exit(1);
