#!/usr/bin/env node
/**
 * Une migration livree est-elle rejouable ? Mesure, pas supposition.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production n'a pas recu onze migrations du depot (mesure du 28/10 :
 * 54 appliquees sur 65). Deux d'entre elles sont marquees ANNULEES dans son
 * historique, les neuf autres ABSENTES. Avant de proposer quoi que ce soit, il
 * faut repondre a UNE question que personne ne pose jamais :
 *
 *   « si on rejoue cette migration sur une base qui la porte deja, que
 *     se passe-t-il ? »
 *
 * La reponse decide de tout :
 *   - REJOUABLE : on peut reappliquer sans crainte, l'ordre de `deploy` n'a
 *     pas d'importance pour elle ;
 *   - CASSE     : si son effet est deja present mais que son historique ne le
 *     sait pas, `migrate deploy` s'ARRETE dessus — et rien apres ne passe.
 *
 * La difference n'est pas theorique : `20261028120000_runtime_function_registry`
 * fait un `CREATE TABLE` sans `IF NOT EXISTS`. Si la table existe deja en
 * production, `deploy` echoue. C'est mesure ici, sur la chaine du depot, et non
 * suppose a la lecture du fichier.
 *
 * CE QUE CE TEST ETABLIT
 *
 *   sur la chaine complete, quelle migration s'execute une seconde fois sans
 *   erreur, et laquelle refuse.
 *
 * CE QU'IL N'ETABLIT PAS
 *
 *   l'etat de la production. Il dit ce qui se passerait SI l'effet etait deja
 *   la. Presence ou absence reelle : c'est l'affaire de la sonde d'effet
 *   (docs/security/2026-10-28-tour30-C-sondes-effets.sql).
 *
 *   npm run test:rejeu-migrations
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
 * Les seules migrations dont on SAIT qu'elles refusent un second passage, avec
 * la raison. Cette liste est volontairement fermee : si une migration se met a
 * casser sans y figurer, le test echoue. C'est ce qu'on veut — une liste
 * ouverte laisserait passer une regression de rejouabilite sans rien dire.
 */
const CASSE_CONNU = {
  '20261028120000_runtime_function_registry':
    'CREATE TABLE sans IF NOT EXISTS : « relation already exists »',
};

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');

/* -------------------------------------------------------------------------
   1. Une base qui porte deja toute la chaine
   ------------------------------------------------------------------------- */

console.log('\n  1. Chaine complete');

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
for (const d of dossiers) await db.exec(lire(d));
console.log(`  ${dossiers.length} migrations appliquees.`);

/* -------------------------------------------------------------------------
   2. Le rejeu, une migration a la fois, dans une transaction annulee
   ------------------------------------------------------------------------- */

console.log('\n  2. Rejeu de chacune des onze');

const rejouables = [];
const cassees = [];
for (const cible of ECARTS) {
  try {
    await db.exec('BEGIN');
    await db.exec(lire(cible));
    await db.exec('ROLLBACK');
    rejouables.push(cible);
    console.log(`  ok    ${cible.slice(0, 14)}  rejouable`);
  } catch (e) {
    await db.exec('ROLLBACK');
    cassees.push(cible);
    const msg = String(e.message).split('\n')[0].slice(0, 90);
    console.log(`        ${cible.slice(0, 14)}  CASSE  ${msg}`);
  }
}

console.log(`\n  Rejouables : ${rejouables.length}/11    Cassent : ${cassees.length}/11`);

/* -------------------------------------------------------------------------
   3. Les assertions
   ------------------------------------------------------------------------- */

console.log('\n  3. Ce que le depot garantit');

ok('dix migrations sur onze sont rejouables sans erreur',
  rejouables.length === 10, `${rejouables.length}`);

ok('les migrations qui cassent sont exactement celles qui sont documentees',
  cassees.length === Object.keys(CASSE_CONNU).length
    && cassees.every((c) => CASSE_CONNU[c]),
  `cassent : ${cassees.join(', ') || 'aucune'}`);

for (const [c, raison] of Object.entries(CASSE_CONNU)) {
  ok(`${c.slice(0, 14)} casse pour la raison documentee`, cassees.includes(c), raison);
}

/**
 * La consequence, ecrite noir sur blanc pour que le runbook ne l'oublie pas :
 * `migrate deploy` applique les migrations en ordre de nom. Une migration qui
 * casse sur une base portant deja son effet ARRETE tout ce qui suit.
 */
const rang = (n) => ECARTS.indexOf(n);
const cettecase = Object.keys(CASSE_CONNU)[0];
const apres = ECARTS.filter((c) => rang(c) > rang(cettecase));
ok('cinq migrations viennent APRES celle qui casse — elles seraient bloquees',
  apres.length === 5, `${apres.length} : ${apres.map((c) => c.slice(0, 14)).join(', ')}`);

await db.close();

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Le rejeu est mesure : dix migrations se rejouent, une refuse.');
  process.exit(0);
}
console.error(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
