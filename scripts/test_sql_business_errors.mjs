import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const migrationsRoot = new URL('../prisma/migrations/', import.meta.url);
const definitions = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
const defined = new Set([...definitions.matchAll(/^  ([a-z][a-z0-9_]+): \{ status:/gm)].map((match) => match[1]));
const raised = new Set();
for (const directory of await readdir(migrationsRoot)) {
  const sql = await readFile(new URL(`${directory}/migration.sql`, migrationsRoot), 'utf8').catch(() => '');
  for (const match of sql.matchAll(/RAISE EXCEPTION '([^']+)'/g)) {
    if (/^[a-z][a-z0-9_]+$/.test(match[1])) raised.add(match[1]);
  }
}
const unmapped = [...raised].filter((code) => !defined.has(code)).sort();
assert.deepEqual(unmapped, [], `Exceptions SQL métier sans mapping HTTP sûr : ${unmapped.join(', ')}`);

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await routeFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

const routesRoot = fileURLToPath(new URL('../api/_routes/', import.meta.url));
const rawRoutesWithoutMapping = [];
for (const path of await routeFiles(routesRoot)) {
  const source = await readFile(path, 'utf8');
  if (!source.includes('internal_server_error')) continue;
  if (!source.includes('$queryRaw') && !source.includes('$executeRaw')) continue;
  if (!source.includes('sqlBusinessError')) rawRoutesWithoutMapping.push(path.replace(new URL('..', root).pathname, ''));
}
assert.deepEqual(rawRoutesWithoutMapping, [], `Routes SQL ramenant encore les erreurs métier à internal_server_error : ${rawRoutesWithoutMapping.join(', ')}`);

console.log(`SQL business error audit passed: ${raised.size} PostgreSQL guards mapped; all raw-query routes classify known failures.`);
