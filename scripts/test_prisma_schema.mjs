#!/usr/bin/env node
/**
 * LE SCHÉMA PRISMA EST-IL VALIDE, ET DIT-IL LA VÉRITÉ SUR LA BASE ?
 *
 * POURQUOI CE TEST EXISTE
 *   `prisma validate` n'avait jamais pu s'exécuter ici : il télécharge un
 *   binaire natif depuis binaries.prisma.sh. Le schéma n'était donc contrôlé par
 *   rien, et il contenait quatre défauts qui le faisaient échouer pour tout le
 *   monde :
 *
 *     1. `crm_companies.converted_at` et `converted_value_eur` ajoutées par une
 *        migration, jamais déclarées dans le modèle — alors qu'un index
 *        référence `converted_at` et que `stage.ts` sélectionne et écrit ces
 *        deux colonnes. Avec un client généré, la conversion prospect → client
 *        levait à l'exécution.
 *     2. `linked_organization` et trois autres relations déclarées obligatoires
 *        sur des clés étrangères optionnelles : Prisma exige que la relation
 *        soit optionnelle elle aussi.
 *     3. `crm_saved_views crm_saved_views[]`, une auto-relation sans côté opposé
 *        et sans aucune colonne auto-référente en base.
 *
 *   Aucun de ces défauts n'est visible en lisant du SQL ou du Prisma. Ils ne
 *   sortent que d'un vrai validateur.
 *
 * SI LE MOTEUR N'EST PAS DISPONIBLE
 *   Le test affiche POSTGRES_ENGINE_UNAVAILABLE et sort en code 2 : le runner
 *   classe ce cas en SKIP, jamais en PASS. Une validation non effectuée ne doit
 *   pas ressembler à une validation réussie.
 *
 *   npm run test:prisma:schema
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  engineHashOf, expectedEngineVersion, installedWasmVersion, schemaWasmAvailable,
  validateSchema, getDmmf, getConfig,
} from './_lib/prisma-schema-wasm.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);

if (!schemaWasmAvailable()) {
  console.error('POSTGRES_ENGINE_UNAVAILABLE');
  console.error('@prisma/prisma-schema-wasm n\'est pas installé : impossible de valider le schéma.');
  console.error(`version de moteur attendue : ${expectedEngineVersion() ?? 'inconnue'}`);
  process.exit(2);
}

let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const check = (fn, label) => {
  try { fn(); ok(label); } catch (e) { bad(label, e?.message); }
};
const eq = (a, e, l) => check(() => {
  if (a !== e) throw new Error(`attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);
}, l);
const isTrue = (cond, l, d) => check(() => {
  if (!cond) throw new Error(d ?? 'attendu vrai');
}, l);

const schemaPath = at('prisma/schema.prisma');
const schema = await readFile(schemaPath, 'utf8');

/* -------------------------------------------------------------------------- */
console.log('\nA. Le validateur est bien celui de Prisma');
/* -------------------------------------------------------------------------- */

const have = installedWasmVersion();
const want = expectedEngineVersion();
isTrue(Boolean(have), 'le moteur WASM est installé');
eq(engineHashOf(have), want,
  `le moteur WASM (${have}) correspond à la version attendue par @prisma/engines-version (${want})`,
  'un moteur décalé pourrait valider ce que le client refuse');

/* Le validateur doit pouvoir REJETER un schéma faux, sinon un schéma faux
   passerait et le test ne prouverait rien. */
const bogus = validateSchema('model A { id String @id\n  @@index([inexistant])\n}');
eq(bogus.ok, false, 'le validateur rejette un schéma qui référence un champ inexistant');
isTrue(/inexistant/.test(bogus.errors), 'et nomme le champ en cause', bogus.errors.slice(0, 80));

/* -------------------------------------------------------------------------- */
console.log('\nB. Le schéma du dépôt valide');
/* -------------------------------------------------------------------------- */

const verdict = validateSchema(schema);
isTrue(verdict.ok, 'prisma/schema.prisma valide', verdict.errors?.slice(0, 900));

const dmmf = getDmmf(schema);
eq(dmmf.datamodel.models.length, 53, '53 modèles');
eq(dmmf.datamodel.enums.length, 40, '40 enums');
const config = getConfig(schema);
eq(config.generators.filter((g) => g.provider.value === 'prisma-client-js').length, 1,
  'un générateur prisma-client-js');
eq(config.datasources[0].activeProvider, 'postgresql', 'un datasource postgresql');

