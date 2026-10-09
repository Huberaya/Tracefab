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
     * Regle : on n'ecrit que ce que l'API renvoie, ET une valeur absente est
     * ecrite comme absente.
     *
     * La regle precedente laissait le champ intact quand l'API ne renvoyait rien,
     * au motif qu'« un passeport public troue inquiete plus qu'il n'informe ».
     * C'est l'inverse qui est vrai : le contenu statique de la page est un
     * echantillon de demonstration. Le laisser en place quand la donnee reelle
     * manque, c'est presenter une valeur inventee comme une valeur sourcee — et
     * rien, a l'ecran, ne permettait de faire la difference.
     *
     * Un champ non renseigne affiche donc « Non renseigne », explicitement.
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
        document.querySelectorAll('[data-dpp-field]').forEach((el) => {
          const v = dig(dpp, el.dataset.dppField);
          const absent = v === undefined || v === null || v === '';
          el.textContent = absent ? 'Non renseigné' : String(v) + (el.dataset.dppSuffix || '');
          el.setAttribute('data-dpp-state', absent ? 'non-renseigne' : 'source');
          // La valeur n'est plus de la demonstration ni une chaine traduisible :
          // sans cela le prochain changement de langue la rendrait a nouveau.
          el.removeAttribute('data-tf-demo');
          el.removeAttribute('data-i18n');
        });
        document.querySelectorAll('[data-dpp-href]').forEach((el) => {
          const v = dig(payload, el.dataset.dppHref);
          if (v) el.setAttribute('href', String(v));
        });
        if (dpp.productName) document.title = dpp.productName + ' — Digital Product Passport | TRACEFAB';
        if (banner) banner.hidden = true;
        /*
         * Le statut « live » vient de la provenance declaree par l'API, pas du
         * seul fait qu'une reponse soit arrivee. Un produit publie mais vide de
         * toute donnee sourcee n'est pas un passeport live : il est incomplet, et
         * la page doit le dire plutot que d'afficher un statut flatteur au-dessus
         * de champs « Non renseigne ».
         */
        const statut = (dpp.provenance && dpp.provenance.status) || 'incomplete';
        document.documentElement.setAttribute('data-dpp-source', statut === 'live' ? 'live' : 'incomplete');
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
  
