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


      /* ---------------------------------------------------------------
       * Sections PUBLIQUES REELLES.
       *
       * Toutes les valeurs de l'API sont inserees avec textContent, jamais
       * innerHTML : un resume d'evenement ou une affirmation peut contenir
       * du HTML hostile sans l'executer. Les champs absents affichent un
       * etat explicite, jamais une valeur de demonstration.
       * --------------------------------------------------------------- */
      const live = {
        root: document.getElementById('dpp-live'),
        updated: document.getElementById('live-updated'),
        limits: document.getElementById('live-limits'),
        identity: document.getElementById('live-identity'),
        composition: document.getElementById('live-composition'),
        materials: document.getElementById('live-materials'),
        materialsEmpty: document.getElementById('live-materials-empty'),
        traceability: document.getElementById('live-traceability'),
        care: document.getElementById('live-care'),
        claims: document.getElementById('live-claims'),
        claimsEmpty: document.getElementById('live-claims-empty'),
        missing: document.getElementById('live-missing'),
      };
      const sourceLabels = {
        product_record: 'Fiche produit',
        materials_record: 'Données matières',
        supply_chain_record: 'Chaîne d’approvisionnement',
        brand_record: 'Identité de marque',
        pef_assessment: 'Évaluation environnementale',
        transaction_record: 'Certificat de transaction',
        published_record: 'Publication relue',
        computed: 'Calcul déterministe',
      };
      const claimStatusLabels = {
        declared: 'Déclaré', documented: 'Documenté', controlled: 'Contrôlé',
        corroborated: 'Corroboré', third_party_verified: 'Vérifié par un tiers',
      };
      const claimStatusExplanations = {
        declared: 'Information fournie par un acteur, sans validation indépendante.',
        documented: 'Information accompagnée d’un justificatif accepté. Cela ne vaut pas certification.',
        controlled: 'Information ayant passé les contrôles définis par TRACEFAB.',
        corroborated: 'Information soutenue par au moins deux documents concordants acceptés.',
        third_party_verified: 'Contrôle réalisé par un organisme vérificateur mandaté, identifié ci-dessous.',
      };
      const fmtDate = (value, withTime) => {
        if (!value) return null;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return null;
        const lang = document.documentElement.lang || 'fr';
        try {
          return new Intl.DateTimeFormat(lang, withTime ? { dateStyle: 'long', timeStyle: 'short' } : { dateStyle: 'long' }).format(d);
        } catch { return d.toISOString().slice(0, 10); }
      };
      const addDefinition = (dl, label, rawField, suffix) => {
        if (!dl) return;
        const row = document.createElement('div'); row.className = 'live-field';
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd');
        const r = renderable(rawField);
        let valueText;
        if (r.text !== null) {
          valueText = r.text + (suffix || '') + (r.status === 'unverified' ? ' (' + marker('unverified') + ')' : '');
        } else {
          valueText = marker(r.status) + (suffix || '');
        }
        dd.textContent = valueText;
        const source = document.createElement('span'); source.className = 'live-source';
        if (rawField && rawField.source && sourceLabels[rawField.source]) {
          source.textContent = 'Origine : ' + sourceLabels[rawField.source];
        } else if (rawField && rawField.status === 'not_filled') {
          source.textContent = 'Non renseigné par la marque';
        } else if (rawField && rawField.status === 'unavailable') {
          source.textContent = 'Donnée non disponible dans le passeport';
        } else if (rawField && rawField.status === 'unverified') {
          source.textContent = 'Valeur présente, non vérifiée';
        }
        if (source.textContent) dd.appendChild(source);
        row.append(dt, dd); dl.appendChild(row);
      };
      const statusBadge = (status, labels, explanations) => {
        const badge = document.createElement('span'); badge.className = 'live-badge';
        badge.dataset.status = status || 'unknown';
        badge.textContent = (labels && labels[status]) || 'Statut non précisé';
        if (explanations && explanations[status]) badge.title = explanations[status];
        return badge;
      };
      const renderLiveMaterials = (dpp) => {
        if (live.materials) live.materials.replaceChildren();
        const composition = renderable(dpp.composition);
        if (live.composition) {
          live.composition.textContent = composition.text !== null
            ? composition.text
            : marker(composition.status);
          live.composition.hidden = false;
        }
        const materials = Array.isArray(dpp.materials) ? dpp.materials : [];
        let shown = 0;
        for (const material of materials) {
          if (!live.materials) break;
          const name = renderable(material.name);
          const percentage = renderable(material.percentage);
          const role = renderable(material.role);
          const origin = renderable(material.originCountry);
          if (name.text === null && percentage.text === null && role.text === null && origin.text === null) continue;
          const li = document.createElement('li'); li.className = 'live-material';
          const strong = document.createElement('strong');
          strong.textContent = name.text !== null ? name.text : marker(name.status);
          li.appendChild(strong);
          const meta = document.createElement('div'); meta.className = 'live-material-meta';
          const parts = [];
          if (percentage.text !== null) parts.push(percentage.text + ' %' + (percentage.status === 'unverified' ? ' (' + marker('unverified') + ')' : ''));
          else parts.push('Pourcentage : ' + marker(percentage.status));
          if (role.text !== null) parts.push('Rôle : ' + role.text);
          if (origin.text !== null) parts.push('Origine déclarée : ' + origin.text);
          meta.textContent = parts.join(' · ');
          li.appendChild(meta);
          if (percentage.status !== 'sourced') li.appendChild(statusBadge(percentage.status, {}, {}));
          live.materials.appendChild(li);
          shown += 1;
        }
        if (live.materialsEmpty) live.materialsEmpty.hidden = shown > 0;
        if (live.composition && shown === 0 && composition.text === null) {
          live.composition.textContent = 'Aucune composition publiable n’est renseignée.';
        }
      };
      const renderLiveClaims = (payload) => {
        if (!live.claims) return;
        live.claims.replaceChildren();
        const claims = Array.isArray(payload.claims) ? payload.claims : [];
        for (const claim of claims) {
          const card = document.createElement('article'); card.className = 'live-claim';
          const statement = document.createElement('p');
          statement.textContent = String(claim.statement || '');
          card.appendChild(statement);
          card.appendChild(statusBadge(claim.validationStatus, claimStatusLabels, claimStatusExplanations));

          const meta = document.createElement('div'); meta.className = 'live-claim-meta';
          const validity = [];
          const from = fmtDate(claim.validFrom, false);
          const until = fmtDate(claim.validUntil, false);
          if (from || until) validity.push('Validité : ' + (from || '—') + ' → ' + (until || '—'));
          if (claim.expired) {
            const expired = document.createElement('span'); expired.className = 'expired';
            expired.textContent = 'Période de validité dépassée';
            meta.appendChild(expired);
          }
          if (validity.length) {
            const span = document.createElement('span'); span.textContent = validity.join(' · '); meta.appendChild(span);
          }
          const evidence = document.createElement('span');
          evidence.textContent = claim.acceptedEvidenceCount > 0
            ? `${claim.acceptedEvidenceCount} preuve${claim.acceptedEvidenceCount > 1 ? 's' : ''} acceptée${claim.acceptedEvidenceCount > 1 ? 's' : ''}`
            : 'Aucune preuve acceptée';
          meta.appendChild(evidence);
          if (claim.verifierDisplayName) {
            const verifier = document.createElement('span');
            verifier.textContent = 'Vérificateur : ' + claim.verifierDisplayName;
            meta.appendChild(verifier);
          }
          const reviewed = fmtDate(claim.reviewedAt, true);
          if (reviewed) {
            const span = document.createElement('span'); span.textContent = 'Revue le ' + reviewed; meta.appendChild(span);
          }
          card.appendChild(meta);

          if (claim.contradictingEvidenceCount > 0) {
            const contradiction = document.createElement('p'); contradiction.className = 'expired';
            contradiction.style.margin = '8px 0 0';
            contradiction.textContent = `${claim.contradictingEvidenceCount} preuve${claim.contradictingEvidenceCount > 1 ? 's' : ''} contradictoire${claim.contradictingEvidenceCount > 1 ? 's' : ''} acceptée${claim.contradictingEvidenceCount > 1 ? 's' : ''} — à examiner`;
            card.appendChild(contradiction);
          }
          if (Array.isArray(claim.evidenceLabels) && claim.evidenceLabels.length) {
            const list = document.createElement('ul'); list.className = 'live-evidence';
            for (const label of claim.evidenceLabels) {
              const li = document.createElement('li'); li.textContent = String(label); list.appendChild(li);
            }
            card.appendChild(list);
          }
          live.claims.appendChild(card);
        }
        if (live.claimsEmpty) live.claimsEmpty.hidden = claims.length > 0;
      };
      const renderLiveLimits = (dpp, payload) => {
        const presentation = dpp.presentation || {};
        const limits = dpp.limits || {};
        if (live.updated) {
          const updated = fmtDate(presentation.lastUpdatedAt, true);
          live.updated.textContent = updated
            ? 'Dernière mise à jour publique : ' + updated
            : 'Aucune date de mise à jour publique n’est disponible.';
        }
        if (live.limits) {
          live.limits.replaceChildren();
          const title = document.createElement('strong');
          title.textContent = `Complétude déclarée : ${Number(limits.missingFields) || 0} champ(s) manquant(s), ${Number(limits.unverifiedFields) || 0} non vérifié(s).`;
          live.limits.appendChild(title);
          const notice = document.createElement('p'); notice.style.margin = '6px 0 0';
          notice.textContent = limits.notice || 'Les données absentes ne sont pas remplacées par des valeurs supposées.';
          live.limits.appendChild(notice);
          const confidentiality = document.createElement('p'); confidentiality.style.margin = '6px 0 0';
          confidentiality.textContent = 'Les informations non publiées peuvent être absentes ou réservées aux acteurs autorisés ; elles ne sont jamais présentées ici comme établies.';
          live.limits.appendChild(confidentiality);
        }
        if (live.missing) {
          live.missing.replaceChildren();
          const capabilities = dpp.capabilities || {};
          const gaps = [
            !capabilities.hasComposition && 'Composition matière non publiée.',
            !capabilities.hasTraceability && 'Chaîne de traçabilité non publiée.',
            !capabilities.hasCareInstructions && 'Instructions d’entretien non publiées.',
            !capabilities.hasClaims && 'Aucune affirmation publique étayée.',
          ].filter(Boolean);
          if (Number(limits.claimsWithoutAcceptedEvidence) > 0) {
            gaps.push(`${limits.claimsWithoutAcceptedEvidence} affirmation(s) annoncent un niveau de confiance sans preuve acceptée.`);
          }
          if (!gaps.length) gaps.push('Les sections publiées ci-dessus sont renseignées ; leur niveau de contrôle reste celui indiqué, sans certification implicite.');
          for (const gap of gaps) {
            const li = document.createElement('li'); li.textContent = gap; live.missing.appendChild(li);
          }
        }
      };
      const renderStructuredData = (payload) => {
        const dpp = (payload && payload.dpp) || {};
        const sourced = (key) => dpp[key] && dpp[key].status === 'sourced' && dpp[key].value !== null && dpp[key].value !== undefined;
        const json = { '@context': 'https://schema.org', '@type': 'Product' };
        if (sourced('productName')) json.name = String(dpp.productName.value);
        if (sourced('sku')) json.sku = String(dpp.sku.value);
        if (sourced('gtin')) json.gtin = String(dpp.gtin.value);
        if (sourced('productReference')) json.model = String(dpp.productReference.value);
        if (sourced('brandName')) json.brand = { '@type': 'Brand', name: String(dpp.brandName.value) };
        if (sourced('countryOfManufacture')) json.countryOfOrigin = String(dpp.countryOfManufacture.value);
        const materials = (Array.isArray(dpp.materials) ? dpp.materials : [])
          .filter((m) => m && m.name && m.name.status === 'sourced' && m.percentage && m.percentage.status === 'sourced')
          .map((m) => ({ '@type': 'DefinedTerm', name: String(m.name.value), percentage: Number(m.percentage.value) }));
        if (materials.length) json.material = materials;
        if (dpp.presentation && dpp.presentation.lastUpdatedAt) json.dateModified = dpp.presentation.lastUpdatedAt;
        if (dpp.links && dpp.links.dppUrl) json.url = dpp.links.dppUrl;
        if (!json.name) {
          json['@type'] = 'WebPage';
          json.name = 'Digital Product Passport — TRACEFAB';
        }
        const previous = document.getElementById('dpp-jsonld');
        const script = document.createElement('script');
        script.type = 'application/ld+json';
        script.id = 'dpp-jsonld';
        script.textContent = JSON.stringify(json);
        if (previous) previous.replaceWith(script);
        else document.head.appendChild(script);

        if (json['@type'] === 'Product') {
          const title = json.name + ' — Digital Product Passport | TRACEFAB';
          document.title = title;
          const description = `${json.name} — Digital Product Passport TRACEFAB. Informations publiées par la marque ; les données absentes ou non vérifiées sont signalées comme telles.`;
          document.querySelector('meta[name="description"]')?.setAttribute('content', description.slice(0, 300));
          document.querySelector('meta[property="og:title"]')?.setAttribute('content', json.name + ' — DPP TRACEFAB');
          document.querySelector('meta[property="og:description"]')?.setAttribute('content', description.slice(0, 240));
        }
      };
      const renderLive = (payload) => {
        const dpp = (payload && payload.dpp) || {};
        if (!live.root) return;
        if (live.identity) {
          live.identity.replaceChildren();
          addDefinition(live.identity, 'Marque responsable', dpp.brandName);
          addDefinition(live.identity, 'Référence', dpp.productReference);
          addDefinition(live.identity, 'Catégorie', dpp.category);
          addDefinition(live.identity, 'Pays de fabrication', dpp.countryOfManufacture);
          addDefinition(live.identity, 'Pays de conception', dpp.countryOfDesign);
          addDefinition(live.identity, 'Poids', dpp.weightGrams, ' g');
          addDefinition(live.identity, 'Date de publication relue', dpp.verificationDate);
          addDefinition(live.identity, 'Certificat de transaction', dpp.transactionCertificateNumber);
        }
        renderLiveMaterials(dpp);
        if (live.traceability) {
          const trace = renderable(dpp.supplyChainSummary);
          live.traceability.textContent = trace.text !== null
            ? trace.text
            : 'Aucune chaîne de traçabilité publiable n’est renseignée.';
          if (trace.status === 'unverified') live.traceability.textContent += ' (' + marker('unverified') + ')';
        }
        if (live.care) {
          live.care.replaceChildren();
          addDefinition(live.care, 'Entretien', dpp.careInstructions);
          addDefinition(live.care, 'Fin de vie / recyclage', dpp.recyclingInstructions);
        }
        renderLiveClaims(payload);
        renderLiveLimits(dpp, payload);
        renderStructuredData(payload);
        live.root.hidden = false;
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
      const eventSummary = (item) => item.publicSummary ?? item.public_summary;
      const eventStatus = (item) => item.validationStatus ?? item.validation_status;
      const eventRecordedAt = (item) => item.recordedAt ?? item.recorded_at;
      const eventBusinessAt = (item) => item.businessOccurredAt ?? item.business_occurred_at;
      const renderHistory = (history, expanded) => {
        if (!lifecycle.list || !lifecycle.status) return;
        lifecycleEvents = Array.isArray(history) ? history.filter((item) => item && eventSummary(item) && eventStatus(item) !== 'rejected') : [];
        lifecycleEvents.sort((a, b) => String(eventRecordedAt(b) || '').localeCompare(String(eventRecordedAt(a) || '')));
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
          const time = document.createElement('time'); const rawDate = eventBusinessAt(item) || eventRecordedAt(item); const date = new Date(rawDate);
          time.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
          time.textContent = Number.isNaN(date.getTime()) ? 'Date non disponible' : new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(date);
          const title = document.createElement('h3'); title.className = 'lifecycle-event-title';
          title.textContent = eventSummary(item) || eventLabels[item.eventType || item.event_type] || 'Événement du produit';
          const st = eventStatus(item) || 'declared';
          const badge = document.createElement('span'); badge.className = 'trust-badge'; badge.dataset.status = st;
          badge.textContent = trustLabels[st] || 'Statut non précisé';
          badge.title = (trustExplanations[st] || 'Niveau de contrôle non précisé.')
            + (item.verifiedByName ? ' Organisme vérificateur : ' + item.verifiedByName + '.' : '');
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
        renderLive(payload);
        return true;
      };

      fetch('/api/dpp/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((payload) => { if (!apply(payload)) throw new Error('empty'); })
        .catch(() => {
          // Un identifiant réel ne retombe jamais sur les affirmations de la
          // démonstration : elles sont masquées, même en cas d'erreur réseau.
          document.documentElement.setAttribute('data-dpp-source', 'unavailable');
          if (live.root) live.root.hidden = true;
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
  
