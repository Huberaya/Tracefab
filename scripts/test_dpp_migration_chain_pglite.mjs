#!/usr/bin/env node
/* ==========================================================================
   La chaine de migrations COMPLETE, jouee dans un PostgreSQL reel (WASM).

   POURQUOI CE TEST EXISTE
   -----------------------
   `test_dpp_quality_gate_pglite.mjs` verifie la semantique de la barriere sur
   un schema minimal : utile, mais un schema minimal ne dit pas si la migration
   s'applique sur le VRAI schema du produit (colonnes, types, contraintes,
   policies). Une migration qui casse sur la base reelle est une migration
   qui n'existe pas.

   Ce test applique donc, dans l'ordre, **les 58 migrations du depot**, sur un
   PostgreSQL compile en WASM (PGlite, devDependency), apres creation des
   roles attendus. Puis il rejoue la sequence avant/apres sur la fonction
   installee :

     1. la definition d'origine (`20261021170000`) est reposee : un produit
        jamais evalue franchit `quality.no_open_issues` — le faux vert ;
     2. la migration corrective (`20261027100000`) est reappliquee : le meme
        produit echoue, puis passe apres evaluation.

   CE QUI EST PROUVE
   -----------------
   La chaine complete s'applique sans erreur, y compris la migration ajoutee ;
   la barriere se comporte comme documente sur le vrai schema.

   CE QUI N'EST PAS PROUVE
   -----------------------
   PGlite n'est ni Neon ni la base de recette : pas de RLS en conditions
   reelles, pas de donnees de production, et une migration refusee ici pour
   une raison d'environnement (role, extension non disponible) ne le serait
   pas forcement ailleurs. Le test le signale au lieu de le masquer.
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch (error) {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) { console.log(`  ok    ${label}`); return; }
  failures += 1;
  console.error(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`);
};

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;

// Les migrations supposent des roles provisionnes hors Prisma. On les cree
// avec les attributs attendus : `tracefab_app` doit pouvoir se connecter et
// ne doit surtout pas contourner la RLS.
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
`);

const dirs = fs.readdirSync(MIGRATIONS)
  .filter((name) => fs.statSync(path.join(MIGRATIONS, name)).isDirectory())
  .sort();

let applied = 0;
const failed = [];
for (const dir of dirs) {
  const file = path.join(MIGRATIONS, dir, 'migration.sql');
  if (!fs.existsSync(file)) continue;
  try {
    await db.exec(fs.readFileSync(file, 'utf8'));
    applied += 1;
  } catch (error) {
    failed.push([dir, String(error.message).split('\n')[0]]);
  }
}

console.log(`\n  ${applied}/${dirs.length} migration(s) appliquee(s)`);
if (failed.length) {
  for (const [dir, message] of failed) console.error(`  ECHEC ${dir} — ${message.slice(0, 180)}`);
  failures += failed.length;
} else {
  check('les migrations du depot s\'appliquent dans l\'ordre, sans erreur', true);
}

/* -- La sequence avant/apres, sur le schema reel -------------------------- */
const PRODUIT = '11111111-1111-4111-8111-111111111111';

// Un produit doit appartenir a une organisation de type « brand » : le
// trigger d'integrite le verifie, et le contourner rendrait le test menteur.
const ORG = '44444444-4444-4444-8444-444444444444';
await db.exec(`
  INSERT INTO organizations (id, type, legal_name, country_code)
  VALUES ('${ORG}', 'brand', 'Organisation de recette', 'FR');
  INSERT INTO tracefab_products (id, brand_organization_id, version, reference, name, status)
  VALUES ('${PRODUIT}', '${ORG}', 1, 'TS-001', 'T-shirt de recette', 'active');
`);

const met = async (key) => {
  const { rows } = await db.query('SELECT tracefab_dpp_requirement_met($1, $2) AS met', [key, PRODUIT]);
  return rows[0].met;
};

// 1. Definition d'origine, reposee verbatim depuis son fichier.
const origine = fs.readFileSync(path.join(MIGRATIONS, '20261021170000_dpp_readiness_truthful_gates/migration.sql'), 'utf8');
await db.exec(origine);
const avant = await met('quality.no_open_issues');
check('sur le vrai schema, la definition d\'origine laisse passer un produit non evalue', avant === true, `valeur : ${avant}`);

