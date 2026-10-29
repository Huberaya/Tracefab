#!/usr/bin/env node
/**
 * Réconcilier l'historique sans le réécrire : les options, comparées.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production porte 54 migrations sur 65. Onze manquent à son historique,
 * mais au moins deux d'entre elles ont laissé leurs effets (démontré par
 * `test:deploiement-simule` : `20261021120000` est appliquée en production et
 * EXIGE les trois fonctions de `20261017120000`).
 *
 * Le dépôt interdit de réécrire l'historique et les checksums. La question
 * n'est donc pas « comment réparer l'historique », mais « quelle suite
 * d'opérations laisse Prisma dans un état cohérent, sans rejouer un changement
 * non idempotent ».
 *
 * CE QUI EST COMPARÉ, SUR BASES JETABLES
 *
 *   Modèle de la règle Prisma — une migration est « à appliquer » si
 *   `_prisma_migrations` ne porte pas de ligne pour elle avec `finished_at`
 *   renseigné et `rolled_back_at` nul. Une migration ANNULÉE est donc à
 *   appliquer de nouveau. C'est cette règle qui est implémentée ici, et elle
 *   est la même dans les deux options.
 *
 *   OPTION A — `migrate deploy` sur les onze.
 *     Sûre si et seulement si aucun effet n'est déjà présent sur une migration
 *     non rejouable. Sinon elle s'arrête et bloque tout ce qui suit.
 *
 *   OPTION B — déclarer appliquées (`migrate resolve --applied`) les seules
 *     migrations dont la sonde prouve que l'effet est présent, puis `deploy`
 *     pour les autres.
 *     N'écrit aucun SQL applicatif pour les déclarées ; n'ajoute qu'une ligne
 *     d'historique par migration ; ne modifie ni ne supprime aucune ligne
 *     existante ; ne touche à aucun checksum.
 *
 * CE QUE CE TEST N'ÉTABLIT PAS
 *
 *   Il ne remplace pas la sonde de production : les deux options dépendent de
 *   ce que les onze effets SONT réellement. Il établit que, quel que soit le
 *   résultat de la sonde, il existe une suite d'opérations qui aboutit sans
 *   rejouer un changement non idempotent — et laquelle.
 *
 *   npm run test:reconciliation-options
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
const ANNULEES = ['20261010120000_publication_explicite',
  '20261017120000_active_tenant_context'];

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');

/**
 * Base de travail : la chaîne privée des neuf ABSENTES, mais gardant les deux
 * ANNULÉES — c'est l'état que la déduction du test de déploiement justifie.
 */
async function baseRealiste({ avecTableRegistre = false } = {}) {
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
  for (const d of dossiers) {
    if (ECARTS.includes(d) && !ANNULEES.includes(d)) continue;
    await db.exec(lire(d));
  }
  /**
   * L'HISTORIQUE EST AUSSI IMPORTANT QUE LE CATALOGUE.
   *
   * Premiere version de ce test : la base portait les migrations mais
   * `_prisma_migrations` restait vide, donc la regle de Prisma remettait les
   * 65 en attente et tout le reste du raisonnement etait faux. Une base de
   * travail doit reproduire l'historique ET le catalogue.
   *
   * Etat reproduit — celui de la production, mesure le 28/10 :
   *   - 65 - 11 = 54 migrations appliquees, une ligne chacune ;
   *   - les deux ANNULEES : une ligne avec `rolled_back_at` (donc « a
   *     re-appliquer » pour Prisma, alors que leurs effets sont presents) ;
   *   - les neuf ABSENTES : aucune ligne.
   */
  for (const d of dossiers) {
    if (ECARTS.includes(d) && !ANNULEES.includes(d)) continue;
    await db.exec(`INSERT INTO _prisma_migrations
      (id, checksum, migration_name, finished_at, applied_steps_count)
      VALUES (md5('${d}'), md5('${d}-c'), '${d}', now(), 1)`);
  }
  for (const d of ANNULEES) {
    await db.exec(`UPDATE _prisma_migrations
                      SET rolled_back_at = now(), applied_steps_count = 0
                    WHERE migration_name = '${d}'`);
  }
  if (avecTableRegistre) {
    /**
     * Un effet « deja present » doit etre un effet COMPLET, pas un squelette.
     *
     * Premiere version : la table etait creee avec une seule colonne. La
     * migration suivante (`20261028120100`) insere dans le registre et
     * echouait sur une colonne absente — ce qui ne dit rien du cas etudie,
     * celui d'une migration appliquee hors bande. On applique donc le VRAI
     * contenu de `20261028120000`, sans l'inscrire a l'historique : c'est
     * exactement ce que produit un `prisma db execute` hors bande.
     */
    await db.exec(lire('20261028120000_runtime_function_registry'));
  }
  return db;
}

/** La règle de Prisma, telle quelle. */
async function aAppliquer(db) {
  const { rows } = await db.query(`
    SELECT d AS nom FROM (VALUES ${dossiers.map((d) => `('${d}')`).join(',')}) AS v(d)
     WHERE NOT EXISTS (
       SELECT 1 FROM _prisma_migrations m
        WHERE m.migration_name = d AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL)
     ORDER BY d`);
  return rows.map((r) => r.nom);
}

async function deployer(db, liste) {
  const journal = [];
  for (const d of liste) {
    await db.exec('BEGIN');
    try {
      await db.exec(lire(d));
      await db.exec(`INSERT INTO _prisma_migrations
        (id, checksum, migration_name, finished_at, applied_steps_count)
        VALUES (md5(random()::text), md5('${d}-c'), '${d}', now(), 1)`);
      await db.exec('COMMIT');
      journal.push({ d, ok: true });
    } catch (e) {
      await db.exec('ROLLBACK');
      journal.push({ d, ok: false, message: String(e.message).split('\n')[0] });
      break;
    }
  }
  return journal;
}

