#!/usr/bin/env node
/**
 * Matrice des migrations — snapshot Neon mesure le 04/11/2026.
 *
 * Le script ne se connecte pas a Neon. Il compare les fichiers du depot aux
 * 56 checksums exportes en lecture seule depuis Production et Preproduction.
 * Il distingue les 13 migrations absentes et les 2 tentatives annulees qui
 * disposent aussi d'une ligne terminee.
 *
 *   node scripts/matrice_migrations.mjs
 *   node scripts/matrice_migrations.mjs --markdown
 *   node scripts/matrice_migrations.mjs --verifier
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_APPLIED, ROLLED_BACK_ATTEMPTS, ECARTS, CATALOGUE, HORS_BANDE,
  BORNE_RELEVE, SNAPSHOT_DATE,
} from './lib/ecarts_migrations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'prisma', 'migrations');
const markdown = process.argv.includes('--markdown');

const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const sha256 = (name) => {
  const file = join(migrationsDir, name, 'migration.sql');
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
};

const errors = [];
const rows = [];
const newNames = [];

for (const name of migrations) {
  const actual = sha256(name);
  const expected = PRODUCTION_APPLIED[name];
  const gap = ECARTS[name];
  let history;
  let effect;
  let catalogue;
  let status;

  if (expected) {
    if (HORS_BANDE[name]) {
      history = 'APPLIQUEE HORS BANDE';
      effect = 'MESURE';
      catalogue = `PRESENT MESURE — objets : ${HORS_BANDE[name].join(', ')}`;
      status = 'A QUALIFIER';
    } else {
      history = 'APPLIQUEE';
      effect = 'NON PROUVE';
      catalogue = 'NON LU — historique réussi, catalogue non relu migration par migration';
      status = 'NON PROUVE';
    }
    if (actual !== expected) {
      errors.push(`${name}: checksum different de Production/Preproduction (attendu ${expected}, depot ${actual})`);
    }
  } else if (gap) {
    history = 'ABSENTE';
    effect = gap.effets[0];
    catalogue = CATALOGUE[name]?.catalogue ?? 'NON LU';
    status = CATALOGUE[name]?.statut ?? 'NON PROUVE';
  } else if (name > BORNE_RELEVE) {
    history = 'NOUVELLE (postérieure au snapshot)';
    effect = 'NON DEPLOYEE';
    catalogue = 'ABSENTE — écrite après le snapshot';
    status = 'NON DEPLOYEE';
    newNames.push(name);
  } else {
    errors.push(`${name}: migration non classée dans le snapshot`);
    history = 'NON CLASSEE';
    effect = 'NON PROUVE';
    catalogue = 'NON LU';
    status = 'NON PROUVE';
  }

  if (!actual) errors.push(`${name}: migration.sql absente ou illisible`);
  rows.push({ name, actual, expected: expected ?? null, history, effect, catalogue, status, detail: gap?.objet ?? '—', next: gap?.suite ?? '—' });
}

for (const name of Object.keys(PRODUCTION_APPLIED)) {
  if (!migrations.includes(name)) errors.push(`snapshot applique mais dossier absent du depot: ${name}`);
}
for (const name of Object.keys(ECARTS)) {
  if (!migrations.includes(name)) errors.push(`migration en attente absente du depot: ${name}`);
}
for (const [name, objects] of Object.entries(HORS_BANDE)) {
  if (!migrations.includes(name)) errors.push(`migration hors bande absente du depot: ${name}`);
  if (!PRODUCTION_APPLIED[name]) errors.push(`migration hors bande sans ligne terminee dans Neon: ${name}`);
  if (!Array.isArray(objects) || objects.length === 0) errors.push(`migration hors bande sans objets attestes: ${name}`);
}
for (const [name, gap] of Object.entries(ECARTS)) {
  if (gap.historique !== 'ABSENTE') errors.push(`${name}: statut d'historique incoherent`);
  if (!CATALOGUE[name] || !CATALOGUE[name].catalogue || !CATALOGUE[name].statut) {
    errors.push(`${name}: fait catalogue manquant`);
  }
}

const count = (history) => rows.filter((row) => row.history === history).length;
const applied = count('APPLIQUEE');
const outOfBand = count('APPLIQUEE HORS BANDE');
const missing = count('ABSENTE');
const newCount = count('NOUVELLE (postérieure au snapshot)');
const checksumCount = rows.filter((row) => row.expected && row.actual !== row.expected).length;

if (applied + outOfBand !== Object.keys(PRODUCTION_APPLIED).length) errors.push('compte applique ne correspond pas au snapshot');
if (outOfBand !== Object.keys(HORS_BANDE).length) errors.push('compte hors bande ne correspond pas au snapshot');
if (missing !== Object.keys(ECARTS).length) errors.push('compte absent ne correspond pas aux 13 migrations en attente');
if (applied + outOfBand + missing + newCount !== rows.length) errors.push('l arithmetique des categories ne ferme pas');
if (ROLLED_BACK_ATTEMPTS.length !== 2) errors.push('le nombre de tentatives annulees du snapshot a change');

const knownDuplicatePrefixes = ['20261006120000','20261006200000','20261006220000','20261017120000'];
const prefixes = migrations.map((name) => name.slice(0,14));
const duplicates = [...new Set(prefixes.filter((prefix,i)=>prefixes.indexOf(prefix)!==i))].sort();
for (const prefix of duplicates) if (!knownDuplicatePrefixes.includes(prefix)) errors.push(`nouveau prefixe d horodatage en double: ${prefix}`);
for (const prefix of knownDuplicatePrefixes) if (!duplicates.includes(prefix)) errors.push(`prefixe declare en double mais absent: ${prefix}`);

if (markdown) {
  console.log(`# Matrice des migrations — snapshot ${SNAPSHOT_DATE}\n`);
  console.log('| Migration | SHA depot | SHA base si appliquée | Historique | Catalogue observé | Statut | Suite |');
  console.log('|---|---|---|---|---|---|---|');
  for (const row of rows) {
    console.log(`| \`${row.name}\` | \`${(row.actual ?? '').slice(0,12)}\` | ${row.expected ? `\`${row.expected.slice(0,12)}\`` : '—'} | ${row.history} | ${row.catalogue} | **${row.status}** | ${row.next} |`);
  }
} else {
  console.log(`Matrice des migrations — snapshot ${SNAPSHOT_DATE}\n`);
  console.log(`  migrations du depot             : ${rows.length}`);
  console.log(`  appliquees via Prisma           : ${applied}`);
  console.log(`  appliquees hors bande            : ${outOfBand}`);
  console.log(`  absentes de l'historique        : ${missing}`);
  console.log(`  nouvelles apres snapshot        : ${newCount}`);
  console.log(`  tentatives annulees historiques : ${ROLLED_BACK_ATTEMPTS.length} (les deux noms ont aussi une ligne terminee)`);
  console.log(`  divergences de checksum         : ${checksumCount}`);
  console.log(`  prefixes en double              : ${duplicates.length} connus`);
  console.log('');
  for (const row of rows.filter((item) => item.history === 'ABSENTE' || item.history.startsWith('NOUVELLE'))) {
    console.log(`  ${row.name}\n    historique=${row.history} catalogue=${row.status}\n    ${row.detail}\n    suite: ${row.next}`);
  }
}
if (errors.length) {
  console.error('\nDIVERGENCES :');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
if (!markdown) console.log('\nMatrice cohérente : 51 via Prisma + 5 hors bande, 13 absentes, 0 checksum divergent.');
