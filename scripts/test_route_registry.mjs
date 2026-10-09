/* ==========================================================================
   Integrite de la table de routage de api/index.ts.

   Contexte : api/index.ts resout les requetes avec
       routes.find((c) => c.pattern.test(path))
   puis, si rien ne matche, repond 404 route_not_found. Il n'y a aucun
   catch-all et aucune resolution par systeme de fichiers.

   Consequence : un handler ecrit sous api/_routes/ mais absent de la table
   est du code mort, injoignable, et le defaut est totalement silencieux.
   C'est exactement ce qui est arrive a 10 routes, dont deux appelees par
   l'interface (la relance fournisseur et les partages fournisseur), qui
   repondaient 404 en production.

   Ce test verifie trois proprietes :
     1. tout fichier de route est enregistre
     2. toute route enregistree pointe vers un fichier existant
     3. aucun motif n'en masque un autre (ordre de la table)
   ========================================================================== */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROUTES_DIR = 'api/_routes';
const INDEX = 'api/index.ts';
const src = readFileSync(INDEX, 'utf8');
let failures = 0;
const fail = (msg) => { console.error('  ECHEC ' + msg); failures++; };

/* --- table de routage telle qu'elle est reellement evaluee -------------- */
const ROUTE_RE =
  /\{ pattern: (\/\^.*?\$\/), params: \[([^\]]*)\], load: \(\) => import\('\.\/_routes\/([^']+)\.js'\) \}/g;
const routes = [...src.matchAll(ROUTE_RE)].map((m, i) => ({
  order: i,
  pattern: eval(m[1]), // eslint-disable-line no-eval -- litteral issu du source
  params: m[2].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean),
  mod: m[3],
}));

if (routes.length === 0) fail('aucune route parsee — le format de api/index.ts a change');
console.log(`  ${routes.length} routes dans la table`);

/* --- 1. tout fichier de route est enregistre ---------------------------- */
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.ts')) files.push(relative(ROUTES_DIR, p).slice(0, -3));
  }
})(ROUTES_DIR);

const registered = new Set(routes.map((r) => r.mod));
const orphans = files.filter((f) => !registered.has(f));
if (orphans.length) {
  fail(`${orphans.length} fichier(s) de route non enregistre(s) dans ${INDEX} :`);
  orphans.forEach((o) => console.error(`          - ${ROUTES_DIR}/${o}.ts`));
} else {
  console.log(`  ${files.length} fichiers de route, tous enregistres`);
}

/* --- 2. toute route pointe vers un fichier existant --------------------- */
const dangling = routes.filter((r) => !existsSync(join(ROUTES_DIR, r.mod + '.ts')));
if (dangling.length) {
  fail(`${dangling.length} route(s) pointant vers un fichier inexistant :`);
  dangling.forEach((d) => console.error(`          - ${d.mod}`));
} else {
  console.log('  aucune route ne pointe vers un fichier manquant');
}

/* --- 3. aucun motif n'en masque un autre -------------------------------- */
/* Un motif place avant un autre le masque s'il capture aussi le chemin
   concret que le second est cense servir. On reconstruit pour chaque route
   un chemin representatif en remplacant les segments parametres. */
const sample = (r) => {
  let i = 0;
  return r.pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\(\[\^\\\/\]\+\)/g, () => `sample${i++}`)
    .replace(/\\([-/])/g, '$1');
};

let shadowed = 0;
for (const r of routes) {
  const path = sample(r);
  if (/[\\(\[*+?]/.test(path)) continue; // motif trop complexe pour un echantillon fiable
  const winner = routes.find((c) => c.pattern.test(path));
  if (winner && winner.mod !== r.mod) {
    fail(`"${path}" devrait atteindre ${r.mod} mais est capture par ${winner.mod} (declare plus haut)`);
    shadowed++;
  }
}
if (!shadowed) console.log('  aucun motif n\'en masque un autre');

/* --- resultat ----------------------------------------------------------- */
if (failures) {
  console.error(`\nIntegrite du routeur : ${failures} probleme(s).`);
  process.exit(1);
}
console.log('\nIntegrite du routeur : OK.');
