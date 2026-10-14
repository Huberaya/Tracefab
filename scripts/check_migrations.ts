import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { compareMigrationHistory } from './lib/migration-history-check.mjs';

const prisma = new PrismaClient();

async function main() {
  console.log('=== CONTRÔLE FAIL-CLOSED DES MIGRATIONS POSTGRESQL ===\n');

  const migrationsDir = path.resolve(process.cwd(), 'prisma/migrations');
  let diskMigrations: string[];
  try {
    diskMigrations = fs.readdirSync(migrationsDir)
      .filter((name) => fs.statSync(path.join(migrationsDir, name)).isDirectory())
      .filter((name) => name !== 'migration_lock.toml')
      .sort();

    if (diskMigrations.length === 0) {
      throw new Error('Aucun dossier de migration détecté : le contrôle serait vide de sens.');
    }

    for (const name of diskMigrations) {
      const sqlPath = path.join(migrationsDir, name, 'migration.sql');
      if (!fs.existsSync(sqlPath) || fs.statSync(sqlPath).size === 0) {
        throw new Error(`Fichier migration.sql absent ou vide : ${name}`);
      }
    }
  } catch (error: any) {
    console.error(`ÉCHEC — lecture du dépôt impossible : ${error?.message ?? 'erreur inconnue'}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Dossiers de migration dans le dépôt : ${diskMigrations.length}.\n`);

  let records: any[];
  try {
    records = await prisma.$queryRawUnsafe<any[]>(
      'SELECT migration_name, started_at, finished_at, rolled_back_at FROM public."_prisma_migrations" ORDER BY started_at ASC NULLS FIRST, migration_name ASC'
    );
  } catch (error: any) {
    console.error('ÉCHEC — impossible de lire public."_prisma_migrations".');
    console.error('Le contrôle ne peut pas conclure et ne doit pas afficher un succès.');
    console.error(`Détail : ${String(error?.message ?? 'erreur inconnue').split(String.fromCharCode(10))[0]}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Entrées dans l’historique Prisma : ${records.length}.\n`);
  const result = compareMigrationHistory(diskMigrations, records);

  for (const name of result.applied) console.log(`[APPLIQUÉE] ${name}`);
  for (const name of result.pending) console.log(`[EN ATTENTE] ${name}`);
  for (const name of result.failed) console.log(`[ÉCHEC / NON RÉSOLUE] ${name}`);
  for (const name of result.unknown) console.log(`[ABSENTE DU DÉPÔT] ${name}`);

  console.log('\n--- RÉSUMÉ ---');
  console.log(`Dépôt : ${result.diskCount} | Appliquées : ${result.applied.length} | En attente : ${result.pending.length} | Échecs : ${result.failed.length} | Inconnues : ${result.unknown.length}`);

  if (!result.ok) {
    console.error('\nÉCHEC — divergence détectée. Aucune migration n’a été exécutée.');
    for (const issue of result.errors) console.error(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nSUCCÈS — le dépôt et l’historique Prisma sont cohérents.');
}

main()
  .catch((error: any) => {
    console.error(`ÉCHEC — contrôle interrompu : ${String(error?.message ?? 'erreur inconnue').split(String.fromCharCode(10))[0]}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {
      process.exitCode = 1;
    });
  });
