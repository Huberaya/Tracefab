#!/usr/bin/env node
/**
 * TRACEFAB i18n architecture test.
 *
 * The repository accumulated five disconnected translation sources, two of
 * which nothing loaded. This test pins the contract of the shared runtime
 * (`public/i18n-core.js`) and of `locales/` as the single live source:
 *
 *   - switching language really changes rendered text, in all 7 languages;
 *   - a missing key never blanks the UI, it keeps the authored text and is
 *     reported in `TracefabI18n.missing`;
 *   - adding a language is adding a directory, not editing JavaScript;
 *   - every locale file exposes the same key set.
 *
 *   npm run test:i18n
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;
const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];

console.log('\nA. Les fichiers de langue sont la source');
const runtime = await readFile(new URL('public/i18n-core.js', root), 'utf8');
assert(/\/locales\/' \+ lang \+ '\/' \+ scope/.test(runtime) || runtime.includes("/locales/' + lang + '/"), 'le runtime lit locales/{lang}/{scope}.json');
assert(!/const [A-Z_]*DICTIONARY = \{/.test(runtime), 'le runtime ne contient aucun dictionnaire inline');
const localeDirs = (await readdir(new URL('locales/', root))).filter((d) => !d.startsWith('.'));
assert(LANGS.every((l) => localeDirs.includes(l)), `les ${LANGS.length} langues du brief sont présentes`, localeDirs.join(','));

const keySets = {};
for (const lang of LANGS) {
  const raw = await readFile(new URL(`locales/${lang}/app.json`, root), 'utf8');
  const doc = JSON.parse(raw);
  const flat = {};
  (function walk(o, p) { for (const k of Object.keys(o)) { const v = o[k]; const path = p ? `${p}.${k}` : k; if (v && typeof v === 'object') walk(v, path); else flat[path] = v; } })(doc, '');
  keySets[lang] = flat;
}
const reference = Object.keys(keySets.fr).sort().join('|');
for (const lang of LANGS) {
  eq(Object.keys(keySets[lang]).sort().join('|'), reference, `${lang} expose exactement le même jeu de clés que fr`);
}
assert(Object.keys(keySets.fr).length >= 30, `${Object.keys(keySets.fr).length} chaînes par langue`);
for (const lang of LANGS) {
  const empty = Object.entries(keySets[lang]).filter(([, v]) => !String(v || '').trim());
  eq(empty.length, 0, `${lang} n’a aucune chaîne vide`, empty.map(([k]) => k).join(','));
}
// Aucune langue ne doit être une copie d'une autre.
assert(keySets.de['tr.massBalance'] !== keySets.fr['tr.massBalance'], 'l’allemand est réellement traduit, pas copié du français');
assert(keySets.nl['nav.overview'] !== keySets.en['nav.overview'], 'le néerlandais est réellement traduit, pas copié de l’anglais');

console.log('\nB. Le runtime dans la surface réelle');
async function bootWithI18n(surfacePath) {
  const html = await readFile(new URL(surfacePath, root), 'utf8');
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: `https://tracefab.vercel.app/${surfacePath}?demo=1`,
    virtualConsole,
  });
  const { window } = dom;
  const { document } = window;
  // jsdom ne récupère pas les scripts ni les JSON externes : on sert les vrais fichiers.
  window.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    try {
      const body = await readFile(new URL(`.${path}`, root), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    } catch (e) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
  };
  await new Promise((r) => setTimeout(r, 60));
  const script = document.createElement('script');
  script.textContent = runtime;
  document.body.appendChild(script);
  /* En production /i18n-core.js est un <script src> chargé avant le script de la
     surface. jsdom ne récupère pas les scripts externes : on injecte le runtime
     puis on initialise et on re-rend, ce qui reproduit exactement cet ordre. */
  if (window.TracefabI18n) {
    await window.TracefabI18n.init({ scope: 'app', fallback: 'fr' });
    const nav = document.querySelector('[data-nav]');
    if (nav) nav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  await new Promise((r) => setTimeout(r, 80));
  return { window, document, pageErrors };
}

const { window, document, pageErrors } = await bootWithI18n('traceability/index.html');
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 60));

assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
const i18n = window.TracefabI18n;
assert(!!i18n, 'le runtime est exposé');
eq(i18n.LANGS.join(','), LANGS.join(','), 'les 7 langues sont déclarées');
assert(i18n.isReady, 'un dictionnaire est chargé');

