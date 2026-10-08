// TRACEFAB Universal Real-Time Translation Engine
// Full multi-language dictionary for EN, FR, DE, IT, ES, NL, PT

(function () {
  /*
   * Le glossaire n'est plus dupliqué dans ce fichier : il vit dans
   * /translations_deep.json, qui en est désormais la seule source.
   *
   * Les deux copies étaient strictement identiques (101 entrées, 6 langues,
   * vérifié entrée par entrée) et seule celle-ci était chargée — le fichier JSON
   * était servi par Vercel sans qu'aucun code ne le lise.
   */
  let GLOSSARY = {};

  /* Texte d'origine de chaque nœud traduit, pour pouvoir changer de langue. */
  const originalText = new WeakMap();
  const PLACEHOLDER_ATTR = 'data-tracefab-placeholder';
  let glossaryLoad = null;

  function loadGlossary() {
    if (!glossaryLoad) {
      glossaryLoad = fetch('/translations_deep.json')
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (data) {
          GLOSSARY = data || {};
          return GLOSSARY;
        })
        .catch(function (error) {
          /*
           * Un échec de chargement ne doit jamais être silencieux : c'est
           * exactement le défaut du Chantier 29. GLOSSARY reste vide, la page
           * demeure en français plutôt que d'afficher un mélange partiel.
           */
          console.error('TRACEFAB i18n : /translations_deep.json non chargé, la page reste en français.', error);
          GLOSSARY = {};
          return GLOSSARY;
        });
    }
    return glossaryLoad;
  }

  /**
   * Point d'entrée : attend le glossaire puis applique. Renvoie une promesse ;
   * les appelants qui ne l'attendent pas continuent de fonctionner, la traduction
   * s'applique un cran plus tard.
   */
  function translateDom(lang) {
    if (!lang) return Promise.resolve();
    return loadGlossary().then(function () { applyDom(lang); });
  }

  /**
   * Applique le glossaire au DOM. Suppose le glossaire déjà chargé.
   *
   * La traduction part toujours du texte d'origine, jamais du texte affiché.
   * Sinon un premier passage en anglais rend « Products » intraduisible en
   * allemand : plus aucune clé française ne correspond. C'était le comportement
   * d'origine — basculer d'une langue non française à une autre ne faisait rien.
   */
  function applyDom(lang) {
    if (!lang) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'code', 'pre', 'textarea'].includes(tag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    const textNodes = [];
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    textNodes.forEach(function (n) {
      const source = learnText(n);
      const trimmed = source.trim();
      const map = GLOSSARY[trimmed];
      if (!map) return;
      const translated = lang === 'fr' ? trimmed : map[lang];
      if (!translated) return;
      /* Remplacement dans le texte d'origine : les espaces autour sont conservés. */
      n.nodeValue = source.replace(trimmed, translated);
    });

    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(function (input) {
      if (!input.hasAttribute(PLACEHOLDER_ATTR)) {
        input.setAttribute(PLACEHOLDER_ATTR, input.getAttribute('placeholder'));
      }
      const original = input.getAttribute(PLACEHOLDER_ATTR);
      const map = GLOSSARY[original];
      if (!map) return;
      const translated = lang === 'fr' ? original : map[lang];
      if (translated) input.setAttribute('placeholder', translated);
    });
  }

  /**
   * Renvoie le texte d'origine d'un nœud, en l'apprenant au premier passage.
   *
   * Si l'application a remplacé le contenu par autre chose que le texte d'origine
   * ou l'une de ses traductions, on réapprend : le glossaire ne doit pas écraser
   * une valeur que la page vient de poser.
   */
  function learnText(n) {
    const current = n.nodeValue.trim();
    const known = originalText.get(n);
    if (known === undefined) {
      originalText.set(n, n.nodeValue);
      return n.nodeValue;
    }
    const map = GLOSSARY[known.trim()];
    const expected = [known.trim()].concat(map ? Object.keys(map).map(function (l) { return map[l]; }) : []);
    if (!expected.includes(current)) {
      originalText.set(n, n.nodeValue);
      return n.nodeValue;
    }
    return known;
  }

  let currentLanguage = localStorage.getItem('tracefab_lang') || 'en';
  let observer = null;

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      translateDom(currentLanguage);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.setTracefabGlobalLanguage = function(lang) {
    currentLanguage = lang;
    localStorage.setItem('tracefab_lang', lang);
    document.documentElement.lang = lang;
    /* La promesse est renvoyée : un appelant (ou un test) peut attendre que le
       glossaire soit chargé et appliqué au lieu de deviner un délai. */
    return translateDom(lang);
  };

  document.addEventListener('DOMContentLoaded', () => {
    currentLanguage = localStorage.getItem('tracefab_lang') || 'en';
    setupObserver();
    translateDom(currentLanguage);
  });
})();