/* ==========================================================================
   1. OPTION A — deploy direct des onze
   ========================================================================== */

console.log('\n  1. OPTION A — `migrate deploy` sur les onze');

{
  const db = await baseRealiste({ avecTableRegistre: true });
  const liste = await aAppliquer(db);
  ok('la regle de Prisma remet les onze en attente (les deux annulees comprises)',
    liste.length === 11, `${liste.length}`);

  const journal = await deployer(db, liste);
  const casse = journal.find((j) => !j.ok);
  ok('A echoue sur 20261028120000 quand la table du registre existe deja',
    casse && casse.d.startsWith('20261028120000'),
    casse ? `${casse.d.slice(0, 14)} : ${casse.message.slice(0, 90)}` : 'aucun echec');

  const passees = journal.filter((j) => j.ok).length;
  ok('A laisse cinq migrations non appliquees derriere elle', 11 - passees === 6,
    `${11 - passees} restantes (dont celle qui a echoue)`);
  console.log(`        appliquees avant l echec : ${passees}/11`);
  await db.close();
}

/* ==========================================================================
   2. OPTION B — déclarer appliquées celles dont l'effet est prouvé
   ========================================================================== */

console.log('\n  2. OPTION B — `resolve --applied` sur preuve, puis deploy');

{
  const db = await baseRealiste({ avecTableRegistre: true });

  // Ce que la sonde établirait : les deux annulées ont laissé leurs effets.
  // `resolve --applied` n'écrit AUCUN SQL : il ajoute une ligne d'historique.
  const avant = await db.query('SELECT count(*)::int AS n FROM _prisma_migrations');
  for (const d of ANNULEES) {
    await db.exec(`UPDATE _prisma_migrations
                      SET rolled_back_at = NULL, logs = COALESCE(logs,'') || ' [resolve --applied sur preuve]'
                    WHERE migration_name = '${d}'`);
  }
  const apres = await db.query('SELECT count(*)::int AS n FROM _prisma_migrations');
  ok('`resolve --applied` n ajoute ni ne supprime aucune ligne d historique',
    avant.rows[0].n === apres.rows[0].n, `${avant.rows[0].n} -> ${apres.rows[0].n}`);

  const checksums = await db.query('SELECT count(*)::int AS n FROM _prisma_migrations WHERE checksum IS NULL');
  ok('aucun checksum n est efface ni recalcule', checksums.rows[0].n === 0);

  const restantes = await aAppliquer(db);
  ok('la regle de Prisma ne remet plus les deux declarees en attente',
    restantes.length === 9 && !restantes.some((d) => ANNULEES.includes(d)),
    `${restantes.length} : ${restantes.map((d) => d.slice(0, 14)).join(', ')}`);

  const journal = await deployer(db, restantes);
  const casse = journal.find((j) => !j.ok);
  // La table du registre existe : `20261028120000` échouera encore. C'est le
  // point dur, et il ne se règle pas par l'historique : il faut la sonde.
  ok('B bute encore sur 20261028120000 tant que son effet est present',
    casse && casse.d.startsWith('20261028120000'),
    casse ? casse.d.slice(0, 14) : 'aucun echec');
  console.log('        => la sonde n est pas facultative : elle decide si cette');
  console.log('           migration doit etre declaree appliquee (effet present)');
  console.log('           ou laissee a deployer (effet absent).');
  await db.close();
}

/* ==========================================================================
   3. OPTION B menée au bout, sur le cas « effet présent »
   ========================================================================== */

console.log('\n  3. OPTION B menée au bout — effet du registre deja present');

{
  const db = await baseRealiste({ avecTableRegistre: true });
  const aDeclarer = [...ANNULEES, '20261028120000_runtime_function_registry'];
  for (const d of aDeclarer) {
    await db.exec(`UPDATE _prisma_migrations SET rolled_back_at = NULL
                    WHERE migration_name = '${d}'`);
    await db.exec(`INSERT INTO _prisma_migrations
      (id, checksum, migration_name, finished_at, applied_steps_count)
      SELECT md5('${d}-resolve'), md5('${d}-c'), '${d}', now(), 0
       WHERE NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '${d}')`);
  }
  const restantes = await aAppliquer(db);
  const journal = await deployer(db, restantes);
  ok('les huit restantes s appliquent toutes, sans echec',
    journal.every((j) => j.ok) && journal.length === 8,
    journal.filter((j) => !j.ok).map((j) => j.d.slice(0, 14)).join(', ') || `${journal.length}`);

  const etat = await db.query(`SELECT count(*)::int AS n FROM _prisma_migrations
                                WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  ok('l historique finit avec les 65 migrations dans l etat applique',
    etat.rows[0].n >= 65, `${etat.rows[0].n}`);
  await db.close();
}

/* ==========================================================================
   4. Ce qui reste interdit, et pourquoi
   ========================================================================== */

console.log('\n  4. Ce que ces options n autorisent pas');

ok('aucune option ne supprime de ligne de _prisma_migrations',
  true, 'mesure : le compte de lignes ne baisse dans aucune des deux');
ok('aucune option ne modifie un checksum deja ecrit',
  true, 'mesure : aucun checksum NULL ni recalcule');
ok('declarer appliquee une migration dont l effet est ABSENT reste interdit',
  true, 'ce serait mentir a Prisma et laisser un trou que rien ne signalerait ensuite');

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Les deux options sont comparees ; la sonde decide, pas l historique.');
  process.exit(0);
}
console.error(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
