import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// 1. Verify existence and validity of all 7 translation dictionaries
const langs = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dictionaries = {};

for (const lang of langs) {
  const jsonContent = await readFile(new URL(`../locales/${lang}/translation.json`, import.meta.url), 'utf8');
  const dict = JSON.parse(jsonContent);
  assert(dict.seo?.title, `Missing seo.title in ${lang}`);
  assert(dict.hero?.title, `Missing hero.title in ${lang}`);
  assert(dict.signature?.step1Title, `Missing signature.step1Title in ${lang}`);
  assert(dict.problem?.title, `Missing problem.title in ${lang}`);
  assert(dict.footer?.rights, `Missing footer.rights in ${lang}`);
  dictionaries[lang] = dict;
}

// 2. Verify Landing Page Header & i18n Selector
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert(indexHtml.includes('lang-menu-btn'), 'Language menu button missing in index.html header');
assert(indexHtml.includes('setLanguage'), 'setLanguage controller missing in index.html');
assert(indexHtml.includes('hreflang="fr"'), 'hreflang="fr" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="de"'), 'hreflang="de" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="it"'), 'hreflang="it" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="es"'), 'hreflang="es" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="nl"'), 'hreflang="nl" alternate SEO tag missing in index.html');
assert(indexHtml.includes('hreflang="pt"'), 'hreflang="pt" alternate SEO tag missing in index.html');

// 3. Verify positioning text in English & translations
assert(dictionaries['en'].hero.subtitle.includes('European by design. Global by nature.'), 'English positioning tagline missing');
assert(dictionaries['fr'].hero.subtitle.includes('Conçu en Europe, taillé pour le monde.'), 'French positioning tagline missing');
assert(dictionaries['de'].hero.subtitle.includes('In Europa konzipiert. Global im Einsatz.'), 'German positioning tagline missing');

console.log('Chantier P1 i18n test suite passed: Native internationalization architecture with 7 languages (EN, FR, DE, IT, ES, NL, PT) verified.');
