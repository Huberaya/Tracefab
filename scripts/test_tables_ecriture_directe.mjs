#!/usr/bin/env node
/**
 * Garde de cohérence : toute table que l'application écrit DIRECTEMENT doit être
 * accordée en écriture au rôle applicatif.
 *
 * POURQUOI CE CONTRÔLE EXISTE
 *
 * Le 19 octobre 2026, `scripts/lib/tracefab_app_role.mjs` restreignait le rôle
 * applicatif à 4 tables d'écriture directe. La liste était annoncée comme
 * « établie par extraction des ordres INSERT / UPDATE / DELETE de api/ », mais
 * l'extraction ne relevait que le SQL écrit en clair ($executeRaw / $queryRaw)
 * et laissait dehors toutes les écritures par méthode de modèle Prisma
 * (`tx.user.upsert(...)`, `.data_points.create(...)`), qui sont la forme
 * dominante du dépôt. Mesure corrigée : 21 tables sont écrites directement,
 * pas 4. Le provisionnement Clerk (users, 5 sites) était parmi les 17 cassées.
 *
 * Aucun contrôle ne pouvait le voir : le test de privilèges recopiait la même
 * liste au lieu de la contester. Ce fichier est la garde manquante. Il ne lit
 * AUCUNE liste à la main — il re-dérive la vérité depuis api/ et la compare.
 *
 * MÉTHODE (statique, aucune base requise, donc exécutable dans le job CI qui
 * n'a pas de service PostgreSQL) :
 *
 *   1. tables réellement créées   : CREATE TABLE / DROP TABLE des migrations
 *   2. écritures Prisma           : <récepteur>.<modèle>.<verbe d'écriture>(
 *                                   modèle -> table via @@map ou nom du modèle
 *   3. écritures SQL              : INSERT INTO | UPDATE | DELETE FROM <table>
 *   4. comparaison avec TABLES_ECRITURE_DIRECTE (source unique importée)
 *
 * DEPUIS LA MIGRATION 20261028130000, une table peut être accordée en écriture
 * COLONNE PAR COLONNE au lieu du niveau table : `tracefab_products`. Le rôle
 * runtime n'a plus INSERT/UPDATE/DELETE sur la table, seulement sur vingt
 * colonnes métier — les quatre colonnes calculées (version, data_completion,
 * data_readiness, data_ready_at) en sont exclues, sinon le GUC falsifiable de
 * `products_validate_brand_ownership` redeviendrait atteignable.
 *
 * Ce fichier distingue donc deux périmètres et vérifie, pour le périmètre
 * colonne, que la liste accordée n'inclut AUCUNE colonne calculée. Le contenu
 * réel des écritures est lui vérifié à l'exécution par
 * test:neon:produit-champs-calcules, sur une base réelle.
 *
 * Le sens qui compte est le premier : une table écrite mais non accordée donne
 * 42501 en production. L'autre sens (accordée sans écriture) est un excès de
 * privilège : signalé, et il fait aussi échouer, parce qu'un privilège
 * inutile est précisément ce que le durcissement veut supprimer.
 *
 * CONTRÔLE NÉGATIF : TABLES_ECRITURE_CONTROLE_NEGATIF=table_fantome injecte une
 * table écrite fictive ; le contrôle doit alors passer au rouge. Un contrôle qui
 * ne peut pas rougir ne prouve rien.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TABLES_ECRITURE_DIRECTE,
  TABLES_ECRITURE_COLONNES,
  COLONNES_ECRITURE_PRODUIT,
  COLONNES_CALCULEES_PRODUIT,
} from './lib/tracefab_app_role.mjs';

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERBES = ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'];

let assertions = 0;
let echecs = 0;
const verifier = (nom, cond, obs) => {
  assertions += 1;
  if (cond) console.log(`  ok    ${nom}`);
  else { echecs += 1; console.log(`  ECHEC ${nom} — observé : ${obs}`); }
};

function fichiers(dir, acc = []) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) fichiers(p, acc);
    else if (/\.ts$/.test(e)) acc.push(p);
  }
  return acc;
}

/* --- 1. Tables réellement créées par les migrations ----------------------- */

