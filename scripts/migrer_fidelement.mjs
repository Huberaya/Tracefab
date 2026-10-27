#!/usr/bin/env node
/**
 * Reimplementation fidèle de `prisma migrate deploy`, pour usage HORS LIGNE.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Dans cet environnement, `prisma migrate deploy` est inutilisable, pour deux
 * raisons independantes et verifiees :
 *
 *   1. le schema-engine classique n'existe pas et son telechargement
 *      (`binaries.prisma.sh`) est bloque ;
 *   2. le moteur de schema en JavaScript (Prisma 6.19, `engine: 'js'`), qui
 *      fonctionne sans binaire, echoue a l'initialisation du registre :
 *      « Column type 'name' could not be deserialized from the database » —
 *      reproduit sur PostgreSQL 18.4 reel, pas seulement sur PGlite.
 *
 * CE QUE CE SCRIPT EST, ET CE QU'IL N'EST PAS
 *
 * Il applique les migrations en attente, dans l'ordre lexicographique du nom de
 * dossier (l'ordre qu'utilise Prisma), en une transaction par migration, et
 * consigne chaque migration terminee dans `_prisma_migrations` avec l'empreinte
 * sha256 du fichier `migration.sql`.
 *
 * Il N'EST PAS une preuve que `prisma migrate deploy` se comporte pareil. La
 * valeur d'empreinte produite par le moteur Rust de Prisma n'a pas pu etre
 * comparee ici : aucun registre ecrit par le vrai CLI n'est disponible hors
 * ligne. En consequence :
 *
 *   - ce script sert a EPROUVER une chaine de migrations sur une base de TEST ;
 *   - il ne doit JAMAIS servir a migrer une base qui recevra ensuite le vrai
 *     CLI, sous peine de faire echouer la comparaison d'empreintes.
 *
 * La production doit passer par `prisma migrate deploy`, jamais par ceci.
 *
 * GARDE-FOUS
 *
 * - Refus de tout hote ressemblant a la production (`TF_HOTE_PRODUCTION`).
 * - `TF_ALLOW_WRITE=oui` obligatoire : aucune ecriture accidentelle.
 * - Mode `--etat` en lecture seule, qui n'ecrit rien du tout.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const RACINE = process.cwd();
const DOSSIER = process.env.TF_MIGRATIONS_PATH
  ? path.resolve(RACINE, process.env.TF_MIGRATIONS_PATH)
  : path.join(RACINE, 'prisma/migrations');

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

const lireEtatSeulement = process.argv.includes('--etat');
// `--jusqu-a <dossier>` : s'arreter a une migration precise incluse. Utile pour
// reconstituer un etat anterieur (ex. une base a 58 migrations avant d'appliquer
// la 59e) sans reecrire l'historique : la base est neuve, le registre refletera
// exactement ce qui a ete joue.
const argJusque = process.argv.indexOf('--jusqu-a');
const migrationDerniere = argJusque > -1 ? process.argv[argJusque + 1] : null;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('NON EXECUTE — DATABASE_URL est obligatoire.');
  process.exit(2);
}

let hote = '';
try { hote = new URL(url).hostname; } catch { /* laisse vide */ }
if (!hote) {
  console.error('REFUS — DATABASE_URL illisible.');
  process.exit(2);
}
if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error(`REFUS — la cible (${hote}) est la base de PRODUCTION.`);
  console.error('Ce script ne migre que des bases de test. Sortie 3.');
  process.exit(3);
}
if (!lireEtatSeulement && process.env.TF_ALLOW_WRITE !== 'oui') {
  console.error('REFUS — ecriture non autorisee. Relancer avec TF_ALLOW_WRITE=oui,');
  console.error('ou en lecture seule avec --etat. Sortie 3.');
  process.exit(3);
}

const migrationsDisque = readdirSync(DOSSIER)
  .filter((nom) => /^\d/.test(nom) && statSync(path.join(DOSSIER, nom)).isDirectory())
  .filter((nom) => existsSync(path.join(DOSSIER, nom, 'migration.sql')))
  .sort();

const empreinte = (fichier) => createHash('sha256').update(readFileSync(fichier)).digest('hex');

const client = new pg.Client({
  connectionString: url,
  ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false,
  application_name: 'tracefab-migration-fidele',
});
await client.connect();

// Le registre est cree a l'identique de ce que pose Prisma.
await client.query(`
  CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )
`);

const { rows: registre } = await client.query(
  'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations',
);
const terminees = new Set(
  registre.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name),
);
const enEchec = registre.filter((r) => !r.finished_at);

console.log(`cible ${hote} · ${migrationsDisque.length} migration(s) sur disque · ${terminees.size} deja appliquee(s)`);
if (enEchec.length) {
  console.log(`EN ECHEC dans le registre : ${enEchec.map((r) => r.migration_name).join(', ')}`);
}

if (migrationDerniere) {
  if (!migrationsDisque.includes(migrationDerniere)) {
    console.error(`REFUS — migration inconnue : ${migrationDerniere}`);
    await client.end();
    process.exit(2);
  }
  const rang = migrationsDisque.indexOf(migrationDerniere);
  console.log(`borne : arret apres ${migrationDerniere} (rang ${rang + 1}/${migrationsDisque.length}).`);
  migrationsDisque.length = rang + 1;
}

const enAttente = migrationsDisque.filter((nom) => !terminees.has(nom));
if (!enAttente.length) {
  console.log('Aucune migration en attente.');
} else {
  console.log(`en attente (${enAttente.length}), dans cet ordre :`);
  enAttente.forEach((nom, i) => console.log(`  ${i + 1}. ${nom}`));
}

if (lireEtatSeulement) {
  console.log('\nmode lecture seule : aucune ecriture effectuee.');
  await client.end();
  process.exit(0);
}

let appliquees = 0;
for (const nom of enAttente) {
  const fichier = path.join(DOSSIER, nom, 'migration.sql');
  const sql = readFileSync(fichier, 'utf8');
  const id = crypto.randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    // Certaines migrations posent `search_path = pg_catalog` pour le reste de
    // leur transaction (20261021120000) : le registre doit donc etre qualifie,
    // et le search_path retabli, sinon l'insertion echoue apres coup.
    await client.query('SET LOCAL search_path TO public, pg_catalog');
    await client.query(
      `INSERT INTO public._prisma_migrations
         (id, checksum, migration_name, finished_at, applied_steps_count)
       VALUES ($1, $2, $3, now(), 1)`,
      [id, empreinte(fichier), nom],
    );
    await client.query('COMMIT');
    appliquees += 1;
    console.log(`  appliquee  ${nom}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Comme Prisma : la ligne d'echec reste, avec finished_at NULL.
    await client.query(
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, logs, applied_steps_count)
       VALUES ($1, $2, $3, $4, 0)`,
      [id, empreinte(fichier), nom, String(error.message).slice(0, 4000)],
    ).catch(() => {});
    console.error(`  ECHEC      ${nom}`);
    console.error(`             ${String(error.message).split('\n')[0]}`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\n${appliquees} migration(s) appliquee(s).`);
await client.end();
