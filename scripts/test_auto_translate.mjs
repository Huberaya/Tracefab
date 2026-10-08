#!/usr/bin/env node
/**
 * auto-translate.js charge son glossaire au lieu de le dupliquer.
 *
 * Le fichier embarquait une copie de 810 lignes du glossaire, strictement
 * identique à public/translations_deep.json (101 entrées, 6 langues, vérifié
 * entrée par entrée). Seul le double inline était lu ; le JSON était servi par
 * Vercel sans qu'aucun code ne le charge.
 *
 * Ce test exécute le fichier réel dans jsdom et vérifie :
 *   A. la duplication a disparu du source ;
 *   B. le glossaire est réellement demandé à /translations_deep.json ;
 *   C. le texte du DOM est traduit, en anglais et en allemand ;
 *   D. un placeholder est traduit ;
 *   E. un échec de chargement ne traduit rien et n'est pas silencieux ;
 *   F. le fichier JSON est une source complète et cohérente ;
 *   G. la couverture réelle du glossaire par page est épinglée.
 *
 *   npm run test:i18n:auto-translate
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, requestInterceptor } from 'jsdom';

const root = new URL('../', import.meta.url);
let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const assert = (c, l, d) => (c ? ok(l) : bad(l, d));
const eq = (a, e, l) => assert(a === e, l, `attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);

const scriptSource = await readFile(new URL('public/auto-translate.js', root), 'utf8');
const glossary = JSON.parse(await readFile(new URL('public/translations_deep.json', root), 'utf8'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Monte une page qui charge /auto-translate.js depuis le disque.
 *
 * jsdom 30 n'a plus de ResourceLoader : les ressources externes passent par
 * `resources.interceptors`. Le `fetch` de la page n'est PAS couvert par cet
 * intercepteur — il faut l'installer soi-même, et avant tout `await`, parce que
 * le script l'appelle dans une microtâche.
 */