const dirMig = path.join(RACINE, 'prisma', 'migrations');
const tablesBase = new Set();
for (const d of fs.readdirSync(dirMig).sort()) {
  const f = path.join(dirMig, d, 'migration.sql');
  if (!fs.existsSync(f)) continue;
  const sql = fs.readFileSync(f, 'utf8');
  for (const m of sql.matchAll(/\bCREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi)) {
    tablesBase.add(m[1]);
  }
  for (const m of sql.matchAll(/\bDROP TABLE\s+(?:IF EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi)) {
    tablesBase.delete(m[1]);
  }
}
console.log(`\n  1. tables créées par les migrations : ${tablesBase.size}`);
verifier('les migrations décrivent un schéma non vide', tablesBase.size > 20, `${tablesBase.size} tables`);

/* --- 2. Modèle Prisma -> table -------------------------------------------- */

const schema = fs.readFileSync(path.join(RACINE, 'prisma', 'schema.prisma'), 'utf8');
const modeleVersTable = {};
for (const b of schema.split(/\n(?=model )/)) {
  const m = b.match(/^model\s+([A-Za-z0-9_]+)/);
  if (!m) continue;
  const map = b.match(/@@map\("([a-z0-9_]+)"\)/);
  const table = map ? map[1] : m[1];
  modeleVersTable[m[1]] = table;
  modeleVersTable[m[1].charAt(0).toLowerCase() + m[1].slice(1)] = table;
}

/* --- 3. Écritures directes relevées dans api/ ----------------------------- */

const ecrites = new Map(); // table -> [sites]
const noter = (t, site) => {
  if (!tablesBase.has(t)) return; // pas une table du schéma -> faux positif
  if (!ecrites.has(t)) ecrites.set(t, []);
  const l = ecrites.get(t);
  if (!l.includes(site)) l.push(site);
};

const fichiersApi = fichiers(path.join(RACINE, 'api'));
for (const f of fichiersApi) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(RACINE, f);
  const ligne = (i) => src.slice(0, i).split('\n').length;

  // 3a. méthodes d'écriture Prisma sur un modèle connu
  const rePrisma = new RegExp(`\\.([A-Za-z0-9_]+)\\.(${VERBES.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = rePrisma.exec(src))) {
    if (!(m[1] in modeleVersTable)) continue;
    noter(modeleVersTable[m[1]], `${rel}:${ligne(m.index)} (${m[1]}.${m[2]})`);
  }

  // 3b. ordres SQL d'écriture, quel que soit l'emballage
  const reSql = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([A-Za-z0-9_]+)"?/gi;
  let v;
  while ((v = reSql.exec(src))) {
    noter(v[2], `${rel}:${ligne(v.index)} (SQL ${v[1].replace(/\s+/g, ' ')})`);
  }
}

/* --- 4. Contrôle négatif optionnel ---------------------------------------- */

const controleNegatif = process.env.TABLES_ECRITURE_CONTROLE_NEGATIF;
if (controleNegatif) {
  tablesBase.add(controleNegatif);
  noter(controleNegatif, `injection de controle negatif (${controleNegatif})`);
  console.log(`\n  controle negatif actif : table fictive « ${controleNegatif} » ajoutée aux tables écrites`);
}

const tablesEcrites = [...ecrites.keys()].sort();
// Les deux périmètres d'écriture : niveau table, et colonne par colonne.
const declarees = [...new Set([...TABLES_ECRITURE_DIRECTE, ...TABLES_ECRITURE_COLONNES])].sort();

console.log(`\n  2. écritures directes relevées dans api/ : ${tablesEcrites.length} tables sur ${fichiersApi.length} fichiers`);
console.log(`     liste du provisioning               : ${declarees.length} tables`);

/* --- 5. Comparaison ------------------------------------------------------- */

console.log('\n  3. comparaison');

const ecritesNonAccordees = tablesEcrites.filter((t) => !declarees.includes(t));
verifier(
  'aucune table écrite par api/ n est privée d écriture pour le role applicatif',
  ecritesNonAccordees.length === 0,
  `${ecritesNonAccordees.length} table(s) écrite(s) non accordée(s) : ${ecritesNonAccordees.join(', ') || 'aucune'}`,
);
for (const t of ecritesNonAccordees) {
  console.log(`        -> ${t} : ${(ecrites.get(t) || []).slice(0, 3).join(' ; ')}`);
}

const accordeesSansEcriture = declarees.filter((t) => !tablesEcrites.includes(t));
verifier(
  'aucun privilege d ecriture directe n est accorde sans chemin applicatif',
  accordeesSansEcriture.length === 0,
  `${accordeesSansEcriture.length} table(s) accordée(s) jamais écrite(s) : ${accordeesSansEcriture.join(', ') || 'aucune'}`,
);

verifier(
  'les deux listes sont exactement identiques',
  JSON.stringify(tablesEcrites) === JSON.stringify(declarees),
  `écrites=${tablesEcrites.length} accordées=${declarees.length}`,
);

// Périmètre colonne : la liste accordée ne doit contenir aucune colonne calculée.
for (const table of TABLES_ECRITURE_COLONNES) {
  const fuites = COLONNES_CALCULEES_PRODUIT.filter((c) => COLONNES_ECRITURE_PRODUIT.includes(c));
  verifier(
    `les colonnes calculées de ${table} sont hors de la liste accordée`,
    fuites.length === 0,
    fuites.length ? `colonnes calculées accordées : ${fuites.join(', ')}` : '',
  );
  verifier(
    `${table} n est pas accordée AUSSI au niveau table`,
    !TABLES_ECRITURE_DIRECTE.includes(table),
    'présente dans TABLES_ECRITURE_DIRECTE : l octroi table rendrait le périmètre colonne inopérant',
  );
  verifier(
    `la liste de colonnes de ${table} est explicite et non vide`,
    COLONNES_ECRITURE_PRODUIT.length > 0 && COLONNES_ECRITURE_PRODUIT.length < 60,
    `${COLONNES_ECRITURE_PRODUIT.length} colonnes`,
  );
}

verifier(
  'la liste du provisioning reste explicite (pas d octroi global)',
  declarees.length > 0 && declarees.length < tablesBase.size,
  `${declarees.length} accordées sur ${tablesBase.size} tables`,
);

/* --- 6. Le contrôle peut-il rougir ? -------------------------------------- */

if (controleNegatif) {
  verifier(
    `le controle rougit bien sur une table écrite non accordée (${controleNegatif})`,
    echecs > 0,
    'aucun echec detecte : le controle est aveugle',
  );
}

console.log('\n  --------------------------------------------');
if (echecs > 0) {
  console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
  console.log('  Une table écrite par api/ sans privilege d ecriture pour tracefab_app');
  console.log('  donne 42501 en production. Corriger scripts/lib/tracefab_app_role.mjs');
  console.log('  puis ajouter une migration de GRANT — jamais l inverse.');
  process.exit(1);
}
console.log(`  ${assertions}/${assertions} assertions verifiees.`);
process.exit(0);
