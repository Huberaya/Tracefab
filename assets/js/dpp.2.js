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
     * identifiant est present dans l'URL, on remplace le contenu de
     * demonstration par les donnees de /api/dpp/:gtin.
     *
     * REGLE DE PROVENANCE (chantier 1A-C) :
     *   - une valeur 'sourced' remplace la valeur de demonstration ;
     *   - une valeur absente ou indisponible remplace AUSSI la demonstration,
     *     par un etat explicite (« Non renseigne », « Non verifie »,
     *     « Indisponible ») — laisser une valeur de demo en place derriere
     *     une banniere masquee presenterait du fictif comme du reel ;
     *   - l'attribut data-dpp-source (live / partial / empty / demo) ne vaut
     *     'live' que si l'API declare des donnees reellement sourcees.
     * =================================================================== */
    (function hydratePassport() {
      const params = new URLSearchParams(location.search);
      // Deux entrees : ?gtin=... et le dernier segment de /dpp/<gtin>.
      const fromPath = location.pathname.replace(/\/+$/, '').split('/').pop();
      const id = params.get('gtin') || params.get('id')
        || (fromPath && fromPath !== 'dpp' && !/\.html?$/.test(fromPath) ? fromPath : null);

      const banner = document.getElementById('dpp-demo-banner');
      if (!id) return;                       // pas d'identifiant : demo assumee
      document.documentElement.setAttribute('data-dpp-requested', 'true');

      const dig = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

      const tr = (k, fallback) => {
        const T = window.TF_I18N;
        return T ? T.t('dpp.' + k, fallback) : fallback;
      };

      // Etats explicites, traduisibles, jamais des valeurs inventees.
      const marker = (status) => {
        if (status === 'unverified') return tr('statusUnverified', 'Non vérifié');
        if (status === 'not_filled') return tr('statusNotFilled', 'Non renseigné');
        return tr('statusUnavailable', 'Indisponible');
      };

      // Un champ du payload est un objet { value, status, source }. Toute
      // forme ancienne (chaine, nombre) est traitee comme sourcee.
      const renderable = (field) => {
        if (field === undefined || field === null) return { text: null, status: 'not_filled' };
        if (typeof field === 'object' && 'status' in field) {
          const hasValue = field.value !== null && field.value !== undefined && field.value !== '';
          if (hasValue && (field.status === 'sourced' || field.status === 'unverified')) {
            return { text: String(field.value), status: field.status };
          }
          return { text: null, status: field.status || 'unavailable' };
        }
        return { text: String(field), status: 'sourced' };
      };

      const lifecycle = {
        list: document.getElementById('lifecycle-list'), status: document.getElementById('lifecycle-status'),
        count: document.getElementById('lifecycle-count'), more: document.getElementById('lifecycle-more'),
      };
      const eventLabels = {
        passport_created: 'Passeport créé', data_submitted: 'Données mises à jour', evidence_added: 'Justificatif ajouté',
        manufacturing_step: 'Étape de fabrication', data_corrected: 'Information corrigée', repair: 'Produit réparé',
        reuse: 'Produit réemployé', recycling: 'Produit orienté vers le recyclage', publication_reviewed: 'Publication examinée',
        published: 'Passeport publié', publication_suspended: 'Publication suspendue', publication_withdrawn: 'Publication retirée',
      };
      const trustLabels = {
        declared: 'Déclaré', documented: 'Documenté', controlled: 'Contrôlé',
        corroborated: 'Corroboré', third_party_verified: 'Vérifié par un tiers',
      };
      const trustExplanations = {
        declared: 'Information fournie par un acteur, sans validation indépendante.',
        documented: 'Information accompagnée d’un justificatif. Cela ne vaut pas certification.',
        controlled: 'Information ayant passé les contrôles définis par TRACEFAB.',
        corroborated: 'Information soutenue par plusieurs éléments concordants.',
        third_party_verified: 'Contrôle réalisé par un tiers identifié selon un périmètre documenté.',
      };
      let lifecycleEvents = [];
      const renderHistory = (history, expanded) => {
        if (!lifecycle.list || !lifecycle.status) return;
        lifecycleEvents = Array.isArray(history) ? history.filter((item) => item && item.public_summary && item.validation_status !== 'rejected') : [];
        lifecycleEvents.sort((a, b) => String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')));
        lifecycle.list.replaceChildren();
        if (!lifecycleEvents.length) {
          lifecycle.status.hidden = false;
          lifecycle.status.textContent = 'Aucun événement de cycle de vie n’est publié pour le moment.';
          lifecycle.list.hidden = true; lifecycle.count.hidden = true; lifecycle.more.hidden = true;
          return;
        }
        const shown = expanded ? lifecycleEvents : lifecycleEvents.slice(0, 5);
        const lang = document.documentElement.lang || 'fr';
        shown.forEach((item) => {
          const li = document.createElement('li'); li.className = 'lifecycle-event';
          const dot = document.createElement('span'); dot.className = 'lifecycle-dot'; dot.setAttribute('aria-hidden', 'true');
          const time = document.createElement('time'); const rawDate = item.business_occurred_at || item.recorded_at; const date = new Date(rawDate);
          time.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
          time.textContent = Number.isNaN(date.getTime()) ? 'Date non disponible' : new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(date);
          const title = document.createElement('h3'); title.className = 'lifecycle-event-title';
          title.textContent = item.public_summary || eventLabels[item.event_type] || 'Événement du produit';
          const badge = document.createElement('span'); badge.className = 'trust-badge'; badge.dataset.status = item.validation_status || 'declared';
          badge.textContent = trustLabels[item.validation_status] || 'Statut non précisé';
          badge.title = trustExplanations[item.validation_status] || 'Niveau de contrôle non précisé.';
          li.append(dot, time, title, badge); lifecycle.list.append(li);
        });
        lifecycle.status.hidden = true; lifecycle.list.hidden = false;
        lifecycle.count.textContent = String(lifecycleEvents.length) + (lifecycleEvents.length > 1 ? ' événements' : ' événement'); lifecycle.count.hidden = false;
        lifecycle.more.hidden = lifecycleEvents.length <= 5; lifecycle.more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        lifecycle.more.textContent = expanded ? 'Réduire l’historique' : `Afficher les ${lifecycleEvents.length} événements`;
      };
      if (lifecycle.more) lifecycle.more.addEventListener('click', () => {
        const expanded = lifecycle.more.getAttribute('aria-expanded') !== 'true'; renderHistory(lifecycleEvents, expanded);
        if (!expanded) document.getElementById('dpp-lifecycle')?.scrollIntoView({ block: 'start' });
      });

      const apply = (payload) => {
        const dpp = payload && payload.dpp;
        if (!dpp) return false;
        let sourcedCount = 0;
        let missingCount = 0;
        document.querySelectorAll('[data-dpp-field]').forEach((el) => {
          const r = renderable(dig(dpp, el.dataset.dppField));
          const suffix = el.dataset.dppSuffix || '';
          if (r.text !== null) {
            el.textContent = r.text + (r.status === 'unverified' ? ' (' + marker('unverified') + ')' : '') + suffix;
            if (r.status === 'sourced') sourcedCount += 1;
            el.setAttribute('data-dpp-provenance', r.status);
          } else {
            // Etat explicite, et la valeur de demonstration disparait avec lui.
            el.textContent = marker(r.status) + suffix;
            el.setAttribute('data-dpp-provenance', r.status);
            missingCount += 1;
          }
          // La valeur n'est plus de la demonstration ni une chaine traduisible :
          // sans cela le prochain changement de langue la rendrait a nouveau.
          el.removeAttribute('data-tf-demo');
          el.removeAttribute('data-i18n');
          el.classList.add('dpp-hydrated');
        });
        document.querySelectorAll('[data-dpp-href]').forEach((el) => {
          const v = dig(payload, el.dataset.dppHref);
          if (v && typeof v === 'string') el.setAttribute('href', v);
        });
        if (dpp.productName) {
          const name = renderable(dpp.productName);
          document.title = (name.text || name.status) + ' — Digital Product Passport | TRACEFAB';
        }
        if (banner) banner.hidden = true;

        // Statut de page : 'live' seulement si l'API declare des donnees
        // sourcees. Le detail reste dans data-dpp-provenance, champ par champ.
        const declared = dpp.presentation && dpp.presentation.source;
        const statut = declared === 'live' && sourcedCount > 0
          ? 'live'
          : (sourcedCount > 0 ? 'partial' : (declared ? declared : 'empty'));
        document.documentElement.setAttribute('data-dpp-source', statut);
        renderHistory(payload.history, false);
        return true;
      };

      fetch('/api/dpp/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((payload) => { if (!apply(payload)) throw new Error('empty'); })
        .catch(() => {
          // Un identifiant réel ne retombe jamais sur les affirmations de la
          // démonstration : elles sont masquées, même en cas d'erreur réseau.
          document.documentElement.setAttribute('data-dpp-source', 'unavailable');
          if (banner) { banner.hidden = false; banner.textContent = 'Passeport indisponible ou inconnu. Aucune donnée de démonstration n’est affichée comme réelle.'; }
          if (lifecycle.status) lifecycle.status.textContent = 'L’historique public n’a pas pu être chargé. Réessayez ultérieurement.';
        });

      /* Gestionnaires de la page, enregistres dans la portee du module.
       * Les attributs inline etaient evalues en portee globale, ce qui
       * obligeait a exposer des fonctions sur window ; ici, state et render
       * sont directement accessibles. */
      window.TFActions.register({
        p01: function (event) { applyDppLang(this.value); },
      });
    })();
  
