#!/usr/bin/env node
/**
 * TRACEFAB — audit d'isolation multi-locataires (chantier 17).
 *
 * TRACEFAB est multi-tenant : une marque ne doit jamais lire les donnees d'une
 * autre. L'isolation repose sur une chaine de trois maillons, appliquee route
 * par route :
 *
 *     requireClerkUser  ->  withTracefabUserContext  ->  scope brand_organization_id
 *
 * Le danger n'est pas qu'un maillon casse, c'est qu'une route nouvelle soit
 * ajoutee sans la chaine. Cet audit rend ce cas impossible en silence : toute
 * route de api/index.ts doit etre classee ici explicitement. Une route inconnue
 * fait echouer la CI, ce qui force l'auteur a declarer son modele d'acces.
 *
 * Usage : node scripts/test_cross_tenant.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
/* Le classement des routes vit dans api/_lib/route-access-models.mjs : le
 * limiteur de debit le lit aussi. Deux copies finiraient par diverger, et
 * c'est exactement ce qui permettait au limiteur de classer une route
 * publique comme authentifiee. */
import { ACCESS_MODELS, CLASSIFIED } from '../api/_lib/route-access-models.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* --------------------------------------------------------- lecture du routeur */

const indexSrc = read('api/index.ts');
const routeRe = /\{\s*pattern:\s*\/\^(.+?)\$\/,[\s\S]*?load:\s*\(\)\s*=>\s*import\('\.\/_routes\/(.+?)\.js'\)/g;
const routes = [];
for (const m of indexSrc.matchAll(routeRe)) {
  const pattern = m[1].replace(/\\/g, '');
  const file = `api/_routes/${m[2]}.ts`;
  // Chemin lisible : on remplace les groupes de capture par le nom du parametre.
  const paramsM = indexSrc.slice(m.index, m.index + 400).match(/params:\s*\[([^\]]*)\]/);
  const params = paramsM ? (paramsM[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)) : [];
  let i = 0;
  const key = pattern.replace(/\(\[\^\/\]\+\)|\(\.\*\)|\([^)]*\)/g, () => `[${params[i++] || 'param'}]`);
  routes.push({ key, file, pattern });
}

/* Un parseur qui rate une route rate sa garde. On compare donc ce qu'on a lu
 * au nombre de chargements declares dans le routeur. */
