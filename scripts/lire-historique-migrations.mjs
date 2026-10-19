#!/usr/bin/env node
/**
 * Comparer l'historique reel de _prisma_migrations aux migrations du depot.
 *
 * STRICTEMENT EN LECTURE SEULE : trois SELECT, aucune ecriture, aucune
 * creation, aucun privilege modifie, aucune migration executee.
 *
 * Affiche l'hote AVANT toute connexion utile : c'est le seul moyen de savoir
 * quelle base repond. Aucune chaine de connexion n'est jamais affichee.
 *
 * Sortie : 0 = historique coherent, 1 = divergence constatee, 2 = non execute.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n  NON EXECUTE — DATABASE_URL est absente.\n  Renseignez-la, puis relancez : npm run db:historique-migrations\n');
  process.exit(2);
}

const { hostname: hote, pathname } = new URL(url);
const base = pathname.replace(/^\//, '');

console.log('');
console.log('  Historique des migrations — lecture seule');
console.log('');
console.log(`  hote verifie : ${hote}`);
console.log(`  base         : ${base}`);
console.log('  Confirmez que cet hôte est bien la branche visée avant de');
console.log('  poursuivre : c est le seul moyen de savoir quelle base répond.');
console.log('');

// Migrations attendues, lues dans le depot.
const attendues = fs
  .readdirSync(path.join(racine, 'prisma', 'migrations'))
  .filter((d) => /^\d{14}_/.test(d))
  .sort();

const client = new pg.Client({ connectionString: url });

let divergences = 0;
try {
  await client.connect();

  const etat = await client.query(`
    SELECT count(*)                                                    AS total,
           count(*) FILTER (WHERE rolled_back_at IS NOT NULL)          AS annulees,
           count(*) FILTER (WHERE finished_at IS NULL
                              AND rolled_back_at IS NULL)              AS inachevees
    FROM _prisma_migrations`);
  const { total, annulees, inachevees } = etat.rows[0];

  console.log(`  migrations attendues (depot)  : ${attendues.length}`);
  console.log(`  lignes dans _prisma_migrations: ${total}`);
  console.log(`    dont annulees               : ${annulees}`);
  console.log(`    dont inachevees             : ${inachevees}`);
  console.log('');

  // Noms reellement journales, non annulees.
  const appliquees = await client.query(
    `SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL`
  );
  const noms = new Set(appliquees.rows.map((r) => r.migration_name));

  const manquantes = attendues.filter((d) => !noms.has(d));
  const orphelines = [...noms].filter((n) => !attendues.includes(n)).sort();

  console.log(`  manquantes (dans le depot, pas en base) : ${manquantes.length}`);
  manquantes.forEach((d) => console.log(`    - ${d}`));
  console.log(`  orphelines (en base, pas dans le depot) : ${orphelines.length}`);
  orphelines.forEach((d) => console.log(`    - ${d}`));
  console.log('');

  // Les trois migrations portees par la PR #58, une par une.
  const portees = [
    '20261017100000_fix_document_lifecycle_access',
    '20261017120000_harden_dpp_table_privileges',
    '20261017150000_harden_finalize_ops_gate'
  ];
  console.log('  migrations portees par la PR :');
  const detail = await client.query(
    `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
     FROM _prisma_migrations WHERE migration_name = ANY($1)`,
    [portees]
  );
  const parNom = new Map(detail.rows.map((r) => [r.migration_name, r]));
  for (const d of portees) {
    const l = parNom.get(d);
    if (!l) console.log(`    ${d}  ABSENTE`);
    else if (l.rolled_back_at) console.log(`    ${d}  ANNULEE`);
    else if (!l.finished_at) console.log(`    ${d}  INACHEVEE`);
    else console.log(`    ${d}  appliquee (${l.applied_steps_count} etape)`);
  }
  console.log('');

  // Une ligne annulee (rolled_back_at renseigne) est la trace d une tentative
  // qui a echoue puis ete deroulee. Prisma la conserve et ne la compte pas
  // comme appliquee : elle n est donc pas une divergence. Seules comptent les
  // migrations absentes, orphelines, ou laissees inachevees sans deroulement.
  divergences = manquantes.length + orphelines.length + Number(inachevees);

  if (divergences === 0) {
    console.log('  VERDICT : historique coherent. Chaque migration du depot est');
    console.log('  journalee et terminee ; aucune ligne orpheline, aucune inachevee.');
    if (Number(annulees) > 0) {
      console.log(`  Note : ${annulees} ligne(s) annulee(s) subsistent. Ce sont des`);
      console.log('  traces de tentatives deroulees, pas des divergences : Prisma les');
      console.log('  conserve et ne les compte pas comme appliquees.');
    }
  } else {
    console.log(`  VERDICT : ${divergences} divergence(s). Le depot et la base ne`);
    console.log('  decrivent pas le meme schema. Aucun correctif n est propose ici :');
    console.log('  toute regularisation exigerait une autorisation explicite et ne');
    console.log('  passerait jamais par une insertion manuelle dans _prisma_migrations.');
  }
} catch (erreur) {
  console.log(`  ECHEC — ${erreur.code ?? erreur.message}`);
  divergences = -1;
} finally {
  await client.end();
}

console.log('');
process.exit(divergences === 0 ? 0 : 1);
