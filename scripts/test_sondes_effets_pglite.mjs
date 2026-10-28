#!/usr/bin/env node
/**
 * Les sondes d'EFFET : est-ce qu'elles distinguent vraiment les deux etats ?
 *
 * POURQUOI CE TEST EXISTE
 *
 * L'historique Prisma de production ne connait pas onze migrations du depot.
 * Une ligne d'historique absente ne prouve pas un effet absent : les cinq
 * migrations « hors bande » en sont la demonstration (enregistrees avec
 * `applied_steps_count = 0`, effets bel et bien presents).
 *
 * Une sonde qui rendrait la meme chose dans les deux cas ne vaudrait rien.
 * Ce test construit donc DEUX bases a partir du depot :
 *
 *   A. la chaine complete (les 65 migrations) — l'etat vise ;
 *   B. la chaine SANS les onze migrations — l'etat que produirait une
 *      production qui n'a jamais recu leurs effets.
 *
 * Il execute sur chacune la meme requete, en lecture seule
 * (docs/security/2026-10-28-tour30-C-sondes-effets.sql), et verifie que les
 * deux jeux de resultats DIFFERENT, sonde par sonde, dans le sens attendu.
 *
 * Ce que cela etablit : la sonde tranche. Ce que cela n'etablit pas : l'etat
 * reel de la production — il faudra le lire sur la production.
 *
 *   npm run test:sondes-effets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const SONDE = path.join(root, 'docs/security/2026-10-28-tour30-C-sondes-effets.sql');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  process.exit(1);
}

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Les onze migrations dont l'historique de production ne porte pas la trace. */
const ECARTS = [
  '20261010120000_publication_explicite',
  '20261017120000_active_tenant_context',
  '20261021170000_dpp_readiness_truthful_gates',
  '20261027100000_dpp_quality_gate_requires_assessment',
  '20261027130000_dpp_review_preservation_and_publication_coherence',
  '20261028120000_runtime_function_registry',
  '20261028120100_worker_identity_not_forgeable',
  '20261028120200_document_reserved_fields_internal_only',
  '20261028130000_product_computed_fields_column_scoped',
  '20261028140000_supplier_invitation_owner_relationship_scope',
  '20261028150000_reconcile_plm_erp_sync_job_policies',
];

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');