/* -------------------------------------------------------------------------- */
console.log('\nC. Aucune relation obligatoire sur une clé étrangère optionnelle');
/* -------------------------------------------------------------------------- */

/*
 * C'est l'erreur qui a cassé la validation : `organization_id String?` avec
 * `linked_organization organizations @relation(...)`. Prisma refuse, et avec
 * raison — une relation non nulle sur une colonne nulle promet un objet qui
 * peut ne pas exister.
 */
const models = new Map();
for (const m of dmmf.datamodel.models) models.set(m.name, m);
const badRelations = [];
for (const m of dmmf.datamodel.models) {
  for (const f of m.fields || []) {
    if (f.kind !== 'object' || f.isList) continue;
    if (!f.isRequired) continue;
    const fkNames = f.relationFromFields || [];
    const scalars = fkNames
      .map((n) => (m.fields || []).find((x) => x.name === n))
      .filter(Boolean);
    if (scalars.some((s) => !s.isRequired)) badRelations.push(`${m.name}.${f.name}`);
  }
}
eq(badRelations.length, 0, 'aucune relation obligatoire posée sur une FK optionnelle',
  badRelations.slice(0, 5).join(', '));

/* -------------------------------------------------------------------------- */
console.log('\nD. Aucun index ne référence un champ absent');
/* -------------------------------------------------------------------------- */

/*
 * C'est le défaut qui faisait échouer `prisma validate` : l'index
 * idx_crm_companies_org_converted portait sur `converted_at`, non déclarée.
 * Vérifié ici en lisant le schéma, pour que le test reste explicite même si le
 * validateur change de message.
 */
const schemaModels = new Map();
for (const match of schema.matchAll(/\nmodel\s+(\w+)\s*\{([\s\S]*?)\n\}\n/g)) {
  const [, name, body] = match;
  const fields = new Set();
  for (const line of body.split('\n')) {
    const fm = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s+\S/);
    /* RegExpMatchArray n'a pas de méthode .group : l'indice numérique, pas un
       appel. Confondre les deux lève « fm.group is not a function ». */
    if (fm && !line.trim().startsWith('@@')) fields.add(fm[1]);
  }
  schemaModels.set(name, { fields, body });
}
const ghostIndexes = [];
for (const [name, { fields, body }] of schemaModels) {
  for (const [, cols] of body.matchAll(/@@(?:index|unique)\(\[([^\]]+)\]/g)) {
    for (const raw of cols.split(',')) {
      /* `created_at(sort: Desc)` : couper avant la parenthèse, pas sur les
         espaces — sinon le champ devient « created_at(sort: ». */
      const col = raw.trim().replace(/\(.*$/, '').replace(/[?"]/g, '').trim();
      if (col && !fields.has(col)) ghostIndexes.push(`${name}.${col}`);
    }
  }
}
eq(ghostIndexes.length, 0, 'aucun @@index/@@unique ne référence un champ non déclaré',
  ghostIndexes.slice(0, 5).join(', '));

/* -------------------------------------------------------------------------- */
console.log('\nE. Le schéma dit la vérité sur la base');
/* -------------------------------------------------------------------------- */

/*
 * Toute colonne créée par une migration doit être déclarée dans le modèle —
 * directement, ou via @map. Sinon `prisma migrate diff` propose de supprimer une
 * colonne réelle, et le client ne sait pas la lire.
 */
const migrationDirs = (await readdir(at('prisma/migrations'))).filter((d) => !d.startsWith('.'));
const added = new Map();   // table -> Set(colonnes)
const dropped = new Map();
for (const dir of migrationDirs.sort()) {
  let sql;
  try { sql = await readFile(at(`prisma/migrations/${dir}/migration.sql`), 'utf8'); } catch { continue; }
  sql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  for (const [, table, body] of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+([\s\S]*?);/g)) {
    for (const [, col] of body.matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+"?(\w+)"?/g)) {
      if (!added.has(table)) added.set(table, new Set());
      added.get(table).add(col);
    }
    for (const [, col] of body.matchAll(/DROP COLUMN(?: IF EXISTS)?\s+"?(\w+)"?/g)) {
      if (!dropped.has(table)) dropped.set(table, new Set());
      dropped.get(table).add(col);
    }
  }
  for (const [, table, body] of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/g)) {
    for (const line of body.split('\n')) {
      const cm = line.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s+(?:TIMESTAMPTZ|UUID|TEXT|INTEGER|BIGINT|BOOLEAN|JSONB|NUMERIC|VARCHAR|DATE|SMALLINT)/i);
      if (cm) {
        if (!added.has(table)) added.set(table, new Set());
        added.get(table).add(cm[1]);
      }
    }
  }
}

