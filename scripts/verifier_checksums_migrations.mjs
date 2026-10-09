#!/usr/bin/env node
/**
 * Verifie que chaque migration deja appliquee en base a toujours le meme
 * contenu que le fichier du depot, et sait reparer l'ecart.
 *
 * Pourquoi cet outil existe
 * -------------------------
 * Prisma stocke dans _prisma_migrations.checksum le sha256 du fichier
 * migration.sql au moment ou il l'a applique. Si le fichier change ensuite,
 * « prisma migrate deploy » refuse de tourner sur cette base.
 *
 * Or il faut parfois corriger une migration deja appliquee. Exemple reel :
 * 20261009180000_public_read_context accordait des droits a un role qu'aucune
 * migration anterieure ne cree. Sur Neon le role preexistait, donc la
 * migration passait ; sur une base vierge toute la chaine echouait. Corriger
 * le fichier etait la bonne reponse, mais cela desynchronise le checksum des
 * bases ou la migration est deja posee.
 *
 * Cet outil rend cet ecart visible et reparable, au lieu de le laisser
 * exploser au prochain deploiement.
 *
 * Sans --appliquer il ne fait que LIRE et signaler. Le code de sortie vaut 1
 * si un ecart subsiste, ce qui permet de l'utiliser comme garde-fou.
 *
 *   node scripts/verifier_checksums_migrations.mjs
 *   node scripts/verifier_checksums_migrations.mjs --appliquer
 *
 * La base visee est DATABASE_URL (utiliser DIRECT_URL pour Neon : un
 * endpoint poole ne convient pas aux operations de migration).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const APPLIQUER = process.argv.includes('--appliquer');
const RACINE = 'prisma/migrations';

function checksumDuDepot(nom) {
  const chemin = join(RACINE, nom, 'migration.sql');
  // Prisma hache les octets bruts du fichier, sans normaliser les fins de
  // ligne : on lit donc en binaire pour obtenir exactement sa valeur.
  return createHash('sha256').update(readFileSync(chemin)).digest('hex');
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL absente. Pour Neon, utiliser DIRECT_URL (endpoint non poole).');
  process.exit(2);
}

const db = new pg.Client({ connectionString: url });
await db.connect();

try {
  const surDisque = new Map(
    readdirSync(RACINE)
      .filter((n) => statSync(join(RACINE, n)).isDirectory())
      .map((n) => [n, checksumDuDepot(n)]),
  );

  const { rows } = await db.query(
    `select migration_name, checksum, finished_at
       from _prisma_migrations
      order by started_at`,
  );

  console.log(`\n  ${rows.length} migration(s) enregistree(s) en base · ${surDisque.size} dans le depot\n`);

  const ecarts = [];
  const absentes = [];

  for (const ligne of rows) {
    const attendu = surDisque.get(ligne.migration_name);
    if (attendu === undefined) {
      absentes.push(ligne.migration_name);
    } else if (attendu !== ligne.checksum) {
      ecarts.push({ nom: ligne.migration_name, enBase: ligne.checksum, attendu });
    }
  }

  const jamaisAppliquees = [...surDisque.keys()].filter(
    (n) => !rows.some((r) => r.migration_name === n),
  );

  for (const nom of absentes) {
    console.log(`  ⚠  ${nom}`);
    console.log('     enregistree en base mais absente du depot — ne pas toucher sans analyse\n');
  }
  for (const nom of jamaisAppliquees) {
    console.log(`  ·  ${nom} : dans le depot, pas encore appliquee ici (normal)\n`);
  }

  if (ecarts.length === 0) {
    console.log('  ok  tous les checksums concordent : migrate deploy passera.\n');
    process.exit(absentes.length > 0 ? 1 : 0);
  }

  for (const e of ecarts) {
    console.log(`  ✗  ${e.nom}`);
    console.log(`     en base  : ${e.enBase}`);
    console.log(`     fichier  : ${e.attendu}`);
  }
  console.log();

  if (!APPLIQUER) {
    console.log('  Le fichier a change apres son application. En l\'etat,');
    console.log('  « prisma migrate deploy » refusera de tourner sur cette base.');
    console.log('  Relancer avec --appliquer apres avoir verifie que le changement');
    console.log('  est bien NEUTRE pour une base deja migree.\n');
    process.exit(1);
  }

  // Une seule transaction : soit tous les checksums sont realignes, soit aucun.
  await db.query('begin');
  try {
    for (const e of ecarts) {
      await db.query(
        'update _prisma_migrations set checksum = $1 where migration_name = $2',
        [e.attendu, e.nom],
      );
    }
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }

  // On ne se fie pas au fait que l'UPDATE n'ait pas leve : on relit.
  const { rows: apres } = await db.query(
    `select migration_name, checksum from _prisma_migrations
      where migration_name = any($1)`,
    [ecarts.map((e) => e.nom)],
  );
  const restants = apres.filter(
    (r) => r.checksum !== surDisque.get(r.migration_name),
  );
  if (restants.length > 0) {
    console.log(`  ✗ ${restants.length} checksum(s) toujours desalignes apres ecriture.\n`);
    process.exit(1);
  }

  console.log(`  ok  ${ecarts.length} checksum(s) realignes et relus depuis la base.\n`);
} finally {
  await db.end();
}