const declaredLoads = (indexSrc.match(/load:\s*\(\)\s*=>\s*import\(/g) || []).length;
if (routes.length !== declaredLoads) {
  console.error(`Routeur mal lu : ${routes.length} routes analysees pour ${declaredLoads} declarees.`);
  process.exit(1);
}

/* ------------------------------------------------------------------- audit */

const failures = [];
const stats = { TENANT: 0, PUBLIC: 0, WORKER: 0, WEBHOOK: 0, REFERENCE: 0 };
const unknown = [];

for (const r of routes) {
  if (!existsSync(join(ROOT, r.file))) {
    failures.push(`${r.key} : fichier de route absent (${r.file})`);
    continue;
  }
  const src = read(r.file);
  const entry = CLASSIFIED[r.key];
  const model = entry ? entry[0] : 'TENANT';
  stats[model] += 1;

  const needs = ACCESS_MODELS[model].needs;
  if (needs.length) {
    const satisfied = needs.some((n) => src.includes(n));
    const all = model === 'TENANT' ? needs.every((n) => src.includes(n)) : satisfied;
    if (!all) {
      const missing = needs.filter((n) => !src.includes(n));
      failures.push(`${r.key} [${model}] : maillon d isolation absent -> ${missing.join(', ')}`);
    }
  }

  // L'isolation reelle est portee par RLS : withTracefabUserContext ouvre une
  // transaction et y arme tracefab.user_id, que les politiques Postgres lisent.
  // Le vrai danger est donc une requete emise HORS de ce contexte, avec le
  // client prisma brut : elle echappe aux politiques.
  if (model === 'TENANT') {
    const rawClient = /\bprisma\.[a-z_]+\.(findMany|findFirst|findUnique|create|update|delete|count|aggregate|groupBy)\(/.test(src);
    if (rawClient) {
      failures.push(`${r.key} [TENANT] : utilise le client prisma brut, hors contexte RLS`);
    }
    const queries = /\.(findMany|findFirst|findUnique|count|aggregate|groupBy)\(/.test(src);
    if (queries && !src.includes('withTracefabUserContext')) {
      failures.push(`${r.key} [TENANT] : interroge la base sans withTracefabUserContext, RLS non armee`);
    }
  }

  if (!entry && !/requireClerkUser/.test(src)) {
    unknown.push(`${r.key} (${r.file})`);
  }
}

/* Routes non classees ET non authentifiees : le cas dangereux. */
for (const u of unknown) {
  failures.push(`${u} : route ni classee ni authentifiee. Declarez son modele d acces dans CLASSIFIED.`);
}

/* ------------------------------------------------------- scenarios croises */

const scenarios = [
  ['Marque A lit les produits de la marque B',
    'tracefab_products', 'brand_organization_id'],
  ['Marque A lit les demandes de donnees de la marque B',
    'data_requests', 'brand_organization_id'],
  ['Marque A lit les relations fournisseurs de la marque B',
    'brand_supplier_relationships', 'brand_organization_id'],
  ['Marque A lit les evaluations PEF de la marque B',
    'product_pef_assessments', 'brand_organization_id'],
  ['Marque A lit les plans d action qualite de la marque B',
    'quality_corrective_action_plans', 'brand_organization_id'],
  ['Marque A lit les reconciliations de bilan massique de la marque B',
    'mass_balance_reconciliations', 'brand_organization_id'],
];

const schema = read('prisma/schema.prisma');
const rlsScenarios = scenarios.map(([title, table, col]) => {
  const m = schema.match(new RegExp(`model\\s+${table}\\s*\\{([\\s\\S]*?)\\n\\}`));
  const hasCol = m ? m[1].includes(col) : false;
  return { title, table, ok: hasCol, why: m ? (hasCol ? '' : `colonne ${col} absente`) : 'modele absent du schema' };
});
for (const s of rlsScenarios) {
  if (!s.ok) failures.push(`scenario croise "${s.title}" : ${s.why}`);
}

// Le verrou final est en base : RLS activee et forcee, declaree dans les
// migrations SQL et non dans schema.prisma.
import { readdirSync } from 'node:fs';
const migDir = join(ROOT, 'prisma/migrations');
let enable = 0; let force = 0; let migrations = 0;
if (existsSync(migDir)) {
  for (const d of readdirSync(migDir)) {
    const f = join(migDir, d, 'migration.sql');
    if (!existsSync(f)) continue;
    migrations += 1;
    const sql = readFileSync(f, 'utf8');
    enable += (sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length;
    force += (sql.match(/FORCE ROW LEVEL SECURITY/g) || []).length;
  }
}
if (enable === 0) failures.push('aucune instruction ENABLE ROW LEVEL SECURITY dans les migrations');

/* ------------------------------------------------------------------ verdict */

const line = '-'.repeat(78);
console.log(`\n=== TRACEFAB — AUDIT D'ISOLATION MULTI-LOCATAIRES ===\n${line}`);
console.log(`Routes inspectees        : ${routes.length}`);
console.log(`  dont locataire (chaine complete exigee) : ${stats.TENANT}`);
console.log(`  dont publiques assumees                 : ${stats.PUBLIC}`);
console.log(`  dont worker (secret partage)            : ${stats.WORKER}`);
console.log(`  dont webhook (signature)                : ${stats.WEBHOOK}`);
console.log(`  dont referentiel sans locataire         : ${stats.REFERENCE}`);
console.log(line);
for (const s of rlsScenarios) {
  console.log(`${s.ok ? 'OK  ' : 'ECHEC'} scenario croise : ${s.title}`);
}
console.log(line);
if (failures.length) {
  console.log(`${failures.length} probleme(s) d isolation :\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(line);
  process.exit(1);
}
console.log('Isolation multi-locataires : aucune route hors modele declare.');
// Ce script lit du code source : il verifie que chaque route DECLARE ses
// maillons d'isolation. C'est un audit statique, utile, et ce n'est pas une
// preuve d'etancheite. Les deux lignes qui suivent le disent sans detour,
// parce que la version precedente affichait « Verrou base de donnees : 46
// ENABLE / 50 FORCE » — un comptage de drapeaux de catalogue, presente comme
// un verrou, sur une base ou aucune politique n'etait jamais evaluee.
console.log(`Declarations dans les migrations : ${enable} ENABLE / ${force} FORCE sur ${migrations} migrations.`);
console.log('Ces drapeaux ne prouvent rien : BYPASSRLS, porte par le role, prime sur ENABLE comme sur FORCE.');
console.log('Preuve d etancheite par execution : npm run test:neon:rls (exige un role sans BYPASSRLS).');
console.log(line);
