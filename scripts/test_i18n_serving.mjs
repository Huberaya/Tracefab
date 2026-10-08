#!/usr/bin/env node
/**
 * Les dictionnaires i18n sont réellement servis en production.
 *
 * `public/i18n-core.js` charge `/locales/{lang}/{scope}.json` au runtime. Or
 * `vercel.json` déclare un tableau `builds` : quand il est présent, seuls les
 * fichiers émis par un build existent dans la sortie. `locales/` est à la racine
 * du dépôt et ne correspondait à aucun des quatre motifs déclarés
 * (`api/index.ts`, `**\/*.html`, `public/**\/*`, `assets/**\/*`) — les requêtes
 * tombaient donc en 404 et le runtime se repliait silencieusement sur sa langue
 * par défaut, sur les trois surfaces qui l'incluent.
 *
 * Ce test vérifie la chaîne complète plutôt que la seule présence d'une ligne :
 *   A. chaque fichier de locales/ est émis par un build ;
 *   B. chaque URL que le runtime construit correspond à un fichier qui existe ;
 *   C. aucune route ne fait ombre à ces URL avant le gestionnaire de fichiers ;
 *   D. le runtime lui-même est servi, et les surfaces qui l'incluent sont joignables ;
 *   E. la CSP autorise le fetch.
 *
 *   npm run test:i18n:serving
 */
import { readFile, readdir, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = (p) => new URL(p, root);

let checks = 0;
let failures = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => { failures += 1; checks += 1; console.error(`  FAIL  ${label}\n        ${detail ?? 'assertion failed'}`); };
const assert = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));
const eq = (actual, expected, label) =>
  assert(actual === expected, label, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);

const config = JSON.parse(await readFile(at('vercel.json'), 'utf8'));
const runtime = await readFile(at('public/i18n-core.js'), 'utf8');

/**
 * Convertit un glob Vercel en expression rationnelle ancrée.
 * Un double-astérisque suivi d'une barre doit pouvoir matcher ZÉRO segment :
 * le motif de `public` couvre `public/i18n-core.js`, ce qu'une conversion
 * naïve ratait.
 */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:[^/]+/)*');
  return new RegExp(`^${body}$`);
}

/**
 * Les `src` de routes Vercel sont des motifs de chemin complets, pas des
 * sous-chaînes : sans ancrage, `src: "/"` capturait n'importe quelle URL.
 */
