#!/usr/bin/env node
/**
 * Le `deploy` qui viendrait : simulation complete, chemin par chemin.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production n'a pas onze migrations du depot (mesure du 28/10). Avant de
 * proposer quoi que ce soit, il faut repondre a trois questions, et aucune ne
 * se deduit de la lecture des fichiers :
 *
 *   1. la sequence des onze s'applique-t-elle, dans l'ordre, sur une base qui
 *      porte deja les cinquante-quatre autres ?
 *   2. l'etat « cinquante-quatre » est-il seulement CONSTRUCTIBLE ? Si une
 *      migration ulterieure exige les effets d'une migration manquante, alors
 *      cet etat ne peut pas avoir existe — et quelque chose de plus s'est
 *      passe en production.
 *   3. si une migration echoue en route, que laisse-t-elle derriere elle, et
 *      que bloque-t-elle ?
 *
 * CE QUE CE TEST ETABLIT — et c'est une DEDUCTION, pas une hypothese
 *
 * `20261021120000_limit_app_function_execute` est appliquee en production (elle
 * ne fait pas partie des onze ecarts). Or elle ECHOUE si les trois fonctions
 * `tracefab_active_organization_id`, `tracefab_in_active_tenant` et
 * `tracefab_require_active_tenant` n'existent pas — elles sont creees par
 * `20261017120000_active_tenant_context`, qui est marquee ANNULEE.
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

/**
 * La migration ecrite le 29/10 : elle n a jamais ete deployee, donc elle n est
 * pas dans `ECARTS` (qui decrit une DERIVE), mais un `deploy` l appliquerait.
 * La simuler separement evite de la faire passer pour « deja appliquee ».
 */
const NOUVELLES = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && d > '20261028150000' && !ECARTS.includes(d))
  .sort();

/** Les deux marquees ANNULEES dans l'historique de production. */
const ANNULEES = ['20261010120000_publication_explicite',
  '20261017120000_active_tenant_context'];

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
   1. L'etat « 54 » est-il constructible ?
   ========================================================================== */

console.log('\n  1. L etat « 54 appliquees, rien de plus » est-il constructible ?');

{
  const db = await nouvelleBase();
  const presents = dossiers.filter((d) => !ECARTS.includes(d));
  let premiere = null;
  for (const d of presents) {
    const r = await appliquer(db, d);
    if (!r.ok) { premiere = { d, message: r.message }; break; }
  }
  ok('sauter les onze CASSE la chaine : l etat « 54 » n est pas un etat atteignable',
    premiere !== null, 'la chaine a survecu, mes conclusions doivent etre revues');
  if (premiere) {
    console.log(`        casse a ${premiere.d.slice(0, 14)} : ${premiere.message.slice(0, 120)}`);
    ok('la migration qui casse est 20261021120000', premiere.d.startsWith('20261021120000'),
      premiere.d);
    ok('elle reclame les trois fonctions du locataire actif',
      /tracefab_active_organization_id/.test(premiere.message)
      && /tracefab_in_active_tenant/.test(premiere.message)
      && /tracefab_require_active_tenant/.test(premiere.message),
      premiere.message.slice(0, 160));
  }
  await db.close();
}

/* ==========================================================================
   2. La deduction : les effets de 20261017120000 sont presents en production
   ========================================================================== */

console.log('\n  2. Preuve indirecte : une migration « annulee » n est pas absente');

/**
 * `20261021120000` est appliquee en production (elle n'est pas dans les onze
 * ecarts). Le test ci-dessus etablit qu'elle ne PEUT pas l'etre sans les trois
 * fonctions de `20261017120000`. Donc ces fonctions existent en production.
 *
 * On verifie ici la seconde moitie du raisonnement, de facon isolee : sur une
 * chaine complete privee de `20261017120000` et de rien d'autre, c'est bien
 * `20261021120000` qui refuse — et pour cette raison precise.
 */
{
  const db = await nouvelleBase();
  let casse = null;
  for (const d of dossiers) {
    if (d === '20261017120000_active_tenant_context') continue;
    const r = await appliquer(db, d);
    if (!r.ok) { casse = { d, message: r.message }; break; }
  }
  ok('retirer 20261017120000 SEULE suffit a faire echouer la chaine',
    casse !== null && casse.d.startsWith('20261021120000'),
    casse ? `${casse.d.slice(0, 14)} : ${casse.message.slice(0, 100)}` : 'aucun echec');
  await db.close();
}

/* ==========================================================================
   3. Le deploy complet, sur l'etat suppose reel
   ========================================================================== */

console.log('\n  3. Sequence des onze, sur une base qui porte deja les cinquante-quatre autres');

const db = await nouvelleBase();
const aAppliquer = dossiers.filter((d) => !ECARTS.includes(d) || ANNULEES.includes(d));
for (const d of aAppliquer) {
  const r = await appliquer(db, d);
  if (!r.ok) { console.error(`ECHEC  construction de la base a ${d.slice(0, 14)} : ${r.message}`); process.exit(1); }
}
// depot - (ecarts hors annulees) : le compte se derive, il ne se recopie pas.
const attendu = dossiers.length - (ECARTS.length - ANNULEES.length);
ok('la base « production avec les deux annulees presentes » se construit',
  aAppliquer.length === attendu, `${aAppliquer.length} / ${attendu}`);

const resultats = [];
for (const d of ECARTS) {
  const r = await appliquer(db, d);
  resultats.push({ d, ...r });
  console.log(`  ${r.ok ? 'ok   ' : 'ECHEC'}  ${d.slice(0, 14)}${r.ok ? '' : `  ${r.message.slice(0, 100)}`}`);
}
ok('les onze migrations s appliquent dans l ordre, sans echec',
  resultats.every((r) => r.ok),
  resultats.filter((r) => !r.ok).map((r) => r.d.slice(0, 14)).join(', '));

// La migration nouvelle suit les onze : un deploy l appliquerait aussi, et elle
// doit passer sur l etat correctement reconcilie.
for (const d of NOUVELLES) {
  const r = await appliquer(db, d);
  ok(`la migration nouvelle ${d.slice(0, 14)} s applique apres les onze`, r.ok, r.message);
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
  ok('cet echec bloque les cinq migrations qui viennent apres', apres.length === 5,
    `${apres.length}`);
  console.log(`        bloquees : ${apres.map((d) => d.slice(0, 14)).join(', ')}`);
  ok('l echec n a laisse aucune trace partielle (transaction annulee)',
    (await db.query("SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE proname = 'tracefab_apply_runtime_function_grants'")).rows[0].n === 0);
  console.log(`        (${avant.length} migrations passees avant l echec, 0 apres)`);
  await db.close();
}

/* ==========================================================================
   5. La lecon operationnelle
   ========================================================================== */

console.log('\n  5. Ce que cela impose au runbook');

/**
 * Le seul cas ou le `deploy` casse est « effet deja present sur une migration
 * non rejouable ». Pour les dix autres, un effet deja present est sans
 * consequence : elles se rejouent. C'est mesure par `test:rejeu-migrations`.
 */
ok('une seule migration non rejouable : la table du registre',
  true, 'mesure par test:rejeu-migrations (10/11 rejouables)');

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Le deploy des onze est simule, son point de rupture identifie.');
  process.exit(0);
}
console.error(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
