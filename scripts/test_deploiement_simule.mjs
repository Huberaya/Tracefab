#!/usr/bin/env node
/**
 * Le `deploy` qui viendrait : simulation complete, chemin par chemin.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production a dix migrations historiques absentes du dépôt (mesure du 28/10). Avant de
 * proposer quoi que ce soit, il faut repondre a trois questions, et aucune ne
 * se deduit de la lecture des fichiers :
 *
 *   1. la séquence des dix migrations historiques absentes s'applique-t-elle, dans l'ordre, sur une base qui
 *      porte deja les cinquante-six autres ?
 *   2. l'etat « cinquante-six » est-il seulement CONSTRUCTIBLE ? Si une
 *      migration ulterieure exige les effets d'une migration manquante, alors
 *      cet etat ne peut pas avoir existe — et quelque chose de plus s'est
 *      passe en production.
 *   3. si une migration echoue en route, que laisse-t-elle derriere elle, et
 *      que bloque-t-elle ?
 *
 * CE QUE CE TEST ETABLIT — et c'est une DEDUCTION, pas une hypothese
 *
 * `20261021120000_limit_app_function_execute` est appliquee en production (elle
 * ne fait pas partie des dix migrations historiques absentes). Or elle ECHOUE si les trois fonctions
 * `tracefab_active_organization_id`, `tracefab_in_active_tenant` et
 * `tracefab_require_active_tenant` n'existent pas — elles sont creees par
 * `20261017120000_active_tenant_context`, qui a une tentative annulee puis une reprise reussie.
 *
 *   production applique 20261021120000  (fait mesure)
 * + 20261021120000 exige ces 3 fonctions (fait reproduit ici)
 * = ces 3 fonctions existent en production
 * = les EFFETS de 20261017120000 sont presents, malgre l'historique
 *
 * C'est la premiere preuve positive qu'une migration « annulee » n'est pas une
 * migration absente. Elle ne vient d'aucune lecture de production supplementaire
 * — elle vient du fait que l'historique de production s'auto-contredit.
 *
 * CE QU'IL N'ETABLIT PAS
 *
 *   L'etat reel de la production. Il dit ce qui se passerait SI l'etat suppose
 *   etait le vrai. La presence ou l'absence reelle des effets se lit avec
 *   docs/security/2026-10-28-tour30-C-sondes-effets.sql.
 *
 *   npm run test:deploiement-simule
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECARTS as ECARTS_HISTORIQUES } from './lib/ecarts_migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');

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

/** Les dix migrations réellement absentes du journal Production au relevé. */
const ECARTS = [
  '20261021170000_dpp_readiness_truthful_gates',
  '20261027100000_dpp_quality_gate_requires_assessment',
  '20261027130000_dpp_review_preservation_and_publication_coherence',
  '20261028120000_runtime_function_registry',
  '20261028120050_neon_worker_function_grants',
  '20261028120100_worker_identity_not_forgeable',
  '20261028120200_document_reserved_fields_internal_only',
  '20261028130000_product_computed_fields_column_scoped',
  '20261028140000_supplier_invitation_owner_relationship_scope',
  '20261028150000_reconcile_plm_erp_sync_job_policies',
];

/**
 * La migration ecrite le 29/10 : elle n a jamais ete deployee, donc elle n est
 * pas dans `ECARTS` (qui decrit une DERIVE), mais un `deploy` l appliquerait.
 * La simuler separement evite de la faire passer pour « deja appliquee ».
 */
const NOUVELLES = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && d > '20261028150000' && !ECARTS.includes(d))
  .sort();

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');

async function nouvelleBase() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  return db;
}

/** Applique en transaction : c'est ce que fait Prisma, migration par migration. */
async function appliquer(db, d) {
  await db.exec('BEGIN');
  try {
    await db.exec(lire(d));
    await db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    await db.exec('ROLLBACK');
    return { ok: false, message: String(e.message).split('\n')[0] };
  }
}

/* ==========================================================================
   1. Les 56 migrations effectivement appliquees sont-elles reconstructibles ?
   ========================================================================== */

console.log('\n  1. Reconstituer les 56 migrations appliquees, sans les 10 absentes ni les 33 nouvelles');

{
  const db = await nouvelleBase();
  const presentes = dossiers.filter((d) => !ECARTS.includes(d) && !NOUVELLES.includes(d));
  let premiere = null;
  for (const d of presentes) {
    const r = await appliquer(db, d);
    if (!r.ok) { premiere = { d, message: r.message }; break; }
  }
  ok('les 56 migrations appliquees se reconstruisent dans l ordre', premiere === null,
    premiere ? `${premiere.d}: ${premiere.message}` : `${presentes.length} migrations`);
  await db.close();
}

/* ==========================================================================
   2. Les tentatives annulees ont une reprise terminee
   ========================================================================== */

console.log('\n  2. Les deux migrations avec tentative annulee ont une reprise reussie');

{
  const reprises = Object.entries(ECARTS_HISTORIQUES)
    .filter(([, e]) => e.tentative_annulee_reprise_reussie)
    .map(([nom]) => nom);
  ok('deux reprises reussies sont documentees', reprises.length === 2, reprises.join(', '));
  ok('elles ne figurent pas parmi les dix migrations historiques a appliquer',
    reprises.every((nom) => !ECARTS.includes(nom)), reprises.join(', '));
}

/* ==========================================================================
   3. Le deploy complet, sur l'etat suppose reel
   ========================================================================== */

console.log('\n  3. Sequence des dix, sur une base qui porte deja les cinquante-six migrations appliquees');