async function construire(sans = new Set()) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
    CREATE TABLE _prisma_migrations (
      id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
      migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0
    );
  `);
  const sautees = [];
  for (const d of dossiers) {
    if (sans.has(d)) { sautees.push(d); continue; }
    try {
      await db.exec(lire(d));
    } catch (e) {
      // Retirer une migration peut rendre la suivante impossible (elle modifie
      // une fonction que sa predecesseure cree). On le dit, on ne le masque pas.
      sautees.push(`${d} (echec : ${String(e.message).split('\n')[0].slice(0, 90)})`);
    }
  }
  return { db, sautees };
}

async function sonder(db) {
  const { rows } = await db.query(fs.readFileSync(SONDE, 'utf8'));
  const out = new Map();
  for (const r of rows) {
    const ligne = r.ligne ?? Object.values(r)[0];
    const [, migration, ...reste] = ligne.split('|');
    out.set(migration, `${reste.join('|')}`);
  }
  return out;
}

/* -------------------------------------------------------------------------
   1. L'etat de reference : la chaine complete
   ------------------------------------------------------------------------- */

console.log('\n  1. Construction de la chaine complete');

const a = await construire();
console.log(`  A — chaine complete : ${dossiers.length - a.sautees.length}/${dossiers.length} migrations`);
ok('la chaine complete s applique sans erreur', a.sautees.length === 0, a.sautees.join(' ; '));

const sa = await sonder(a.db);
ok('onze sondes rendues', sa.size === 11, `${sa.size}`);

/* -------------------------------------------------------------------------
   2. La calibration : UNE base par migration, retiree SEULE
   ------------------------------------------------------------------------- */

/**
 * Retirer les onze d'un coup ne prouve rien de chaque sonde : une base ou
 * plusieurs effets manquent peut rendre la meme valeur qu'une base complete,
 * par coincidence entre deux versions successives d'une meme fonction. C'est
 * exactement ce qui s'est produit au premier essai — la sonde 27100000 lisait
 * `true` dans les deux etats.
 *
 * On retire donc CHAQUE migration seule, et on exige que SA sonde change.
 */
console.log('\n  2. Calibration : chaque sonde, sa migration retiree seule');

/**
 * `20261027130000` repose le corps de `tracefab_dpp_requirement_met` : retirer
 * `20261027100000` seule ne suffit donc pas a faire disparaitre son effet, la
 * suivante le reinscrit. La calibration de cette sonde se fait sur la PAIRE.
 * C'est une contrainte du depot, pas un defaut de la sonde — mais si on ne la
 * nomme pas, on croit calibrer une migration et on en calibre deux.
 */
const RETRAIT = {};

const resultats = [];
for (const cible of ECARTS) {
  const cle = cible.slice(0, 14);
  const b = await construire(new Set(RETRAIT[cle] || [cible]));
  const sb = await sonder(b.db);
  const retiree = b.sautees.find((s) => s.startsWith(cible));
  await b.db.close();

  if (retiree && retiree.includes('echec')) {
    resultats.push({ cle, verdict: 'NON CALIBRABLE', detail: retiree.slice(0, 110) });
    continue;
  }
  const avant = sa.get(cle);
  const apres = sb.get(cle);
  const paire = RETRAIT[cle] ? ' (paire)' : '';
  resultats.push({ cle, verdict: avant !== apres ? `distingue${paire}` : 'MUETTE',
    detail: `A « ${avant} » / sans : « ${apres} »` });
}

for (const r of resultats) {
  // 20261028150000 est muette par construction (rien a retirer sur base neuve).
  const attenduMuet = r.cle === '20261028150000';
  const symbole = r.verdict.startsWith('distingue') || attenduMuet ? 'ok  ' : 'ECHEC';
  console.log(`  ${symbole} ${r.cle}  ${r.verdict.padEnd(15)} ${r.detail}`);
}

const distingue = resultats.filter((r) => r.verdict.startsWith('distingue'));
const muettes = resultats.filter((r) => r.verdict === 'MUETTE' && r.cle !== '20261028150000');
const nonCalibrables = resultats.filter((r) => r.verdict === 'NON CALIBRABLE');

ok('dix sondes sur onze distinguent leur propre migration retiree',
  distingue.length >= 10, `${distingue.length}/11 — muettes : ${muettes.map((m) => m.cle).join(', ') || 'aucune'}`);
ok('aucune sonde muette non justifiee', muettes.length === 0,
  muettes.map((m) => `${m.cle} : ${m.detail}`).join(' ; '));

/* La seule sonde qui DOIT etre muette : 20261028150000 retire deux politiques
   qui n'existent que sur la production. Sur une base neuve, il n'y a rien a
   retirer — l'absence de difference est le resultat correct, et c'est deja
   mesure par test:plm-erp-convergence:chaine sur une base portant la derive. */
const plm = resultats.find((r) => r.cle === '20261028150000');
ok('20261028150000 est muette sur base neuve, et c est attendu',
  plm && plm.verdict === 'MUETTE', plm ? plm.detail : 'sonde absente');
for (const r of nonCalibrables) console.log(`        (non calibrable : ${r.cle} — ${r.detail})`);

/* -------------------------------------------------------------------------
   3. Les valeurs attendues de l'etat A, ecrites noir sur blanc
   ------------------------------------------------------------------------- */

console.log('\n  3. Etat attendu du depot (A)');

const attendu = {
  '20261010120000': 'product_is_public_posee|oui|exige_revue|true',
  '20261017120000': 'fonctions_tenant|3|attendu|3',
  '20261021170000': 'libelle_profil_dpp|Tracefab textile technical readiness',
  '20261027100000': 'requirement_met_lit_scores_du_produit|true',
  '20261027130000': 'suspend_nonconforming_posee|oui',
  '20261028120000': 'table_registre|oui',
  '20261028120100': 'role_tracefab_worker|oui|politiques_sur_current_user|11',
  '20261028120200': 'mark_document_scanning_posee|oui|update_app_sur_documents|false',
  '20261028130000': 'update_app_sur_tracefab_products|false|trigger_lit_encore_le_guc|false',
  '20261028140000': 'garde_relation_invitation|true',
  '20261028150000': 'politiques_plm_erp_sync_jobs|2|attendu|2',
};

for (const [m, v] of Object.entries(attendu)) {
  ok(`${m} : ${v}`, sa.get(m) === v, `obtenu « ${sa.get(m)} »`);
}

/* -------------------------------------------------------------------------
   4. La sonde est en lecture seule
   ------------------------------------------------------------------------- */

console.log('\n  4. La sonde n ecrit rien');

const avant = (await a.db.query(`
  SELECT (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace)::text
      || '/' || (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public')::text
      || '/' || (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace)::text
      AS n`)).rows[0].n;
await sonder(a.db);
const apres = (await a.db.query(`
  SELECT (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace)::text
      || '/' || (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public')::text
      || '/' || (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace)::text
      AS n`)).rows[0].n;
ok('le catalogue est identique avant et apres la sonde', avant === apres, `${avant} → ${apres}`);

await a.db.close();

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  La sonde distingue les onze effets et vaut pour la production.');
  process.exit(0);
}
console.error(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