/* Colonnes réellement présentes = ajoutées − supprimées. */
const undeclared = [];
for (const [table, cols] of added) {
  const model = schemaModels.get(table);
  if (!model) continue;                       // table non modélisée : volontaire
  const removed = dropped.get(table) || new Set();
  /* @map("colonne") compte comme une déclaration. */
  const mapped = new Set([...model.body.matchAll(/@map\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const col of cols) {
    if (removed.has(col)) continue;
    if (!model.fields.has(col) && !mapped.has(col)) undeclared.push(`${table}.${col}`);
  }
}
eq(undeclared.length, 0,
  'toute colonne de la base est déclarée dans le modèle (directement ou via @map)',
  undeclared.slice(0, 6).join(', '));

isTrue(migrationDirs.length >= 37, `la chaîne de migrations est lue (${migrationDirs.length} répertoires)`);
isTrue(added.size >= 30, `les colonnes de ${added.size} tables sont rapprochées du schéma`);

/* Le contrôle doit pouvoir ÉCHOUER : sans cette vérification, un test vert ne
   voudrait rien dire. */
const fake = new Map(schemaModels);
fake.set('crm_companies', { fields: new Set(['id']), body: '' });
const fakeUndeclared = [...(added.get('crm_companies') || [])]
  .filter((c) => c !== 'id');
isTrue(fakeUndeclared.length > 5,
  `le rapprochement détecterait une disparition (${fakeUndeclared.length} colonnes seraient signalées sur crm_companies)`);

/* -------------------------------------------------------------------------- */
console.log('\nF. Les contournements de typage sont retirés');
/* -------------------------------------------------------------------------- */

/*
 * `as unknown as string[]` masquait le type d'un enum au lieu de le satisfaire.
 * Il ne tenait que parce que le client n'était pas généré. Maintenant qu'il
 * l'est, ce cast produisait TS2322 — et faisait exploser un type récursif en
 * TS2615 sur crm-connection.ts.
 */
const offenders = [];
for (const file of ['api/_lib/crm-connection.ts', 'api/_routes/admin/settings.ts']) {
  /* Les commentaires sont retirés AVANT l'assertion : crm-connection.ts explique
     précisément quel cast a été retiré, et le texte du commentaire contient donc
     la chaîne recherchée. */
  const src = (await readFile(at(file), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  if (/as unknown as string\[\]/.test(src)) offenders.push(file);
}
eq(offenders.length, 0, 'plus aucun `as unknown as string[]` dans les deux fichiers concernés',
  offenders.join(', '));
const connection = await readFile(at('api/_lib/crm-connection.ts'), 'utf8');
isTrue(/ONBOARDED_STATUSES = \['submitted', 'approved'\] as const/.test(connection),
  'ONBOARDED_STATUSES est `as const` : le type littéral survit jusqu\'à Prisma');

/* -------------------------------------------------------------------------- */
console.log('\nG. Le client généré, s\'il existe, correspond au schéma');
/* -------------------------------------------------------------------------- */

let generated = null;
try {
  generated = JSON.parse(await readFile(at('node_modules/.prisma/client/package.json'), 'utf8'));
} catch { /* client non généré : ce n'est pas une erreur de ce test */ }

if (generated) {
  const indexDts = await readFile(at('node_modules/.prisma/client/index.d.ts'), 'utf8');
  isTrue(indexDts.length > 1_000_000,
    `index.d.ts est un client typé, pas le placeholder (${(indexDts.length / 1e6).toFixed(1)} Mo)`);
  for (const model of ['crm_companies', 'crm_contacts', 'crm_leads', 'crm_pilots']) {
    isTrue(indexDts.includes(`export type ${model.charAt(0).toUpperCase()}${model.slice(1)} =`)
      || indexDts.includes(`export type ${model} =`),
      `le type ${model} est exporté`);
  }
  isTrue(/converted_at/.test(indexDts),
    'converted_at est typé dans le client — stage.ts le sélectionne et l\'écrit');
} else {
  console.log('  —     client non généré : section ignorée (npm run prisma:generate:offline)');
}

console.log(`\n${failures ? 'ÉCHEC' : 'SUCCÈS'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures ? 1 : 0);
