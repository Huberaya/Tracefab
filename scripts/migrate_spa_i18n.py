#!/usr/bin/env python3
"""
Branche brand-console et supplier-portal sur le catalogue unique
assets/i18n/, servi par le runtime assets/js/tf-i18n.js.

Principe directeur : migration ISO-COMPORTEMENT.
  - les noms de cles d'origine sont conserves, seule la portee est prefixee,
    donc aucun des ~700 sites d'appel n'est touche ;
  - la langue par defaut de chaque application est inchangee (console 'en',
    portail 'fr'), car la changer casserait test_supplier_portal_browser.mjs
    et depasserait le cadre d'une consolidation ;
  - tf-i18n.js ecrit les deux cles de stockage, donc le choix de langue
    circule desormais entre la landing et les applications.

Non idempotent : restaurer depuis git avant toute reexecution.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
edits = 0


def patch(path, old, new, label, count=1):
    global edits
    p = ROOT / path
    s = p.read_text(encoding='utf-8')
    if new.strip() and new.strip()[:40] in s:
        print(f"  DEJA FAIT  {path}: {label}")
        return
    n = s.count(old)
    if n != count:
        print(f"  ECHEC      {path}: {label} — {n} occurrence(s), {count} attendue(s)")
        sys.exit(1)
    p.write_text(s.replace(old, new, count), encoding='utf-8')
    print(f"  ok         {path}: {label}")
    edits += 1


def drop_dict(path, var):
    """Supprime le dictionnaire inline en equilibrant les accolades."""
    global edits
    p = ROOT / path
    s = p.read_text(encoding='utf-8')
    m = re.search(r'(?:const|let|var)\s+' + var + r'\s*=\s*\{', s)
    if not m:
        print(f"  DEJA FAIT  {path}: dictionnaire {var} absent")
        return
    i = s.index('{', m.start())
    depth = 0
    for j in range(i, len(s)):
        if s[j] == '{':
            depth += 1
        elif s[j] == '}':
            depth -= 1
            if depth == 0:
                break
    end = j + 1
    if s[end:end + 1] == ';':
        end += 1
    removed = s[m.start():end]
    note = (
        "// Le dictionnaire inline de cette page a ete fusionne dans le\n"
        "        // catalogue unique /assets/i18n (portees 'shared' et '%s').\n"
        "        // Regenerable par scripts/build_app_i18n.mjs." % var
    )
    p.write_text(s[:m.start()] + note + s[end:], encoding='utf-8')
    print(f"  ok         {path}: dictionnaire {var} retire ({len(removed)} octets)")
    edits += 1


HEAD_CONSOLE = """    <!-- i18n consolide : catalogue unique /assets/i18n, servi par le runtime
         partage tf-i18n.js. TF_I18N_SKIP_META protege le titre propre de
         cette page : sans lui elle heriterait du titre de la landing. -->
    <script>window.TF_I18N_SKIP_META = true;</script>
    <script src="/assets/i18n/en.js"></script>
    <script src="/assets/js/tf-i18n.js"></script>
</head>"""

HEAD_PORTAL = """    <!-- i18n consolide : catalogue unique /assets/i18n, servi par le runtime
         partage tf-i18n.js. Le portail sert aussi des fournisseurs turcs et
         chinois, d'ou l'elargissement de l'ensemble des langues. -->
    <script>
      window.TF_I18N_SUPPORTED = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh'];
      window.TF_I18N_SKIP_META = true;
    </script>
    <script src="/assets/i18n/en.js"></script>
    <script src="/assets/js/tf-i18n.js"></script>
</head>"""

# ---- brand console -------------------------------------------------------
patch('brand-console/index.html', '</head>', HEAD_CONSOLE, 'chargement du catalogue')
drop_dict('brand-console/index.html', 'brandTranslations')
patch(
    'brand-console/index.html',
    """      function bt(key) {
        const lang = state.lang || 'en';
        return brandTranslations[lang]?.[key] || brandTranslations['en']?.[key] || brandTranslations['fr']?.[key] || key;
      }""",
    """      function bt(key) {
        const T = window.TF_I18N;
        if (!T) return key;
        // Portee console d'abord, puis le fonds commun. Le repli anglais
        // est assure par le runtime : plus aucun repli francais implicite.
        return T.t('console.' + key, null) || T.t('shared.' + key, key);
      }""",
    'resolution bt() deleguee au catalogue',
)
patch(
    'brand-console/index.html',
    """      function setBrandLang(lang) {
        state.lang = lang;
        localStorage.setItem('tracefab_lang', lang);
        document.documentElement.lang = lang;
        render();
      }""",
    """      function setBrandLang(lang) {
        state.lang = lang;
        document.documentElement.lang = lang;
        // setLanguage ecrit les deux cles de stockage et charge la locale
        // avant le rendu, sinon la vue s'afficherait en anglais une frame.
        const T = window.TF_I18N;
        if (T) T.setLanguage(lang).then(render); else render();
      }""",
    'commutateur de langue delegue',
)
patch(
    'brand-console/index.html',
    """      window.tracefabBrandConsole = { state, sync };
      boot();""",
    """      window.tracefabBrandConsole = { state, sync };
      // Le catalogue doit etre charge dans la langue de l'application avant
      // le premier rendu.
      (window.TF_I18N ? window.TF_I18N.setLanguage(state.lang) : Promise.resolve())
        .then(boot, boot);""",
    'amorcage synchronise sur la langue',
)

# ---- supplier portal -----------------------------------------------------
patch('supplier-portal/index.html', '</head>', HEAD_PORTAL, 'chargement du catalogue')
drop_dict('supplier-portal/index.html', 'translations')
patch(
    'supplier-portal/index.html',
    """      function t(key) {
        const lang = state.lang || 'fr';
        return translations[lang]?.[key] || translations['fr'][key] || key;
      }""",
    """      function t(key) {
        const T = window.TF_I18N;
        if (!T) return key;
        // Portee portail d'abord, puis le fonds commun. Le repli etait
        // francais : une cle absente en turc rendait du francais. Il est
        // desormais anglais, conformement a la langue source du produit.
        return T.t('portal.' + key, null) || T.t('shared.' + key, key);
      }""",
    'resolution t() deleguee au catalogue',
)
patch(
    'supplier-portal/index.html',
    """          state.lang = event.currentTarget.value;
          try { localStorage.setItem('tracefab_lang', state.lang); } catch (error) { /* noop */ }
          document.documentElement.lang = state.lang;
          render();""",
    """          state.lang = event.currentTarget.value;
          document.documentElement.lang = state.lang;
          const T = window.TF_I18N;
          if (T) T.setLanguage(state.lang).then(render); else render();""",
    'commutateur de langue delegue',
)
patch(
    'supplier-portal/index.html',
    """      window.tracefabSupplierPortal = { state, sync };
      boot();""",
    """      window.tracefabSupplierPortal = { state, sync };
      (window.TF_I18N ? window.TF_I18N.setLanguage(state.lang) : Promise.resolve())
        .then(boot, boot);""",
    'amorcage synchronise sur la langue',
)

print(f"\n  {edits} modification(s) appliquee(s).")