// 2. Migration corrective.
const corrective = fs.readFileSync(path.join(MIGRATIONS, '20261027100000_dpp_quality_gate_requires_assessment/migration.sql'), 'utf8');
try {
  await db.exec(corrective);
  check('la migration corrective se reapplique sur le schema reel', true);
} catch (error) {
  check('la migration corrective se reapplique sur le schema reel', false, String(error.message).slice(0, 200));
}

check('le produit non evalue echoue desormais', (await met('quality.no_open_issues')) === false);

await db.exec(`
  INSERT INTO data_quality_scores (id, owner_organization_id, product_id, calculation_version, blocking_issues)
  VALUES (gen_random_uuid(), '${ORG}', '${PRODUIT}', 'recette-1', '[]'::jsonb)
`);
check('une evaluation sans anomalie rouvre la barriere', (await met('quality.no_open_issues')) === true);

const anomalie = (statut) => db.exec(`INSERT INTO data_quality_issues
  (id, owner_organization_id, product_id, rule_key, rule_version, severity, status, message)
  VALUES (gen_random_uuid(), '${ORG}', '${PRODUIT}', 'test_rule', '1', 'warning', '${statut}', 'anomalie de recette')`);

// Chacun des quatre statuts d'anomalie, eprouve separement : ceux qui doivent
// fermer la barriere la ferment, ceux qui ne le doivent pas la laissent ouverte.
await anomalie('open');
check('une anomalie ouverte referme la barriere', (await met('quality.no_open_issues')) === false);

await db.exec("UPDATE data_quality_issues SET status='acknowledged' WHERE product_id='${PRODUIT}'".replace('${PRODUIT}', PRODUIT));
check('une anomalie seulement acquiescee referme aussi la barriere', (await met('quality.no_open_issues')) === false);

await db.exec(`UPDATE data_quality_issues SET status='waived' WHERE product_id='${PRODUIT}'`);
check(
  'une anomalie levee (waived) ne referme plus la barriere — comportement a assumer, pas a ignorer',
  (await met('quality.no_open_issues')) === true,
);

await db.exec(`UPDATE data_quality_issues SET status='resolved' WHERE product_id='${PRODUIT}'`);
check('une anomalie resolue laisse la barriere ouverte', (await met('quality.no_open_issues')) === true);

// Deux evaluations : c'est la plus recente qui fait foi pour
// `quality.no_blocking_issues`.
await db.exec(`INSERT INTO data_quality_scores (id, owner_organization_id, product_id, calculation_version, blocking_issues, computed_at)
  VALUES (gen_random_uuid(), '${ORG}', '${PRODUIT}', 'recette-2', '["composition_incomplete"]'::jsonb, now() + interval '1 minute')`);
check(
  'quality.no_blocking_issues suit la derniere evaluation, pas la premiere',
  (await met('quality.no_blocking_issues')) === false,
);

// Les autres barrieres du profil restent evaluees honnetement : celles que
// le produit de recette ne satisfait pas doivent rester fausses. Sans ce
// controle, une migration qui renverrait `true` partout passerait le test.
const attendu = {
  'product.reference': true,
  'product.name': true,
  'product.not_draft': true,
  'composition.complete': false,
  'traceability.documented': false,
  'evidence.product_data': false,
  'quality.no_blocking_issues': false, // la 2e evaluation porte une anomalie bloquante
  'quality.requirement_inexistante': false,
};
const ecarts = [];
for (const [key, valeur] of Object.entries(attendu)) {
  const obtenu = await met(key);
  if (obtenu !== valeur) ecarts.push(`${key}: attendu ${valeur}, obtenu ${obtenu}`);
}
check('chaque barriere est evaluee selon sa propre regle', ecarts.length === 0, ecarts.join(' | '));

const { rows: privileges } = await db.query(`
  SELECT has_function_privilege('public', 'tracefab_dpp_requirement_met(text, uuid)', 'execute') AS public_peut,
         has_function_privilege('tracefab_app', 'tracefab_dpp_requirement_met(text, uuid)', 'execute') AS app_peut
`);
check('PUBLIC ne peut pas executer la fonction', privileges[0].public_peut === false);
check('tracefab_app ne peut pas executer la fonction', privileges[0].app_peut === false);

await db.close();

console.log('');
if (failures) {
  console.error(`Chaine de migrations : ${failures} verification(s) en echec.`);
  process.exit(1);
}
console.log('Chaine de migrations : OK — 58 migrations appliquees sur PostgreSQL WASM, barriere qualite verifiee avant/apres.');