async function mount({ failFetch = false } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html lang="fr"><body>
       <nav><a>Produits</a><a>Fournisseurs</a><a>Traçabilité</a></nav>
       <h1>Produits</h1>
       <input placeholder="Fournisseurs" />
       <pre>Produits</pre>
       <script src="/auto-translate.js"></script>
     </body></html>`,
    {
      runScripts: 'dangerously',
      url: 'https://tracefab.test/',
      resources: {
        interceptors: [
          requestInterceptor((req) => {
            const path = new URL(req.url).pathname;
            if (path === '/auto-translate.js') {
              return new Response(scriptSource, { headers: { 'Content-Type': 'text/javascript' } });
            }
            return undefined;
          }),
        ],
      },
    },
  );

  const errors = [];
  dom.window.console.error = (...args) => errors.push(args.map(String).join(' '));

  const fetches = [];
  dom.window.fetch = (url) => {
    fetches.push(String(url));
    if (failFetch) return Promise.resolve(new Response('', { status: 500 }));
    if (String(url) === '/translations_deep.json') {
      return Promise.resolve(
        new Response(JSON.stringify(glossary), { headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };

  for (let i = 0; i < 60 && typeof dom.window.setTracefabGlobalLanguage !== 'function'; i += 1) await wait(10);
  return { dom, window: dom.window, errors, fetches };
}

// ---------------------------------------------------------------------------
console.log('\nA. La duplication a disparu du source');
// ---------------------------------------------------------------------------

assert(!/const GLOSSARY\s*=\s*\{/.test(scriptSource), 'plus aucun glossaire inline `const GLOSSARY = {`');
assert(scriptSource.includes("fetch('/translations_deep.json')"), 'le glossaire est demandé à /translations_deep.json');
assert(scriptSource.includes('console.error'), 'un échec de chargement est journalisé, pas avalé');
assert(
  scriptSource.split('\n').length < 200,
  `le fichier fait ${scriptSource.split('\n').length} lignes (889 avant)`,
);

// ---------------------------------------------------------------------------
console.log('\nB. Le glossaire est réellement chargé');
// ---------------------------------------------------------------------------

const page = await mount();
eq(
  typeof page.window.setTracefabGlobalLanguage,
  'function',
  'window.setTracefabGlobalLanguage est exposé',
);
await page.window.setTracefabGlobalLanguage('en');
assert(
  page.fetches.includes('/translations_deep.json'),
  `le script a bien demandé /translations_deep.json (${page.fetches.join(', ')})`,
);

// ---------------------------------------------------------------------------
console.log('\nC. Le texte du DOM est traduit');
// ---------------------------------------------------------------------------

const bodyText = page.window.document.body.textContent;
assert(bodyText.includes('Products'), '« Produits » → « Products »');
assert(bodyText.includes('Suppliers'), '« Fournisseurs » → « Suppliers »');
assert(bodyText.includes('Traceability'), '« Traçabilité » → « Traceability »');
assert(!bodyText.includes('Fournisseurs'), 'plus aucun « Fournisseurs » dans le corps');

const heading = page.window.document.querySelector('h1').textContent.trim();
eq(heading, 'Products', 'le titre est traduit');

/* `<pre>` est exclu par le filtre : il doit rester en français. */
eq(
  page.window.document.querySelector('pre').textContent.trim(),
  'Produits',
  'le contenu de <pre> n\'est pas traduit (exclusion respectée)',
);

await page.window.setTracefabGlobalLanguage('de');
const deText = page.window.document.body.textContent;
assert(deText.includes('Produkte'), 'bascule en allemand : « Produkte »');
assert(deText.includes('Lieferanten'), 'bascule en allemand : « Lieferanten »');
assert(!deText.includes('Products'), 'l\'anglais a bien été remplacé');
eq(page.window.localStorage.getItem('tracefab_lang'), 'de', 'tracefab_lang est tenu à jour');
eq(page.window.document.documentElement.lang, 'de', 'document.documentElement.lang est tenu à jour');

eq(
  page.window.document.querySelector('input').getAttribute('placeholder'),
  glossary['Fournisseurs'].de,
  `placeholder traduit (${glossary['Fournisseurs'].de})`,
);
await page.window.setTracefabGlobalLanguage('fr');
assert(
  page.window.document.body.textContent.includes('Fournisseurs'),
  'retour au français : le texte d\'origine est restauré',
);
eq(
  page.window.document.querySelector('input').getAttribute('placeholder'),
  'Fournisseurs',
  'retour au français : le placeholder d\'origine est restauré',
);

// ---------------------------------------------------------------------------
console.log('\nD2. Un contenu posé par la page n\'est pas écrasé');
// ---------------------------------------------------------------------------

const h1 = page.window.document.querySelector('h1');
await page.window.setTracefabGlobalLanguage('en');
h1.textContent = 'AW26-0248';           // la page remplace le contenu
await page.window.setTracefabGlobalLanguage('de');
eq(h1.textContent.trim(), 'AW26-0248', 'le glossaire réapprend au lieu d\'écraser la valeur posée');

// ---------------------------------------------------------------------------
console.log('\nD3. Les placeholders sont traduits');
// ---------------------------------------------------------------------------

eq(
  page.window.document.querySelector('input').getAttribute('placeholder'),
  glossary['Fournisseurs'].de,
  `placeholder traduit (${glossary['Fournisseurs'].de})`,
);

// ---------------------------------------------------------------------------
console.log('\nE. Un échec de chargement ne traduit rien, et se voit');
// ---------------------------------------------------------------------------

const broken = await mount({ failFetch: true });
await broken.window.setTracefabGlobalLanguage('en');
assert(
  broken.window.document.body.textContent.includes('Produits'),
  'la page reste en français quand le glossaire ne répond pas',
);
assert(
  broken.errors.some((e) => e.includes('translations_deep.json')),
  `l'échec est journalisé (${broken.errors.length} message(s))`,
);

// ---------------------------------------------------------------------------
console.log('\nF. Le fichier JSON est une source complète');
// ---------------------------------------------------------------------------

const LANGS = ['de', 'en', 'es', 'it', 'nl', 'pt'];
const keys = Object.keys(glossary);
eq(keys.length, 101, '101 entrées dans /translations_deep.json');
const incomplete = keys.filter((k) => LANGS.some((l) => typeof glossary[k]?.[l] !== 'string' || !glossary[k][l].trim()));
eq(incomplete.length, 0, 'chaque entrée porte les 6 langues, non vides', incomplete.slice(0, 3).join(', '));
const selfRef = keys.filter((k) => LANGS.every((l) => glossary[k][l] === k));
eq(selfRef.length, 0, 'aucune entrée ne se traduit par elle-même dans les 6 langues');

// ---------------------------------------------------------------------------
console.log('\nG. Couverture réelle du glossaire, par page');
// ---------------------------------------------------------------------------

const pages = [
  'brand-console/index.html',
  'operations/index.html',
  'quality-center/index.html',
  'supplier-portal/index.html',
];
const coverage = {};
for (const p of pages) {
  const html = await readFile(new URL(p, root), 'utf8');
  coverage[p] = keys.filter((k) => html.includes(k)).length;
}

/*
 * Mesure, pas objectif : ces chiffres épinglent l'état constaté. `operations` ne
 * tire presque rien du glossaire — c'est un fait enregistré, pas un seuil fixé.
 * Si la couverture recule, quelque chose a changé dans ces pages.
 */
const EXPECTED = { 'brand-console/index.html': 55, 'operations/index.html': 1, 'quality-center/index.html': 7, 'supplier-portal/index.html': 33 };
for (const [p, n] of Object.entries(EXPECTED)) {
  eq(coverage[p], n, `${p} : ${n} clés du glossaire présentes`);
}
/* Clés absentes des quatre pages : elles ne peuvent rien traduire aujourd'hui.
   Conservées au fichier (du texte peut apparaître plus tard), mais comptées. */
const htmlCache = Object.fromEntries(await Promise.all(pages.map(async (p) => [p, await readFile(new URL(p, root), 'utf8')])));
const dead = keys.filter((k) => !pages.some((p) => htmlCache[p].includes(k)));
eq(dead.length, 37, '37 clés ne correspondent à aucun texte des 4 pages');

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