console.log('\nC. Changer de langue change réellement le texte rendu');
const navLabel = () => ($('[data-i18n="tr.massBalance"]') || {}).textContent;
const before = navLabel();
eq(before, keySets[i18n.language]['tr.massBalance'], 'le libellé initial vient du dictionnaire');
for (const lang of LANGS) {
  const btn = $(`[data-lang="${lang}"]`);
  assert(!!btn, `bouton de langue ${lang} présent`);
  click(btn);
  await settle();
  eq(i18n.language, lang, `langue active = ${lang}`);
  eq(navLabel(), keySets[lang]['tr.massBalance'], `« Bilan de masse » rendu en ${lang}`);
  eq(document.documentElement.getAttribute('lang'), lang, `<html lang> aligné sur ${lang}`);
}

console.log('\nD. Tous les onglets sont traduits, pas seulement le premier');
click($('[data-lang="de"]'));
await settle();
const expectedDe = {
  'nav.overview': keySets.de['nav.overview'],
  'tr.massBalance': keySets.de['tr.massBalance'],
  'tr.chain': keySets.de['tr.chain'],
  'tr.audit': keySets.de['tr.audit'],
  'nav.traceability': keySets.de['nav.traceability'],
};
for (const [key, text] of Object.entries(expectedDe)) {
  eq(($(`[data-i18n="${key}"]`) || {}).textContent, text, `clé ${key} traduite en allemand`);
}

console.log('\nE. Une clé absente ne vide jamais l’interface');
const authored = $('[data-i18n="nav.traceability"]').getAttribute('data-i18n-default');
assert(!!authored, 'le texte rédigé est conservé comme repli');
const ghost = document.createElement('span');
ghost.setAttribute('data-i18n', 'cette.cle.nexiste.pas');
ghost.textContent = 'Texte rédigé';
document.getElementById('app').appendChild(ghost);
i18n.apply(document.getElementById('app'));
eq(ghost.textContent, 'Texte rédigé', 'une clé inconnue laisse le texte rédigé intact');
assert(i18n.missing.includes('cette.cle.nexiste.pas'), 'la clé manquante est signalée, pas masquée');
ghost.remove();

console.log('\nF. Ajouter une langue = ajouter un dossier');
assert(
  !runtime.includes("'en'") || /LANGS = \[/.test(runtime),
  'la liste des langues est déclarée une fois',
);
const surfaceHtml = await readFile(new URL('traceability/index.html', root), 'utf8');
assert(surfaceHtml.includes('i18n.LANGS'), 'la surface énumère les langues depuis le runtime, sans liste codée en dur');
assert(!/data-lang="(en|de|it|es|nl|pt)"/.test(surfaceHtml), 'aucun bouton de langue codé en dur dans la surface');

console.log('\nG. Les surfaces traduisent réellement, dans le DOM rendu');
for (const surface of ['traceability/index.html', 'evidence/index.html', 'dpp/index.html']) {
  const html = await readFile(new URL(surface, root), 'utf8');
  assert(html.includes('/i18n-core.js'), `${surface} charge le runtime partagé`);
  const booted = await bootWithI18n(surface);
  const doc = booted.document;
  await booted.window.TracefabI18n.setLanguage('de');
  await new Promise((r) => setTimeout(r, 60));
  const nodes = [...doc.querySelectorAll('[data-i18n]')];
  assert(nodes.length >= 4, `${surface} : ${nodes.length} éléments traduits dans le DOM rendu`);
  const dict = booted.window.TracefabI18n.dictionary('de');
  const stale = nodes.filter((n) => {
    const key = n.getAttribute('data-i18n');
    return Object.prototype.hasOwnProperty.call(dict, key) && n.textContent !== dict[key];
  });
  eq(stale.length, 0, `${surface} : aucun élément resté en français alors que la clé existe`, stale.map((n) => n.getAttribute('data-i18n')).join(','));
}

console.log('\nH. Les dictionnaires morts sont identifiés');
const unused = await stat(new URL('public/translations_deep.json', root)).then(() => true, () => false);
assert(unused, 'translations_deep.json existe toujours — documenté comme non chargé');
const indexHtml = await readFile(new URL('index.html', root), 'utf8');
assert(indexHtml.includes('/i18n-engine.js'), 'la landing conserve son moteur existant (migration non régressive)');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:i18n FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:i18n passed — ${checks} contrôles, 0 échec.`);