const routeRegExp = (src) => new RegExp(`^(?:${src})$`);

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(at(dir))) {
    const rel = `${dir}/${entry}`;
    if ((await stat(at(rel))).isDirectory()) out.push(...(await listFiles(rel)));
    else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log('\nA. Chaque dictionnaire est émis par un build');
// ---------------------------------------------------------------------------

const localeFiles = (await listFiles('locales')).sort();
eq(localeFiles.length, 14, '14 dictionnaires présents (7 langues x app + translation)');

const buildPatterns = config.builds.map((b) => ({ src: b.src, re: globToRegExp(b.src) }));
const emittedBy = (file) => buildPatterns.filter((p) => p.re.test(file)).map((p) => p.src);

const orphan = localeFiles.filter((f) => emittedBy(f).length === 0);
eq(orphan.length, 0, 'aucun dictionnaire n’échappe aux builds déclarés', orphan.join(', '));

/* Le motif ajouté doit être celui qui les porte, et lui seul. */
const carrier = emittedBy(localeFiles[0]);
eq(carrier.length, 1, `un seul build émet ${localeFiles[0]}`, carrier.join(' + '));
eq(carrier[0], 'locales/**/*', 'et c’est le motif locales/**/*');

/* Contre-exemple : les motifs préexistants ne couvraient rien. */
for (const legacy of ['api/index.ts', '**/*.html', 'public/**/*', 'assets/**/*']) {
  eq(
    localeFiles.filter((f) => globToRegExp(legacy).test(f)).length,
    0,
    `l’ancien motif ${legacy} ne couvrait aucun dictionnaire`,
  );
}

/* @vercel/static conserve le préfixe du motif : /locales/... est donc l’URL réelle. */
const staticBuild = config.builds.find((b) => b.src === 'locales/**/*');
eq(staticBuild?.use, '@vercel/static', 'le build utilise @vercel/static');
assert(
  config.builds.find((b) => b.src === 'public/**/*')?.use === '@vercel/static' &&
    config.routes.some((r) => r.dest === '/public/i18n-core.js'),
  'précédent vérifié : public/**/* conserve son préfixe, donc locales/**/* conservera le sien',
);

// ---------------------------------------------------------------------------
console.log('\nB. Chaque URL construite par le runtime correspond à un fichier réel');
// ---------------------------------------------------------------------------

/* L’URL est lue dans le runtime lui-même, pas recopiée à la main. */
const urlLine = runtime.split('\n').find((l) => l.includes("'/locales/'"));
assert(!!urlLine, 'la ligne de construction d’URL est retrouvée dans i18n-core.js', urlLine);
assert(
  /\/locales\/' \+ lang \+ '\/' \+ scope \+ '\.json'/.test(urlLine),
  'le runtime charge /locales/{lang}/{scope}.json',
  urlLine.trim().slice(0, 120),
);
assert(
  /\/locales\/' \+ lang \+ '\/translation\.json'/.test(urlLine),
  'avec repli sur /locales/{lang}/translation.json',
);

const langs = (await readdir(at('locales'))).sort();
eq(langs.length, 7, 'sept langues', langs.join(', '));

/* Le scope réellement demandé par chaque surface qui inclut le runtime. */
const surfaces = ['evidence/index.html', 'dpp/index.html', 'traceability/index.html'];
const requested = [];
for (const surface of surfaces) {
  const html = await readFile(at(surface), 'utf8');
  assert(html.includes('/i18n-core.js'), `${surface} inclut le runtime i18n`);
  const scope = /TracefabI18n\.init\(\{\s*scope:\s*'([a-z-]+)'/.exec(html)?.[1];
  assert(!!scope, `${surface} déclare un scope`, 'aucun init({scope}) trouvé');
  requested.push({ surface, scope });
}

for (const { surface, scope } of requested) {
  for (const lang of langs) {
    for (const file of [`${scope}.json`, 'translation.json']) {
      const path = `locales/${lang}/${file}`;
      let exists = true;
      try { await stat(at(path)); } catch { exists = false; }
      if (!exists) bad(`${surface} → /${path} existe`, 'fichier absent');
    }
  }
}
ok(`toutes les URL demandées par les ${requested.length} surfaces x ${langs.length} langues existent`);
checks += 0;

// ---------------------------------------------------------------------------
console.log('\nC. Aucune route ne fait ombre à ces URL');
// ---------------------------------------------------------------------------

const sample = `/locales/${langs[0]}/app.json`;
const shadowing = config.routes
  .filter((r) => r.src)
  .filter((r) => routeRegExp(r.src).test(sample))
  .map((r) => `${r.src} -> ${r.dest}`);
eq(shadowing.length, 0, `aucune route ne capture ${sample}`, shadowing.join(' | '));

const fsHandleIndex = config.routes.findIndex((r) => r.handle === 'filesystem');
assert(fsHandleIndex === config.routes.length - 1, 'le gestionnaire de fichiers est bien présent en fin de table');
assert(
  config.routes.slice(0, fsHandleIndex).every((r) => !routeRegExp(r.src).test(sample)),
  'et aucune route antérieure ne détourne la requête',
);

// ---------------------------------------------------------------------------
console.log('\nD. Le runtime et ses surfaces sont joignables');
// ---------------------------------------------------------------------------

assert(
  emittedBy('public/i18n-core.js').length > 0,
  'i18n-core.js est émis par un build',
);
assert(
  config.routes.some((r) => r.src === '/i18n-core.js' && r.dest === '/public/i18n-core.js'),
  'et mappé sur /i18n-core.js',
);
for (const surface of surfaces) {
  const dir = surface.split('/')[0];
  assert(
    config.routes.some((r) => r.dest === `/${dir}/index.html`),
    `la surface /${dir} a une route`,
  );
}
/* Le JSON doit être valide et non vide, sinon le runtime se replie en silence. */
for (const lang of langs) {
  const parsed = JSON.parse(await readFile(at(`locales/${lang}/app.json`), 'utf8'));
  if (Object.keys(parsed).length === 0) bad(`locales/${lang}/app.json n’est pas vide`);
}
ok('les sept app.json sont des JSON valides et non vides');

// ---------------------------------------------------------------------------
console.log('\nE. La CSP autorise le chargement');
// ---------------------------------------------------------------------------

const csp = config.headers
  .flatMap((h) => h.headers)
  .find((h) => h.key === 'Content-Security-Policy')?.value;
assert(!!csp, 'une Content-Security-Policy est déclarée');
assert(/connect-src[^;]*'self'/.test(csp), 'connect-src autorise la même origine (fetch des dictionnaires)');
assert(/default-src[^;]*'self'/.test(csp), 'default-src autorise la même origine');

// ---------------------------------------------------------------------------
console.log('\nF. Rien n’exclut locales/ du déploiement');
// ---------------------------------------------------------------------------

/* Un .vercelignore ou un champ "files" rendrait le build inopérant. */
let vercelignore = null;
try { vercelignore = await readFile(at('.vercelignore'), 'utf8'); } catch { vercelignore = null; }
assert(vercelignore === null, 'aucun .vercelignore ne filtre les fichiers déployés');

const pkg = JSON.parse(await readFile(at('package.json'), 'utf8'));
assert(pkg.files === undefined, 'aucun champ "files" ne restreint le contenu publié');

const gitignore = await readFile(at('.gitignore'), 'utf8');
assert(
  !gitignore.split('\n').some((l) => l.trim() === 'locales' || l.trim() === 'locales/'),
  '.gitignore n’exclut pas locales/ (les 14 dictionnaires sont donc versionnés)',
);

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
