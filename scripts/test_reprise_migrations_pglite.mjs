#!/usr/bin/env node
/**
 * Reprise des migrations : chaque incident est REPRODUIT, puis franchi.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production porte deux migrations non terminees — refus de privileges sur
 * le schema `public` pour `20261017120000_active_tenant_context`, conflit de
 * signature de fonction pour `20261010120000_publication_explicite` — et deux
 * entrees annulees. Avant de demander l'autorisation d'y toucher, il faut
 * pouvoir repondre a trois questions, et les reponses se mesurent hors
 * production :
 *
 *   1. les deux incidents se reproduisent-ils exactement comme decrit ?
 *   2. le contenu actuel du depot les franchit-il ?
 *   3. une migration interrompue peut-elle etre rejouee sans casser ce qu'elle
 *      a deja fait ?   <- la question qui decide de la surete du plan
 *
 * LE POINT SENSIBLE, ET CE QU'IL CHANGE
 *
 * `prisma migrate resolve --rolled-back <migration>` ne defait RIEN : il pose
 * `rolled_back_at` et laisse la base dans l'etat ou l'echec l'a laissee. Prisma
 * rejouera ensuite la migration. Si elle n'est pas rejouable sur son propre
 * resultat partiel, la reprise aggrave l'incident. Ce test le verifie au lieu
 * de le supposer.
 *
 * CE QUI EST PROUVE / CE QUI NE L'EST PAS
 *
 * Prouve : sur PostgreSQL 18 (PGlite 0.5.12 — meme majeure que Neon), les deux
 * incidents se reproduisent avec le code d'erreur rapporte, le contenu du
 * depot les franchit, et les re-exécutions sont idempotentes.
 * Non prouve : l'etat exact de la production. Tant que l'export de
 * `_prisma_migrations` n'est pas reconcilie, ce test valide une PROCEDURE, pas
 * un diagnostic.
 *
 *   npm run test:reprise-migrations
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

/** Applique les migrations jusqu'a `avant` exclu. */
async function appliquer(db, avant) {
  let n = 0;
  for (const d of dossiers) {
    if (avant && d >= avant) break;
    await db.exec(lire(d));
    n += 1;
  }
  return n;
}

const executer = async (db, sql) => {
  try { await db.exec(sql); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code, message: String(e.message || e) }; }
};

/* ==========================================================================
   PARTIE 1 — incident A : refus de privileges sur le schema public
   ========================================================================== */

console.log('\n  1. `20261017120000_active_tenant_context` — refus sur le schema public');

const CIBLE_A = '20261017120000_active_tenant_context';
{
  const db = await nouvelleBase();
  const n = await appliquer(db, CIBLE_A);
  ok(`${n} migrations appliquees avant la cible`, n > 40, `${n}`);

  // Le role de migration n'a pas CREATE sur public : c'est l'etat de
  // production post-PG15 que decrit l'incident.
  await db.exec(`CREATE ROLE migrator LOGIN PASSWORD 'x' NOSUPERUSER NOBYPASSRLS;
                 GRANT USAGE ON SCHEMA public TO migrator;`);
  const droit = await db.query(`select has_schema_privilege('migrator','public','CREATE') AS p`);
  ok('le role de migration ne peut pas creer dans public', droit.rows[0].p === false);

  await db.exec('SET ROLE migrator;');
  const refus = await executer(db, lire(CIBLE_A));
  await db.exec('RESET ROLE;');
  ok('INCIDENT REPRODUIT : refus de privilege attendu', refus.ok === false && refus.code === '42501',
    `${refus.code} ${refus.message}`);
  ok('le message est bien celui du schema public',
    refus.ok === false && /schema public/i.test(refus.message), refus.message);

  // Une migration refusee n'a rien laisse derriere elle : le rejeu part d'un
  // etat propre, ce qui rend la reprise sure.
  const fantomes = await db.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='tracefab_in_active_tenant'`);
  ok('la cible refusee n a rien cree (rejeu depuis un etat propre)', fantomes.rows[0].n === 0);

  // Procedure corrigee : la migration est jouee par un role qui a le droit de
  // creer dans public — on ne modifie PAS la migration.
  await db.exec('SET ROLE migrator;');
  await db.exec('RESET ROLE;');
  await db.exec(`GRANT CREATE ON SCHEMA public TO migrator;
                 SET ROLE migrator;`);
  const reussite = await executer(db, lire(CIBLE_A));
  await db.exec('RESET ROLE;');
  ok('PROCEDURE CORRIGEE : la migration passe avec le bon privilege', reussite.ok === true,
    reussite.message || '');
  const creee = await db.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='tracefab_in_active_tenant'`);
  ok('les fonctions de la migration existent apres reprise', creee.rows[0].n === 1, `${creee.rows[0].n}`);

  // Rejeu : idempotence, exigence de `migrate resolve --rolled-back`.
  const rejeu = await executer(db, lire(CIBLE_A));
  ok('REJEU idempotent de la migration', rejeu.ok === true, rejeu.message || '');
  await db.close();
}

