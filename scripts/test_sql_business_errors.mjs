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

/**
 * Un code métier traduit en 5xx n'est pas traduit : le client reçoit une erreur
 * de serveur pour une décision d'autorisation. Les quatre codes de
 * `20261028140000_supplier_invitation_owner_relationship_scope`
 * (`owner_role_not_invitable`, `invitation_relationship_not_found`,
 * `invitation_relationship_organization_mismatch`, `invitation_relationship_ended`)
 * sont concernés : une invitation refusée est un 4xx, pas une panne.
 */
const statuts = new Map();
for (const m of definitions.matchAll(/^  ([a-z][a-z0-9_]+): \{ status: (\d+)/gm)) {
  statuts.set(m[1], Number(m[2]));
}
const serveur = [...raised]
  .filter((code) => statuts.has(code) && statuts.get(code) >= 500)
  .sort();
assert.deepEqual(serveur, [],
  `Codes métier traduits en 5xx (le client lit une panne au lieu d'un refus) : ${serveur.join(', ')}`);

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
