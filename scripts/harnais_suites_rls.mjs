#!/usr/bin/env node
/**
 * Harnais des suites `test_rls_*` : une base migree, semee, puis les suites.
 *
 * POURQUOI CE HARNAIS
 *
 * Trois suites RLS du depot ne s'executaient pas dans l'environnement de
 * cloture du 30/10 :
 *
 *   — `scripts/test_rls_bypass_controle_negatif.mjs` sortait en 2 faute de
 *     `DATABASE_URL` ET de `TF_RLS_APP_URL` ;
 *   — `scripts/test_rls_write_policies.mjs` sortait en 1 des qu'elle tournait :
 *     `42P01 relation "organizations" does not exist`. La garde de cible
 *     acceptait `tracefab_test`, mais cette base etait VIDE : aucune migration
 *     n'y avait ete appliquee ;
 *   — `scripts/test_neon_security.mjs`, `test_neon_product_flow.mjs` et
 *     `test_neon_supplier_advanced.mjs` instancient `PrismaClient` : ils
 *     dependent du client Prisma genere et de son adapter (section P1), pas de
 *     ce harnais. Ils sont donc listes, pas executes.
 *
 * Ce que ce harnais fabrique, dans l'ordre ou l'application en a besoin :
 *
 *   1. une base EPHEMERE (nom unique, preuve d'OID, `FORCE` a la destruction) ;
 *   2. le role `tracefab_app` AVANT les migrations (la chaine contient un
 *      `ALTER ROLE`) ;
 *   3. les 66 migrations du depot, lues sur disque et jouees une par une —
 *      aucune dependance a la CLI Prisma ni au reseau ;
 *   4. les fixtures d'isolation (`scripts/seed_rls_fixture.mjs`) : deux
 *      locataires distincts, sans lesquels le controle negatif sort en 2 ;
 *   5. les suites demandees, avec `DATABASE_URL` (proprietaire) et
 *      `TF_RLS_APP_URL` (role applicatif) pointant la MEME base ephemere.
 *
 * Aucune ressource n'est laissee : la base est detruite dans un `finally`, et
 * `fermer()` refuse de detruire une base dont l'OID a change.
 *
 * Usage :
 *   node scripts/run-db-suite.mjs scripts/harnais_suites_rls.mjs \
 *        scripts/test_rls_write_policies.mjs scripts/test_rls_bypass_controle_negatif.mjs
 *
 * Sorties : 0 toutes les suites vertes · 1 au moins une suite en echec ·
 *           2 prerequis manquant.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { creerBaseEphemere, filetDeNettoyage, verrouillerCluster } from './lib/ephemeral-db.mjs';
import { ensureAppRole } from './lib/tracefab_app_role.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const MDP_APP = process.env.TF_APP_PASSWORD || 'harnais_rls_jetable';

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'harnais des suites RLS (migrations + fixtures)',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const suites = process.argv.slice(2);
if (suites.length === 0) {
  console.error('  Usage : node scripts/harnais_suites_rls.mjs <suite> [suite...]');
  process.exit(2);
}

function session(url) {
  return new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
}

const base = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_harnais_rls' });
const filet = filetDeNettoyage(async () => {
  await base.fermer();
});

let codeSortie = 1;
// Le verrou de CLUSTER ne couvre QUE la phase que ce harnais execute lui-meme
// (role + migrations, qui touchent `pg_authid`). Il est relache AVANT de lancer
// les enfants : `seed_rls_fixture.mjs` et plusieurs suites le prennent a leur
// tour, et un verrou consultatif n'est pas reentrant entre deux sessions —
// le garder ici les ferait attendre indefiniment (mesure : 15 minutes de
// blocage, enfant tue par le timeout).
let verrou = null;
try {
  console.log(`  base ephemere ${base.nom} (oid=${base.oid})`);

  verrou = await verrouillerCluster({ urlProprietaire });

  // 2. Role applicatif AVANT les migrations.
  {
    const db = session(base.url);
    await db.connect();
    try {
      await ensureAppRole(db, MDP_APP);
    } finally {
      await db.end();
    }
  }

  // 3. Migrations, lues sur disque.
  let appliquees = 0;
  const echecsMigration = [];
  {
    const mig = session(base.url);
    await mig.connect();
    try {
      await mig.query(`CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id text PRIMARY KEY, checksum text NOT NULL, finished_at timestamptz,
        migration_name text NOT NULL, logs text, rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
      const dossiers = readdirSync(join(RACINE, 'prisma', 'migrations'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      for (const d of dossiers) {
        const sql = readFileSync(join(RACINE, 'prisma', 'migrations', d, 'migration.sql'), 'utf8');
        if (!sql.trim() || sql.trim() === '-- This is an empty migration.') continue;
        try {
          await mig.query(sql);
          appliquees += 1;
        } catch (e) {
          echecsMigration.push(`${d} (${e.code})`);
        }
      }
    } finally {
      await mig.end();
    }
  }
  console.log(`  ${appliquees} migrations appliquees`
    + `${echecsMigration.length ? `, ${echecsMigration.length} en echec : ${echecsMigration.join(', ')}` : ''}`);

  // Fin de la section critique de ce harnais : on relache AVANT les enfants.
  await verrou.relacher();
  verrou = null;

  // 4. Fixtures d'isolation : deux locataires.
  {
    const r = spawnSync(process.execPath, [join(RACINE, 'scripts', 'seed_rls_fixture.mjs')], {
      cwd: RACINE, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: base.url, TF_APP_PASSWORD: MDP_APP },
    });
    if (r.status !== 0) {
      console.log(`  FIXTURES EN ECHEC (exit=${r.status}) — les suites qui en dependent sortiront en 2`);
      const ligne = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').pop();
      if (ligne) console.log(`    ${ligne}`);
    } else {
      console.log('  fixtures d isolation posees (deux locataires)');
    }
  }

  // 5. Suites, sur la MEME base.
  const u = new URL(base.url);
  u.username = 'tracefab_app';
  u.password = MDP_APP;
  const urlApp = u.toString();

  const resultats = [];
  for (const suite of suites) {
    const chemin = join(RACINE, suite);
    process.stdout.write(`\n  >>> ${suite}\n`);
    const r = spawnSync(process.execPath, [chemin], {
      cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        DATABASE_URL: base.url,
        TF_RLS_APP_URL: urlApp,
        TF_APP_PASSWORD: MDP_APP,
      },
    });
    const code = r.status ?? 1;
    resultats.push({ suite, code });
    console.log(`  <<< ${suite} : exit=${code}`);
  }

  const rouges = resultats.filter((r) => r.code !== 0);
  console.log('');
  for (const r of resultats) {
    console.log(`  ${r.code === 0 ? 'VERT ' : 'ROUGE'} ${r.suite} (exit=${r.code})`);
  }
  codeSortie = rouges.length === 0 ? 0 : 1;
} finally {
  if (verrou) await verrou.relacher();
  await base.fermer();
  console.log(`  base ephemere detruite : ${base.nom}`);
}
void filet;
process.exit(codeSortie);