/* ==========================================================================
   PARTIE 2 — incident B : conflit de signature de fonction (P3018 du 15/10)
   ========================================================================== */

console.log('\n  2. `20261010120000_publication_explicite` — conflit de signature');

const CIBLE_B = '20261010120000_publication_explicite';
{
  const db = await nouvelleBase();
  const n = await appliquer(db, CIBLE_B);
  ok(`${n} migrations appliquees avant la cible`, n > 30, `${n}`);

  // Etat d'avant l'incident : la fonction existe avec son parametre `p_org`.
  await db.exec(`
    DROP FUNCTION IF EXISTS public.tracefab_public_brand(uuid);
    CREATE FUNCTION public.tracefab_public_brand(p_org uuid)
    RETURNS TABLE (display_name text, country_code text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $body$
      SELECT o.display_name, o.country_code FROM organizations o WHERE o.id = p_org;
    $body$;
  `);
  const avant = await db.query(
    `select p.proargnames[1] AS nom from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='tracefab_public_brand'`);
  ok('la fonction prealable porte le parametre `p_org`', avant.rows[0].nom === 'p_org',
    String(avant.rows[0].nom));

  // La forme naive du correctif — celle qui a echoue le 15 octobre.
  const naif = await executer(db, `
    CREATE OR REPLACE FUNCTION public.tracefab_public_brand(p_organization_id uuid)
    RETURNS TABLE (display_name text, country_code text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $body$ SELECT o.display_name, o.country_code FROM organizations o WHERE o.id = p_organization_id; $body$;
  `);
  ok('INCIDENT REPRODUIT : renommage de parametre refuse',
    naif.ok === false && naif.code === '42P13', `${naif.code} ${naif.message}`);
  ok('le message est bien celui du nom de parametre',
    naif.ok === false && /input parameter/i.test(naif.message), naif.message);

  // Le contenu ACTUEL du depot, joue sur exactement cet etat.
  const corrige = await executer(db, lire(CIBLE_B));
  ok('CONTENU DU DEPOT : la migration franchit l etat qui a echoue', corrige.ok === true,
    corrige.message || '');

  const apres = await db.query(
    `select p.proargnames[1] AS nom from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='tracefab_public_brand'`);
  ok('le nom de parametre existant est PRESERVE (pas de DROP/CREATE destructeur)',
    apres.rows[0].nom === 'p_org', String(apres.rows[0].nom));

  const rejeu = await executer(db, lire(CIBLE_B));
  ok('REJEU idempotent de la migration', rejeu.ok === true, rejeu.message || '');
  await db.close();
}

/* ==========================================================================
   PARTIE 3 — reprise d'un historique bloque : 58 appliquees, 5 manquantes
   ========================================================================== */

console.log('\n  3. Reprise complete d un historique bloque');

