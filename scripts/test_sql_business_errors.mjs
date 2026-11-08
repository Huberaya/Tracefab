import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const migrationsRoot = new URL('../prisma/migrations/', import.meta.url);
const definitions = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
const defined = new Set([...definitions.matchAll(/^  ([a-z][a-z0-9_]+): \{ status:/gm)].map((match) => match[1]));

/**
 * Seules les exceptions émises par des fonctions SQL peuvent remonter à une
 * route qui exécute une requête brute. Les RAISE EXCEPTION des blocs DO de
 * migration sont des assertions de déploiement (préconditions/catalogue) :
 * ils doivent faire échouer la migration, jamais être traduits en HTTP.
 *
 * Les fonctions PostgreSQL du dépôt utilisent un corps AS dollar-quoté ou
 * littéral. On extrait ces corps plutôt que de scanner indistinctement tout
 * migration.sql, ce qui confondrait les gardes de migration et les erreurs
 * métier exposées par l'API.
 */
function extractFunctionBodies(sql) {
  const bodies = [];
  const declarations = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gim;
  let declaration;
  while ((declaration = declarations.exec(sql)) !== null) {
    const asClause = /\bAS\s+(\$[A-Za-z_0-9]*\$|E?'(?:''|[^'])*')/gi;
    asClause.lastIndex = declarations.lastIndex;
    const body = asClause.exec(sql);
    if (!body) {
      throw new Error('Définition CREATE FUNCTION sans corps AS reconnu après : '
        + sql.slice(declaration.index, declaration.index + 160).replace(/\s+/g, ' '));
    }

    const delimiter = body[1];
    if (delimiter.startsWith('$')) {
      const bodyStart = asClause.lastIndex;
      const bodyEnd = sql.indexOf(delimiter, bodyStart);
      if (bodyEnd < 0) throw new Error('Corps de fonction non terminé (' + delimiter + ')');
      bodies.push(sql.slice(bodyStart, bodyEnd));
      declarations.lastIndex = bodyEnd + delimiter.length;
    } else {
      // Corps SQL littéral : retirer les quotes et dédoubler les apostrophes.
      bodies.push(delimiter.replace(/^E?'/i, '').slice(0, -1).replace(/''/g, "'"));
      declarations.lastIndex = asClause.lastIndex;
    }
  }
  return bodies;
}

function exceptionCodes(source) {
  return [...source.matchAll(/RAISE EXCEPTION '([^']+)'/g)]
    .map((match) => match[1])
    .filter((code) => /^[a-z][a-z0-9_]+$/.test(code));
}

// Contrat du scanner : une garde DO reste interne, une exception de fonction
// est bien considérée comme une erreur métier potentiellement exposée.
const fixture = "
DO $migration_guard$ BEGIN RAISE EXCEPTION 'guard_only_code'; END $migration_guard$;
CREATE OR REPLACE FUNCTION public.fixture_business_error() RETURNS void
LANGUAGE plpgsql AS $function_body$
BEGIN
  RAISE EXCEPTION 'fixture_business_code';
END
$function_body$;
";
assert.deepEqual(exceptionCodes(extractFunctionBodies(fixture).join('\n')), ['fixture_business_code']);

const raised = new Set();
for (const directory of await readdir(migrationsRoot)) {
  const sql = await readFile(new URL('../prisma/migrations/' + directory + '/migration.sql', import.meta.url), 'utf8').catch(() => '');
  for (const code of exceptionCodes(extractFunctionBodies(sql).join('\n'))) raised.add(code);
}
const unmapped = [...raised].filter((code) => !defined.has(code)).sort();
assert.deepEqual(unmapped, [], 'Exceptions SQL métier sans mapping HTTP sûr : ' + unmapped.join(', '));

/**
 * Un code métier traduit en 5xx n'est pas traduit : le client reçoit une erreur
 * de serveur pour une décision d'autorisation. Les quatre codes de la migration
 * supplier_invitation_owner_relationship_scope sont concernés : une invitation
 * refusée est un 4xx, pas une panne.
 */
const statuts = new Map();
for (const m of definitions.matchAll(/^  ([a-z][a-z0-9_]+): \{ status: (\d+)/gm)) {
  statuts.set(m[1], Number(m[2]));
}
const serveur = [...raised]
  .filter((code) => statuts.has(code) && statuts.get(code) >= 500)
  .sort();
assert.deepEqual(serveur, [],
  "Codes métier traduits en 5xx (le client lit une panne au lieu d'un refus) : " + serveur.join(', '));

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
assert.deepEqual(rawRoutesWithoutMapping, [], 'Routes SQL ramenant encore les erreurs métier à internal_server_error : ' + rawRoutesWithoutMapping.join(', '));

console.log('SQL business error audit passed: ' + raised.size + ' PostgreSQL function exceptions mapped; migration DO guards are excluded from HTTP mapping.');
