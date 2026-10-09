    // dppLangs a ete fusionne dans le catalogue unique /assets/i18n
    // (portee 'dpp'). Regenerable par scripts/build_dpp_i18n.mjs.

    const BADGE_ICON = `<svg fill="currentColor" viewBox="0 0 20 20" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg> `;

    function applyDppLang(lang) {
      const T = window.TF_I18N;
      if (T) { T.setLanguage(lang); return; }
      renderDppLang(lang);
    }

    // Rendu effectif, separe du commutateur pour que tout changement de
    // langue — selecteur de cette page, console, autre onglet — emprunte le
    // meme chemin.
    function renderDppLang(lang) {
      const T = window.TF_I18N;
      const tr = (k) => (T ? T.t('dpp.' + k, k) : k);
      document.documentElement.lang = lang;
      const badge = document.querySelector('.badge-eu');
      if (badge) badge.innerHTML = BADGE_ICON + ' ' + tr('badgeEu');
      const select = document.getElementById('dpp-lang-select');
      if (select) select.value = lang;
    }

    document.addEventListener('tf:languagechange', (event) => renderDppLang(event.detail.lang));

    document.addEventListener('DOMContentLoaded', () => {
      // Le runtime detecte la langue (?lang, stockage partage, navigateur)
      // puis emet tf:languagechange, qui declenche le rendu.
      renderDppLang((window.TF_I18N && window.TF_I18N.lang) || 'en');
    });

    /* ===================================================================
     * Hydratation du passeport public
     *
     * La page reste entierement servie en statique : c'est elle que lisent
     * les moteurs de recherche, et elle fonctionne sans backend. Quand un
     * identifiant est present dans l'URL, on remplace les valeurs de
     * demonstration par les donnees reelles de /api/dpp/:gtin.
     *
     * Regle : on n'ecrit que ce que l'API renvoie. Une valeur absente laisse
     * la valeur affichee intacte plutot que de vider le champ — un passeport
     * public troue inquiete plus qu'il n'informe.
     * =================================================================== */
    (function hydratePassport() {
      const params = new URLSearchParams(location.search);
      // Deux entrees : ?gtin=... et le dernier segment de /dpp/<gtin>.
      const fromPath = location.pathname.replace(/\/+$/, '').split('/').pop();
      const id = params.get('gtin') || params.get('id')
        || (fromPath && fromPath !== 'dpp' && !/\.html?$/.test(fromPath) ? fromPath : null);

      const banner = document.getElementById('dpp-demo-banner');
      if (!id) return;                       // pas d'identifiant : demo assumee

      const dig = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

      const apply = (payload) => {
        const dpp = payload && payload.dpp;
        if (!dpp) return false;
        const manquants = [];
        document.querySelectorAll('[data-dpp-field]').forEach((el) => {
            const v = dig(dpp, el.dataset.dppField);
            // La valeur n'est plus de la demonstration ni une chaine traduisible :
            // sans cela le prochain changement de langue la rendrait a nouveau.
            el.removeAttribute('data-tf-demo');
            el.removeAttribute('data-i18n');
            if (v === undefined || v === null || v === '') {
              // ABSENTE DU PASSEPORT REEL.
              //
              // La regle precedente — « une valeur absente laisse la valeur
              // affichee intacte » — etait tenable tant que l'API comblait
              // tout. Ce n'est plus le cas : un produit sans analyse PEF ou
              // sans matiere declaree renvoie desormais undefined, parce que
              // la plateforme a cesse d'inventer. Conserver la valeur statique
              // reviendrait a presenter un chiffre de demonstration sur une
              // page dont la banniere de demonstration a disparu — exactement
              // le scenario que l'on veut rendre impossible.
              el.textContent = '—';
              el.setAttribute('data-dpp-missing', '');
              manquants.push(el.dataset.dppField);
              return;
            }
            el.removeAttribute('data-dpp-missing');
            el.textContent = String(v) + (el.dataset.dppSuffix || '');
        });
        document.querySelectorAll('[data-dpp-href]').forEach((el) => {
          const v = dig(payload, el.dataset.dppHref);
          if (v) el.setAttribute('href', String(v));
        });
        // Le monogramme etait fige sur « AD » (Atelier Demo). Affiche a cote
        // d'une marque reelle, il la contredisait visuellement.
        const mono = document.querySelector('[data-dpp-initials]');
        if (mono && dpp.brandName) {
          mono.textContent = String(dpp.brandName).trim().split(/\s+/)
            .slice(0, 2).map((m) => m[0] || '').join('').toUpperCase() || '—';
        }
        if (dpp.productName) document.title = dpp.productName + ' — Digital Product Passport | TRACEFAB';
        if (banner) banner.hidden = true;
        document.documentElement.setAttribute('data-dpp-source', 'live');
          // Nombre de rubriques non renseignees par la marque : la page peut
          // expliquer les tirets au lieu de les laisser sans justification.
          document.documentElement.setAttribute('data-dpp-missing-count', String(manquants.length));
        return true;
      };

      fetch('/api/dpp/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((payload) => { if (!apply(payload)) throw new Error('empty'); })
        .catch(() => {
          // Echec reseau ou passeport inconnu : on garde le contenu statique,
          // mais on le dit. Afficher de la demo pour du reel serait le pire cas.
          document.documentElement.setAttribute('data-dpp-source', 'demo');
          if (banner) banner.hidden = false;
        });
    

      /* Gestionnaires de la page, enregistres dans la portee du module.
       * Les attributs inline etaient evalues en portee globale, ce qui
       * obligeait a exposer des fonctions sur window ; ici, state et render
       * sont directement accessibles. */
      window.TFActions.register({
        p01: function (event) { applyDppLang(this.value); },
      });
    })();
  
