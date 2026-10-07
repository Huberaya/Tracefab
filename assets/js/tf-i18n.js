/* ==========================================================================
   TRACEFAB — i18n runtime (v3.0)

   Native multilingual architecture. Components never contain business copy:
   they contain keys. The catalogue lives in /assets/i18n/.

   Markup contract
     data-i18n="key"                 → textContent
     data-i18n-html="key"            → innerHTML (only for copy with <span>/<em>)
     data-i18n-attr="attr:key, ..."  → attributes (placeholder, aria-label, content…)

   Resolution order
     ?lang=xx  →  localStorage  →  navigator.languages  →  'en'

   The reference locale (EN) is loaded synchronously from /assets/i18n/en.js,
   so the page is never blocked on a network request and degrades gracefully:
   if a locale file fails to load, the English markup stays intact.
   ========================================================================== */
(function () {
  'use strict';

  var SUPPORTED = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
  var DEFAULT = 'en';
  var STORAGE_KEY = 'tracefab.lang';
  var BASE = '/assets/i18n/';

  var flatCache = {};

  function flatten(obj, prefix, out) {
    out = out || {};
    prefix = prefix || '';
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      var key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out[key] = v;
    }
    return out;
  }

  function bundle(lang) {
    if (flatCache[lang]) return flatCache[lang];
    var raw = (window.TF_I18N_BUNDLES || {})[lang];
    if (!raw) return null;
    flatCache[lang] = flatten(raw);
    return flatCache[lang];
  }

  function detect() {
    var qs = new URLSearchParams(window.location.search).get('lang');
    if (qs && SUPPORTED.indexOf(qs.toLowerCase()) !== -1) return qs.toLowerCase();
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    } catch (e) { /* storage blocked */ }
    var navLangs = navigator.languages || [navigator.language || DEFAULT];
    for (var i = 0; i < navLangs.length; i++) {
      var short = String(navLangs[i]).slice(0, 2).toLowerCase();
      if (SUPPORTED.indexOf(short) !== -1) return short;
    }
    return DEFAULT;
  }

  var current = DEFAULT;

  function t(key, fallback) {
    var active = bundle(current);
    if (active && active[key] != null) return active[key];
    var base = bundle(DEFAULT);
    if (base && base[key] != null) return base[key];
    return fallback != null ? fallback : '';
  }

  function applyTo(root) {
    root = root || document;

    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var value = t(key, null);
      if (value !== null && value !== '') el.textContent = value;
    });

    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html');
      var value = t(key, null);
      if (value !== null && value !== '') el.innerHTML = value;
    });

    root.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(',').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length < 2) return;
        var attr = bits[0].trim();
        var value = t(bits[1].trim(), null);
        if (value !== null && value !== '') el.setAttribute(attr, value);
      });
    });
  }

  function applyDocumentMeta() {
    document.documentElement.setAttribute('lang', current);
    var title = t('meta.title', null);
    if (title) document.title = title;
    var desc = t('meta.description', null);
    if (desc) {
      var tag = document.querySelector('meta[name="description"]');
      if (tag) tag.setAttribute('content', desc);
    }
  }

  function loadLocale(lang) {
    if (lang === DEFAULT || bundle(lang)) return Promise.resolve(true);
    return fetch(BASE + lang + '.json', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('locale ' + lang + ' unavailable'); return r.json(); })
      .then(function (data) {
        window.TF_I18N_BUNDLES[lang] = data;
        return true;
      })
      .catch(function (err) {
        if (window.console) console.warn('[tf-i18n]', err.message);
        return false;
      });
  }

  function setLanguage(lang, opts) {
    opts = opts || {};
    if (SUPPORTED.indexOf(lang) === -1) lang = DEFAULT;
    return loadLocale(lang).then(function (ok) {
      current = ok ? lang : DEFAULT;
      try { window.localStorage.setItem(STORAGE_KEY, current); } catch (e) { /* noop */ }
      applyDocumentMeta();
      applyTo(document);
      document.dispatchEvent(new CustomEvent('tf:languagechange', { detail: { lang: current } }));
      if (!opts.silent && window.console && window.console.debug) {
        console.debug('[tf-i18n] language =', current);
      }
      return current;
    });
  }

  var api = {
    supported: SUPPORTED,
    default: DEFAULT,
    get lang() { return current; },
    t: t,
    apply: applyTo,
    setLanguage: setLanguage
  };

  // `ready` must exist synchronously: tf-landing.js may evaluate before boot()
  // runs on DOMContentLoaded, and anything gated on the active locale (counters,
  // the data core, the chain matrix) would otherwise render the English markup.
  var resolveReady;
  api.ready = new Promise(function (res) { resolveReady = res; });

  window.TF_I18N = api;

  // Boot
  function boot() {
    current = detect();
    setLanguage(current, { silent: true }).then(resolveReady, resolveReady);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
