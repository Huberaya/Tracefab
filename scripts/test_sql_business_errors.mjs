import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlBusinessError } from '../api/_lib/sql-errors.ts';

const root = new URL('..', import.meta.url);
const migrationsRoot = new URL('../prisma/migrations/', import.meta.url);
const definitions = await readFile(new URL('../api/_lib/sql-errors.ts', import.meta.url), 'utf8');
const defined = new Set([...definitions.matchAll(/^  ([a-z][a-z0-9_]+): \{ status:/gm)].map((match) => match[1]));

/**
 * Extraction DES EXCEPTIONS LEVEES PAR LES MIGRATIONS.
 *
 * La version precedente ne reconnaissait que la forme exacte
 * `RAISE EXCEPTION '<code>'`, sur une seule ligne et avec une espace unique.
 * Or le depot leve aussi des codes machine sur deux lignes :
 *
 *     RAISE EXCEPTION
 *       'rate_limit_counter_identity_is_immutable'
 *       USING ERRCODE = '42501';
 *
 * `rate_limit_counter_identity_is_immutable` etait donc absent du registre
 * alors qu'il est leve en production, et le test ne pouvait pas le voir. Une
 * extraction qui depend de la mise en forme du SQL ne prouve rien : elle
 * mesure le formatage, pas la couverture. La forme est desormais reconnue
 * quelle que soit l'indentation, et les messages libelles (une phrase en
 * francais) restent exclus par le filtre d'identifiant.
 */
const identifiant = /^[a-z][a-z0-9_]+$/;

async function codesLeves() {
  const leves = new Map();
  for (const directory of await readdir(migrationsRoot)) {
    const sql = await readFile(new URL(`${directory}/migration.sql`, migrationsRoot), 'utf8').catch(() => '');
    for (const match of sql.matchAll(/RAISE\s+EXCEPTION\s+'([^']+)'/gi)) {
      if (!identifiant.test(match[1])) continue;
      if (!leves.has(match[1])) leves.set(match[1], []);
      leves.get(match[1]).push(directory);
    }
  }
  return leves;
}

const leves = await codesLeves();
const raised = new Set(leves.keys());
const unmapped = [...raised].filter((code) => !defined.has(code)).sort();
assert.deepEqual(unmapped, [], `Exceptions SQL métier sans mapping HTTP sûr : ${unmapped.join(', ')}`);

/**
 * Gardes introduites par les migrations de securisation multi-tenant.
 *
 * Ces codes sont verifies nommement : ils portent une decision de securite, et
 * une faute de frappe dans le registre les rendrait muets. Le test exige aussi
 * qu'ils viennent bien d'une migration — un code declare sans emetteur ne
 * protegerait rien.
 */
const GARDES_MULTI_TENANT = {
  'active_tenant_documents_helper_executable_by_runtime': 409,
  'active_tenant_documents_runtime_owns_definer_function': 409,
  'active_tenant_material_certification_helper_executable_by_runtime': 409,
  'active_tenant_material_certification_runtime_owns_definer_function': 409,
  'active_tenant_quality_cap_helper_executable_by_runtime': 409,
  'active_tenant_quality_cap_runtime_owns_definer_function': 409,
  'active_tenant_quality_collection_helper_executable_by_runtime': 409,
  'active_tenant_quality_collection_runtime_owns_definer_function': 409,
  'active_tenant_supplier_profile_helper_executable_by_runtime': 409,
  'active_tenant_supplier_profile_runtime_owns_definer_function': 409,
  'active_tenant_supplier_quality_anchor_missing': 409,
  'active_tenant_supplier_quality_changed_owner_or_acl': 409,
  'active_tenant_supplier_quality_helper_executable_by_runtime': 409,
  'active_tenant_supplier_quality_postcondition_failed': 409,
  'active_tenant_supplier_quality_runtime_owns_definer_function': 409,
  'active_tenant_supplier_quality_target_missing_or_not_definer': 409,
  'active_tenant_tc_registration_cannot_find_plpgsql_body': 409,
  'active_tenant_tc_registration_changed_oid_owner_or_acl': 409,
  'active_tenant_tc_registration_expected_parameters_missing': 409,
  'active_tenant_tc_registration_postcondition_failed': 409,
  'active_tenant_tc_registration_target_not_security_definer': 409,
  'rate_limit_counter_identity_is_immutable': 409,
};

