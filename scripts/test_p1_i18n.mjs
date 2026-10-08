import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pageSource } from './lib/page_source.mjs';

// 1. Verify existence and validity of all 7 translation dictionaries
const langs = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dictionaries = {};

// Repointe le 7 octobre 2026 : ce test lisait locales/<lang>/translation.json,
// l'ancien dictionnaire de la landing d'avant la refonte. Cet arbre n'etait
// charge par aucune page et ses sections (mockup, signature, problem)
// n'existent plus. La source unique est desormais assets/i18n/, servie a
// l'execution par tf-i18n.js. Les clefs verifiees sont les equivalentes.
{
  const g = { };
  new Function('window', await readFile(new URL('../assets/i18n/en.js', import.meta.url), 'utf8'))(g);
  dictionaries['en'] = g.TF_I18N_BUNDLES.en;
}
for (const lang of langs.filter((l) => l !== 'en')) {
  dictionaries[lang] = JSON.parse(
    await readFile(new URL(`../assets/i18n/${lang}.json`, import.meta.url), 'utf8'),
  );
}
for (const lang of langs) {
  const dict = dictionaries[lang];
  assert(dict.meta?.title, `Missing meta.title in ${lang}`);
  assert(dict.hero?.line1, `Missing hero.line1 in ${lang}`);
  assert(dict.hero?.sub, `Missing hero.sub in ${lang}`);
  assert(dict.nav?.platform, `Missing nav.platform in ${lang}`);
  assert(dict.footer?.statement, `Missing footer.statement in ${lang}`);
  assert(dict.footer?.europe, `Missing footer.europe in ${lang}`);
}

// 2. Verify Landing Page Header & i18n Selector
const indexHtml = pageSource('index.html');
assert(indexHtml.includes('lang-menu-btn'), 'Language menu button missing in index.html header');
assert(indexHtml.includes('setLanguage'), 'setLanguage controller missing in index.html');
assert(indexHtml.includes('hreflang="fr"'), 'hreflang="fr" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="de"'), 'hreflang="de" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="it"'), 'hreflang="it" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="es"'), 'hreflang="es" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="nl"'), 'hreflang="nl" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="pt"'), 'hreflang="pt" alternate SEO tag missing in index.html');

// 3. Verify positioning text in English & translations
assert(dictionaries['en'].footer.europe.includes('European by design'), 'English positioning tagline missing');
assert(dictionaries['fr'].footer.europe.includes('Pensée en Europe'), 'French positioning tagline missing');
assert(dictionaries['de'].footer.europe.includes('In Europa gedacht'), 'German positioning tagline missing');

console.log('Chantier P1 i18n test suite passed: Native internationalization architecture with 7 languages (EN, FR, DE, IT, ES, NL, PT) verified.');
