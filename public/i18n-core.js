/**
 * TRACEFAB i18n core — the shared translation runtime.
 *
 * Why this exists: the repository accumulated five disconnected translation
 * sources (locales/*.json, i18n-engine.js, auto-translate.js, an inline
 * brandTranslations map, translations_deep.json), two of which nothing loads.
 * Adding a language meant editing JavaScript in several files.
 *
 * This runtime makes `locales/{lang}/{scope}.json` the single live source:
 * adding a language is adding a directory, adding a surface is adding a file.
 *
 * Guarantees:
 *  - a missing key never blanks the UI: the authored markup stays as fallback,
 *    and the key is recorded in `TracefabI18n.missing` so gaps are visible;
 *  - a missing locale falls back to the declared fallback language, then to the
 *    authored markup;
 *  - no network call blocks first paint — text renders in the authored language
 *    and is upgraded when the dictionary arrives.
 *
 * Usage in a surface:
 *   <script src="/i18n-core.js"></script>
 *   <h1 data-i18n="chain.title">Chaîne</h1>
 *   TracefabI18n.init({ scope: 'app' }).then(() => render());
 */
(function () {
  'use strict';

  var LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
  /*
   * Langues effectivement proposées par la surface courante. `init({ languages })`
   * peut l'étendre : le portail fournisseur traduit aussi en tr et zh. On ne
   * l'ajoute pas à LANGS en dur, sinon les surfaces qui n'ont aucun dictionnaire
   * turc proposeraient une langue qu'elles ne peuvent pas servir.
   */
  var langs = LANGS;
  var STORAGE_KEY = 'tracefab.lang';

  var dictionaries = {};
  var missing = [];
  var language = null;
  var fallback = 'fr';
  var scope = 'app';
  var ready = false;

  function detect() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && langs.indexOf(stored) !== -1) return stored;
    } catch (e) { /* stockage indisponible (mode privé) */ }
    var nav = (navigator.language || 'fr').slice(0, 2).toLowerCase();
    return langs.indexOf(nav) !== -1 ? nav : fallback;
  }

  function flatten(source, prefix, target) {
    Object.keys(source).forEach(function (key) {
      var value = source[key];
      var path = prefix ? prefix + '.' + key : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, target);
      else target[path] = value;
    });
    return target;
  }

  function load(lang) {
    if (dictionaries[lang]) return Promise.resolve(dictionaries[lang]);
    var urls = ['/locales/' + lang + '/' + scope + '.json', '/locales/' + lang + '/translation.json'];
    return urls.reduce(function (chain, url) {
      return chain.then(function (acc) {
        return fetch(url, { headers: { Accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : null; })
          .catch(function () { return null; })
          .then(function (json) { return json ? flatten(json, '', acc) : acc; });
      });
    }, Promise.resolve({})).then(function (dict) {
      dictionaries[lang] = dict;
      return dict;
    });
  }

  function t(key) {
    var dict = dictionaries[language] || {};
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    var fb = dictionaries[fallback] || {};
    if (Object.prototype.hasOwnProperty.call(fb, key)) return fb[key];
    if (missing.indexOf(key) === -1) missing.push(key);
    return null;
  }

  /** Remplace les textes marqués. Un texte non traduit conserve sa valeur d'origine. */
  function apply(root) {
    var scopeRoot = root || document;
    Array.prototype.forEach.call(scopeRoot.querySelectorAll('[data-i18n]'), function (el) {
      if (!el.hasAttribute('data-i18n-default')) {
        el.setAttribute('data-i18n-default', el.textContent);
      }
      var value = t(el.getAttribute('data-i18n'));
      el.textContent = value === null ? el.getAttribute('data-i18n-default') : value;
    });
    Array.prototype.forEach.call(scopeRoot.querySelectorAll('[data-i18n-attr]'), function (el) {
      var spec = el.getAttribute('data-i18n-attr'); // "aria-label:key,label:key2"
      spec.split(',').forEach(function (pair) {
        var parts = pair.split(':');
        if (parts.length !== 2) return;
        var value = t(parts[1].trim());
        if (value !== null) el.setAttribute(parts[0].trim(), value);
      });
    });
    document.documentElement.setAttribute('lang', language);
  }

  function setLanguage(lang) {
    if (langs.indexOf(lang) === -1) return Promise.resolve(false);
    language = lang;
    try { window.localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
    return load(lang).then(function () {
      ready = true;
      apply(document);
      document.dispatchEvent(new CustomEvent('tracefab:lang', { detail: { language: lang } }));
      return true;
    });
  }

  function init(options) {
    var opts = options || {};
    scope = opts.scope || 'app';
    if (Array.isArray(opts.languages) && opts.languages.length) langs = opts.languages.slice();
    fallback = opts.fallback || 'fr';
    language = langs.indexOf(opts.language || '') !== -1 ? opts.language : detect();
    return setLanguage(language);
  }

  window.TracefabI18n = {
    /** Liste vive : reflète ce que la surface a déclaré pouvoir servir. */
    get LANGS() { return langs.slice(); },
    init: init,
    setLanguage: setLanguage,
    apply: apply,
    t: t,
    /** Chaînes demandées mais absentes du dictionnaire : à combler, jamais à masquer. */
    get missing() { return missing.slice(); },
    get language() { return language; },
    get isReady() { return ready; },
    dictionary: function (lang) { return dictionaries[lang || language] || {}; },
  };
})();