const statuts = new Map();
for (const m of definitions.matchAll(/^  ([a-z][a-z0-9_]+): \{ status: (\d+)/gm)) {
  statuts.set(m[1], Number(m[2]));
}

for (const [code, attendu] of Object.entries(GARDES_MULTI_TENANT)) {
  assert.ok(leves.has(code), `${code} est declare sans qu'aucune migration ne le leve : ${leves.get(code)}`);
  assert.ok(statuts.has(code), `${code} est leve par une migration mais absent du registre HTTP`);
  assert.equal(statuts.get(code), attendu, `Statut HTTP incorrect pour ${code}`);
  // Un invariant de configuration du schema est un conflit, jamais une panne
  // serveur : le client ne doit pas lire un 5xx pour un etat de schema refuse.
  assert.ok(statuts.get(code) >= 400 && statuts.get(code) < 500,
    `${code} est traduit en ${statuts.get(code)} : un refus de garde ne doit pas devenir une erreur serveur`);
}

/**
 * Un code metier traduit en 5xx n'est pas traduit : le client recoit une erreur
 * de serveur pour une decision d'autorisation. Les quatre codes de
 * `20261028140000_supplier_invitation_owner_relationship_scope`
 * (`owner_role_not_invitable`, `invitation_relationship_not_found`,
 * `invitation_relationship_organization_mismatch`, `invitation_relationship_ended`)
 * sont concernés : une invitation refusée est un 4xx, pas une panne.
 */
const workerGuardStatuses = new Map([
  ['worker_migration_requires_admin_role', 403],
  ['worker_role_creation_requires_createrole', 403],
  ['tracefab_worker_role_not_least_privilege', 409],
  ['worker_migration_membership_not_minimal', 409],
  ['worker_migration_executor_membership_missing', 409],
  ['tracefab_app_must_not_be_worker_member', 409],
  ['tracefab_worker_must_not_retain_schema_create', 409],
]);
for (const [code, expected] of workerGuardStatuses) {
  assert.equal(statuts.get(code), expected, `Statut HTTP incorrect pour ${code}`);
}

const serveur = [...raised]
  .filter((code) => statuts.has(code) && statuts.get(code) >= 500)
  .sort();
assert.deepEqual(serveur, [],
  `Codes métier traduits en 5xx (le client lit une panne au lieu d'un refus) : ${serveur.join(', ')}`);

/**
 * Sémantique des statuts : les grands registres ne doivent pas s'effondrer sur
 * une seule valeur. Un refus d'autorisation (403), une ressource absente (404),
 * un conflit d'etat (409) et une requete mal formee (400) restent distincts :
 * les confondre rend impossible de distinguer une erreur d'appel d'une erreur
 * de droits, et pousse les clients a reessayer ce qui ne doit pas l'etre.
 */
const parStatut = new Map();
for (const statut of statuts.values()) parStatut.set(statut, (parStatut.get(statut) ?? 0) + 1);
for (const attendu of [400, 401, 403, 404, 409, 422]) {
  assert.ok((parStatut.get(attendu) ?? 0) > 0, `Aucun code traduit en ${attendu} : la semantique des statuts s'est effondree`);
}

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

/**
 * CLASSEMENT PAR LA FONCTION REELLE, PAS PAR UNE COPIE.
 *
 * Le classement se fait par inclusion de sous-chaine sur le message PostgreSQL.
 * Deux codes du registre sont prefixes d'un autre, et l'ordre de declaration
 * faisait donc gagner le plus court :
 *
 *     invalid_material_percentage  ->  annonce « invalid_material »
 *     passport_not_found_or_private ->  annonce « passport_not_found »
 *
 * Le statut tombait juste par coincidence ; le motif annonce au client, non.
 * Ces cas sont exerces sur la vraie fonction exportee : une reimplementation
 * dans le test ne prouverait que la fidelite de la copie.
 */
const casNonAmbiguës = [
  ['invalid_material_percentage', 'invalid_material_percentage'],
  ['passport_not_found_or_private', 'passport_not_found_or_private'],
  ['invalid_material', 'invalid_material'],
  ['passport_not_found', 'passport_not_found'],
];
for (const [message, attendu] of casNonAmbiguës) {
  const classe = sqlBusinessError(new Error(message));
  assert.equal(classe?.error, attendu,
    `Un message PostgreSQL « ${message} » doit etre classe « ${attendu} », obtenu « ${classe?.error} »`);
}

// Un message qui contient le code au milieu d'un texte reste reconnu, et le
// code n'est jamais renvoye au client sous forme de message brut.
const enfoui = sqlBusinessError(new Error('ERROR: document_access_denied — detail interne'));
assert.deepEqual(enfoui, { status: 403, error: 'document_access_denied' });

// Une erreur inconnue n'est surtout pas traduite : elle doit remonter comme
// erreur interne, pas etre habillee en refus metier.
assert.equal(sqlBusinessError(new Error('relation "x" does not exist')), null);

console.log(
  `SQL business error audit passed: ${raised.size} PostgreSQL guards mapped; `
  + `${Object.keys(GARDES_MULTI_TENANT).length} multi-tenant guards verified by name; `
  + `all raw-query routes classify known failures.`,
);
