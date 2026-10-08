#!/usr/bin/env node
/**
 * La configuration de déploiement décrit une application qui existe vraiment.
 *
 * `vercel.json` est le seul fichier qui décide de ce qui est servi en production.
 * Une référence cassée y est invisible au typecheck comme aux tests d'interface :
 * le dépôt compile, la page s'affiche en local, et la route 404 une fois déployée.
 *
 * Vérifié ici :
 *   A. le builder est épinglé — `@vercel/node` sans version résout `latest` à
 *      chaque build, donc un major peut arriver sans qu'aucun commit ne change ;
 *   B. chaque `dest` de route pointe vers un fichier qui existe ;
 *   C. chaque fichier de public/ est joignable par une route ;
 *   D. le chemin du cron correspond à une route réellement déclarée ;
 *   E. chaque surface HTML a sa route, et chaque route a sa surface ;
 *   F. `engines.node` est déclaré, cohérent avec @types/node.
 *
 *   npm run test:deploy:config
 */
import { readFile, readdir, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = (p) => new URL(p, root);

let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const assert = (c, l, d) => (c ? ok(l) : bad(l, d));
const eq = (a, e, l) => assert(a === e, l, `attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);

const config = JSON.parse(await readFile(at('vercel.json'), 'utf8'));
const pkg = JSON.parse(await readFile(at('package.json'), 'utf8'));
const router = await readFile(at('api/index.ts'), 'utf8');
const exists = async (rel) => { try { await stat(at(rel)); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
console.log('\nA. Le builder est épinglé');
// ---------------------------------------------------------------------------

const nodeBuild = config.builds.find((b) => b.use.startsWith('@vercel/node'));
assert(!!nodeBuild, 'un build utilise @vercel/node');
assert(
  /^@vercel\/node@\d+\.\d+\.\d+$/.test(nodeBuild.use),
  `la version est figée (${nodeBuild.use})`,
  'sans @version, Vercel résout `latest` à chaque build : un major peut arriver sans aucun commit',
);
for (const build of config.builds) {
  if (build.use === '@vercel/static') continue;
  assert(
    /@\d+\.\d+\.\d+$/.test(build.use),
    `tout builder non statique est épinglé (${build.use})`,
  );
}
/* Le fichier que le build déclare doit exister. */
assert(await exists(nodeBuild.src), `le point d'entrée ${nodeBuild.src} existe`);

// ---------------------------------------------------------------------------
console.log('\nB. Chaque destination de route existe');
// ---------------------------------------------------------------------------

const fileDests = config.routes
  .filter((r) => r.dest)
  .map((r) => ({ src: r.src, file: r.dest.split('?')[0].replace(/^\//, '') }))
  .filter((r) => !r.file.includes('$'));

for (const { src, file } of fileDests) {
  assert(await exists(file), `${src} → ${file} existe`);
}
const parametrized = config.routes.filter((r) => r.dest && r.dest.includes('$1'));
ok(`${parametrized.length} route(s) paramétrée(s) vérifiée(s) par construction`);

// ---------------------------------------------------------------------------
console.log('\nC. Chaque fichier de public/ est joignable');
// ---------------------------------------------------------------------------

const publicFiles = await readdir(at("public"));
const routedDestinations = new Set(config.routes.filter((r) => r.dest).map((r) => r.dest.split('?')[0]));
const orphanPublic = publicFiles.filter((f) => !routedDestinations.has(`/public/${f}`));
eq(
  orphanPublic.length,
  0,
  `les ${publicFiles.length} fichiers de public/ ont chacun une route`,
  orphanPublic.join(', '),
);

// ---------------------------------------------------------------------------
console.log('\nD. Le cron pointe vers une route déclarée');
// ---------------------------------------------------------------------------

/** `/api/a/b-c` → le motif tel qu'il est écrit dans api/index.ts. */
const toRouterPattern = (path) =>
  path.replace(/^\/api\//, '').replace(/-/g, '\\-').replace(/\//g, '\\/');

for (const cron of config.crons || []) {
  const pattern = toRouterPattern(cron.path);
  assert(
    router.includes(pattern),
    `le cron ${cron.path} correspond à une route déclarée`,
    `motif recherché : ${pattern}`,
  );
  assert(/^\S+ \S+ \S+ \S+ \S+$/.test(cron.schedule), `schedule cron valide (${cron.schedule})`);
  const handler = router
    .split('\n')
    .find((l) => l.includes(pattern) && l.includes('import('));
  const target = /import\('\.\/([^']+)'\)/.exec(handler || '')?.[1];
  assert(!!target, `le gestionnaire du cron est identifié`);
  assert(
    await exists(`api/${target.replace(/\.js$/, '.ts')}`),
    `le fichier du gestionnaire existe (api/${target.replace(/\.js$/, '.ts')})`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nE. Surfaces et routes se correspondent');
// ---------------------------------------------------------------------------


/* Le répertoire d'une surface est tout le chemin avant /index.html — pas
   seulement son premier segment : la route /invitations/accept en est un à
   deux niveaux, et la route racine n'a aucun répertoire. */
const routedSurfaces = new Set(
  config.routes
    .filter((r) => r.dest && r.dest.endsWith('/index.html'))
    .map((r) => {
      const path = r.dest.split('?')[0].replace(/^\//, '');
      /* `/index.html` est la racine : son « répertoire » est vide. */
      return path === 'index.html' ? '' : path.replace(/\/index\.html$/, '');
    }),
);

/* Toute route vers X/index.html doit avoir son répertoire. */
for (const surface of routedSurfaces) {
  /* La route racine a un répertoire vide : son index.html est à la racine. */
  const file = surface ? `${surface}/index.html` : 'index.html';
  assert(await exists(file), `la route /${surface || '(racine)'} a son ${file}`);
}

/* Réciproque : un répertoire portant un index.html doit être joignable,
   sinon il est déployé mais inaccessible. */
const htmlDirs = [];
for (const entry of await readdir(at('.'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (['api', 'public', 'assets', 'docs', 'locales', 'node_modules', 'scripts', 'prisma', 'supabase', 'catalog', '.git'].includes(entry.name)) continue;
  if (await exists(`${entry.name}/index.html`)) htmlDirs.push(entry.name);
}
const unreachable = htmlDirs.filter((d) => !routedSurfaces.has(d) && d !== '');
eq(
  unreachable.length,
  0,
  `les ${htmlDirs.length} surfaces ayant un index.html sont toutes joignables`,
  unreachable.join(', '),
);

// ---------------------------------------------------------------------------
console.log('\nF. Le runtime est déclaré et cohérent');
// ---------------------------------------------------------------------------

assert(!!pkg.engines?.node, `engines.node est déclaré (${pkg.engines?.node})`);
const engineMajor = /(\d+)/.exec(pkg.engines.node)?.[1];
const typesMajor = /(\d+)/.exec(pkg.devDependencies?.['@types/node'] || '')?.[1];
eq(engineMajor, typesMajor, 'engines.node et @types/node portent le même majeur');

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
