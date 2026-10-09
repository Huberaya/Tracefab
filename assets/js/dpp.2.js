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
        // LES BLOCS NON ALIMENTES NE RESTENT PAS A L'ECRAN.
        //
        // La page statique porte une centaine d'elements de demonstration :
        // « GOTS Certified », « 100% certified materials », « REACH », des
        // teneurs en microfibres, une chaine detaillee tier par tier. L'API
        // n'expose rien de tout cela. En mode live, la banniere de
        // demonstration disparait — et ces affirmations restaient affichees
        // comme si elles decrivaient le produit scanne.
        //
        // On parcourt donc chaque panneau et on retire les blocs qui ne
        // contiennent aucune valeur reellement hydratee. Un bloc survit s'il
        // porte un [data-dpp-field] renseigne. Le reste cede la place a une
        // mention unique par panneau.
        // `.trust-pill-bar` est inclus : les pastilles du hero — « ✓ 100%
        // certified materials », « GOTS Certified », « OEKO-TEX Class 1 »,
        // « Made in Portugal » — sont des allegations figees, et le hero est
        // la premiere chose que lit la personne qui scanne.
        // `.trust-pill-bar` est inclus : les pastilles du hero — « ✓ 100%
        // certified materials », « GOTS Certified », « OEKO-TEX Class 1 »,
        // « Made in Portugal » — sont des allegations figees, et le hero est
        // la premiere chose que lit la personne qui scanne.
        //
        // La descente est RECURSIVE. Une premiere version ne traitait que les
        // enfants directs du panneau : la carte de composition survivait parce
        // qu'elle contenait la composition reelle, en emportant avec elle la
        // ligne voisine « GOTS v6.0 », qui elle n'est adossee a rien.
        //
        // Elle s'arrete en revanche des qu'un element contient DIRECTEMENT une
        // valeur hydratee. Sans cette borne, on separerait l'intitule de sa
        // valeur — « 2.1 m³ » sans « Consommation d'eau » n'informe personne.
        // Elements marques a la main dans le HTML : commentaires et identifiants
        // de demonstration qui cohabitent avec une vraie valeur dans la meme
        // carte (« -64% thanks to GOTS-certified… » colle a la consommation
        // d'eau reelle). L'elagage s'arrete au parent direct d'une valeur, donc
        // il ne peut pas les atteindre — ils sont donc designes explicitement.
        document.querySelectorAll('[data-dpp-static]').forEach((el) => {
          el.hidden = true;
          el.setAttribute('data-dpp-retire', '');
        });
        const VIVANT = '[data-dpp-field]:not([data-dpp-missing]):not([data-dpp-retire])';
        const hydrate = (el) => (el.matches(VIVANT) || !!el.querySelector(VIVANT))
          && !el.hasAttribute('data-dpp-retire');
        const porteDirectement = (el) => !!el.querySelector(':scope > ' + VIVANT);
        let retires = 0;
        const elaguer = (parent) => {
          [...parent.children].forEach((enfant) => {
            if (!hydrate(enfant)) {
              enfant.hidden = true;
              enfant.setAttribute('data-dpp-retire', '');
              retires += 1;
              return;
            }
            if (!porteDirectement(enfant)) elaguer(enfant);
          });
        };
        document.querySelectorAll('.tab-content-panel, .trust-pill-bar').forEach((panneau) => {
          elaguer(panneau);
          // La mention n'a de sens que dans un panneau d'onglet : une barre de
          // pastilles vide se passe d'explication.
          if (panneau.classList.contains('tab-content-panel')
            && panneau.querySelector('[data-dpp-retire]') && !panneau.querySelector('[data-dpp-avis]')) {
            const avis = document.createElement('p');
            avis.setAttribute('data-dpp-avis', '');
            avis.setAttribute('data-i18n', 'dpp.sectionIndisponible');
            avis.style.cssText = 'font-size:13px;color:var(--text-muted);margin:16px 0;';
            avis.textContent = window.TFi18n && window.TFi18n.t
              ? window.TFi18n.t('dpp.sectionIndisponible', 'The brand has not published this information for this product.')
              : 'The brand has not published this information for this product.';
            panneau.appendChild(avis);
          }
        });
        document.documentElement.setAttribute('data-dpp-retires', String(retires));
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
  
