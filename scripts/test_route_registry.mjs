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

/* --- 4. chaque gestionnaire ecrit sa reponse ---------------------------- */
/* Contexte : le blocage Production du 2026-10-17. La branche GET de
   /api/schema-bindings terminait par `return bindings.map(...)` — un tableau
   nu. Le routeur central (api/index.ts) IGNORE la valeur de retour des
   gestionnaires : rien n'etait jamais ecrit sur res, la fonction serverless
   se terminait sans repondre, et la passerelle renvoyait 504 Gateway Timeout
   sur CHAQUE appel. La fiche produit etait donc invisible pour tout locataire
   reel, alors que la requete SQL et les politiques RLS, elles, fonctionnaient.

   Ce garde empeche la recurrence de toute la CLASSE du defaut. Un `return`
   situe dans le corps du gestionnaire HORS delegation de contexte
   (withTracefab*Context) doit soit ecrire la reponse — json(...),
   res.*, methodNotAllowed(...) — soit rendre explicitement la main apres
   avoir deja repondu (return undefined), soit deleguer en passant `res`.

   Les `return` INTERNES aux callbacks de withTracefab*Context restent
   autorises : ces callbacks construisent des valeurs, et c'est le json(res…)
   qu'ils contiennent qui ecrit la reponse. On verifie d'ailleurs que ce
   json(res existe bien dans le gestionnaire pour chaque delegation. */
{
  const RESPONDS = /^(?:return\s)?(?:await\s)?(?:json|methodNotAllowed)\(\s*res\b|^return\s+res\.|^return\s+undefined\b/;
  const DELEGATION = /^return\s+(?:await\s)?withTracefab\w*Context\(/;
  const PASSES_RES = /\(\s*[^()]*\bres\b[^()]*\)\s*;?\s*$/;
  let bare = 0;
  for (const mod of files) {
    const source = readFileSync(join(ROUTES_DIR, mod + '.ts'), 'utf8');

    // Corps du gestionnaire exporte uniquement (les helpers du fichier ne
    // sont pas concernes).
    const handlerStart = source.search(/export default (?:async )?function handler/);
    if (handlerStart < 0) { fail(`${mod}.ts — pas de gestionnaire exporte`); bare++; continue; }
    const openBrace = source.indexOf('{', handlerStart);
    let depth = 0;
    let handlerEnd = source.length;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) { handlerEnd = i; break; } }
    }
    const handler = source.slice(openBrace, handlerEnd);

    // Regions de delegation : tout ce qui vit entre withTracefab*Context(
    // et sa parenthese fermante est un callback — ses return construisent
    // des valeurs, ils n'ecrivent pas la reponse.
    const delegationSpans = [];
    const contextCall = /withTracefab\w*Context\(/g;
    let call;
    while ((call = contextCall.exec(handler))) {
      let parens = 0;
      for (let i = call.index; i < handler.length; i++) {
        if (handler[i] === '(') parens++;
        else if (handler[i] === ')') {
          parens--;
          if (parens === 0) { delegationSpans.push([call.index, i]); break; }
        }
      }
    }
    const inDelegation = (index) => delegationSpans.some(([a, b]) => index >= a && index <= b);

    const hasResponseWrite = /\b(?:json|methodNotAllowed)\(\s*res\b|res\.status\(/.test(handler);

    const lines = handler.split('\n');
    let offset = 0;
    for (const line of lines) {
      const lineStart = offset;
      offset += line.length + 1;
      const trimmed = line.trim();
      if (!trimmed.startsWith('return ')) continue;
      if (inDelegation(lineStart)) continue;
      if (RESPONDS.test(trimmed)) continue;
      if (DELEGATION.test(trimmed)) {
        // Delegation legitime seulement si le gestionnaire ecrit bien une
        // reponse quelque part (le callback doit contenir son json(res…).
        if (!hasResponseWrite) {
          fail(`${mod}.ts — delegation withTracefab*Context sans aucune ecriture json(res…) dans le gestionnaire`);
          bare++;
        }
        continue;
      }
      if (PASSES_RES.test(trimmed)) continue; // ex. return proxyClerkFrontendApi(req, res);
      fail(`${mod}.ts — « ${trimmed.slice(0, 70)} » au niveau du gestionnaire sans ecriture de reponse (classe du defaut 504 schema-bindings)`);
      bare++;
    }
  }
  if (!bare) console.log('  chaque gestionnaire ecrit sa reponse (aucun return nu au niveau handler)');
}

/* --- resultat ----------------------------------------------------------- */
if (failures) {
  console.error(`\nIntegrite du routeur : ${failures} probleme(s).`);
  process.exit(1);
}
console.log('\nIntegrite du routeur : OK.');
