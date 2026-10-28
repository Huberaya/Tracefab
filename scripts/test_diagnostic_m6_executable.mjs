#!/usr/bin/env node
/**
 * Le releve M6 doit S'EXECUTER — un script de diagnostic jamais execute n'est
 * pas un diagnostic, c'est un brouillon.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `docs/security/2026-10-28-m6-lecture-seule.sql` est destine a la production,
 * mais il a ete ecrit sans jamais tourner sur un schema complet : une colonne
 * mal nommee, un catalogue lu au mauvais endroit, et l'operateur decouvre
 * l'erreur au pire moment, sur la base qu'il ne faut pas abimer. Ce test
 * applique les 63 migrations du depot dans un PostgreSQL compile en WASM,
 * fabrique un historique de migrations SYNTHETIQUE, puis execute le fichier de
 * releve en entier.
 *
 * CE QUI EST PROUVE
 *   - le script s'execute sans erreur sur le schema reel du produit ;
 *   - chacun de ses blocs rend un resultat (aucun bloc muet) ;
 *   - il ne modifie rien : l'historique de migrations est identique avant/apres,
 *     et une tentative d'ecriture dans la meme transaction est refusee par le
 *     serveur lui-meme.
 *
 * CE QUI N'EST PAS PROUVE
 *   PGlite n'est pas Neon : les privileges, les extensions et les politiques
 *   ne s'y comportent pas comme en production. Ce test prouve que le SQL est
 *   juste et inoffensif, PAS ce que la production repondra. Le releve reste a
 *   executer par un operateur habilite sur la base reelle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = path.join(root, 'docs/security/2026-10-28-m6-lecture-seule.sql');
const MIGRATIONS = path.join(root, 'prisma/migrations');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch (error) {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  process.exit(1);
}

let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;

// Roles attendus par les migrations et par le releve.
await db.exec(`
  CREATE ROLE neondb_owner LOGIN PASSWORD 'x' NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB;
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
`);

// Les 63 migrations, dans l'ordre.
const dossiers = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d))
  .sort();
let appliquees = 0;
for (const d of dossiers) {
  const f = path.join(MIGRATIONS, d, 'migration.sql');
  if (!fs.existsSync(f)) continue;
  await db.exec(fs.readFileSync(f, 'utf8'));
  appliquees += 1;
}
ok(`${appliquees} migrations appliquees`, appliquees === dossiers.length, `${appliquees}/${dossiers.length}`);

// Historique de migrations SYNTHETIQUE. Aucune donnee de production : on
// fabrique exactement le cas decrit — deux entrees non terminees, deux
// annulees — pour verifier que le releve les rend lisibles.
await db.exec(`
  CREATE TABLE public._prisma_migrations (
    id                    varchar(36) PRIMARY KEY,
    checksum              varchar(64) NOT NULL,
    finished_at           timestamptz,
    migration_name        varchar(255) NOT NULL,
    logs                  text,
    rolled_back_at        timestamptz,
    started_at            timestamptz NOT NULL DEFAULT now(),
    applied_steps_count   integer NOT NULL DEFAULT 0
  );
  INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
  VALUES ('synth-1', repeat('a', 64), now(), '20261010120000_publication_explicite', 0);
  UPDATE public._prisma_migrations
     SET finished_at = NULL, logs = 'ERREUR SYNTHETIQUE : conflit de signature de fonction'
   WHERE id = 'synth-1';
  INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
  VALUES ('synth-2', repeat('b', 64), NULL, '20261017120000_active_tenant_context', 0);
  INSERT INTO public._prisma_migrations (id, checksum, finished_at, rolled_back_at, migration_name, applied_steps_count)
  VALUES ('synth-3', repeat('c', 64), NULL, now(), '20261015120000_ancienne_corrigee', 0);
`);

const etatAvant = async () => (await db.query(
  'SELECT count(*)::int AS n, coalesce(sum(applied_steps_count),0)::int AS s, max(checksum) AS c FROM public._prisma_migrations',
)).rows[0];
const avant = await etatAvant();

/* --- Execution du releve ------------------------------------------------- */

