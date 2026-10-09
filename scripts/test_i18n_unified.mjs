#!/usr/bin/env node
/**
 * Chantier 31 — Les deux consoles traduisent depuis locales/, plus depuis leur code.
 *
 * Avant : `brand-console` portait un objet `brandTranslations` (25 clés x 7 langues)
 * et `supplier-portal` un objet `translations` (25 clés x 9 langues), tous deux en
 * dur dans le HTML. Ajouter une langue demandait d'éditer du JavaScript, et le
 * contenu métier vivait dans un composant.
 *
 * Deux sélecteurs de langue étaient morts au passage, pour la même raison que
 * `openBomModal` au Chantier 28 : les deux pages sont des IIFE, et
 * `onchange="setBrandLang(this.value)"` comme le `<select id="lang-switch">` non
 * branché appelaient des fonctions inaccessibles depuis un attribut inline.
 *
 * Ce test ne se contente pas de vérifier que le dictionnaire a disparu : il charge
 * chaque console dans jsdom avec un `fetch` qui sert les VRAIS fichiers
 * locales/*.json, puis vérifie le texte réellement rendu et le changement de
 * langue.
 *
 *   npm run test:i18n:unified
 */
import { readFile } from 'node:fs/promises';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const at = (p) => new URL(p, root);

let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const assert = (c, l, d) => (c ? ok(l) : bad(l, d));
const eq = (a, e, l) => assert(a === e, l, `attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);

const consoleHtml = await readFile(at('brand-console/index.html'), 'utf8');
const portalHtml = await readFile(at('supplier-portal/index.html'), 'utf8');
const runtimeSrc = await readFile(at('public/i18n-core.js'), 'utf8');

/**
 * jsdom 30 n'a plus de ResourceLoader : les ressources passent par un
 * intercepteur. Il sert ici /i18n-core.js, /auto-translate.js ET les
 * /locales/*.json que le runtime va chercher — la page s'exécute donc comme en
 * production, avec son vrai fetch, sans réseau.
 */
const serveLocally = requestInterceptor((request) => {
  const rel = new URL(request.url).pathname.replace(/^\/+/, '');
  for (const candidate of [rel, `public/${rel}`]) {
    const full = fileURLToPath(at(candidate));
    if (existsSync(full)) {
      const body = readFileSync(full, 'utf8');
      const type = candidate.endsWith('.json') ? 'application/json' : 'application/javascript';
      return new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8` } });
    }
  }
  return new Response('', { status: 404 });
});