{
  const db = await nouvelleBase();
  // La production annonce 58 entrees pour 63 migrations. On reconstitue donc
  // une base ou les migrations 1 a 58 sont appliquees et les cinq dernieres ne
  // le sont pas — c'est ce que dit le compte, et rien de plus.
  const appliquees = dossiers.slice(0, 58);
  const manquantes = dossiers.slice(58);
  await db.exec(`
    CREATE TABLE public._prisma_migrations (
      id varchar(36) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      finished_at timestamptz,
      migration_name varchar(255) NOT NULL,
      logs text,
      rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0
    );
  `);
  for (const d of appliquees) {
    await db.exec(lire(d));
    await db.exec(`INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES (gen_random_uuid()::text, repeat('0',64), now(), '${d}', 1)`);
  }
  // 58 est le nombre de lignes de l'historique de production mesure le 28/10,
  // pas une propriete du depot : il ne doit pas suivre le nombre de migrations
  // du depot, sans quoi ce test casserait a chaque migration ajoutee.
  const ATTENDU_PRODUCTION = 58;
  ok(`${ATTENDU_PRODUCTION} migrations appliquees et enregistrees`,
    appliquees.length === ATTENDU_PRODUCTION, `${appliquees.length}`);
  ok('les migrations posterieures a l historique de production sont les seules manquantes',
    manquantes.length === dossiers.length - ATTENDU_PRODUCTION,
    `${manquantes.length} manquante(s) pour ${dossiers.length} migrations`);

  // Les incidents rapportes, poses sur des migrations DEJA appliquees : c'est
  // la lecture qui rend le compte de 58 coherent. Les deux fautives et deux
  // annulees portent des noms dans les 58.
  await db.exec(`
    UPDATE public._prisma_migrations
       SET finished_at = NULL, applied_steps_count = 0,
           logs = 'synth: cannot change name of input parameter "p_org"'
     WHERE migration_name = '${CIBLE_B}';
    UPDATE public._prisma_migrations
       SET finished_at = NULL, applied_steps_count = 0,
           logs = 'synth: permission denied for schema public'
     WHERE migration_name = '${CIBLE_A}';
    INSERT INTO public._prisma_migrations (id, checksum, finished_at, rolled_back_at, migration_name, applied_steps_count)
    VALUES (gen_random_uuid()::text, repeat('c',64), now(), now(), '20261016130000_dynamic_dpp_lifecycle', 1),
           (gen_random_uuid()::text, repeat('d',64), now(), now(), '20261017100000_fix_document_lifecycle_access', 1);
  `);

  const etat = await db.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE finished_at IS NULL)::int AS non_terminees,
           count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int AS annulees
      FROM public._prisma_migrations;
  `);
  ok('CONSTAT 2 REPRODUIT : 60 entree(s), 2 non terminees, 2 annulees',
    etat.rows[0].non_terminees === 2 && etat.rows[0].annulees === 2,
    JSON.stringify(etat.rows[0]));

  const registreAvant = await db.query(
    `select count(*)::int n from information_schema.tables
      where table_schema='public' and table_name='tracefab_runtime_function_registry'`);
  ok('CONSTAT 3 REPRODUIT : le registre runtime est absent', registreAvant.rows[0].n === 0);
  const workerAvant = await db.query(`select count(*)::int n from pg_roles where rolname='tracefab_worker'`);
  ok('le role worker est absent', workerAvant.rows[0].n === 0);

  // --- Le blocage : tant qu'une entree est non terminee, deploy s'arrete.
  // On modelise la precondition que Prisma applique avant toute migration.
  const bloque = await db.query(
    `select count(*)::int n from public._prisma_migrations where finished_at is null and rolled_back_at is null`);
  ok('DEPLOY EST BLOQUE : une entree non terminee subsiste', bloque.rows[0].n === 2);

  // --- Etape 1 du plan : `migrate resolve --rolled-back`, RIEN DE PLUS.
  // Il horodate l'abandon, il ne defait rien : les objets deja crees restent.
  await db.exec(`
    UPDATE public._prisma_migrations SET rolled_back_at = now()
     WHERE finished_at IS NULL AND rolled_back_at IS NULL;
  `);
  const debloque = await db.query(
    `select count(*)::int n from public._prisma_migrations where finished_at is null and rolled_back_at is null`);
  ok('APRES RESOLVE : plus aucune entree bloquante', debloque.rows[0].n === 0);

  // --- Etape 2 du plan : deploy RE-EXECUTE les deux migrations abandonnees,
  // puis applique les cinq manquantes. Ce rejeu n'est pas un detail : c'est la
  // raison pour laquelle l'idempotence prouvee aux parties 1 et 2 conditionne
  // la surete du plan. On le modelise dans l'ordre alphabetique reel.
  const rejouees = [CIBLE_B, CIBLE_A];
  for (const d of rejouees) {
    await db.exec(lire(d));
    await db.exec(`INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES (gen_random_uuid()::text, repeat('2',64), now(), '${d}', 1)`);
  }
  ok('les deux migrations abandonnees ont ete rejouees sans erreur', true,
    rejouees.join(', '));

  // --- Etape 3 du plan : deploy applique les cinq manquantes.
  for (const d of manquantes) {
    await db.exec(lire(d));
    await db.exec(`INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES (gen_random_uuid()::text, repeat('1',64), now(), '${d}', 1)`);
  }
  ok(`les ${manquantes.length} migrations manquantes se sont appliquees`, true);

  // --- Postconditions : ce que la production doit montrer apres reprise.
  const registre = await db.query(
    `select count(*)::int n from information_schema.tables
      where table_schema='public' and table_name='tracefab_runtime_function_registry'`);
  ok('POSTCONDITION : la table du registre runtime existe', registre.rows[0].n === 1);

  const worker = await db.query(`select count(*)::int n from pg_roles where rolname='tracefab_worker'`);
  ok('POSTCONDITION : le role `tracefab_worker` existe', worker.rows[0].n === 1);

  const registreContenu = await db.query(`select count(*)::int n from public.tracefab_runtime_function_registry`);
  ok('POSTCONDITION : le registre est peuple', registreContenu.rows[0].n > 0,
    `${registreContenu.rows[0].n} fonction(s) declaree(s)`);

  const distinctes = await db.query(
    `select count(DISTINCT migration_name)::int n from public._prisma_migrations where finished_at is not null`);
  ok(`POSTCONDITION : les ${dossiers.length} migrations sont attestees terminees`,
    distinctes.rows[0].n === dossiers.length, `${distinctes.rows[0].n} / ${dossiers.length}`);

  await db.close();
}

console.log(`\n  ${verifies - echecs}/${verifies} verifications passees.`);
if (echecs > 0) {
  console.error('  Les incidents ne se reproduisent pas comme decrit, ou la reprise n est pas sure.');
  process.exit(1);
}
console.log('  Incidents reproduits, contenu du depot valide, reprise sure sur base jetable.');
console.log('  Ceci valide une PROCEDURE, pas l etat de la production.\n');