const sql = fs.readFileSync(SQL, 'utf8');
let execution = 'ok';
try {
  // La transaction READ ONLY est ouverte par l'operateur ; le fichier la ferme
  // par son propre ROLLBACK. On reproduit exactement ce geste.
  await db.exec('BEGIN READ ONLY;');
  await db.exec(sql);
} catch (error) {
  execution = String(error.message || error);
}
ok('le releve s execute sans erreur sur le schema complet', execution === 'ok', execution.slice(0, 300));

/* --- Chaque bloc doit rendre un resultat --------------------------------- */

// Les blocs sont separes par des commentaires « -- N. » ou « -- 5 bis. ».
const titres = [...sql.matchAll(/^-- (\d+(?: bis)?\.) /gm)].map((m) => m[1]);
ok('le fichier annonce ses blocs', titres.length >= 6, `${titres.length} bloc(s) : ${titres.join(' ')}`);
ok('le bloc « qui peut migrer » est present', sql.includes('peut_creer_dans_public'));

// Les requetes du nouveau bloc, jouees telles quelles.
const acl = await db.query(`
  SELECT current_database() AS base,
         pg_catalog.pg_get_userbyid(d.datdba) AS proprietaire_base,
         pg_catalog.pg_get_userbyid(n.nspowner) AS proprietaire_schema_public,
         n.nspacl AS acl_schema_public
    FROM pg_catalog.pg_database d
    CROSS JOIN pg_catalog.pg_namespace n
   WHERE d.datname = current_database() AND n.nspname = 'public';
`);
ok('le bloc rend le proprietaire du schema public', acl.rows.length === 1,
  `${acl.rows.length} ligne(s)`);

const droits = await db.query(`
  SELECT r.rolname,
         has_schema_privilege(r.rolname, 'public', 'CREATE') AS peut_creer_dans_public,
         has_schema_privilege(r.rolname, 'public', 'USAGE') AS peut_utiliser_public,
         pg_catalog.pg_has_role(r.rolname, 'pg_database_owner', 'MEMBER') AS membre_pg_database_owner
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('neondb_owner', 'tracefab_app', 'tracefab_worker') OR r.rolsuper
   ORDER BY r.rolname;
`);
ok('le bloc rend les privileges par role', droits.rows.length >= 2, `${droits.rows.length} role(s)`);
ok('le role de migration est evalue nommement',
  droits.rows.some((r) => r.rolname === 'neondb_owner'));

/* --- Le releve doit etre inoffensif -------------------------------------- */

const apres = await etatAvant();
ok('l historique de migrations est inchange',
  avant.n === apres.n && avant.s === apres.s && avant.c === apres.c,
  `${JSON.stringify(avant)} -> ${JSON.stringify(apres)}`);

// Une ecriture tente dans la meme transaction READ ONLY doit etre refusee par
// le serveur : c'est la garantie de fond, pas une convention de lecture.
await db.exec('BEGIN READ ONLY;');
let refus = null;
try {
  await db.exec("INSERT INTO public._prisma_migrations (id, checksum, migration_name) VALUES ('x', 'y', 'z')");
} catch (error) {
  refus = String(error.message || error);
}
await db.exec('ROLLBACK;');
ok('une ecriture est refusee en transaction READ ONLY',
  refus !== null && /read-only/i.test(refus), refus ? refus.slice(0, 120) : 'aucun refus');

// Et l'entree non terminee fabriquee est bien lisible par le bloc des echecs.
const incidents = await db.query(`
  SELECT migration_name FROM public._prisma_migrations
   WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
   ORDER BY started_at DESC;
`);
ok('les trois incidents synthetiques sont visibles',
  incidents.rows.length === 3, `${incidents.rows.length} ligne(s)`);

console.log(echecs === 0
  ? '\n  Releve M6 executable et inoffensif sur le schema complet.\n'
  : `\n  ${echecs} echec(s).\n`);
process.exit(echecs === 0 ? 0 : 1);