async function mount(html, lang) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: `https://tracefab.vercel.app/${lang ? `?lang=${lang}` : ''}`,
    virtualConsole: vc,
    resources: { interceptors: [serveLocally] },
  });
  /*
   * Une fenêtre jsdom n'expose pas `fetch`. Le runtime appelle fetch dans une
   * microtâche, donc l'installer juste après la construction — avant tout await —
   * arrive à temps. L'intercepteur ci-dessus ne couvre que le chargement des
   * <script src>, pas les fetch de la page.
   */
  dom.window.fetch = async (url) => {
    const rel = String(url).replace(/^\/+/, '');
    for (const candidate of [rel, `public/${rel}`]) {
      try {
        return { ok: true, status: 200, json: async () => JSON.parse(await readFile(at(candidate), 'utf8')) };
      } catch { /* essaie le candidat suivant */ }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  if (lang) dom.window.localStorage.setItem('tracefab_lang', lang);
  /*
   * boot() est suspendu à init(). Attendre `isReady` et non une longueur de
   * texte : sinon on asserte sur un rendu produit avant l'arrivée du
   * dictionnaire, c'est-à-dire sur des clés brutes.
   */
  for (let i = 0; i < 150; i += 1) {
    if (dom.window.TracefabI18n?.isReady && (dom.window.document.getElementById('app')?.textContent || '').length > 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 60));
  return { dom, window: dom.window, document: dom.window.document, errors };
}

// ---------------------------------------------------------------------------
console.log('\nA. Le contenu métier n’est plus codé dans les composants');
// ---------------------------------------------------------------------------

eq((consoleHtml.match(/const brandTranslations\s*=/g) || []).length, 0, 'brand-console n’a plus de dictionnaire inline');
eq((portalHtml.match(/const translations\s*=\s*\{/g) || []).length, 0, 'supplier-portal non plus');
for (const [name, html] of [['brand-console', consoleHtml], ['supplier-portal', portalHtml]]) {
  assert(html.includes('/i18n-core.js'), `${name} charge le runtime partagé`);
}
assert(/init\(\{\s*scope:\s*'console'/.test(consoleHtml), 'brand-console initialise le scope « console »');
assert(/init\(\{\s*scope:\s*'supplier'/.test(portalHtml), 'supplier-portal initialise le scope « supplier »');

/* Le rendu doit attendre le dictionnaire, sinon bt()/t() renvoient la clé brute. */
for (const [name, html] of [['brand-console', consoleHtml], ['supplier-portal', portalHtml]]) {
  assert(
    /\.then\(\(\) => \{[\s\S]{0,200}return boot\(\);/.test(html),
    `${name} attend le dictionnaire avant de rendre`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nB. Aucun sélecteur de langue n’est mort');
// ---------------------------------------------------------------------------

assert(
  !consoleHtml.includes('onchange="setBrandLang'),
  'brand-console n’appelle plus une fonction d’IIFE depuis un attribut inline',
);
assert(
  consoleHtml.includes("getElementById('brand-lang-select')?.addEventListener('change'"),
  'et son sélecteur est branché dans le code',
);
assert(
  portalHtml.includes("getElementById('lang-switch')?.addEventListener('change'"),
  'le sélecteur du portail fournisseur est branché (il ne l’était pas)',
);
assert(
  !portalHtml.includes('onchange="'),
  'le portail ne dépend d’aucun gestionnaire inline',
);

// ---------------------------------------------------------------------------
console.log('\nC. Cohérence des dictionnaires servis');
// ---------------------------------------------------------------------------

const readDict = async (lang, scope) => JSON.parse(await readFile(at(`locales/${lang}/${scope}.json`), 'utf8'));

const CONSOLE_LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const PORTAL_LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh'];

/* Nombre de clés attendu par portée.
   console  : 25 — les libellés de la console marque n'ont pas bougé.
   supplier : 50 — les 25 libellés d'origine, plus 25 clés ajoutées quand les
              étiquettes de statut (24) et le libellé du champ « État » ont cessé
              d'être codés en dur dans supplier-portal/index.html. Un fournisseur
              turc ou chinois lisait « Brouillon » et des dates au format français. */
const EXPECTED_KEYS = { console: 25, supplier: 50 };
for (const [scope, langs] of [['console', CONSOLE_LANGS], ['supplier', PORTAL_LANGS]]) {
  const ref = Object.keys(await readDict(langs[0], scope)).sort();
  eq(ref.length, EXPECTED_KEYS[scope], `${scope}.json : ${EXPECTED_KEYS[scope]} clés (${langs[0]})`);
  for (const lang of langs) {
    const keys = Object.keys(await readDict(lang, scope)).sort();
    eq(JSON.stringify(keys), JSON.stringify(ref), `${scope}/${lang} a exactement les mêmes clés`);
  }
}

/* Chaque clé appelée dans le code doit exister dans toutes les langues. */
const calledKeys = (html, fn) =>
/* [a-zA-Z0-9_] et non [a-zA-Z] : les clés de statut s'appellent status_draft ou
   status_needs_review. Sans underscore elles restaient invisibles à ce contrôle,
   qui serait passé à côté de toute clé mal orthographiée. */
  [...new Set([...html.matchAll(new RegExp(`(?<![a-zA-Z.])${fn}\\(['"]([a-zA-Z0-9_]+)['"]\\)`, 'g'))].map((m) => m[1]))];

for (const [name, html, fn, scope, langs] of [
  ['brand-console', consoleHtml, 'bt', 'console', CONSOLE_LANGS],
  ['supplier-portal', portalHtml, 't', 'supplier', PORTAL_LANGS],
]) {
  const used = calledKeys(html, fn);
  assert(used.length > 0, `${name} : clés appelées détectées (${used.length})`);
  for (const lang of langs) {
    const dict = await readDict(lang, scope);
    const missing = used.filter((k) => !(k in dict));
    eq(missing.length, 0, `${name} : chaque clé appelée existe en ${lang}`, missing.join(', '));
  }
}

// ---------------------------------------------------------------------------
console.log('\nD. Le runtime n’a pas régressé pour les trois surfaces existantes');
// ---------------------------------------------------------------------------

assert(
  /var langs = LANGS;/.test(runtimeSrc),
  'la liste par défaut reste les 7 langues d’origine',
);
assert(
  /get LANGS\(\) \{ return langs\.slice\(\); \}/.test(runtimeSrc),
  'LANGS est exposé comme liste vive (les surfaces qui le lisent continuent de fonctionner)',
);
assert(
  /if \(Array\.isArray\(opts\.languages\)/.test(runtimeSrc),
  'l’extension est optique : sans `languages`, rien ne change',
);
eq((runtimeSrc.match(/LANGS\.indexOf/g) || []).length, 0, 'plus aucun test de langue ne lit la liste figée');

// ---------------------------------------------------------------------------
console.log('\nE. Rendu réel — brand-console');
// ---------------------------------------------------------------------------

const frDict = await readDict('fr', 'console');
const enDict = await readDict('en', 'console');

{
  const { window, document, errors } = await mount(consoleHtml, 'fr');
  eq(window.TracefabI18n?.language, 'fr', 'le runtime a bien chargé le français');
  eq(window.TracefabI18n?.dictionary('fr').overview, frDict.overview, 'le dictionnaire servi est celui du dépôt');
  const text = document.getElementById('app').textContent;
  assert(text.includes(frDict.overview), `la navigation affiche « ${frDict.overview} »`);
  assert(text.includes(frDict.supplyChain), `et « ${frDict.supplyChain} »`);
  assert(
    !/\bnavMain\b|\bnavCollection\b/.test(text),
    'aucune clé brute ne fuit dans l’interface',
  );
  eq(errors.length, 0, 'aucune erreur de page', errors.join(' | '));
}

{
  const { window, document } = await mount(consoleHtml, 'en');
  eq(window.TracefabI18n?.language, 'en', 'le runtime charge l’anglais quand c’est la langue stockée');
  const text = document.getElementById('app').textContent;
  assert(text.includes(enDict.overview), `la navigation affiche « ${enDict.overview} »`);
}

/* Le changement de langue doit réellement produire un effet. */
{
  const { window, document } = await mount(consoleHtml, 'fr');
  const select = document.getElementById('brand-lang-select');
  assert(!!select, 'le sélecteur est rendu');
  select.value = 'de';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  eq(window.TracefabI18n?.language, 'de', 'le sélecteur change la langue du runtime');
  const deDict = await readDict('de', 'console');
  assert(
    document.getElementById('app').textContent.includes(deDict.overview),
    `et l’interface affiche « ${deDict.overview} »`,
  );
  eq(window.localStorage.getItem('tracefab_lang'), 'de', 'la clé lue par auto-translate.js est tenue à jour');
}

// ---------------------------------------------------------------------------
console.log('\nF. Rendu réel — supplier-portal, turc et chinois compris');
// ---------------------------------------------------------------------------

{
  const { window, document, errors } = await mount(portalHtml, 'fr');
  eq(window.TracefabI18n?.language, 'fr', 'le runtime a chargé le français');
  const frSp = await readDict('fr', 'supplier');
  const text = document.getElementById('app').textContent;
  assert(text.includes(frSp.overview), `la navigation affiche « ${frSp.overview} »`);
  eq(errors.length, 0, 'aucune erreur de page', errors.join(' | '));
}

for (const lang of ['tr', 'zh']) {
  const { window, document } = await mount(portalHtml, lang);
  eq(window.TracefabI18n?.language, lang, `le ${lang} est une langue sélectionnable`);
  const dict = await readDict(lang, 'supplier');
  assert(
    document.getElementById('app').textContent.includes(dict.overview),
    `et l’interface affiche « ${dict.overview} »`,
  );
}

{
  const { window, document } = await mount(portalHtml, 'fr');
  const select = document.getElementById('lang-switch');
  assert(!!select, 'le sélecteur est rendu');
  eq(select.options.length, 9, 'il propose les neuf langues');
  select.value = 'zh';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  eq(window.TracefabI18n?.language, 'zh', 'le sélecteur change la langue (il était mort avant)');
  const zh = await readDict('zh', 'supplier');
  assert(
    document.getElementById('app').textContent.includes(zh.overview),
    `et l’interface affiche « ${zh.overview} »`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nG. Une clé absente ne produit jamais une valeur inventée');
// ---------------------------------------------------------------------------

{
  const { window } = await mount(consoleHtml, 'fr');
  eq(window.TracefabI18n.t('cleInexistante'), null, 'le runtime renvoie null pour une clé absente');
  assert(
    window.TracefabI18n.missing.includes('cleInexistante'),
    'et l’enregistre dans `missing` plutôt que de la masquer',
  );
}

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