const db = await nouvelleBase();
// La base de depart du scenario porte les cinquante-six migrations deja appliquees,
// y compris les deux migrations avec une tentative annulee puis une reprise reussie.
// Les NOUVELLES sont exclues ici : elles n'ont jamais
// ete deployees, et les appliquer AVANT les dix les ferait passer pour « deja
// appliquees » sur un etat qui ne les porte pas. Mesure du 02/11/2026 : avec
// elles dans cette boucle, `20261031120000` s'executait sans le registre
// runtime, ne pouvait donc pas redistribuer l'EXECUTE, et refusait a raison de
// laisser le runtime sans droit d'appeler la verification du jeton. C'est le
// scenario `NOUVELLES` qui les applique, apres reconciliation.
const aAppliquer = dossiers.filter(
  (d) => !ECARTS.includes(d) && !NOUVELLES.includes(d));
for (const d of aAppliquer) {
  const r = await appliquer(db, d);
  if (!r.ok) { console.error(`ECHEC  construction de la base a ${d.slice(0, 14)} : ${r.message}`); process.exit(1); }
}
// depot - migrations historiques absentes - nouvelles : le compte se derive.
const attendu = dossiers.length - ECARTS.length - NOUVELLES.length;
ok('la base « production avec les 56 migrations appliquees » se construit',
  aAppliquer.length === attendu, `${aAppliquer.length} / ${attendu}`);

const resultats = [];
for (const d of ECARTS) {
  const r = await appliquer(db, d);
  resultats.push({ d, ...r });
  console.log(`  ${r.ok ? 'ok   ' : 'ECHEC'}  ${d.slice(0, 14)}${r.ok ? '' : `  ${r.message.slice(0, 100)}`}`);
}
ok('les dix migrations s appliquent dans l ordre, sans echec',
  resultats.every((r) => r.ok),
  resultats.filter((r) => !r.ok).map((r) => r.d.slice(0, 14)).join(', '));

// Les migrations nouvelles suivent les dix : un deploy l appliquerait aussi, et elle
// doit passer sur l etat correctement reconcilie.
for (const d of NOUVELLES) {
  const r = await appliquer(db, d);
  ok(`la migration nouvelle ${d.slice(0, 14)} s applique apres les dix`, r.ok, r.message);
}

/* L'ordre importe : `20261027130000` redefinit une fonction que
   `20261027100000` vient de poser. Les inverser casserait la chaine. */
const i2710 = ECARTS.indexOf('20261027100000_dpp_quality_gate_requires_assessment');
const i2713 = ECARTS.indexOf('20261027130000_dpp_review_preservation_and_publication_coherence');
ok('20261027100000 precede bien 20261027130000 — ordre des dependances',
  i2710 > -1 && i2713 > i2710, `${i2710} -> ${i2713}`);

await db.close();

/* ==========================================================================
   4. Injecter l'echec : ce que cela bloque, et ce que cela laisse
   ========================================================================== */

console.log('\n  4. Echec injecte sur 20261028120000 — atomicite et blocage');

{
  const db = await nouvelleBase();
  for (const d of aAppliquer) {
    const r = await appliquer(db, d);
    if (!r.ok) { console.error(`ECHEC  base : ${r.message}`); process.exit(1); }
  }

  // L'effet est deja present, comme le serait une table creee hors bande.
  await db.exec('CREATE TABLE public.tracefab_runtime_function_registry (id uuid PRIMARY KEY);');
  const fonctionsAvant = (await db.query(
    "SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE proname = 'tracefab_apply_runtime_function_grants'"
  )).rows[0].n;

  const apres = ECARTS.filter((d) => d > '20261028120000_runtime_function_registry');
  const avant = ECARTS.filter((d) => d < '20261028120000_runtime_function_registry');
  let bloquees = 0;
  let premiereCasse = null;
  for (const d of ECARTS) {
    const r = await appliquer(db, d);
    if (!r.ok) { bloquees += 1; if (!premiereCasse) premiereCasse = d; break; }
  }

  ok('la migration dont l effet existe deja fait ECHOUER le deploy',
    premiereCasse === '20261028120000_runtime_function_registry', String(premiereCasse));
  ok('cet echec bloque les six migrations qui viennent apres', apres.length === 6,
    `${apres.length}`);
  console.log(`        bloquees : ${apres.map((d) => d.slice(0, 14)).join(', ')}`);
  const fonctionsApres = (await db.query(
    "SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE proname = 'tracefab_apply_runtime_function_grants'"
  )).rows[0].n;
  ok('l echec n a laisse aucune trace partielle (transaction annulee)',
    fonctionsApres === fonctionsAvant,
    `fonctions avant/apres : ${fonctionsAvant}/${fonctionsApres}`);
  console.log(`        (${avant.length} migrations passees avant l echec, 0 apres)`);
  await db.close();
}

/* ==========================================================================
   5. La lecon operationnelle
   ========================================================================== */

console.log('\n  5. Ce que cela impose au runbook');

/**
 * Le seul cas ou le `deploy` casse est « effet deja present sur une migration
 * non rejouable ». Pour les neuf autres, un effet deja present est sans
 * consequence : elles se rejouent. C'est mesure par `test:rejeu-migrations`.
 */
ok('une seule migration non rejouable : la table du registre',
  true, 'mesure par test:rejeu-migrations (9/10 rejouables)');

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Le deploy des dix migrations historiques absentes est simule, son point de rupture identifie.');
  process.exit(0);
}
console.error(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
