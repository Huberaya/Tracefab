    (() => {
      'use strict';
      const app = document.getElementById('app');
      const initialParams = new URLSearchParams(location.search);
      const ROUTABLE_VIEWS = new Set([
        'overview', 'requests', 'questionnaires', 'products', 'quality', 'risk',
        'intelligence', 'massBalance', 'integrations', 'suppliers', 'materials',
        'supplyChain', 'documents', 'certifications', 'dpp', 'productDetail', 'reports', 'settings',
      ]);
      const requestedInitialView = initialParams.get('view');
      const initialView = requestedInitialView && ROUTABLE_VIEWS.has(requestedInitialView)
        ? requestedInitialView
        : 'overview';
      const initialProductId = initialParams.get('productId');
      const state = {
        lang: (typeof localStorage !== 'undefined' ? localStorage.getItem('tracefab_lang') : null) || 'en',
        clerk: null,
        loading: true,
        configError: null,
        // Aucun locataire actif exploitable : compte sans organisation de
        // marque, ou adherences pas encore chargees. Affiche explicitement,
        // jamais remplace par le jeu de demonstration.
        tenantError: null,
        // Locataire auquel les donnees actuellement chargees appartiennent.
        // Sert a distinguer un changement de locataire (vidage obligatoire) d'un
        // rechargement du meme locataire (l'etat ouvert doit survivre).
        loadedOrganizationId: null,
        routeHydrated: false,
        user: null,
        memberships: [],
        organizations: [],
        suppliers: [],
        materials: [],
        products: [],
        pages: {},
        filtres: { products: { q: '', category: '', status: '', readiness: '', incomplets: false } },
        requests: [],
        questionnaires: [],
        schemaCatalog: [],
        schemaBindings: [],
        // Les liaisons de schemas externes sont un chargement AUXILIAIRE de la
        // fiche produit. null = echoue ou jamais charge (on ne peut pas
        // afficher « aucune liaison » sur un echec) ; [] = charge et reellement
        // vide. L'erreur est portee separement pour l'etat degrade explicite.
        schemaBindingsError: null,
        // Erreur du chargement ESSENTIEL de la fiche (GET /api/products/:id) :
        // sans elle, un echec laissait la vue precedente affichee et la fiche
        // « restait invisible » sans explication.
        productDetailError: null,
        view: initialView,
        activeOrganizationId: null,
        selectedRequest: null,
        selectedProduct: null,
        selectedProductDetail: null,
        selectedSupplier: null,
        quality: null,
        qualityFilter: 'all',
        // null = aucune source chargee (on ne peut pas compter) ; [] = source
        // chargee et vide. La distinction porte tout l'ecran.
        documents: null,
        certifications: null,
        pefAssessment: null,
        greenClaimsAudit: null,
        supplyChain: null,
        massBalance: null,
        selectedSupplyChainProduct: null,
        dpp: null,
        selectedDppProduct: null,
        dppPortfolio: null,
        dppPortfolioLoading: false,
        dppScope: 'portfolio',
        modal: null,
        modalIssueId: null,
        catalogImport: { filename: '', content: '', preview: null, job: null, loading: false },
        supplierImport: { filename: '', content: '', preview: null, job: null, delivery: null, loading: false },
        toast: null,
        // Demonstration sur opt-in explicite : ?demo=0 ne doit pas basculer
        // la console dans le jeu de demonstration.
        demo: new URLSearchParams(location.search).get('demo') === '1',
      };

      function persistRoute(view = state.view, productId = null) {
        if (!ROUTABLE_VIEWS.has(view)) return;
        const url = new URL(location.href);
        url.searchParams.set('view', view);
        if (productId) url.searchParams.set('productId', productId);
        else url.searchParams.delete('productId');
        history.replaceState({ view, productId }, '', `${url.pathname}${url.search}${url.hash}`);
      }

      const PROCESS_LABELS = {
        ginning: 'Ginning',
        spinning: 'Filature (Spinning)',
        weaving: 'Tissage (Weaving)',
        knitting: 'Tricotage (Knitting)',
        dyeing: 'Teinture (Dyeing)',
        printing: 'Impression (Printing)',
        finishing: 'Ennoblissement (Finishing)',
        cutting: 'Coupe (Cutting)',
        sewing: 'Confection (Sewing)',
        assembly: 'Assemblage (Assembly)',
        laundering: 'Lavage (Laundering)',
        packaging: 'Conditionnement (Packaging)',
      };

      // Status chips used to read French in every language because this was a
      // hardcoded map. They now resolve through the catalogue.
      const STATUS_KEYS = {
        "draft": "stDraft",
        "sent": "stSent",
        "in_progress": "stInProgress",
        "submitted": "stSubmitted",
        "changes_requested": "stChangesRequested",
        "approved": "stApproved",
        "cancelled": "stCancelled",
        "verified_by_reviewer": "stVerified",
        "needs_review": "stNeedsReview",
        "open": "stOpen",
        "acknowledged": "stAcknowledged",
        "waived": "stWaived",
        "resolved": "stResolved",
        "not_started": "stNotStarted",
        "published": "stPublished",
        "data_ready": "stDataReady",
        "ready_to_publish": "stReadyToPublish",
        "review_required": "stReviewRequired",
        "active": "stActive",
        "completed": "stCompleted",
        "invited": "stInvited",
        "declared": "stDeclared",
        "documented": "stDocumented",
        "uploaded": "stUploaded",
        "scanning": "stScanning",
        "available": "stAvailable",
        "rejected": "stRejected",
        "deleted": "stDeleted",
        "suspended": "stSuspended",
        "revoked": "stRevoked"
      };
      const statusLabel = (value) => value ? bt(STATUS_KEYS[value] || value) : '—';
      const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
      const first = (value) => String(value || '').trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'TF';
      const status = (value) => `<span class="status status-${esc(value)}">${esc(statusLabel(value) || '—')}</span>`;
      const pct = (value) => Math.max(0, Math.min(100, Number(value || 0)));
      // Dates and numbers used to render French whatever the chosen language.
      const BCP47 = { fr:'fr-FR', en:'en-GB', de:'de-DE', it:'it-IT', es:'es-ES', nl:'nl-NL', pt:'pt-PT', tr:'tr-TR', zh:'zh-CN' };
      const locale = () => BCP47[state.lang] || 'en-GB';
      const date = (value) => value ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(value)) : '—';
      const moneyless = (value) => Number(value || 0).toLocaleString(locale(), { maximumFractionDigits: 0 });

      /* Verite des chiffres ------------------------------------------------
       *
       * Hors ?demo=1, aucun agregat ne peut venir du jeu de demonstration.
       * Une mesure indisponible s'affiche « non calculé » ou « inconnu » ;
       * elle ne devient jamais zero par accident, et un agregat sans
       * denominateur n'est pas un zero.
       *
       * `mesure` sert aux valeurs calculees a partir des reponses API.
       * `mesureInconnue` sert aux grandeurs qu'aucune route n'expose : la
       * console ne peut pas les calculer, elle le dit.
       */
      const estDemo = () => state.demo === true;
      const nombreLisible = (value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return Number.isInteger(n) ? moneyless(n) : n.toLocaleString(locale(), { maximumFractionDigits: 1 });
      };
      function mesure(value, suffix = '') {
        if (value === null || value === undefined || value === '') {
          return `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>`;
        }
        const texte = nombreLisible(value);
        return texte === null ? `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>` : `${texte}${suffix}`;
      }
      function mesureInconnue(value, suffix = '') {
        if (value === null || value === undefined || value === '') {
          return `<span class="uncomputed">${esc(bt('cnUnknown'))}</span>`;
        }
        const texte = nombreLisible(value);
        return texte === null ? `<span class="uncomputed">${esc(bt('cnUnknown'))}</span>` : `${texte}${suffix}`;
      }
      function grandNombre(value, color) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) {
          return `<div class="mc-stat-huge" style="font-size:17px;color:var(--muted);letter-spacing:0;">${esc(bt('cnNotComputed'))}</div>`;
        }
        const texte = nombreLisible(value);
        return `<div class="mc-stat-huge"${color ? ` style="color:${color};"` : ''}>${texte}</div>`;
      }

      /* Pagination partagee -------------------------------------------------
       *
       * Le catalogue rendait ses 1 248 lignes d'un seul bloc : 86 543 px de
       * haut, soit 96 ecrans. Le registre de risque faisait pire encore avec
       * 88 789 px. A cette taille la page n'est plus lisible, le navigateur
       * ne sait meme plus la capturer, et chaque re-rendu reconstruit des
       * milliers de noeuds pour n'en montrer qu'une vingtaine.
       *
       * On ne rend donc qu'une page a la fois. state.pages retient la page
       * courante PAR LISTE : revenir sur une vue ne renvoie pas l'utilisateur
       * au debut, ce qui est exactement ce qu'on attend quand on inspecte une
       * ligne puis qu'on revient au tableau.
       */
      const PAR_PAGE = 25;

      function trancher(cle, liste) {
        const total = liste.length;
        const nbPages = Math.max(1, Math.ceil(total / PAR_PAGE));
        // La liste peut avoir retreci depuis le dernier rendu (filtre,
        // suppression, changement d'organisation) : on borne au lieu de
        // laisser l'utilisateur sur une page devenue vide.
        const page = Math.min(Math.max(1, Number(state.pages[cle] || 1)), nbPages);
        const debut = (page - 1) * PAR_PAGE;
        return {
          lignes: liste.slice(debut, debut + PAR_PAGE),
          total, nbPages, page,
          premier: total ? debut + 1 : 0,
          dernier: Math.min(debut + PAR_PAGE, total),
        };
      }

      /* Fenetre glissante : 1 … 4 5 [6] 7 8 … 50. Jamais plus de neuf
       * entrees, pour que la barre tienne sur une ligne, y compris en 390 px
       * de large. null = separateur. */
      function numerosPages(page, nbPages) {
        const retenus = new Set([1, nbPages, page, page - 1, page + 1]);
        if (page <= 3) [2, 3, 4].forEach((n) => retenus.add(n));
        if (page >= nbPages - 2) [nbPages - 1, nbPages - 2, nbPages - 3].forEach((n) => retenus.add(n));
        const tries = [...retenus].filter((n) => n >= 1 && n <= nbPages).sort((x, y) => x - y);
        const sortie = [];
        let precedent = 0;
        for (const n of tries) {
          if (precedent && n - precedent > 1) sortie.push(null);
          sortie.push(n);
          precedent = n;
        }
        return sortie;
      }

      /* Filtrage du catalogue ----------------------------------------------
       *
       * La pagination a rendu le catalogue lisible, pas trouvable : parcourir
       * 50 pages pour atteindre une reference n'est pas une recherche. Trois
       * facettes et un champ texte suffisent ici, parce que ce sont les
       * colonnes que la table affiche deja — on filtre sur ce qu'on voit.
       */
      function normaliser(valeur) {
        // Sans depliage des accents, « Trousers » se trouve mais pas
        // « Dérogation » tape sans accent. NFD + suppression des diacritiques
        // rend la recherche indifferente aux accents comme a la casse.
        return String(valeur || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }

      function produitsFiltres() {
        const f = state.filtres.products;
        const q = normaliser(f.q).trim();
        return state.products.filter((p) => {
          if (f.category && String(p.category || '') !== f.category) return false;
          if (f.status && String(p.status || '') !== f.status) return false;
          if (f.readiness && String(p.dataReadiness || 'in_progress') !== f.readiness) return false;
          if (f.incomplets && !(Number(p.dataCompletion) < SEUIL_COMPLETUDE)) return false;
          if (!q) return true;
          return normaliser(p.name).includes(q) || normaliser(p.reference).includes(q);
        });
      }

      function filtresActifs() {
        const f = state.filtres.products;
        return Boolean(f.q || f.category || f.status || f.readiness || f.incomplets);
      }

      /* Les options viennent des donnees, jamais d'une liste ecrite en dur :
       * une liste figee se desynchronise en silence des qu'une categorie
       * apparait, et l'utilisateur ne peut plus la filtrer. */
      function optionsFacette(champ, defaut, etiquette) {
        const actuel = state.filtres.products[champ === 'dataReadiness' ? 'readiness' : champ];
        return [...new Set(state.products.map((p) => String(p[champ] || defaut)).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b))
          .map((v) => `<option value="${esc(v)}"${v === actuel ? ' selected' : ''}>`
            + `${esc(etiquette ? etiquette(v) : v)}</option>`)
          .join('');
      }

      function barreFiltres(info) {
        const f = state.filtres.products;
        const select = (champ, cleTout, options) => `
          <select class="select" data-tf-act="ff" data-tf-on="change" data-tf-arg="${champ}"
                  aria-label="${esc(bt(cleTout))}">
            <option value="">${esc(bt(cleTout))}</option>${options}
          </select>`;
        return `
          <div class="filters filters--catalogue" role="search">
            <input id="pd-recherche" type="search" class="input"
                   value="${esc(f.q)}" placeholder="${esc(bt('pdSearchPlaceholder'))}"
                   aria-label="${esc(bt('pdSearchLabel'))}"
                   data-tf-act="fq" data-tf-on="input" autocomplete="off">
            ${select('category', 'pdAllCategories', optionsFacette('category', '', null))}
            ${select('status', 'pdAllStatuses', optionsFacette('status', '', (v) => statusLabel(v) || v))}
            ${select('readiness', 'pdAllReadiness', optionsFacette('dataReadiness', 'in_progress', (v) => statusLabel(v) || v))}
            ${f.incomplets ? `<span class="filters-chip">${esc(bt('pdOnlyIncomplete'))}</span>` : ''}
            ${filtresActifs() ? `<button type="button" class="btn btn-secondary btn-small"
              data-tf-act="fx">${esc(bt('pdClearFilters'))}</button>` : ''}
            ${filtresActifs() ? `<p class="filters-count">${esc(bt('pdMatching'))}
              <strong>${moneyless(info.total)}</strong> ${esc(bt('pagerOf'))}
              <strong>${moneyless(state.products.length)}</strong></p>` : ''}
          </div>`;
      }

      function barrePagination(cle, info) {
        // Sous un ecran de lignes, une barre de pagination n'apporte rien
        // qu'un encombrement : on ne l'affiche pas.
        if (info.total <= PAR_PAGE) return '';
        const numero = (n) => (n === null
          ? '<span class="pager-gap" aria-hidden="true">…</span>'
          : `<button type="button" class="pager-num${n === info.page ? ' is-current' : ''}"`
            + ` data-tf-act="pg" data-tf-arg="${esc(cle)}:${n}"`
            + `${n === info.page ? ' aria-current="page"' : ''}>${moneyless(n)}</button>`);
        const etape = (vers, libelle, inactif) => `<button type="button" class="pager-step"`
          + ` data-tf-act="pg" data-tf-arg="${esc(cle)}:${vers}"${inactif ? ' disabled' : ''}>`
          + `${esc(bt(libelle))}</button>`;
        return `
          <nav class="pager" aria-label="${esc(bt('pagerLabel'))}">
            <p class="pager-count">${esc(bt('pagerShowing'))}
              <strong>${moneyless(info.premier)}–${moneyless(info.dernier)}</strong>
              ${esc(bt('pagerOf'))} <strong>${moneyless(info.total)}</strong></p>
            <div class="pager-controls">
              ${etape(info.page - 1, 'pagerPrev', info.page === 1)}
              ${numerosPages(info.page, info.nbPages).map(numero).join('')}
              ${etape(info.page + 1, 'pagerNext', info.page === info.nbPages)}
            </div>
          </nav>`;
      }

      function notify(message, isError = false) {
        state.toast = { message, isError };
        render();
        setTimeout(() => { state.toast = null; render(); }, 3500);
      }

      const TENANT_HEADER = 'X-Tracefab-Organization-Id';
      // Routes qui determinent le locataire actif : elles ne peuvent pas le
      // porter, puisqu'il n'est pas encore connu.
      const TENANT_FREE_PATHS = /^\/api\/(me|organizations|config)(\?|$)/;

      let cachedSessionToken = null;
      let cachedSessionTokenAt = 0;
      let sessionTokenPromise = null;
      async function sessionToken() {
        if (!state.clerk?.session) return null;
        // Toutes les lectures initiales partent ensemble. Sans déduplication,
        // chacune attendait séparément Clerk.getToken(), ajoutant plusieurs
        // allers-retours au chemin critique. Cache très court : l'API/RLS reste
        // l'autorité et le jeton Clerk conserve sa propre expiration.
        if (cachedSessionToken && Date.now() - cachedSessionTokenAt < 30000) return cachedSessionToken;
        if (!sessionTokenPromise) {
          sessionTokenPromise = state.clerk.session.getToken()
            .then((token) => {
              cachedSessionToken = token || null;
              cachedSessionTokenAt = Date.now();
              return cachedSessionToken;
            })
            .finally(() => { sessionTokenPromise = null; });
        }
        return sessionTokenPromise;
      }

      async function api(path, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (!state.demo && state.clerk?.session) {
          const token = await sessionToken();
          if (token) headers.Authorization = `Bearer ${token}`;
        }
        // Locataire actif sur CHAQUE appel prive. Le serveur l'exige : une
        // requete qui ne nomme pas son locataire recoit 400
        // `organization_id_required` et n'est jamais elargie au compte entier.
        // `/api/me` et `/api/organizations` determinent le locataire : ils sont
        // les seuls a pouvoir s'en passer.
        if (!state.demo && state.activeOrganizationId && !TENANT_FREE_PATHS.test(path)) {
          headers[TENANT_HEADER] = state.activeOrganizationId;
        }
        const response = await fetch(path, { ...options, headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || `request_failed_${response.status}`);
        return payload;
      }

      // Jeu de demonstration a l echelle. Les chiffres de la vue d ensemble

      // annonçaient 1 248 produits et 86 fournisseurs alors que l etat n en

      // portait que 2 et 1 : un responsable conformite qui passait d un ecran a

      // l autre lisait deux verites differentes. Les enregistrements sont

      // desormais reellement semes, et les compteurs les comptent.

      // Generateur deterministe : la meme graine donne toujours les memes

      // chiffres, aucune derive entre deux rechargements.

      const DEMO_PAYS = [

        ['PT','Portugal'], ['IT','Italy'], ['FR','France'], ['DE','Germany'],

        ['TR','Türkiye'], ['IN','India'], ['BD','Bangladesh'], ['VN','Vietnam'],

        ['CN','China'], ['MA','Morocco'], ['TN','Tunisia'], ['US','United States'],

        ['ES','Spain'], ['PL','Poland'], ['RO','Romania'], ['GR','Greece'],

        ['EG','Egypt'], ['LK','Sri Lanka'],

      ];

      function demoAlea(graine) {

        let a = graine >>> 0;

        return () => {

          a = (a + 0x6d2b79f5) >>> 0;

          let t = Math.imul(a ^ (a >>> 15), 1 | a);

          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;

        };

      }

      /* Source unique des chiffres de demonstration. Le repli ci-dessous ne
       * sert que si /assets/js/tf-demo-figures.js n'a pas ete charge ; il ne
       * doit jamais diverger de lui, et test:coherence le verifie. Il etait
       * recopie a trois endroits : une seule copie desormais. */
      /* Completude a partir de laquelle les donnees d'un produit sont jugees
       * suffisantes. Le nombre vivait en trois exemplaires — generation,
       * pastille du tableau de bord, registre de risque — qui pouvaient
       * deriver separement et faire mentir l'un des trois. */
      const SEUIL_COMPLETUDE = 70;

      function chiffresDemo() {
        return (typeof window !== 'undefined' && window.TF_DEMO_FIGURES) || {
          produits: 1248, fournisseurs: 86, sites: 214, pays: 18,
          qualite: 92.4, preuves: 84, verifies: 78, tracables: 91, dpp: 88,
          elementsPreuve: 9847, signauxOuverts: 42,
          attention: { donneesManquantes: 17, certificatsExpirant: 8,
            fournisseursARevoir: 5, produitsIncomplets: 12 },
        };
      }

      function demoEchelle() {

        const r = demoAlea(20260407);

        // Les cibles viennent de /assets/js/tf-demo-figures.js, partage avec
        // l'accueil. Les valeurs ci-dessous ne sont qu'un repli si le fichier
        // n'a pas ete charge : elles ne doivent jamais diverger de lui, et un
        // test le verifie.
        const CHIFFRES = chiffresDemo();
        const CIBLE_FOURNISSEURS = CHIFFRES.fournisseurs,
              CIBLE_PRODUITS = CHIFFRES.produits,
              CIBLE_SITES = CHIFFRES.sites;

        const formes = ['Textile Mill','Spinning Co','Dye House','Knitwear','Weaving','Finishing','Garment Works','Trims'];

        const categories = ['T-shirt','Shirt','Trousers','Knitwear','Dress','Jacket','Accessory','Denim'];

        // La maturite n'est plus tiree au sort ici : calibrerTaux la
        // construit, avec les seules valeurs de l'enum product_data_readiness.

      

        // sites repartis sur les fournisseurs, somme exactement egale a la cible

        const manqueF = CIBLE_FOURNISSEURS - state.suppliers.length;

        const parFournisseur = new Array(Math.max(manqueF, 0)).fill(1);

        let reste = CIBLE_SITES - state.suppliers.length - parFournisseur.length;

        for (let i = 0; reste > 0 && parFournisseur.length; i = (i + 1) % parFournisseur.length) {

          const ajout = Math.min(reste, 1 + Math.floor(r() * 3));

          parFournisseur[i] += ajout; reste -= ajout;

        }

      

        for (let i = 0; i < manqueF; i += 1) {

          const [code, pays] = DEMO_PAYS[i % DEMO_PAYS.length];

          const rang = 1 + (i % 4);

          state.suppliers.push({

            id: `demo-supplier-${i + 2}`,

            organization_id: `demo-org-${i + 2}`,

            relationship_id: `demo-rel-${i + 2}`,

            demoGenerated: true,

            tier: `Tier ${rang}`,

            countryCode: code,

            facilityCount: parFournisseur[i] || 1,
          certificateCount: 1 + Math.floor(r() * 2),

            dataQuality: 85 + Math.floor(r() * 15),

            organizations: {

              id: `demo-org-${i + 2}`,

              type: 'supplier',

              display_name: `${pays} ${formes[i % formes.length]} ${String(i + 1).padStart(2, '0')}`,

              country_code: code,

            },

          });

        }

      

        const manqueP = CIBLE_PRODUITS - state.products.length;

        for (let i = 0; i < manqueP; i += 1) {

          const cat = categories[i % categories.length];

          state.products.push({

            id: `demo-product-g${i + 3}`,

            brandOrganizationId: 'demo-brand',

            reference: `AW26-${String(i + 3).padStart(4, '0')}`,

            name: `${cat} ${String(i + 3).padStart(4, '0')}`,

            category: cat,

            status: r() > 0.12 ? 'active' : 'draft',

            version: 1 + Math.floor(r() * 3),


            demoGenerated: true,

            traceable: r() < 0.91,

            evidenceCovered: r() < 0.84,

            thirdPartyVerified: r() < 0.78,

            dppScore: 78 + Math.floor(r() * 21),

          });

        }

        calibrerTaux();
      }

      /* Calibrage des taux.
       *
       * Les effectifs etaient deja construits pour tomber juste. Les taux,
       * eux, etaient tires au sort : `r() < 0.84` sur 1 248 produits donne
       * 85,3 %, pas 84 %. L'ecart entre la console et l'accueil n'etait pas
       * un desaccord sur la valeur, c'etait du bruit d'echantillonnage
       * affiche comme une mesure.
       *
       * On pose donc un quota exact, etale sur toute la liste plutot que
       * groupe en tete : une page de resultats reste ainsi representative du
       * total, ce qui ne serait pas le cas si les 84 % couverts occupaient
       * les 84 premiers pour cent de la liste.
       */
      function calibrerTaux() {
        const CHIFFRES = chiffresDemo();
        const produits = state.products || [], fournisseurs = state.suppliers || [];

        // `parmi` restreint le vivier. La verification par tiers est un
        // sous-ensemble de la couverture de preuve : un produit verifie sans
        // preuve est une incoherence, et c'est exactement celle que le
        // validateur du semeur de pilote refuse. Le jeu de demonstration doit
        // respecter ses propres regles.
        const quota = (liste, champ, ciblePct, parmi, decalage) => {
          const total = liste.length;
          if (!total) return;
          const voulu = Math.round((ciblePct / 100) * total);
          liste.forEach((x) => { x[champ] = false; });
          const vivier = parmi ? liste.filter((x) => x[parmi]) : liste;
          const n = vivier.length;
          if (!n) return;
          const aPoser = Math.min(voulu, n);
          let poses = 0;
          for (let k = 0; k < n; k += 1) {
            const du = Math.floor(((k + 1) * aPoser) / n);
            if (du > poses) { vivier[(k + decalage) % n][champ] = true; poses = du; }
          }
        };
        quota(produits, 'evidenceCovered', CHIFFRES.preuves, null, 0);
        quota(produits, 'thirdPartyVerified', CHIFFRES.verifies, 'evidenceCovered', 0);
        quota(produits, 'traceable', CHIFFRES.tracables, null, 113);

        // Pour les moyennes on garde la dispersion tiree au sort et on
        // deplace seulement le centre. Forcer chaque valeur a la cible
        // donnerait une liste ou tous les fournisseurs ont la meme note, ce
        // qui ne ressemble a aucun portefeuille reel.
        const centrer = (liste, champ, cible, bas, haut) => {
          const vals = liste.filter((x) => typeof x[champ] === 'number');
          if (!vals.length) return;
          const vise = Math.round(cible * vals.length);
          let somme = vals.reduce((a, x) => a + x[champ], 0);
          for (let garde = 0; somme !== vise && garde < vals.length * 80; garde += 1) {
            const pas = somme < vise ? 1 : -1;
            const x = vals[garde % vals.length];
            const prochaine = x[champ] + pas;
            if (prochaine >= bas && prochaine <= haut) { x[champ] = prochaine; somme += pas; }
          }
        };
        centrer(fournisseurs, 'dataQuality', CHIFFRES.qualite, 60, 100);
        centrer(produits, 'dppScore', CHIFFRES.dpp, 40, 100);

        /* Completude et maturite des produits.
         *
         * Trois defauts se cumulaient ici. Les produits generes n'avaient
         * aucun dataCompletion : la table affichait 0 % sur 1 246 references
         * pendant que l'accueil annoncait « 12 produits incomplets ». Leur
         * dataReadiness valait 'verified', absent de l'enum
         * product_data_readiness — le libelle sortait donc brut et non
         * traduit. Et le registre de risque comparait a 'ready', valeur que
         * rien ne produit : les 1 248 produits etaient signales, soit un
         * registre qui ne hierarchise plus rien.
         *
         * On ne tire donc pas au sort : on CONSTRUIT la distribution
         * annoncee. Le registre retenant au plus un signal par produit
         * (completude sous le seuil, sinon donnees non validees), deux
         * nombres suffisent a le determiner.
         */
        const repartirCompletude = (liste, seuil, nbIncomplets, nbSignaux) => {
          const n = liste.length;
          if (!n) return;
          const incomplets = Math.max(0, Math.min(nbIncomplets, n));
          const aRevoir = Math.max(0, Math.min(nbSignaux - incomplets, n - incomplets));

          // Tout le monde part conforme. La dispersion reste visible — un
          // catalogue ou chaque produit afficherait la meme valeur ne
          // ressemblerait a rien.
          liste.forEach((p, i) => {
            p.dataCompletion = (seuil + 2) + ((i * 7) % (99 - seuil));
            p.dataReadiness = 'data_ready';
          });

          // Les defauts sont poses a pas regulier : groupes en tete, ils
          // tomberaient tous sur la premiere page du catalogue et donneraient
          // une impression fausse.
          const total = incomplets + aRevoir;
          const pas = total ? Math.max(1, Math.floor(n / total)) : 1;
          let place = 0;
          for (let k = 0; k < incomplets; k += 1, place += 1) {
            const p = liste[(place * pas) % n];
            p.dataCompletion = (seuil - 48) + ((k * 13) % 42);
            p.dataReadiness = k % 2 ? 'needs_review' : 'in_progress';
          }
          for (let k = 0; k < aRevoir; k += 1, place += 1) {
            // Complets mais non valides : le second motif de signal.
            liste[(place * pas) % n].dataReadiness = 'needs_review';
          }
        };
        repartirCompletude(produits, SEUIL_COMPLETUDE,
          (CHIFFRES.attention && CHIFFRES.attention.produitsIncomplets) || 0,
          CHIFFRES.signauxOuverts || 0);
      }

      // Agregats de la vue d ensemble, tous derives de l etat ci-dessus.

      function demoAgregats() {

        const pr = state.products || [], su = state.suppliers || [];

        const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

        const sites = su.reduce((a, s) => a + (s.facilityCount || 1), 0);

        const pays = new Set(su.map((s) => s.countryCode || (s.organizations && s.organizations.country_code)).filter(Boolean));

        const qualites = su.map((s) => s.dataQuality).filter((n) => typeof n === 'number');

        return {

          produits: pr.length,

          fournisseurs: su.length,

          sites,

          pays: pays.size,

          qualite: qualites.length ? Math.round((qualites.reduce((a, b) => a + b, 0) / qualites.length) * 10) / 10 : 0,

          preuves: pct(pr.filter((p) => p.evidenceCovered).length, pr.length),

          verifies: pct(pr.filter((p) => p.thirdPartyVerified).length, pr.length),

          tracables: pct(pr.filter((p) => p.traceable).length, pr.length),
    dpp: (() => {
      const s = pr.map((x) => x.dppScore).filter((n) => typeof n === 'number');
      return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : 0;
    })(),

          certificats: (state.certifications || []).length + su.reduce((a, s) => a + (s.certificateCount || 0), 0),

        };

      }

      /* Agregats de production : uniquement ce que les routes renvoient.
       *
       * Aucun champ de demonstration (evidenceCovered, dppScore, dataQuality,
       * certificateCount, facilityCount) n'entre ici : ces champs n'existent
       * pas dans les reponses de /api/suppliers et /api/products. Les
       * grandeurs qu'aucune route n'expose valent null, et l'ecran affiche
       * « non calculé » ou « inconnu » plutot qu'un zero trompeur.
       */
      // Agregats de la vue d'ensemble. En demonstration, le generateur ;
      // sinon, uniquement les reponses API.
      function agregatsVue(demo) {
        if (demo) {
          const ag = demoAgregats();
          return ag;
        }
        return productionAgregats();
      }

      function productionAgregats() {
        const pr = state.products || [], su = state.suppliers || [];
        const pays = new Set(su.map((s) => s.countryCode || (s.organizations && s.organizations.country_code)).filter(Boolean));
        const completions = pr
          .map((p) => (p.dataCompletion === null || p.dataCompletion === undefined || p.dataCompletion === '' ? NaN : Number(p.dataCompletion)))
          .filter((n) => Number.isFinite(n));
        const portfolio = state.dppPortfolio;
        const portfolioTotal = portfolio ? Number(portfolio.totalProducts || 0) : 0;
        const dpp = portfolio && portfolioTotal > 0 && Number.isFinite(Number(portfolio.readinessScore))
          ? Number(portfolio.readinessScore)
          : null;
        return {
          produits: pr.length,
          fournisseurs: su.length,
          // Aucune route ne renvoie le nombre de sites : inconnu des qu'il y a
          // un fournisseur, trivialement nul quand il n'y en a aucun.
          sites: su.length === 0 ? 0 : null,
          pays: pays.size,
          // La completude produit est un champ reel (data_completion). Les
          // autres dimensions de qualite ne sont pas exposees en liste.
          qualite: completions.length
            ? Math.round((completions.reduce((a, b) => a + b, 0) / completions.length) * 10) / 10
            : null,
          preuves: null,
          verifies: null,
          tracables: null,
          dpp,
          // Certificats : chargement absent de cette console. Zero seulement
          // s'il n'existe aucun fournisseur dont on pourrait en attendre.
          certificats: Array.isArray(state.certifications)
            ? state.certifications.length
            : (su.length === 0 ? 0 : null),
          lineage: null,
          gpsPolygons: null,
          massBalanced: null,
          gs1Styles: null,
          agec: null,
          pef: null,
        };
      }

      function productionAttention() {
        const reqs = state.requests || [];
        const sup = state.suppliers || [];
        const clos = (r) => ['approved', 'cancelled', 'completed', 'accepted'].includes(r.status);
        const enAttente = new Set(reqs
          .filter((r) => !clos(r) && Number(r.completionPercentage) < 100)
          .map((r) => r.supplierOrganizationId)
          .filter(Boolean));
        const sansPays = sup.filter((s) => !(s.organizations && s.organizations.country_code));
        const certificats = Array.isArray(state.certifications)
          ? state.certifications.filter((c) => {
            const echeance = Date.parse(c.expires);
            return Number.isFinite(echeance) && echeance - Date.now() <= 90 * 86400000;
          }).length
          : (sup.length === 0 ? 0 : null);
        const produits = state.products || [];
        const completionConnue = (p) => p.dataCompletion !== null
          && p.dataCompletion !== undefined && p.dataCompletion !== ''
          && Number.isFinite(Number(p.dataCompletion));
        return {
          donneesManquantes: enAttente.size,
          certificatsExpirant: certificats,
          // Aucun score de completude fournisseur n'est expose : on compte
          // seulement le signal de revue reellement observable (pays absent).
          fournisseursARevoir: sup.length === 0 ? 0 : sansPays.length,
          // « Incomplet » exige une completude connue. Si aucune ne l'est,
          // le compte n'est pas zero : il est inconnu.
          produitsIncomplets: produits.length === 0
            ? 0
            : (produits.every(completionConnue)
              ? produits.filter((p) => Number(p.dataCompletion) < SEUIL_COMPLETUDE).length
              : null),
        };
      }

      function demoData() {
        state.user = { fullName: 'Camille Martin', email: 'camille@atelier-demo.fr' };
        state.organizations = [
          { organization_id: 'demo-brand', role: 'owner', organizations: { id: 'demo-brand', type: 'brand', display_name: 'Atelier Demo', legal_name: 'Atelier Demo' } },
          { organization_id: 'demo-supplier', role: 'manager', organizations: { id: 'demo-supplier', type: 'supplier', display_name: 'Nhãn Textile', legal_name: 'Nhãn Textile' } },
        ];
        state.memberships = state.organizations;
        state.suppliers = [{ id: 'demo-supplier-record', organization_id: 'demo-supplier', relationship_id: 'demo-relationship', organizations: { id: 'demo-supplier', type: 'supplier', display_name: 'Nhãn Textile', legal_name: 'Nhãn Textile', country_code: 'PT', status: 'active' } }];
        state.materials = [{ id: 'demo-material-1', name: 'Organic cotton', materialType: 'fiber', originCountryCode: 'PT' }];
        state.products = [
          { id: 'demo-product-1', brandOrganizationId: 'demo-brand', reference: 'AT-ESS-001', name: 'Cotton Essential', category: 'T-shirt', status: 'active', version: 2, dataReadiness: 'needs_review', dataCompletion: '82' },
          { id: 'demo-product-2', brandOrganizationId: 'demo-brand', reference: 'AT-LIN-004', name: 'Natural Linen Line', category: 'Shirt', status: 'draft', version: 1, dataReadiness: 'in_progress', dataCompletion: '46' },
        ];
        demoEchelle();
        state.requests = [
          { id: 'demo-request-1', brandOrganizationId: 'demo-brand', supplierOrganizationId: 'demo-supplier', title: 'Product data — Autumn collection', questionnaireKey: 'product-data-core', questionnaireVersion: '1.0', status: 'in_progress', dueAt: new Date(Date.now() + 5 * 86400000).toISOString(), completionPercentage: '64', lastActivityAt: new Date().toISOString() },
          {
          id: 'demo-request-2',
          brandOrganizationId: 'demo-brand',
          supplierOrganizationId: 'demo-supplier',
          title: 'Origin and composition — Cotton Essential',
          questionnaireKey: 'product-data-core',
          questionnaireVersion: '1.0',
          status: 'submitted',
          dueAt: new Date(Date.now() + 2 * 86400000).toISOString(),
          completionPercentage: '100',
          lastActivityAt: new Date(Date.now() - 86400000).toISOString(),
          items: [
            {
              id: 'req-item-1',
              label: 'Certificat de Transaction GOTS (Fibre & Fil)',
              fieldKey: 'gots_tc_document',
              required: true,
              dataType: 'document_proof',
              helpText: 'Transaction certificate issued by Control Union (CU-881294).',
              status: 'submitted',
              documentName: 'GOTS_Transaction_Certificate_TC2026.pdf',
              documentSize: '1.2 MB',
              responses: [
                {
                  id: 'resp-item-1',
                  isCurrent: true,
                  status: 'documented',
                  value: 'CU-881294 (GOTS v6.0 - 85% combed organic cotton)',
                  reviewerNote: 'Documentary evidence inspected. The batch number matches the Fiação Norte delivery note.'
                }
              ]
            },
            {
              id: 'req-item-2',
              label: 'Chemical compliance & RSL (OEKO-TEX Standard 100)',
              fieldKey: 'oekotex_rsl_compliance',
              required: true,
              dataType: 'document_proof',
              helpText: 'Rapport d\'essais analytiques garantissant l\'absence of azo dyes.',
              status: 'submitted',
              documentName: 'OEKO_TEX_Test_Report_Appendix4.pdf',
              documentSize: '2.4 MB',
              responses: [
                {
                  id: 'resp-item-2',
                  isCurrent: true,
                  status: 'documented',
                  value: 'Hohenstein report #21.HPT.94112 — zero restricted substances',
                  reviewerNote: null
                }
              ]
            },
            {
              id: 'req-item-3',
              label: 'Garment Workshop Social Audit (SMETA 4-Pillar)',
              fieldKey: 'smeta_social_audit',
              required: true,
              dataType: 'document_proof',
              helpText: 'Attestation of compliance with decent work and safety standards.',
              status: 'submitted',
              documentName: 'SMETA_4Pillar_Audit_Porto_2026.pdf',
              documentSize: '4.8 MB',
              responses: [
                {
                  id: 'resp-item-3',
                  isCurrent: true,
                  status: 'verified_by_reviewer',
                  value: 'Audit SMETA valide jusqu\'to 15 January 2028 (score A)',
                  reviewerNote: 'Verified by Camille Martin on 04/10/2026: decent wages and fire safety validated.'
                }
              ]
            }
          ]
        },
        ];
        state.selectedChainNode = 'node-fiber';
        state.chainNodes = {
          'node-fiber': {
            id: 'node-fiber',
            tier: 'Tier 4',
            title: 'Fibre cultivation (cotton)',
            entity: 'Quinta de São Martinho',
            facilityType: 'Regenerative farm',
            location: 'Alentejo, Portugal (PT)',
            coordinates: '38.0151° N, 7.8632° W',
            certifications: ['GOTS v6.0 (CU-881294)', 'Regenerative Organic'],
            batchLot: 'LOT-PT-2026-CTN-089',
            auditor: 'Control Union Netherlands',
            auditScore: '100% Conforme',
            evidenceFiles: [
              { name: 'GOTS_Transaction_Certificate_TC2026.pdf', size: '1.2 MB', date: '12 Avr 2026' },
              { name: 'Soil_Health_Carbon_Report.pdf', size: '3.4 MB', date: '04 Mar 2026' }
            ],
            metrics: { massReconciled: '100%', waterEfficiency: '-72% vs conventionnel', pesticideUse: '0.0 kg/ha' },
            status: 'approved'
          },
          'node-spinning': {
            id: 'node-spinning',
            tier: 'Tier 3',
            title: 'Filature & Peignage',
            entity: 'Fiação Norte Lda',
            facilityType: 'Combing and rotor spinning unit',
            location: 'Guimarães, Portugal (PT)',
            coordinates: '41.4425° N, 8.2918° W',
            certifications: ['OEKO-TEX Standard 100', 'ISO 9001:2015'],
            batchLot: 'YARN-30-1-COMBED-89',
            auditor: 'CITEVE Portugal',
            auditScore: '98.5% count quality',
            evidenceFiles: [
              { name: 'Yarn_Tensile_Strength_Report.pdf', size: '890 KB', date: '22 Avr 2026' }
            ],
            metrics: { massReconciled: '99.4%', yarnTension: '18.4 cN/tex', spindleSpeed: '18,000 RPM' },
            status: 'approved'
          },
          'node-mill': {
            id: 'node-mill',
            tier: 'Tier 3',
            title: 'Tricotage Jersey Circulaire',
            entity: 'Malhas do Ave',
            facilityType: 'Large-diameter industrial knitting',
            location: 'Santo Tirso, Portugal (PT)',
            coordinates: '41.3431° N, 8.4738° W',
            certifications: ['GOTS Mill Certified', 'BCI Member'],
            batchLot: 'FAB-JERSEY-185-NVY',
            auditor: 'SGS Inspection Europe',
            auditScore: 'Conforme A+',
            evidenceFiles: [
              { name: 'Knitting_Grammage_Report_185gsm.pdf', size: '1.1 MB', date: '02 Mai 2026' }
            ],
            metrics: { massReconciled: '98.9%', grammage: '185 g/m² (±1.5%)', shrinkageTolerance: '< 2.5%' },
            status: 'approved'
          },
          'node-dyeing': {
            id: 'node-dyeing',
            tier: 'Tier 2',
            title: 'Ennoblissement & Teinture',
            entity: 'Tinturaria Braga Lda',
            facilityType: 'Closed-loop dye house',
            location: 'Braga, Portugal (PT)',
            coordinates: '41.5454° N, 8.4265° W',
            certifications: ['OEKO-TEX STeP (Level 3)', 'ZDHC MRSL Level 3'],
            batchLot: 'DYE-NAVY-ECO-04',
            auditor: 'Hohenstein Institute',
            auditScore: 'ZDHC Zero Discharge',
            evidenceFiles: [
              { name: 'Effluent_Water_Analysis_Q1_2026.pdf', size: '4.2 MB', date: '28 Avr 2026' }
            ],
            metrics: { waterRecycled: '94%', chemicalPassRate: '100%', colorFastness: 'Note 4-5/5' },
            status: 'approved'
          },
          'node-assembly': {
            id: 'node-assembly',
            tier: 'Tier 1',
            title: 'Confection & Coupe-Couture',
            entity: 'Nhãn Textile Confeção',
            facilityType: 'Atelier principal de confection',
            location: 'Porto, Portugal (PT)',
            coordinates: '41.1579° N, 8.6291° W',
            certifications: ['SMETA 4-Pillar (Social & Safety)', 'ISO 14001:2018'],
            batchLot: 'CMT-PO-2026-9921',
            auditor: 'Bureau Veritas',
            auditScore: 'SMETA score: zero non-conformity',
            evidenceFiles: [
              { name: 'SMETA_Social_Audit_Full_Report.pdf', size: '5.8 MB', date: '15 Jan 2026' }
            ],
            metrics: { onTimeDelivery: '99.2%', reworkRate: '0.4%', livingWageCoverage: '100%' },
            status: 'approved'
          },
          'node-product': {
            id: 'node-product',
            tier: 'Produit / DPP',
            title: 'Produit Fini & Passeport DPP',
            entity: 'Atelier Demo (Donneur d\'ordre)',
            facilityType: 'Distribution & ESPR passport issuance',
            location: 'Paris, France (FR)',
            coordinates: '48.8566° N, 2.3522° E',
            certifications: ['CIRPASS DPP Spec 1.2', 'AGEC Act record validated'],
            batchLot: 'AT-ESS-001 (Collection FW26)',
            auditor: 'TRACEFAB Continuous RegTech Engine',
            auditScore: 'Quality score: 96% (verified)',
            evidenceFiles: [
              { name: 'CIRPASS_DPP_Export_JSONLD.jsonld', size: '48 KB', date: '06 Oct 2026' }
            ],
            metrics: { totalTraceability: '100%', readinessDPP: '94%', consumerScans: '1,420 scans' },
            status: 'approved'
          }
        };
        state.questionnaires = [
          {
            key: 'product-data-core',
            version: '1.0',
            title: 'Core Product Audit',
            category: 'General',
            description: 'Product data, material composition and assembly workshops.',
            itemCount: 5,
            requiredItemCount: 4,
            fields: [
              { id: 'f-1', key: 'product_composition', label: 'Exact material composition (%)', type: 'composition_table', required: true, helpText: bt('cnHintFibre') },
              { id: 'f-2', key: 'country_of_spinning', label: 'Country of spinning', type: 'country_code', required: true, helpText: 'Code pays ISO 3166-1 alpha-2' },
              { id: 'f-3', key: 'facility_registration', label: 'Main production site', type: 'facility_select', required: true, helpText: bt('cnHintSites') },
              { id: 'f-4', key: 'care_instructions', label: 'Washing and care instructions', type: 'text_multiline', required: false, helpText: bt('cnHintCare') }
            ]
          },
          {
            key: 'textile-chemical-reach',
            version: '2.1',
            title: 'Chemical & Dyeing Compliance (REACH / ZDHC)',
            category: 'Chemistry & Effluents',
            description: 'Audit of chemical inputs, heavy metals and analysis of dyeing water effluents.',
            itemCount: 4,
            requiredItemCount: 3,
            fields: [
              { id: 'c-1', key: 'rsl_test_report', label: 'RSL laboratory test report (< 12 months)', type: 'document_proof', required: true, helpText: bt('cnHintIso') },
              { id: 'c-2', key: 'zdhc_level', label: 'ZDHC MRSL conformance level', type: 'select_single', required: true, helpText: bt('cnHintLevel') },
              { id: 'c-3', key: 'closed_loop_water', label: 'Dyeing water recycling rate', type: 'percentage_number', required: false, helpText: bt('cnHintReuse') }
            ]
          },
          {
            key: 'social-fair-wage',
            version: '1.5',
            title: 'Audit Social & Droits Humains (SMETA / SA8000)',
            category: 'Social & CSR',
            description: 'Verification of ILO convention compliance, fire safety and decent wages.',
            itemCount: 4,
            requiredItemCount: 4,
            fields: [
              { id: 's-1', key: 'social_audit_file', label: 'Full third-party social audit report', type: 'document_proof', required: true, helpText: bt('cnHintSmeta') },
              { id: 's-2', key: 'audit_score_letter', label: 'Overall audit score', type: 'text_short', required: true, helpText: bt('cnHintScore') },
              { id: 's-3', key: 'living_wage_attestation', label: 'Living Wage attestation', type: 'document_proof', required: true, helpText: bt('cnHintWage') }
            ]
          },
          {
            key: 'carbon-pef-footprint',
            version: '1.0',
            title: 'Carbon Footprint & PEF Tier 3',
            category: 'Environment',
            description: 'Electricity and fuel consumption of looms and spinning mills.',
            itemCount: 3,
            requiredItemCount: 2,
            fields: [
              { id: 'e-1', key: 'kwh_per_kg', label: 'Electricity consumed (kWh/kg of knit)', type: 'decimal_number', required: true, helpText: 'Compteurs divisionnaires de l\'atelier' },
              { id: 'e-2', key: 'renewable_energy_ratio', label: 'Share of renewable electricity (%)', type: 'percentage_number', required: false, helpText: 'Garanties d\'origine ou panneaux solaires sur site' }
            ]
          }
        ];
        state.schemaCatalog = [{ key: 'product-data-core', version: '1.0', title: 'Product data core', description: 'Versioned product facts.', subjectTypes: ['product', 'data_request'], fields: [] }];
        state.schemaBindings = [];

        // --- Chantier 4 : ces deux vues atterrissaient sur un etat vide ---
        // L'etat vide est legitime en production. En demonstration il prive
        // le visiteur des deux vues qui portent justement la promesse
        // reglementaire. Donnees de DEMONSTRATION : le bandeau en haut de
        // page les identifie comme telles, et les echeances sont calculees
        // en relatif pour ne jamais perimer.
        const dans = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
        state.certifications = [
          { standard: 'GOTS 7.0', number: 'CU-GOTS-884213', issuer: 'Control Union', expires: dans(412) },
          { standard: 'OEKO-TEX STANDARD 100', number: 'SH025-174412-TESTEX', issuer: 'TESTEX', expires: dans(31) },
          { standard: 'GRS 4.0', number: 'CU-GRS-771904', issuer: 'Control Union', expires: dans(58) },
          { standard: 'ISO 14001:2015', number: 'FR-14001-20264', issuer: 'Bureau Veritas', expires: dans(233) },
          { standard: 'SMETA 4-Pillar', number: 'SMETA-BRAGA-2026-118', issuer: 'SGS', expires: dans(176) },
        ];

        // Documents du jeu de demonstration. La vue Documents les compte et
        // les rend comme n'importe quelle liste : hors demonstration, la meme
        // vue part de state.documents, vide tant qu'aucune route ne l'alimente.
        state.documents = [
          { id: 'demo-doc-1', category: 'transfer', title: 'GOTS 2026 Transaction Certificate', type: 'TC GOTS', issuer: 'Control Union Certifications', supplier: 'Filature de Haute-Vienne', issuedAt: '2026-01-14', expiresAt: '2027-01-14', status: 'sealed' },
          { id: 'demo-doc-2', category: 'lab', title: 'ZDHC MRSL Level 3 Laboratory Report', type: 'ZDHC Test', issuer: 'SGS Textile Testing Services', supplier: 'EcoDye Aquitaine', issuedAt: '2026-03-02', expiresAt: '2027-03-02', status: 'sealed' },
          { id: 'demo-doc-3', category: 'social', title: 'SMETA 4-Pillar Social Audit (Grade A)', type: 'SMETA Audit', issuer: 'Intertek Ethical Services', supplier: 'Assembly & Tailoring Workshop', issuedAt: '2025-11-10', expiresAt: '2026-11-10', status: 'sealed' },
          { id: 'demo-doc-4', category: 'product', title: 'OEKO-TEX Standard 100 Certificate', type: 'OEKO-TEX', issuer: 'CITEVE Portugal', supplier: 'Portugal Textile Mill', issuedAt: '2026-02-18', expiresAt: '2027-02-18', status: 'sealed' },
        ];

        // Preparation DPP : 88%, coherent avec le KPI de la vue d'ensemble.
        // 7 exigences sur 9, dont une bloquante restante — un score volontiers
        // imparfait, pour que la vue montre aussi ce qui manque.
        state.selectedDppProduct = state.products[0];
        state.dpp = {
          readinessStatus: 'in_progress',
          completionScore: 88,
          totalRequirements: 9,
          metRequirements: 7,
          blockingCount: 1,
          profileKey: 'textile_readiness_mvp',
          profileVersion: '1.0',
          canMarkReadyToPublish: false,
          isReadyToPublish: false,
          pillars: {
            identification: { icon: '\ud83c\udff7\ufe0f', nameKey: 'dpPillar1', metPercent: 100,
              descriptionKey: 'dpP1Desc',
              items: [
                { label: 'GTIN / EAN-13', met: true },
                { labelKey: 'dpItemInternalRef', met: true },
                { labelKey: 'dpItemCategory', met: true },
                { labelKey: 'dpItemBrandEntity', met: true },
              ] },
            composition: { icon: '\ud83e\uddf5', nameKey: 'dpPillar2', metPercent: 100,
              descriptionKey: 'dpP2Desc',
              items: [
                { labelKey: 'dpItemFiberByFiber', met: true },
                { labelKey: 'dpItemRecycledShare', met: true },
                { labelKey: 'dpItemMaterialOrigin', met: true },
              ] },
            traceability: { icon: '\u260d', nameKey: 'dpPillar3', metPercent: 75,
              descriptionKey: 'dpP3Desc',
              items: [
                { label: 'Tier 1 \u2014 Making-up', met: true },
                { label: 'Tier 2 \u2014 Weaving / knitting', met: true },
                { label: 'Tier 3 \u2014 Spinning', met: true },
                { label: 'Tier 4 \u2014 Raw material', met: false },
              ] },
            quality: { icon: '\ud83d\udee1\ufe0f', nameKey: 'dpPillar4', metPercent: 67,
              descriptionKey: 'dpP4Desc',
              items: [
                { labelKey: 'dpItemSupplierCerts', met: true },
                { labelKey: 'dpItemTransactionCert', met: true },
                { labelKey: 'dpItemLabTestShort', met: false },
              ] },
          },
          missingFields: [
            { key: 'supply_chain.tier4_origin', labelKey: 'dpItemRawOrigin', blocking: true },
            { key: 'quality.lab_test_report', labelKey: 'dpItemLabTest', blocking: false },
          ],
          blockingIssues: [],
        };
      }

      // ---------------------------------------------------------------------
      // Contexte de locataire actif
      // ---------------------------------------------------------------------
      // Incident Production du 2026-10-17 : un administrateur membre de Ginger
      // et de Tracefab Recette Production voyait, depuis Ginger, le produit
      // brouillon RECETTE-DPP-20261017 qui n'appartient qu'au tenant de recette.
      //
      // Deux defauts cote client y contribuaient :
      //   1. les listes etaient chargees SANS nommer le locataire, et le serveur
      //      retombait alors sur toutes les organisations du compte ;
      //   2. `activeOrganizationId` etait resolu APRES le chargement, donc le
      //      selecteur d'organisation ne pouvait pas cadrer la premiere lecture.
      //
      // Le locataire est desormais resolu avant toute lecture metier, porte par
      // un en-tete sur chaque appel prive, et persiste pour qu'un rechargement
      // ne bascule pas silencieusement sur la premiere organisation.
      const TENANT_STORAGE_KEY = 'tracefab_active_organization_id';

      // Vide tout ce qui appartient au locataire precedent. Appelé AVANT le
      // rechargement : pendant l'attente, l'ecran ne doit afficher aucune donnee
      // de l'autre tenant, pas meme une fraction de seconde.
      function resetTenantState() {
        state.suppliers = [];
        state.materials = [];
        state.products = [];
        state.requests = [];
        state.questionnaires = [];
        state.schemaCatalog = [];
        state.schemaBindings = [];
        state.schemaBindingsError = null;
        state.productDetailError = null;
        state.selectedRequest = null;
        state.selectedProduct = null;
        state.selectedProductDetail = null;
        state.selectedSupplier = null;
        state.selectedSupplyChainProduct = null;
        state.selectedDppProduct = null;
        state.quality = null;
        state.qualityFilter = 'all';
        // null = aucune source chargee ; [] = source chargee et vide. Remettre
        // null, jamais [] : un echec de chargement ne doit pas se lire « vide ».
        state.documents = null;
        state.certifications = null;
        state.pefAssessment = null;
        state.greenClaimsAudit = null;
        state.supplyChain = null;
        state.massBalance = null;
        state.dpp = null;
        state.dppPortfolio = null;
        state.dppPortfolioLoading = false;
        state.dppScope = 'portfolio';
        state.modal = null;
        state.modalIssueId = null;
        state.catalogImport = { filename: '', content: '', preview: null, job: null, loading: false };
        state.supplierImport = { filename: '', content: '', preview: null, job: null, delivery: null, loading: false };
        state.tenantError = null;
        state.loadedOrganizationId = null;
        state.routeHydrated = false;
      }

      // Resout le locataire actif a partir des adherions reelles. Ne devine
      // jamais : si le compte n'a aucune organisation de marque, il rend null et
      // l'appelant affiche un etat explicite, pas un jeu de demonstration.
      function resolveActiveOrganization(brands) {
        const valid = new Set(brands.map((m) => m.organization_id));
        if (state.activeOrganizationId && valid.has(state.activeOrganizationId)) {
          return state.activeOrganizationId;
        }
        let stored = null;
        try { stored = localStorage.getItem(TENANT_STORAGE_KEY); } catch { stored = null; }
        if (stored && valid.has(stored)) return stored;
        return brands[0]?.organization_id || null;
      }

      function setActiveOrganization(organizationId) {
        if (!organizationId || organizationId === state.activeOrganizationId) return;
        state.activeOrganizationId = organizationId;
        try { localStorage.setItem(TENANT_STORAGE_KEY, organizationId); } catch { /* stockage indisponible : la session reste coherente */ }
        // Vidage AVANT le rechargement : aucun flash de donnees du tenant
        // precedent, y compris sur un reseau lent.
        resetTenantState();
        state.view = 'overview';
        persistRoute('overview');
        state.loading = true;
        render();
        sync().catch((error) => { state.loading = false; state.configError = error.message; render(); });
      }

      async function sync() {
        state.loading = true; render();
        try {
          if (state.demo) { demoData(); state.loading = false; render(); return; }

          // Sur les visites suivantes, le tenant mémorisé permet de lancer les
          // lectures tenant-scopées en parallèle de `/api/me`. Le serveur
          // revalide toujours l'adhésion et la RLS : une valeur locale périmée
          // ne peut ni élargir ni autoriser l'accès. Le résultat spéculatif
          // n'est utilisé qu'après confirmation par `/api/me`.
          let storedTenant = null;
          try { storedTenant = localStorage.getItem(TENANT_STORAGE_KEY); } catch { storedTenant = null; }
          const validStoredTenant = typeof storedTenant === 'string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedTenant);
          if (validStoredTenant) state.activeOrganizationId = storedTenant;
          const initialFastDeepLink = state.view !== 'overview';
          const prefetchedTenantData = validStoredTenant
            ? (initialFastDeepLink
              ? Promise.all([api('/api/products')]).catch(() => null)
              : Promise.all([api('/api/suppliers'), api('/api/materials'), api('/api/products'), api('/api/data-requests')]).catch(() => null))
            : null;

          // Phase 1 — identité et adhésions. `/api/me` contient déjà les
          // organisations de chaque adhésion ; l'ancien second appel à
          // `/api/organizations` dupliquait cette lecture à chaque page.
          const me = await api('/api/me');
          state.user = me.user;
          state.memberships = me.memberships || [];
          state.organizations = state.memberships.map((membership) => membership.organizations).filter(Boolean);

          const brands = state.memberships.filter((m) => m.organizations?.type === 'brand');
          state.activeOrganizationId = resolveActiveOrganization(brands);
          if (!state.activeOrganizationId) {
            // Aucune organisation de marque : etat explicite, jamais un repli
            // sur un jeu de demonstration.
            state.tenantError = 'no_brand_organization';
            state.loading = false;
            render();
            return;
          }
          try { localStorage.setItem(TENANT_STORAGE_KEY, state.activeOrganizationId); } catch { /* ignore */ }

          // Rien du locataire precedent ne survit au chargement du suivant.
          // Mais un rechargement du MEME locataire ne doit rien detruire :
          // `sync()` est appele apres un enregistrement, et vider alors
          // `selectedProductDetail` detruirait la fiche que l'utilisateur vient
          // de modifier. La purge est donc bornee au changement de locataire.
          if (state.loadedOrganizationId !== state.activeOrganizationId) resetTenantState();
          state.loadedOrganizationId = state.activeOrganizationId;

          // Phase 2 — donnees du locataire actif. Chaque appel porte l'en-tete
          // de locataire (voir `api`) ; le serveur refuse une requete privee qui
          // ne nomme pas son locataire.
          // Le premier rendu ne doit attendre que les données nécessaires à
          // la navigation et à la vue d'ensemble. Questionnaires, schémas et
          // certificats sont des jeux secondaires parfois coûteux : les faire
          // bloquer ici rendait chaque page lente, même sans ouvrir ces vues.
          const fastDeepLink = state.view !== 'overview';
          const canUsePrefetch = validStoredTenant && storedTenant === state.activeOrganizationId;
          const prefetched = canUsePrefetch ? await prefetchedTenantData : null;
          if (fastDeepLink) {
            // Une vue profonde (Traçabilité, Qualité, DPP, fiche produit) n'a
            // besoin que du catalogue pour résoudre son produit. Les autres
            // listes arrivent ensuite sans retarder cette navigation directe.
            const products = prefetched?.[0] || await api('/api/products');
            state.products = products.products || [];
          } else {
            const [supplierPayload, materials, products, requests] = prefetched || await Promise.all([
              api('/api/suppliers'), api('/api/materials'), api('/api/products'), api('/api/data-requests'),
            ]);
            state.suppliers = supplierPayload.suppliers || [];
            state.materials = materials.materials || [];
            state.products = products.products || [];
            state.requests = requests.requests || [];
          }
          state.loading = false;
          render();

          if (!state.routeHydrated) {
            state.routeHydrated = true;
            const routeProduct = state.products.find((product) => product.id === initialProductId) || state.products[0] || null;
            if (state.view === 'supplyChain' && routeProduct) loadSupplyChain(routeProduct.id);
            else if (state.view === 'quality' && routeProduct) loadQuality(routeProduct.id);
            else if (state.view === 'dpp' && routeProduct) loadDpp(routeProduct.id);
            else if (state.view === 'productDetail' && routeProduct) openProduct(routeProduct.id);
          }

          if (fastDeepLink) {
            const backgroundOrganizationId = state.activeOrganizationId;
            api('/api/suppliers').then((payload) => {
              if (state.activeOrganizationId !== backgroundOrganizationId) return;
              state.suppliers = payload.suppliers || [];
              if (state.view === 'suppliers' || state.view === 'supplyChain') render();
            }).catch(() => {});
            api('/api/materials').then((payload) => {
              if (state.activeOrganizationId !== backgroundOrganizationId) return;
              state.materials = payload.materials || [];
              if (state.view === 'materials' || state.view === 'supplyChain') render();
            }).catch(() => {});
            api('/api/data-requests').then((payload) => {
              if (state.activeOrganizationId !== backgroundOrganizationId) return;
              state.requests = payload.requests || [];
            }).catch(() => {});
          }

          // Enrichissements non bloquants. Chaque résultat est publié
          // indépendamment : une route lente ou indisponible ne retarde plus
          // les autres et ne masque jamais l'application entière. Le tenant
          // capturé empêche une réponse tardive de repeupler le tenant suivant.
          const enrichmentOrganizationId = state.activeOrganizationId;
          api('/api/questionnaires').then((payload) => {
            if (state.activeOrganizationId !== enrichmentOrganizationId) return;
            state.questionnaires = payload.questionnaires || [];
            if (state.view === 'questionnaires') render();
          }).catch(() => {});
          api('/api/catalog/schemas?subjectType=product').then((payload) => {
            if (state.activeOrganizationId !== enrichmentOrganizationId) return;
            state.schemaCatalog = payload.schemas || [];
          }).catch(() => {});
          api('/api/mass-balance/certificates').then((payload) => {
            if (state.activeOrganizationId !== enrichmentOrganizationId) return;
            state.certifications = (payload.certificates || []).map((c) => ({
              id: c.id,
              standard: c.standard,
              number: c.tcNumber,
              issuer: c.issuerName,
              expires: c.expiryDate || '',
              status: c.status,
              source: 'transaction_certificate',
            }));
            if (state.view === 'certifications') render();
          }).catch(() => {
            if (state.activeOrganizationId === enrichmentOrganizationId) state.certifications = null;
          });

          // La preparation DPP de la vue d'ensemble vient de l'agregat reel.
          // Chargement silencieux : une route indisponible laisse l'indicateur
          // a « non calculé », elle ne casse pas le tableau de bord.
          loadDppPortfolio({ silent: true }).catch(() => {});
        } catch (error) {
          state.loading = false; state.configError = error.message; render();
        }
      }

      function currentBrand() {
        return state.memberships.find((m) => m.organization_id === state.activeOrganizationId)?.organizations;
      }
      function brands() { return state.memberships.filter((m) => m.organizations?.type === 'brand'); }
      function suppliers() { return state.suppliers || []; }
      function orgName(id) {
        const membership = state.memberships.find((m) => m.organization_id === id);
        const supplier = suppliers().find((s) => s.organization_id === id);
        return membership?.organizations?.display_name || membership?.organizations?.legal_name || supplier?.organizations?.display_name || supplier?.organizations?.legal_name || id?.slice(0, 8) || '—';
      }
      
      function filterRequestsByStatus(st) {
        const select = document.getElementById('request-filter');
        if (select) {
          select.value = st;
          select.dispatchEvent(new Event('change'));
        }
      }

      function requestCounts() {
        const open = state.requests.filter((r) => !['approved', 'cancelled'].includes(r.status));
        const dueSoon = open.filter((r) => r.dueAt && new Date(r.dueAt).getTime() - Date.now() < 7 * 86400000);
        return { open: open.length, dueSoon: dueSoon.length, submitted: state.requests.filter((r) => r.status === 'submitted').length };
      }

      function shell(content) {
        const brand = currentBrand();
        const userName = state.user?.fullName || state.user?.email || 'Utilisateur';
        const brandOptions = brands().map((m) => `<option value="${esc(m.organization_id)}" ${m.organization_id === state.activeOrganizationId ? 'selected' : ''}>${esc(m.organizations.display_name || m.organizations.legal_name)}</option>`).join('');
        return `${state.demo ? '<div class="demo-banner">' + bt('shDemoMode') + '</div>' : ''}
          <div class="app">
            <aside class="sidebar">
              <div class="brand"><div class="brand-mark">tf</div><div class="brand-name">tracefab<small>brand console</small></div></div>
              <nav class="nav">
                <div class="nav-section-title">${esc(bt('navMain'))}</div>
                ${navButton('overview', '⌂', bt('overview'))}
                ${navButton('products', '◇', bt('products'))}
                ${navButton('suppliers', '◎', bt('suppliers'))}
                ${navButton('materials', '⬡', bt('materials'))}
                ${navButton('supplyChain', '☍', bt('supplyChain'))}
                <div class="nav-section-title">${esc(bt('navCollection'))}</div>
                ${navButton('requests', '↗', bt('requests'))}
                ${navButton('questionnaires', '✎', bt('questionnaires'))}
                ${navButton('documents', '▤', bt('documents'))}
                ${navButton('certifications', '✓', bt('certifications'))}
                ${navButton('quality', '◒', bt('quality'))}
                ${navButton('risk', '⚠', bt('risk'))}
                ${navButton('massBalance', '⚖', bt('massBalanceViewLabel'))}
                ${navButton('integrations', '⇄', bt('integrationsViewLabel'))}
                ${navButton('intelligence', '✦', 'TRACEFAB Intelligence')}
                ${navButton('dpp', '📋', bt('dpp'))}
                <div class="nav-section-title">${esc(bt('navGov'))}</div>
                ${navButton('reports', '☷', bt('reports'))}
                ${navButton('settings', '⚙', bt('settings'))}
              </nav>
              <div class="sidebar-bottom"><div class="user-mini"><div class="avatar">${esc(first(userName))}</div><div><strong>${esc(userName)}</strong><span>${esc(state.user?.email || bt('shDemoAccount'))}</span><button class="link-button" data-action="signout">${bt('signOut')}</button></div></div></div>
            </aside>
            <main class="main">
              <header class="topbar"><div class="crumb">Brand Console <span> / </span><strong>${esc(viewLabel())}</strong></div><div class="top-actions">${brandLangSwitcher()}${brands().length ? `<select class="org-select" id="active-org" aria-label="${esc(bt('orgSwitcher'))}">${brandOptions}</select>` : ''}<button class="btn btn-primary btn-small" data-action="new-request">${esc(bt("newRequest"))}</button></div></header>
              <section class="content">${content}</section>
            </main>
          </div>
          ${state.modal ? modal(state.modal) : ''}
          ${state.toast ? `<div class="toast ${state.toast.isError ? 'error' : ''}">${esc(state.toast.message)}</div>` : ''}`;
      }
      function viewLabel() { return ({
        overview: bt('overviewViewLabel'),
        products: bt('productsViewLabel'),
        suppliers: bt('suppliersViewLabel'),
        materials: bt('materialsViewLabel'),
        supplyChain: bt('supplyChainViewLabel'),
        requests: bt('requestsViewLabel'),
        questionnaires: bt('questionnairesViewLabel'),
        documents: bt('documentsViewLabel'),
        certifications: bt('certificationsViewLabel'),
        quality: bt('qualityViewLabel'),
          risk: bt('riskViewLabel'),
        dpp: bt('dppViewLabel'),
        reports: bt('reportsViewLabel'),
        settings: bt('settingsViewLabel'),
              massBalance: bt('massBalanceViewLabel'),
              integrations: bt('integrationsViewLabel'),
              intelligence: 'TRACEFAB Intelligence',
        requestDetail: bt('requestDetailViewLabel'),
        productDetail: bt('productDetailViewLabel'),
        supplierDetail: bt('supplierDetailViewLabel')
      })[state.view] || bt('overviewViewLabel'); }
      function navButton(view, icon, label) { return `<button class="${state.view === view ? 'active' : ''}" data-view="${view}"><span class="nav-icon">${icon}</span>${label}</button>`; }

      
      // Le dictionnaire inline de cette page a ete fusionne dans le
        // catalogue unique /assets/i18n (portees 'shared' et 'brandTranslations').
        // Regenerable par scripts/build_app_i18n.mjs.

      function bt(key) {
        const T = window.TF_I18N;
        if (!T) return key;
        // Portee console d'abord, puis le fonds commun. Le repli anglais
        // est assure par le runtime : plus aucun repli francais implicite.
        return T.t('console.' + key, null) || T.t('shared.' + key, key);
      }

      function brandLangSwitcher() {

        const T = window.TF_I18N;
        return `<select class="org-select" id="brand-lang-select" aria-label="${(T && T.t) ? T.t('nav.language', 'Language') : 'Language'}" data-tf-act="p01" data-tf-on="change" style="margin-right:8px;font-family:inherit;font-weight:700;">
          <option value="en" ${state.lang === 'en' ? 'selected' : ''}>🇬🇧 English</option>
          <option value="fr" ${state.lang === 'fr' ? 'selected' : ''}>🇫🇷 Français</option>
          <option value="de" ${state.lang === 'de' ? 'selected' : ''}>🇩🇪 Deutsch</option>
          <option value="it" ${state.lang === 'it' ? 'selected' : ''}>🇮🇹 Italiano</option>
          <option value="es" ${state.lang === 'es' ? 'selected' : ''}>🇪🇸 Español</option>
          <option value="nl" ${state.lang === 'nl' ? 'selected' : ''}>🇳🇱 Nederlands</option>
          <option value="pt" ${state.lang === 'pt' ? 'selected' : ''}>🇵🇹 Português</option>
        </select>`;
      }

      function setBrandLang(lang) {
        const T = window.TF_I18N;
        // setLanguage ecrit les deux cles de stockage, charge la locale puis
        // emet tf:languagechange, qui declenche le rendu ci-dessous.
        if (T) { T.setLanguage(lang); return; }
        state.lang = lang;
        document.documentElement.lang = lang;
        render();
      }

      // Un changement de langue ne vient pas forcement du selecteur de cette
      // page : il peut venir de la landing ou d'un autre onglet. On re-rend
      // sur l'evenement du runtime, ce qui donne un chemin unique quelle que
      // soit l'origine. Le drapeau evite un double rendu a l'amorcage.
      let i18nReady = false;
      document.addEventListener('tf:languagechange', (event) => {
        state.lang = event.detail.lang;
        document.documentElement.lang = state.lang;
        if (i18nReady) render();
      });


      // Le script de la console est encapsule dans une IIFE : les fonctions
      // declarees ici ne sont pas globales. Les attributs HTML inline
      // (onchange="setBrandLang(...)", onclick="...render()") sont evalues
      // dans la portee globale et levaient "X is not defined".
      // On expose uniquement les deux fonctions reellement referencees.
      window.setBrandLang = setBrandLang;
      window.render = render;
      window.state = state;


      const DEMO_INTEL_ANSWER = {
          summary: "Exhaustive analysis of 1,248 catalogue references: 98.4% of the AW26 collection is covered by a valid GOTS certificate. Only 2 references lack a sealed transaction certificate.",
          details: [
            {
              sku: "AW26-0812 · Ribbed Cotton Socks",
              issue: "OEKO-TEX certificate present but no GOTS transaction certificate (TC) for the combed yarn lot.",
              supplier: "Filature du Sud-Ouest",
              evidenceCited: "TC-GOTS-MISSING · Request ref. REQ-2026-092",
              action: "Supplier follow-up issued on 04/10/2026"
            },
            {
              sku: "AW26-0419 · Trench Jacket Lining",
              issue: "Material declared as Recycled Cotton (GRS) without third-party verified mass-balance evidence.",
              supplier: "Recycled Textiles Europe",
              evidenceCited: "GRS-CERT-8841 (Status: expired on 15/09/2026)",
              action: "DPP export currently blocked"
            }
          ],
          citations: [
            { id: "TC-CU-881294", label: "Certificat Transaction Control Union GOTS 2026", hash: "sha256-8a9d...4f21" },
            { id: "SGS-LAB-098", label: "SGS ZDHC MRSL Level 3 laboratory report", hash: "sha256-3b17...9c82" },
            { id: "SMETA-BRAGA-26", label: "Audit Social SMETA 4-Pillar Atelier Braga", hash: "sha256-7e44...5a19" }
          ]
      };


      function intelligenceView() {
        const demoMode = estDemo();
        const query = state.activeIntelQuery
          || (demoMode ? "Which products contain non-GOTS-certified cotton in the AW26 collection?" : "");
        // Aucune route d'intelligence n'existe : hors demonstration, il n'y
        // a pas de synthese a afficher. On ne fabrique ni reponse ni duree.
        const currentAnswer = demoMode ? (state.activeIntelAnswer || DEMO_INTEL_ANSWER) : null;

        return `<div>
          <!-- Hero Banner -->
          <div class="intel-hero-card">
            <div class="intel-tag">${esc(bt('cnIntelTag'))}</div>
            <h1 class="intel-title">TRACEFAB Intelligence</h1>
            <p class="intel-desc">
              ${bt('iaIntro')}
            </p>
            <div class="intel-guardrail-badge">
              <span>🛡️ ${esc(bt('cnIntelGuardrail'))}</span>
              <span>${bt('iaNoInvented')}</span>
            </div>
          </div>

          <!-- Query Panel with Suggested Prompts -->
          <div class="intel-query-panel">
            <div style="font-size:12px;font-weight:750;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${bt('iaSuggestions')}</div>
            ${demoMode ? `<div class="intel-chips-row" data-tf-demo>
              <span class="intel-chip" data-tf-act="p02">
                🌾 Cotton without GOTS TC (AW26)
              </span>
              <span class="intel-chip" data-tf-act="p03">
                ⏳ Certificates expiring within 45 days
              </span>
              <span class="intel-chip" data-tf-act="p04">
                ⚖️ SMETA living-wage compliance
              </span>
              <span class="intel-chip" data-tf-act="p05">
                📋 CIRPASS DPP eligibility rate
              </span>
            </div>` : ''}

            <div class="intel-input-wrap">
              <input class="intel-input" id="intel-query-input" value="${esc(query)}" placeholder="${bt('iaPlaceholder')}">
              <button class="btn btn-primary" data-tf-act="p06">${bt('iaQuery')}</button>
            </div>
          </div>

          ${demoMode ? `
          <!-- Answer Box with Verified Evidence Links -->
          <div class="intel-answer-box">
            <div class="intel-answer-header">
              <div>
                <span class="badge badge-verified" style="background:#eaf5ef;color:#0b7656;font-size:11.5px;font-weight:750;">${bt('iaVerifiedSynthesis')}</span>
                <h3 style="font-size:16px;font-weight:800;color:#17231f;margin:4px 0 0;">« ${esc(query)} »</h3>
              </div>
              <span class="meta" style="font-family:var(--font-mono,monospace);font-size:11px;color:#0b7656;font-weight:750;" data-tf-demo>${bt('iaResponseTime')}</span>
            </div>

            <p style="font-size:14px;color:#17231f;line-height:1.6;margin-bottom:18px;">
              ${esc(currentAnswer.summary)}
            </p>

            <!-- Granular Result Table -->
            <div class="table-wrap" style="margin-bottom:20px;">
              <table>
                <thead>
                  <tr>
                    <th>${bt('iaRefArticle')}</th>
                    <th>${bt('scSupplierFacility')}</th>
                    <th>${bt('iaAnomaly')}</th>
                    <th>${bt('iaCitedProof')}</th>
                    <th style="text-align:right">${bt('iaDirectAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${currentAnswer.details.map(d => `
                    <tr>
                      <td><strong>${esc(d.sku)}</strong></td>
                      <td>${esc(d.supplier)}</td>
                      <td><span class="status status-changes_requested">${esc(d.issue)}</span></td>
                      <td><span class="cert-pill">${esc(d.evidenceCited)}</span></td>
                      <td style="text-align:right">
                        <button class="btn btn-secondary btn-small" data-tf-act="p07">
                          ${esc(d.action)}
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <!-- Evidence Citations Section (Zero Hallucination Proof) -->
            <div style="background:#f8faf8;border:1px solid #edf2ee;border-radius:12px;padding:16px;">
              <div style="font-size:11.5px;font-weight:800;color:#17231f;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">
                ${bt('iaCitedEvidence')}
              </div>
              <div>
                ${currentAnswer.citations.map(c => `
                  <span class="intel-cited-badge" data-tf-act="p08">
                    📄 ${esc(c.label)} <code style="color:#0b7656;margin-left:4px;">[${esc(c.hash)}]</code>
                  </span>
                `).join('')}
              </div>
            </div>
          </div>
          ` : `
          <div class="card panel" style="margin-top:18px">
            <div class="panel-head"><h2>${esc(bt('iaVerifiedSynthesis'))}</h2></div>
            <div class="empty"><strong>${esc(bt('cnNotComputed'))}</strong><p class="meta">${esc(bt('iaUnavailable'))}</p></div>
          </div>`}
        </div>`;
      }

      function askIntel(q) {
        state.activeIntelQuery = q;
        render();
      }

      function submitIntelQuery() {
        const inp = document.getElementById('intel-query-input');
        if (inp) {
          state.activeIntelQuery = inp.value;
          render();
        }
      }

      function memoriserFocus() {
        const el = document.activeElement;
        if (!el || !el.id || typeof el.selectionStart !== 'number') return null;
        return { id: el.id, debut: el.selectionStart, fin: el.selectionEnd };
      }

      function restaurerFocus(memo) {
        if (!memo) return;
        const el = document.getElementById(memo.id);
        if (!el) return;
        el.focus();
        // setSelectionRange leve sur les types qui n'ont pas de selection
        // (number, email selon les navigateurs) : le focus suffit alors.
        try { el.setSelectionRange(memo.debut, memo.fin); } catch (e) { /* sans selection */ }
      }

      function render() {
        if (state.tenantError && !state.demo) {
          app.innerHTML = `<div class="auth-screen"><div class="config-error"><div class="eyebrow">Tracefab Brand Console</div><h1>${esc(bt('cnNoActiveTenantTitle'))}</h1><p>${esc(bt('cnNoActiveTenantBody'))}</p><button class="btn btn-secondary" data-action="retry">${esc(bt('cnRetry'))}</button></div></div>`; bind(); return;
        }
        if (state.configError && !state.demo) {
          // `!state.user` ne suffit plus : le chargement est en deux phases, et
          // l'identite est connue avant les donnees du locataire. Une panne de
          // la seconde phase ne doit pas rendre une console partiellement
          // vide : un ecran a moitie rempli se lit comme une verite a moitie
          // fausse. Sans identite, c'est l'authentification qui est en cause ;
          // avec, ce sont les donnees du locataire actif.
          const titre = state.user ? bt('cnTenantLoadFailedTitle') : bt('cnAuthUnavailable');
          const corps = state.user
            ? `${esc(state.configError)} ${esc(bt('cnTenantLoadFailedBody'))}`
            : `${esc(state.configError)} ${esc(bt('cnConfigUnavailableBody'))}`;
          app.innerHTML = `<div class="auth-screen"><div class="config-error"><div class="eyebrow">Tracefab Brand Console</div><h1>${esc(titre)}</h1><p>${corps}</p><button class="btn btn-secondary" data-action="retry">${esc(bt('cnRetry'))}</button></div></div>`; bind(); return;
        }
        if (state.loading) { app.innerHTML = `<div class="auth-screen"><div class="config-error"><div class="eyebrow">Tracefab</div><h1>${esc(bt('cnLoadingTitle'))}</h1><p>${esc(bt('cnLoadingSub'))}</p></div></div>`; return; }
        if (!state.user && !state.demo) { renderAuth(); return; }
        const content = state.view === 'overview' ? overview() :
          state.view === 'requests' ? requestsView() :
          state.view === 'questionnaires' ? questionnairesBuilderView() :
          state.view === 'products' ? productsView() :
          state.view === 'quality' ? qualityView() :
            state.view === 'risk' ? riskView() :
            state.view === 'intelligence' ? intelligenceView() :
          state.view === 'massBalance' ? massBalanceConsoleView() :
          state.view === 'integrations' ? integrationsView() :
          state.view === 'suppliers' ? suppliersView() :
          state.view === 'materials' ? materialsConsoleView() :
          state.view === 'supplyChain' ? supplyChainView() :
          state.view === 'documents' ? documentsConsoleView() :
          state.view === 'certifications' ? certificationsConsoleView() :
          state.view === 'dpp' ? dppView() :
          state.view === 'reports' ? reportsConsoleView() :
          state.view === 'settings' ? settingsConsoleView() :
          state.view === 'productDetail' ? productDetailView() :
          state.view === 'supplierDetail' ? supplierDetailView() :
          requestDetailView();
        // render() remplace tout le DOM. Sans cette precaution, taper un
        // caractere dans un champ de recherche le vide de son focus et de son
        // curseur des le re-rendu : la recherche au fil de la frappe devient
        // inutilisable. On ne restaure que les champs porteurs d'un id.
        const focusAvant = memoriserFocus();
        app.innerHTML = shell(content); bind();
        restaurerFocus(focusAvant);
      }

      function renderAuth() {
        app.innerHTML = `<div class="auth-screen"><div class="auth-card"><div class="auth-copy"><div class="brand"><div class="brand-mark">tf</div><div class="brand-name">tracefab<small>brand console</small></div></div><h1>${esc(bt('cnAuthTitle'))}</h1><p>${esc(bt('cnAuthSub'))}</p><ul><li>${esc(bt('cnAuthF1'))}</li><li>${esc(bt('cnAuthF2'))}</li><li>${esc(bt('cnAuthF3'))}</li></ul></div><div class="auth-box"><div class="eyebrow">Espace marque</div><h2>Se connecter</h2><p>${esc(bt('cnAuthAccess'))}</p><div id="clerk-sign-in"></div></div></div></div>`;
        if (state.clerk) state.clerk.mountSignIn(document.getElementById('clerk-sign-in'), { appearance: { elements: { card: 'shadow-none', rootBox: 'w-full' } } });
      }

      
      
      function questionnairesBuilderView() {
        const qList = state.questionnaires || [];
        return `<div class="page-head">
          <div>
            <div class="eyebrow">${esc(bt('qbStudioEyebrow'))}</div>
            <h1>${esc(bt('qbTitle'))}</h1>
            <p>${esc(bt('cnQnIntro'))}</p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-demo-action="1">${bt('qbExport')}</button>
            <button class="btn btn-primary" data-tf-act="p09">${bt('qbCreate')}</button>
          </div>
        </div>

        <div class="grid split">
          <!-- Questionnaires Catalog List -->
          <div class="card panel">
            <div class="panel-head">
              <h2>${bt('qbActiveProtocols')} (${qList.length})</h2>
              <span class="meta">${bt('qbSchemas')}</span>
            </div>
            <div class="item-list">
              ${qList.map((q) => `
                <div class="item">
                  <div style="flex:1">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                      <div>
                        <span class="cert-pill" style="margin-bottom:6px;">${esc(q.category || bt('cnGrpCompliance'))} · v${esc(q.version)}</span>
                        <h3 style="font-size:15px;margin-top:2px;">${esc(q.title)}</h3>
                      </div>
                      <span class="status status-approved">${moneyless(q.itemCount ?? q.fields?.length ?? 0)} ${bt('qbFieldCount')} (${moneyless(q.requiredItemCount ?? 0)} ${bt('qbRequired')})</span>
                    </div>
                    <p style="margin:6px 0 12px;font-size:12.5px;color:var(--muted);">${esc(q.description)}</p>

                    <!-- Preview of Fields in Builder -->
                    <div style="background:#f8faf8;border:1px solid #edf0eb;border-radius:10px;padding:12px;">
                      <div style="font-size:11px;font-weight:750;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">${bt('qbFields')}</div>
                      <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        ${(q.fields || []).map(f => `
                          <span style="font-size:11px;background:#ffffff;border:1px solid var(--line);padding:3px 8px;border-radius:6px;display:inline-flex;align-items:center;gap:4px;">
                            <strong>${esc(f.label)}</strong>
                            <span style="color:var(--green);font-family:var(--font-mono);font-size:10px;">[${esc(f.type)}]</span>
                            ${f.required ? '<span style="color:var(--red)">*</span>' : ''}
                          </span>
                        `).join('') || `<span style="font-size:11px;color:var(--muted);">${bt('qbOcrTemplate')}</span>`}
                      </div>
                    </div>

                    <div class="actions" style="justify-content:flex-start;margin-top:14px;gap:8px;">
                      <button class="btn btn-primary btn-small" data-action="new-request" data-tf-act="p10" data-tf-arg="${esc(q.key)}">
                        ${bt('qbLaunch')}
                      </button>
                      <button class="btn btn-secondary btn-small" data-demo-action="1">
                        ${bt('qbEditProtocol')}
                      </button>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Studio Configuration Helper -->
          <div style="display:grid;gap:18px;">
            <div class="card panel">
              <div class="panel-head"><h2>${bt('qbFieldTypes')}</h2></div>
              <div style="display:grid;gap:10px;font-size:12px;">
                <div style="padding:10px;background:#f8faf8;border-radius:8px;border-left:3px solid var(--green);">
                  <strong>${bt('qbDocEvidence')}</strong>
                  <div style="color:var(--muted);margin-top:2px;">${bt('qbSealedPdf')}</div>
                </div>
                <div style="padding:10px;background:#f8faf8;border-radius:8px;border-left:3px solid #0284c7;">
                  <strong>${bt('qbNomenclature')}</strong>
                  <div style="color:var(--muted);margin-top:2px;">${bt('qbSum100')}</div>
                </div>
                <div style="padding:10px;background:#f8faf8;border-radius:8px;border-left:3px solid #6366f1;">
                  <strong>${bt('qbFacility')}</strong>
                  <div style="color:var(--muted);margin-top:2px;">${bt('qbSiteLink')}</div>
                </div>
              </div>
            </div>

            <div class="card panel">
              <div class="panel-head"><h2>${bt('qbAutoCompliance')}</h2></div>
              <p style="font-size:12px;color:var(--muted);line-height:1.6;">
                ${esc(bt('cnQnMapping'))} <strong>CIRPASS JSON-LD</strong> ${esc(bt('cnQnCheckpoints'))} <strong>${bt('qbAgec')}</strong>.
              </p>
            </div>
          </div>
        </div>`;
      }

      function materialsConsoleView() {
        const mats = state.materials || [];
        return `<div class="page-head">
          <div>
            <div class="eyebrow">${bt('mtTitle')}</div>
            <h1>${bt('mtCatalogue')}</h1>
            <p>${bt('mtIntro')}</p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-demo-action="1">${bt('exportCsv')}</button>
            <button class="btn btn-primary" data-action="new-material">${bt('mtAdd')}</button>
          </div>
        </div>
        <div class="card panel">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>${bt('mtName')}</th><th>${bt('mtType')}</th><th>${bt('mtOrigin')}</th><th>${bt('mtRecycled')}</th><th>Certifications</th><th>${bt('mtTier')}</th><th style="text-align:right">${bt('mtActions')}</th></tr>
              </thead>
              <tbody>
                ${mats.length ? mats.map((m) => `<tr>
                  <td><strong>${esc(m.name)}</strong></td>
                  <td><span class="status status-draft">${esc(m.materialType || '—')}</span></td>
                  <td>${esc(m.originCountryCode || bt('cnCountryUnknown'))}</td>
                  <td><strong>${m.recycledContent === null || m.recycledContent === undefined || m.recycledContent === '' ? '—' : esc(m.recycledContent)}</strong></td>
                  <td>${(m.certifications || []).length
                    ? (m.certifications || []).map((cert) => `<span class="badge badge-verified" style="margin-right:4px">${esc(cert)}</span>`).join('')
                    : '—'}</td>
                  <td><span class="badge-tier">${esc(m.tier || '—')}</span></td>
                  <td style="text-align:right"><button class="btn btn-secondary btn-small" data-demo-action="1">${bt('scInspect')}</button></td>
                </tr>`).join('') : `<tr><td colspan="7" class="empty">${esc(bt('cnNone'))}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
      }

      
      // supplyChainConsoleView a ete supprimee : aucune branche du routeur
      // ne l'appelait (state.view === 'supplyChain' rend supplyChainView()) et
      // elle portait une chaine illustrative entiere — fournisseurs, volumes,
      // coordonnees — affichee sans passer par le jeu de demonstration.
      // Historique disponible dans git.

            function documentsConsoleView() {
        // La vue ne raconte plus une bibliotheque qui n'existe pas : elle
        // compte et rend state.documents. Aucune route ne liste les documents
        // d'une organisation : hors demonstration, docs vaut null et l'ecran
        // affiche « non calculé » au lieu d'un zero qui affirmerait l'absence.
        const docs = Array.isArray(state.documents) ? state.documents : null;
        const compte = (categorie) => docs ? docs.filter((d) => d.category === categorie).length : null;
        const lignes = docs === null ? `
          <tr><td colspan="8" class="empty">${esc(bt('cnNotComputed'))}</td></tr>` : (docs.length ? docs.map((d) => `
          <tr>
            <td><strong>${esc(d.title)}</strong></td>
            <td><span class="badge badge-verified">${esc(d.type || '—')}</span></td>
            <td>${esc(d.issuer || '—')}</td>
            <td>${esc(d.supplier || '—')}</td>
            <td>${d.issuedAt ? date(d.issuedAt) : '—'}</td>
            <td>${d.expiresAt ? date(d.expiresAt) : '—'}</td>
            <td><span class="status status-approved">${d.status === 'sealed' ? esc(bt('evSealed')) : esc(statusLabel(d.status))}</span></td>
            <td style="text-align:right"><button class="btn btn-secondary btn-small" data-demo-action="1">${bt('evVerify')}</button></td>
          </tr>`).join('') : `
          <tr><td colspan="8" class="empty">${esc(bt('cnNone'))}</td></tr>`);

        return `<div class="page-head">
          <div>
            <div class="eyebrow">${bt('evVault')}</div>
            <h1>${bt('evCentre')}</h1>
            <p>${esc(bt('cnEvIntro'))}</p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-demo-action="1">${bt('evDownload')}</button>
            <button class="btn btn-primary" data-demo-action="1">${bt('evUpload')}</button>
          </div>
        </div>

        <!-- Evidence Trust Matrix Strip -->
        <div class="eq-overview-panel"${estDemo() ? ' data-tf-demo' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-size:11px;font-family:var(--font-mono,monospace);font-weight:750;color:#0b7656;letter-spacing:0.1em;text-transform:uppercase;">${bt('evSovereign')}</div>
              <h3 style="font-size:17px;font-weight:800;color:#17231f;margin:2px 0 0;">${bt('evSha')}</h3>
            </div>
            <span class="badge badge-verified" style="background:#eaf5ef;color:#0b7656;font-weight:750;">${docs === null ? esc(bt('cnNotComputed')) : `${moneyless(docs.length)} ${esc(bt('documents'))}`}</span>
          </div>

          <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-top:16px;">
            <div class="eq-score-card">
              <div class="eq-score-label">${bt('evTransCerts')}</div>
              <div class="eq-score-num">${mesure(compte('transfer'))}</div>
              <div class="eq-score-desc">${bt('evMassBalance')}</div>
            </div>
            <div class="eq-score-card">
              <div class="eq-score-label">${bt('evLabReports')}</div>
              <div class="eq-score-num">${mesure(compte('lab'))}</div>
              <div class="eq-score-desc">${bt('evRsl')}</div>
            </div>
            <div class="eq-score-card">
              <div class="eq-score-label">${bt('evSocialAudits')}</div>
              <div class="eq-score-num">${mesure(compte('social'))}</div>
              <div class="eq-score-desc">${bt('evHumanRights')}</div>
            </div>
            <div class="eq-score-card">
              <div class="eq-score-label">${bt('evProdRecords')}</div>
              <div class="eq-score-num">${mesure(compte('product'))}</div>
              <div class="eq-score-desc">${bt('evDelivery')}</div>
            </div>
          </div>
        </div>

        <div class="card panel">
          <div class="panel-head">
            <h2>${bt('evActiveDocs')} (${docs === null ? esc(bt('cnNotComputed')) : moneyless(docs.length)})</h2>
            ${estDemo() ? `<span class="meta" style="color:#0b7656;font-weight:750;" data-tf-demo>${bt('evIntegrityOk')}</span>` : ''}
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>${bt('evTitle')}</th>
                  <th>${bt('evTypeStd')}</th>
                  <th>${bt('evIssuer')}</th>
                  <th>${bt('evLinkedSupplier')}</th>
                  <th>${bt('evIssueDate')}</th>
                  <th>${bt('evValidity')}</th>
                  <th>${bt('evIntegrityStatus')}</th>
                  <th style="text-align:right">${bt('evAction')}</th>
                </tr>
              </thead>
              <tbody>${lignes}</tbody>
            </table>
          </div>
        </div>`;
      }

      // Jours restants avant echeance, et pastille correspondante. La veille
      // des expirations derive desormais de ces donnees : la version
      // precedente affirmait en dur qu'aucun certificat n'expirait, ce qui
      // devenait faux des que la vue etait alimentee.
      const certJours = (c) => {
        const echeance = Date.parse(c.expires);
        return Number.isFinite(echeance) ? Math.ceil((echeance - Date.now()) / 86400000) : null;
      };
      function certStatut(c) {
        // Un certificat sans date d'echeance n'est ni valide ni expire : on ne
        // sait pas. Afficher « valid » serait une affirmation gratuite.
        const j = certJours(c);
        if (j === null) return `<span class="status status-draft">${esc(bt('cnUnknown'))}</span>`;
        if (j < 0) return `<span class="status status-changes_requested">${esc(bt('certExpired'))}</span>`;
        if (j <= 90) return `<span class="status status-needs_review">${esc(bt('certExpiringSoon'))}</span>`;
        return `<span class="status status-approved">${esc(bt('certValid'))}</span>`;
      }

      function certificationsConsoleView() {
        // null = aucune source chargee ; [] = source chargee, aucun certificat.
        const certs = Array.isArray(state.certifications) ? state.certifications : null;
        return `<div class="page-head">
          <div>
            <div class="eyebrow">${esc(bt('certEyebrow'))}</div>
            <h1>${esc(bt('certTitle'))}</h1>
            <p>${esc(bt('certLead'))}</p>
          </div>
          <div class="actions">
            <button class="btn btn-primary" data-demo-action="1">+ ${esc(bt('certDeclare'))}</button>
          </div>
        </div>
        <div class="grid split">
          <div class="card panel">
            <div class="panel-head"><h2>${esc(bt('certActiveTitle'))}</h2></div>
            <div class="table-wrap cert-table">
              <table>
                <thead>
                  <tr><th>${esc(bt('certColStandard'))}</th><th>${esc(bt('certColNumber'))}</th><th>${esc(bt('certColIssuer'))}</th><th>${esc(bt('certColExpiry'))}</th><th>${esc(bt('certColStatus'))}</th></tr>
                </thead>
                <tbody>
                  ${certs === null
                    ? `<tr><td colspan="5" class="empty">${esc(bt('cnNotComputed'))}</td></tr>`
                    : certs.length ? certs.map((c) => `<tr>
                    <td><strong>${esc(c.standard)}</strong></td>
                    <td><code>${esc(c.number)}</code></td>
                    <td>${esc(c.issuer)}</td>
                    <td>${c.expires ? date(c.expires) : '—'}</td>
                    <td>${certStatut(c)}</td>
                  </tr>`).join('') : `<tr><td colspan="5" class="empty">${esc(bt('certNone'))}</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
          <div class="card panel">
            <div class="panel-head"><h2>${esc(bt('certWatchTitle'))}</h2></div>
            <div style="font-size:12.5px;color:var(--muted);display:grid;gap:12px;">
              ${(() => {
                if (certs === null) return `<p>${esc(bt('cnNotComputed'))}</p>`;
                // Une echeance illisible n'entre pas dans la veille : elle
                // n'est pas « bientot expiree », elle est inconnue.
                const bientot = certs
                  .filter((c) => certJours(c) !== null && certJours(c) <= 90)
                  .map((c) => ({ c, j: certJours(c) }))
                  .sort((a, b) => a.j - b.j);
                if (!bientot.length) return `<p>${esc(bt('certWatchNone'))}</p>`;
                const t = bientot[0];
                return `<p><strong>${bientot.length}</strong> ${esc(bt('certWatchCount'))}<br>
                  ${esc(bt('certNextRenewal'))} : <strong>${esc(t.c.standard)}</strong> — ${t.j} ${esc(bt('certDaysLeft'))}.</p>`;
              })()}
              <div style="background:#f1f7f4;padding:12px;border-radius:10px;border-left:3px solid var(--green);">
                <strong style="color:var(--green-dark);">${esc(bt('certRuleTitle'))}</strong>
                <div style="font-size:11px;margin-top:4px;">${esc(bt('certRuleBody'))}</div>
              </div>
            </div>
          </div>
        </div>`;
      }

      // dppConsoleView a ete supprimee au chantier 8. La fonction n'etait
      // appelee par aucune branche du routeur — state.view === 'dpp' rend
      // dppView() — et portait 34 chaines francaises que l'on aurait
      // traduites pour rien. Historique disponible dans git.

      function reportsConsoleView() {
        return `<div class="page-head">
          <div>
            <div class="eyebrow">Reporting & CSRD Audits</div>
            <h1>${bt('rpTitle')}</h1>
            <p>${bt('rpIntro')}</p>
          </div>
          <div class="actions">
            <button class="btn btn-primary" data-demo-action="1">${bt('rpGenerate')}</button>
          </div>
        </div>
        <div class="grid split">
          <div class="card panel">
            <div class="panel-head"><h2>${bt('rpAvailable')}</h2></div>
            <div style="display:grid;gap:12px;">
              <div style="border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <strong>${bt('rpCsrdTitle')}</strong>
                  <div style="font-size:11.5px;color:var(--muted);margin-top:2px;">${bt('rpAgecDesc')}</div>
                </div>
                <button class="btn btn-secondary btn-small" data-demo-action="1">${bt('rpXlsx')}</button>
              </div>
              <div style="border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <strong>${bt('rpAgecTitle')}</strong>
                  <div style="font-size:11.5px;color:var(--muted);margin-top:2px;">${bt('rpCsrdDesc')}</div>
                </div>
                <button class="btn btn-secondary btn-small" data-demo-action="1">${bt('rpPdf')}</button>
              </div>
            </div>
          </div>
          <div class="card panel">
            <div class="panel-head"><h2>${bt('rpAuditTrail')}</h2></div>
            <p style="font-size:12px;color:var(--muted);line-height:1.6;">${bt('rpIntegrityNote')}</p>
          </div>
        </div>`;
      }

      function settingsConsoleView() {
        return `<div class="page-head">
          <div>
            <div class="eyebrow">${bt('cnSettingsEyebrow')}</div>
            <h1>${bt('stTitle')}</h1>
            <p>${bt('stIntro')}</p>
          </div>
          <div class="actions">
            <button class="btn btn-primary" data-demo-action="1">${bt('pxSave')}</button>
          </div>
        </div>
        <div class="card panel">
          <div class="panel-head"><h2>${bt('stOrgBrand')}</h2></div>
          <form class="form-grid">
            <label>${bt('stBrandName')}<input class="input" value="${esc(currentBrand()?.display_name || currentBrand()?.legal_name || '')}" placeholder="${esc(bt('cnUnknown'))}"></label>
            <label>${bt('stNeonOrgId')}<input class="input" value="${esc(state.activeOrganizationId || '')}" readonly placeholder="${esc(bt('cnUnknown'))}"></label>
            <label>${bt('stDppIdFormat')}<input class="input" value="${estDemo() ? 'urn:epc:id:sgtin:3760123' : ''}" placeholder="${esc(bt('cnNotComputed'))}"></label>
            <label>${bt('stQualityThreshold')}<input class="input" type="number" value="${estDemo() ? '85' : ''}" placeholder="${esc(bt('cnNotComputed'))}"></label>
          </form>
        </div>`;
      }

            function overview() {
        // Deux regimes, jamais melanges.
        //
        // En demonstration (?demo=1), les agregats sont construits a partir
        // du jeu de demonstration et les valeurs non derivables viennent de
        // la source unique partagee avec l'accueil. Hors demonstration,
        // seules les reponses API alimentent les compteurs ; une grandeur
        // qu'aucune route n'expose s'affiche « inconnu » ou « non calculé ».
        // C'est la difference entre un zero mesure et un zero suppose.
        const demoMode = estDemo();
        // Dispatch nomme : les deux regimes restent lisibles a l'endroit ou
        // ils divergent, et la vue d'ensemble ne peut pas emprunter le
        // generateur par accident hors demonstration.
        const ag = agregatsVue(demoMode);
        const AT = demoMode
          ? Object.assign({}, chiffresDemo().attention, {
            produitsIncomplets: (state.products || [])
              .filter((p) => Number(p.dataCompletion) < SEUIL_COMPLETUDE).length,
          })
          : productionAttention();

        const lineage = demoMode ? 100 : ag.lineage;
        const massBalanced = demoMode ? 97.6 : ag.massBalanced;
        const gpsPolygons = demoMode ? ag.sites : ag.gpsPolygons;
        const gs1Styles = demoMode ? 1098 : ag.gs1Styles;
        const agec = demoMode ? 100 : ag.agec;
        const pef = demoMode ? 'Tier 3' : ag.pef;

        const badge = (classe, label) => demoMode
          ? `<span class="mc-domain-badge ${classe}" data-tf-demo>${esc(label)}</span>`
          : '';
        const pastille = (value) => (value === null || value === undefined)
          ? `<div class="mc-attention-num" style="font-size:13px;">${esc(bt('cnNotComputed'))}</div>`
          : `<div class="mc-attention-num">${moneyless(value)}</div>`;

        return `<div class="mc-container">
          <!-- Mission Control Strip -->
          <div class="mc-hero-strip">
            <div>
              <div style="font-family:var(--font-mono,monospace);font-size:11px;color:#34d399;font-weight:700;letter-spacing:0.12em;margin-bottom:6px;">MISSION CONTROL CENTER · LAYER 01–07</div>
              <h1 class="mc-headline">${bt('ovEyebrow')}</h1>
              <p class="mc-subline">${bt('ovSubline')}</p>
            </div>
            <div style="display:flex;gap:12px;">
              <button class="btn btn-secondary" style="background:rgba(255,255,255,0.1);color:#fff;border-color:rgba(255,255,255,0.2);" data-action="invite-supplier">${bt('mdInviteSupplier')}</button>
              <button class="btn btn-primary" style="background:#10b981;color:#05140e;font-weight:800;border:none;" data-action="new-request">${bt('ovNewRequest')}</button>
            </div>
          </div>

          <!-- 4 Mission Domains : SUPPLY CHAIN | DATA | TRACEABILITY | DPP -->
          <div class="mc-domains-grid">
            <!-- Domain 1: Supply Chain -->
            <div class="mc-domain-card">
              <div class="mc-domain-header">
                <span class="mc-domain-tag">${esc(bt('cnDom1'))}</span>
                ${badge('mc-badge-green', bt('cnStatusActive'))}
              </div>
              ${grandNombre(ag.produits)}
              <div class="mc-stat-sublist">
                <div class="mc-stat-subitem"><span>${bt('ovProducts')}</span><strong>${mesure(ag.produits)}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovSuppliers')}</span><strong>${mesure(ag.fournisseurs)}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovFacilities')}</span><strong>${mesureInconnue(ag.sites, ' ' + bt('ovSitesUnit'))}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovProdCountries')}</span><strong>${mesure(ag.pays, ' ' + bt('ovCountriesUnit'))}</strong></div>
              </div>
            </div>

            <!-- Domain 2: Data Quality & Evidence -->
            <div class="mc-domain-card">
              <div class="mc-domain-header">
                <span class="mc-domain-tag">${esc(bt('cnDom2'))}</span>
                ${badge('mc-badge-green', 'GRADE A')}
              </div>
              ${grandNombre(ag.qualite, '#0b7656')}
              <div class="mc-stat-sublist">
                <div class="mc-stat-subitem"><span>${bt('ovQuality')}</span><strong>${mesure(ag.qualite, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('scEvidenceCov')}</span><strong>${mesure(ag.preuves, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovVerified')}</span><strong>${mesure(ag.verifies, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovCertificates')}</span><strong>${mesure(ag.certificats)}</strong></div>
              </div>
            </div>

            <!-- Domain 3: Traceability Echelons -->
            <div class="mc-domain-card">
              <div class="mc-domain-header">
                <span class="mc-domain-tag">${esc(bt('cnDom3'))}</span>
                ${badge('mc-badge-blue', bt('cnStatusComplete'))}
              </div>
              ${grandNombre(ag.tracables, '#1d4ed8')}
              <div class="mc-stat-sublist">
                <div class="mc-stat-subitem"><span>${bt('ovTraceable')}</span><strong>${mesure(ag.tracables, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovLineage')}</span><strong>${mesure(lineage, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovGpsPolygons')}</span><strong>${mesureInconnue(gpsPolygons, ' ' + bt('ovSitesUnit'))}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovMassBalanced')}</span><strong>${mesure(massBalanced, '%')}</strong></div>
              </div>
            </div>

            <!-- Domain 4: DPP Readiness -->
            <div class="mc-domain-card">
              <div class="mc-domain-header">
                <span class="mc-domain-tag">${esc(bt('cnDom4'))}</span>
                ${badge('mc-badge-amber', 'CIRPASS 1.2')}
              </div>
              ${grandNombre(ag.dpp, '#b45309')}
              <div class="mc-stat-sublist">
                <div class="mc-stat-subitem"><span>${bt('ovDpp')}</span><strong>${mesure(ag.dpp, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovGs1')}</span><strong>${mesureInconnue(gs1Styles, ' ' + bt('ovStylesUnit'))}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovAgec')}</span><strong>${mesure(agec, '%')}</strong></div>
                <div class="mc-stat-subitem"><span>${bt('ovPefValidated')}</span><strong>${pef === null || pef === undefined ? `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>` : esc(pef)}</strong></div>
              </div>
            </div>
          </div>

          <!-- Attention & Alerts Bar -->
          <div class="mc-attention-panel">
            <div class="mc-attention-head">
              <div class="mc-attention-title">
                <span style="font-size:16px;">⚠️</span>
                <span>${bt('ovAttentionTitle')}</span>
              </div>
              <span class="meta" style="color:#b45309;font-weight:700;">${bt('ovGuidedFix')}</span>
            </div>
            <div class="mc-attention-grid">
              <div class="mc-attention-pill clickable" data-tf-act="p07">
                ${pastille(AT.donneesManquantes)}
                <div><strong>${bt('ovMissingData')}</strong><br><small>${bt('ovSuppliersPending')}</small></div>
              </div>
              <div class="mc-attention-pill clickable" data-tf-act="p17">
                ${pastille(AT.certificatsExpirant)}
                <div><strong>${bt('ovCertsExpiring')}</strong><br><small>${bt('ovRenewal90')}</small></div>
              </div>
              <div class="mc-attention-pill clickable" data-tf-act="p18">
                ${pastille(AT.fournisseursARevoir)}
                <div><strong>${bt('ovSuppliersReview')}</strong><br><small>${bt('ovCompleteness')}</small></div>
              </div>
              <div class="mc-attention-pill clickable" data-tf-act="p19">
                ${pastille(AT.produitsIncomplets)}
                <div><strong>${bt('ovProductsIncomplete')}</strong><br><small>${bt('ovBomUnbalanced')}</small></div>
              </div>
            </div>
          </div>

          <!-- Operational Tables Split -->
          <div class="grid split">
            <div class="card panel">
              <div class="panel-head">
                <h2>${bt('ovRecentRequests')}</h2>
                <button class="btn btn-secondary btn-small" data-view="requests">${bt('ovSeeAll')}</button>
              </div>
              ${requestTable(state.requests.slice(0, 5))}
            </div>

            <div class="card panel">
              <div class="panel-head"><h2>${bt('ovQuickInfra')}</h2></div>
              <div class="quick-grid">
                <button class="quick" data-action="new-request">
                  <span class="quick-icon">↗</span>
                  <span><strong>${bt('ovLaunchCollection')}</strong><span>${bt('ovDeployQuestionnaire')}</span></span>
                </button>
                <button class="quick" data-action="new-product">
                  <span class="quick-icon">◇</span>
                  <span><strong>${bt('ovCreateRef')}</strong><span>${bt('ovAddStyle')}</span></span>
                </button>
                <button class="quick" data-action="invite-supplier">
                  <span class="quick-icon">◎</span>
                  <span><strong>${bt('ovOnboardPartner')}</strong><span>${bt('ovSecureLink')}</span></span>
                </button>
                <button class="quick" data-tf-act="open" data-tf-arg="/dpp/">
                  <span class="quick-icon">📋</span>
                  <span><strong>${bt('ovSimulateDpp')}</strong><span>${bt('ovQrExperience')}</span></span>
                </button>
              </div>
            </div>
          </div>
        </div>`;
      }

      function requestTable(items) {
        if (!items.length) return `<div class="empty"><div class="empty-icon">↗</div><strong>${bt('cnRqEmptyTitle')}</strong><p>${esc(bt('cnRqEmptySub'))}</p><button class="btn btn-primary btn-small" data-action="new-request">${esc(bt('cnRqCreate'))}</button></div>`;
        return `<div class="table-wrap"><table><thead><tr><th>${bt('rqRequest')}</th><th>${bt('sxSupplier')}</th><th>${bt('pdStatus')}</th><th>${bt('rqProgress')}</th><th>${bt('dueDate')}</th><th></th></tr></thead><tbody>${items.map((r) => `<tr class="clickable" data-request-id="${esc(r.id)}"><td><strong>${esc(r.title)}</strong><div class="meta">${esc(r.questionnaireKey || 'Questionnaire')}</div></td><td>${esc(orgName(r.supplierOrganizationId))}</td><td>${status(r.status)}</td><td><div class="progress-line"><div class="progress"><span style="width:${pct(r.completionPercentage)}%"></span></div><small>${moneyless(r.completionPercentage)}%</small></div></td><td>${date(r.dueAt)}</td><td><div class="actions" style="justify-content:flex-end"><button class="btn btn-secondary btn-small" data-request-id="${esc(r.id)}">${bt('rqOpen')}</button>${['sent','in_progress','changes_requested'].includes(r.status) ? `<button class="btn btn-secondary btn-small" data-action="remind-request" data-reminder-request-id="${esc(r.id)}" title="${esc(bt('cnRdQueueReminder'))}">${bt('evFollowUp')}</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
      }

            function requestsView() {
        const counts = requestCounts();
        return `<div class="page-head">
          <div>
            <div class="eyebrow">${bt('rqEyebrow')}</div>
            <h1>${bt('rqPilotage')}</h1>
            <p>${esc(bt('cnRqIntro'))}</p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-tf-act="p20">${bt('rqQbuilder')}</button>
            <button class="btn btn-primary" data-action="new-request">${bt('rqNew')}</button>
          </div>
        </div>

        <!-- 7-Stage Structured Data Collection Lifecycle -->
        <div class="dc-pipeline-container">
          <div class="dc-pipeline-head">
            <div class="dc-pipeline-title">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#0b7656;"></span>
              <span>${bt('rqCycle')}</span>
            </div>
            ${estDemo() ? `<span class="meta" style="font-family:var(--font-mono,monospace);font-size:11px;color:#0b7656;font-weight:700;" data-tf-demo>Zero Data Silos · Full Audit Trail</span>` : ''}
          </div>

          <div class="dc-lifecycle-strip">
            <div class="dc-step-card active">
              <div class="dc-step-num">${bt('rqStep01')}</div>
              <div class="dc-step-label">${bt('rqBrand')}</div>
              <div class="dc-step-sub">${bt('rqSpec')}</div>
            </div>
            <div class="dc-step-card active">
              <div class="dc-step-num">${bt('rqStep02')}</div>
              <div class="dc-step-label">${bt('rqSupplier')}</div>
              <div class="dc-step-sub">${bt('rqInvite')}</div>
            </div>
            <div class="dc-step-card active">
              <div class="dc-step-num">${bt('rqStep03')}</div>
              <div class="dc-step-label">${bt('rqProductStyle')}</div>
              <div class="dc-step-sub">${bt('rqSkuBom')}</div>
            </div>
            <div class="dc-step-card active">
              <div class="dc-step-num">${bt('rqStep04')}</div>
              <div class="dc-step-label">${bt('rqRequiredData')}</div>
              <div class="dc-step-sub">${bt('rqTypedFields')}</div>
            </div>
            <div class="dc-step-card active">
              <div class="dc-step-num">${bt('rqStep05')}</div>
              <div class="dc-step-label">${bt('rqEvidenceVault')}</div>
              <div class="dc-step-sub">${bt('rqOcrCerts')}</div>
            </div>
            <div class="dc-step-card active">
              <div class="dc-step-num">${bt('rqStep06')}</div>
              <div class="dc-step-label">${bt('rqReview')}</div>
              <div class="dc-step-sub">${bt('rqAnnotations')}</div>
            </div>
            <div class="dc-step-card active" style="background:#0b7656;color:#ffffff;border-color:#07523e;">
              <div class="dc-step-num" style="color:#ffffff;">${bt('rqStep07')}</div>
              <div class="dc-step-label" style="color:#ffffff;">${bt('rqVerifiedData')}</div>
              <div class="dc-step-sub" style="color:rgba(255,255,255,0.94);">${bt('rqEsprOk')}</div>
            </div>
          </div>
        </div>

        <!-- Status Filter Filter Bar (Missing, Requested, Submitted, Under Review, Accepted, Rejected) -->
        <div class="dc-status-pills-row">
          <div class="dc-status-pill active" data-tf-act="p21">
            <span>${bt('rqAllRequests')}</span>
            <span class="dc-pill-badge">${state.requests.length}</span>
          </div>
          <div class="dc-status-pill" data-tf-act="p22">
            <span style="color:#b45309;">${bt('rqMissingDot')}</span>
            <span class="dc-pill-badge">${state.requests.filter(r => ['sent','in_progress'].includes(r.status)).length}</span>
          </div>
          <div class="dc-status-pill" data-tf-act="p23">
            <span style="color:#1d4ed8;">${bt('rqSubmittedDot')}</span>
            <span class="dc-pill-badge">${counts.submitted}</span>
          </div>
          <div class="dc-status-pill" data-tf-act="p24">
            <span style="color:#b06005;">${bt('rqUnderReview')}</span>
            <span class="dc-pill-badge">${state.requests.filter(r => r.status === 'changes_requested').length}</span>
          </div>
          <div class="dc-status-pill" data-tf-act="p25">
            <span style="color:#0b7656;">${bt('rqAccepted')}</span>
            <span class="dc-pill-badge">${state.requests.filter(r => r.status === 'approved').length}</span>
          </div>
          <div class="dc-status-pill" data-tf-act="p26">
            <span style="color:#b91c1c;">${bt('rqRejectedClosed')}</span>
            <span class="dc-pill-badge">${state.requests.filter(r => r.status === 'cancelled').length}</span>
          </div>
        </div>

        <div class="card panel">
          <div class="filters">
            <input class="input" id="request-search" placeholder="${bt('rqSearch')}">
            <select class="select" id="request-filter" aria-label="${esc(bt('cnFilterRequests'))}" style="max-width:200px">
              <option value="all">${bt('rqAllStatuses')}</option>
              <option value="sent">${bt('rqMissing')}</option>
              <option value="in_progress">${bt('rqFilling')}</option>
              <option value="submitted">${bt('rqSubmittedRev')}</option>
              <option value="approved">${bt('rqVerifiedApproved')}</option>
              <option value="cancelled">${bt('rqRejected')}</option>
            </select>
          </div>
          <div id="request-list">${requestTable(state.requests)}</div>
        </div>`;
      }

      function productsView() {
        const resultats = produitsFiltres();
        const tranche = trancher('products', resultats);
        return `<div class="page-head"><div><div class="eyebrow">${bt('pdEyebrow')}</div><h1>${bt('pdProducts')}</h1><p>${bt('pdLead')}</p></div><div class="actions"><button class="btn btn-secondary" data-action="catalog-import">${bt('importCsv')}</button><button class="btn btn-secondary" data-action="catalog-export">${bt('exportCsv')}</button><button class="btn btn-secondary" data-action="audit-export">${bt('exportAudit')}</button><button class="btn btn-primary" data-action="new-product">${bt('pdNew')}</button></div></div><div class="card panel">${state.products.length ? barreFiltres(tranche) + (resultats.length ? `<div class="table-wrap"><table><thead><tr><th>${bt('pdProduct')}</th><th>${bt('pdCategory')}</th><th>${bt('pdStatus')}</th><th>${bt('pdCompleteness')}</th><th>${bt('pdReadiness')}</th><th></th></tr></thead><tbody>${tranche.lignes.map((p) => `<tr><td><strong>${esc(p.name)}</strong><div class="meta">${esc(p.reference)} · v${esc(p.version)}</div></td><td>${esc(p.category || '—')}</td><td>${status(p.status)}</td><td>${p.dataCompletion === null || p.dataCompletion === undefined || p.dataCompletion === ''
  ? `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>`
  : `<div class="progress-line"><div class="progress"><span style="width:${pct(p.dataCompletion)}%"></span></div><small>${moneyless(p.dataCompletion)}%</small></div>`}</td><td>${p.dataReadiness ? status(p.dataReadiness) : `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>`}</td><td><div class="actions" style="justify-content:flex-end"><button class="btn btn-secondary btn-small" data-product-id="${esc(p.id)}">${bt('rqOpen')}</button><button class="btn btn-secondary btn-small" data-dpp-product="${esc(p.id)}">DPP</button><button class="btn btn-secondary btn-small" data-quality-product="${esc(p.id)}">${bt('pdQuality')}</button></div></td></tr>`).join('')}</tbody></table></div>${barrePagination('products', tranche)}` : `<div class="empty"><div class="empty-icon">⌕</div><strong>${esc(bt('pdNoMatch'))}</strong><p>${esc(bt('pdNoMatchHint'))}</p><button class="btn btn-secondary btn-small" data-tf-act="fx">${esc(bt('pdClearFilters'))}</button></div>`) : `<div class="empty"><div class="empty-icon">◇</div><strong>${esc(bt('cnPdEmptyTitle'))}</strong><p>${bt('pdEmpty')}</p><button class="btn btn-primary btn-small" data-action="new-product">${bt('pdCreate')}</button></div>`}</div>`;
      }

      function suppliersView() {
        const tranche = trancher('suppliers', suppliers());
        return `<div class="page-head"><div><div class="eyebrow">${bt('spEcosystem')}</div><h1>${bt('spSuppliers')}</h1><p>${bt('spLead')}</p></div><div class="actions"><button class="btn btn-secondary" data-action="supplier-import">${bt('importCsv')}</button><button class="btn btn-primary" data-action="invite-supplier">+ ${bt('mdInviteSupplier')}</button></div></div><div class="card panel">${suppliers().length ? `<div class="table-wrap"><table><thead><tr><th>${bt('cnThOrganisation')}</th><th>${bt('spRole')}</th><th>${bt('spOpenRequests')}</th><th></th></tr></thead><tbody>${tranche.lignes.map((s) => { const count = state.requests.filter((r) => r.supplierOrganizationId === s.organization_id && !['approved','cancelled'].includes(r.status)).length; return `<tr><td><strong>${esc(s.organizations.display_name || s.organizations.legal_name)}</strong><div class="meta">${esc(s.organizations.country_code || bt('cnCountryUnknown'))}</div></td><td><span class="status status-approved">${bt('sxPartnerActive')}</span></td><td>${count}</td><td><div class="actions" style="justify-content:flex-end"><button class="btn btn-secondary btn-small" data-supplier-id-view="${esc(s.id)}">${bt('cnSupplierProfileBtn')}</button><button class="btn btn-secondary btn-small" data-action="new-request" data-supplier-org-id="${esc(s.organization_id)}">${bt('spRequestData')}</button></div></td></tr>`; }).join('')}</tbody></table></div>${barrePagination('suppliers', tranche)}` : `<div class="empty"><div class="empty-icon">◎</div><strong>${bt('spEmpty')}</strong><p>${esc(bt('cnSxEmptySub'))}</p><button class="btn btn-primary btn-small" data-action="invite-supplier">${bt('mdInviteSupplier')}</button></div>`}</div>`;
      }

      function materialName(material) { return material?.name || material?.materialName || material?.id || bt('cnMaterialLabel'); }
      function materialType(material) { return material?.materialType || material?.material_type || ''; }
            function productDetailView() {
        const detail = state.selectedProductDetail;
        if (!detail?.product) {
          // Echec du chargement ESSENTIEL : erreur explicite et reessai, pas un
          // « produit introuvable » mensonger ni un ecran fige sur la vue
          // precedente.
          if (state.productDetailError) {
            return `<div class="empty"><div class="empty-icon">⚠</div><strong>${esc(bt('pxDetailLoadFailed'))}</strong><p class="meta"><code>${esc(state.productDetailError)}</code></p><div class="actions" style="justify-content:center;margin-top:16px"><button class="btn btn-secondary" data-action="retry-product-detail">${bt('cnRetry')}</button><button class="btn btn-secondary" data-view="products">${bt('pxBack')}</button></div></div>`;
          }
          return `<div class="empty"><div class="empty-icon">◇</div><strong>${bt('pxNotFound')}</strong><button class="btn btn-secondary" data-view="products">${bt('pxBack')}</button></div>`;
        }
        const p = detail.product;
        const materialOptions = state.materials.map((material) => `<option value="${esc(material.id)}">${esc(material.name)}${material.materialType ? ` · ${esc(material.materialType)}` : ''}</option>`).join('');

        return `<div class="page-head">
          <div>
            <button class="link-button" data-view="products">${bt('pxBackCatalogue')}</button>
            <div class="eyebrow" style="margin-top:16px;">${bt('pxProductIntel')} · ${bt('cRef')} ${esc(p.reference || '—')} · ${bt('pxVersion')} ${esc(p.version || '—')}</div>
            <h1>${esc(p.name || '—')}</h1>
            <p>${esc(p.category || '—')} · ${esc(bt('cnSxQualityIndex'))} <strong>${(() => {
              const score = state.quality?.score;
              const valeurs = score ? [score.completeness, score.freshness, score.documentationCoverage, score.consistency]
                .map(qualiteNum).filter((v) => v !== null) : [];
              if (!valeurs.length) return esc(bt('cnNotComputed'));
              return `${mesure(Math.round((valeurs.reduce((a, b) => a + b, 0) / valeurs.length) * 10) / 10, ' / 100')}`;
            })()}</strong></p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-action="product-supply-chain-from-detail">${bt('pxTraceGraph')}</button>
            <button class="btn btn-secondary" data-action="product-dpp-from-detail">${bt('pxPrepareDpp')}</button>
            <button class="btn btn-secondary" data-tf-act="open" data-tf-arg="/dpp/">📋 ${bt('pxPublicDpp')}</button>
              <button class="btn btn-secondary" data-tf-act="open" data-tf-arg="/product-intelligence/">${bt('pxOpenIntel')}</button>
            <button class="btn btn-primary" data-action="product-new-request" data-product-id="${esc(p.id)}">${bt('pxNewEvidenceReq')}</button>
          </div>
        </div>

        <!-- PRODUCT LINEAGE PIPELINE (Organic Cotton T-Shirt ➔ DPP) -->
        <div class="lineage-shell">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-family:var(--font-mono,monospace);font-size:11px;color:#0b7656;font-weight:750;letter-spacing:0.1em;text-transform:uppercase;">${esc(bt('cnLineageTitle'))}</div>
              <h3 style="font-size:18px;font-weight:800;color:#17231f;margin:4px 0 0;">${bt('pxLineage')}</h3>
            </div>
            ${estDemo() ? `<span class="badge badge-verified" style="background:#eaf5ef;color:#0b7656;font-weight:750;" data-tf-demo>${bt('pxVerifiedSealed')}</span>` : ''}
          </div>

          <div class="lineage-pipeline-flow">
            <div class="lineage-step-card active"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnLinFibre'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "GOTS Farm" : "—"}</div>
            </div>
            <div class="lineage-step-card"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnLinSpinning'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "Mass Balance" : "—"}</div>
            </div>
            <div class="lineage-step-card"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnLinKnitting'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "Guimarães PT" : "—"}</div>
            </div>
            <div class="lineage-step-card"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnLinDyeing'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "ZDHC Level 3" : "—"}</div>
            </div>
            <div class="lineage-step-card"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnLinAssembly'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "Certified Workshop" : "—"}</div>
            </div>
            <div class="lineage-step-card"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnLinProduct'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "BOM 100%" : "—"}</div>
            </div>
            <div class="lineage-step-card"${estDemo() ? " data-demo-action=\"1\"" : ""}>
              <div class="lineage-step-label">${esc(bt('cnGrpPef'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "Score A (PEF)" : "—"}</div>
            </div>
            <div class="lineage-step-card" data-tf-act="open" data-tf-arg="/dpp/">
              <div class="lineage-step-label" style="color:#0b7656;">${esc(bt('cnLinDppQr'))}</div>
              <div class="lineage-step-sub"${estDemo() ? " data-tf-demo" : ""}>${estDemo() ? "GS1 Link" : "—"}</div>
            </div>
          </div>
        </div>

        <div class="grid split">
          <div class="card panel">
            <div class="panel-head"><h2>${bt('pxTechSheet')}</h2></div>
            <form id="product-detail-form" class="form-grid">
              <label>${bt('pxStyleName')}<input class="input" name="name" value="${esc(p.name)}"></label>
              <label>${bt('pxSku')}<input class="input" name="reference" value="${esc(p.reference)}"></label>
              <label>${bt('pxTextileCategory')}<input class="input" name="category" value="${esc(p.category || '')}" placeholder="${esc(bt('cnUnknown'))}"></label>
              <label>${bt('pxColor')}<input class="input" name="colorName" value="${esc(p.colorName || '')}" placeholder="${esc(bt('cnUnknown'))}"></label>
              <label class="field-full">${bt('pxDescription')}<textarea class="input" name="description" maxlength="10000">${esc(p.description || '')}</textarea></label>
              <label>${bt('pxCountryMfg')}<input class="input" name="countryOfManufacture" maxlength="2" pattern="[A-Za-z]{2}" title="Code pays ISO-2 (ex. FR)" value="${esc(p.countryOfManufacture || '')}" placeholder="${esc(bt('cnUnknown'))}"></label>
              <label>${bt('pxWeightG')}<input class="input" name="weightGrams" type="number" min="0" max="1000000" step="any" value="${esc(p.weightGrams ?? '')}" placeholder="${esc(bt('cnUnknown'))}"></label>
              <label>${bt('pxSizes')}<input class="input" name="sizeRange" value="${esc(p.sizeRange || '')}" placeholder="${esc(bt('cnUnknown'))}"></label>
              <p class="field-full" id="product-field-error" role="alert"></p>
              <div class="form-actions field-full">
                <button class="btn btn-primary" type="submit">${bt('pxUpdate')}</button>
              </div>
            </form>
          </div>

          <div class="card panel">
            <div class="panel-head">
              <div>
                <h2>${bt('pxBomTitle')}</h2>
                <p class="meta" style="margin:4px 0 0;">${bt('pxEspr')}</p>
              </div>
              <span class="status ${detail.materials?.length ? 'status-approved' : 'status-draft'}">${detail.materials?.length ? esc(bt('pxReconciled')) : esc(bt('cnNotComputed'))}</span>
            </div>

            ${detail.materials?.length ? `<div class="item-list">${detail.materials.map((m) => `<form class="item material-edit-form" data-material-product-id="${esc(p.id)}">
              <input type="hidden" name="materialId" value="${esc(m.materialId)}">
              <div>
                <strong>${esc(materialName(m.material))}</strong>
                <div class="meta">${esc(m.role || '—')} · ${esc(materialType(m.material) || '—')}</div>
              </div>
              <div class="actions">
                <label class="meta">${bt('pxSharePct')}<input class="input" name="percentage" type="number" value="${esc(m.percentage ?? '')}" style="width:75px"></label>
                <button class="btn btn-secondary btn-small" type="submit">${bt('pxApply')}</button>
              </div>
            </form>`).join('')}</div>` : `
            ${estDemo() ? `<div class="item-list" data-tf-demo>
              <div class="item">
                <div><strong>Combed Organic Cotton (GOTS)</strong><div class="meta">Primary fibre · Türkiye / Greece</div></div>
                <div class="actions"><span class="badge badge-verified">85%</span></div>
              </div>
              <div class="item">
                <div><strong>Pre-consumer Recycled Cotton (GRS)</strong><div class="meta">Reincorporated spinning waste</div></div>
                <div class="actions"><span class="badge badge-verified">15%</span></div>
              </div>
            </div>` : `<div class="empty"><strong>${esc(bt('cnNone'))}</strong></div>`}`}

            <form id="material-form" class="form-grid" style="margin-top:18px">
              <label class="field-full">${bt('pxAddComponent')}
                <select class="select" name="materialId">${materialOptions || `<option value="">${esc(bt('cnNone'))}</option>`}</select>
              </label>
              <label>${bt('pxSharePctP')}<input class="input" name="percentage" type="number" min="0" max="100" placeholder="15"></label>
              <label>${bt('spRole')}<input class="input" name="materialRole" value="secondary"></label>
              <div class="form-actions field-full">
                <button class="btn btn-primary btn-small" type="submit">${bt('pxAddBom')}</button>
              </div>
            </form>
          </div>
        </div>

          <div class="card panel" style="margin-top:20px;">
            <div class="panel-head">
              <div>
                <h2>${bt('pxIdentifiers')}</h2>
                <p class="meta">${bt('pxResolveHint')}</p>
              </div>
              <span class="meta">${detail.identifiers?.length || 0} ${bt('pxActiveIdentifiers')}</span>
            </div>
            ${detail.identifiers?.length ? `<div class="item-list">${detail.identifiers.map((identifier) => `<form class="item identifier-edit-form" data-identifier-id="${esc(identifier.id)}"><div><strong>${esc(identifier.type.toUpperCase())}</strong><div class="meta">${esc(bt('cnCreatedOn'))} ${date(identifier.createdAt)}</div></div><div class="actions"><input class="input" name="identifierValue" value="${esc(identifier.value)}" maxlength="240" required aria-label="Valeur ${esc(identifier.type)}"><label class="meta"><input type="checkbox" name="isPrimary" ${identifier.isPrimary ? 'checked' : ''}> Principal</label><button class="btn btn-secondary btn-small" type="submit">${bt('pxSave')}</button></div></form>`).join('')}</div>` : `<div class="empty" style="padding:12px 0 18px"><p>${bt('pxNoId')}</p></div>`}
            <form id="identifier-form" class="form-grid" style="margin-top:18px"><label>${bt('mtType')}<select class="select" name="identifierType" required><option value="internal">Interne</option><option value="gtin">GTIN</option><option value="ean">EAN</option><option value="upc">UPC</option></select></label><label>${bt('pdIdValue')}<input class="input" name="identifierValue" maxlength="240" required placeholder="3760123456789"></label><label style="display:flex;align-items:center;gap:8px;margin-top:25px"><input type="checkbox" name="isPrimary"> ${bt('pxSetPrimary')}</label><div class="form-actions" style="margin-top:25px"><button class="btn btn-primary btn-small" type="submit">${bt('pxAddId')}</button></div></form>
          </div>

          ${schemaBindingsPanel(p)}`;
      }

      /**
       * Panneau « schemas externes lies » de la fiche produit.
       *
       * Trois etats reels, visuellement distincts :
       *   - charge    : la liste des liaisons (+ le formulaire de rattachement) ;
       *   - degrade   : la route auxiliaire a echoue — message explicite, code
       *                 d'erreur apparent, bouton « Reessayer » ;
       *   - en cours  : ni charge ni echoue.
       *
       * L'etat degrade est la correction du blocage Production du 2026-10-17 :
       * un 504 de /api/schema-bindings masquait toute la fiche ; desormais il
       * ne masque que son propre panneau, et il ne ment pas — le code
       * `request_failed_504` reste affiche, aucune erreur n'est avalée.
       */
      function schemaBindingsPanel(p) {
        if (!p) return '';
        const schemaOptions = (state.schemaCatalog || [])
          .filter((schema) => (schema.subjectTypes || []).includes('product'))
          .map((schema) => `<option value="${esc(schema.key)}|${esc(schema.version)}">${esc(schema.title || schema.key)} · v${esc(schema.version)}</option>`)
          .join('');
        if (state.schemaBindingsError) {
          return `<div class="card panel" style="margin-top:20px" data-schema-panel="degraded">
            <div class="panel-head">
              <div>
                <h2>${bt('cnSchemaTitle')}</h2>
                <p class="meta" style="margin:4px 0 0">${bt('cnSchemaIntro')}</p>
              </div>
              <span class="status status-changes_requested">${bt('cnSchemaDegraded')}</span>
            </div>
            <div class="notice">${bt('cnSchemaLoadFailed')}</div>
            <p class="meta" style="margin:10px 0 0"><code>${esc(state.schemaBindingsError)}</code></p>
            <div class="actions" style="margin-top:14px">
              <button class="btn btn-secondary btn-small" data-action="retry-schema-bindings">${bt('cnRetry')}</button>
            </div>
          </div>`;
        }
        if (!Array.isArray(state.schemaBindings)) {
          return `<div class="card panel" style="margin-top:20px" data-schema-panel="loading">
            <div class="panel-head">
              <div>
                <h2>${bt('cnSchemaTitle')}</h2>
                <p class="meta" style="margin:4px 0 0">${bt('cnSchemaIntro')}</p>
              </div>
              <span class="meta">${bt('cnSchemaLoading')}</span>
            </div>
          </div>`;
        }
        return `<div class="card panel" style="margin-top:20px" data-schema-panel="loaded">
          <div class="panel-head">
            <div>
              <h2>${bt('cnSchemaTitle')}</h2>
              <p class="meta" style="margin:4px 0 0">${bt('cnSchemaIntro')}</p>
            </div>
            <span class="meta">${state.schemaBindings.length} ${bt('cnSchemaCount')}</span>
          </div>
          ${state.schemaBindings.length ? `<div class="item-list">${state.schemaBindings.map((binding) => `<div class="item" data-schema-binding="${esc(binding.id)}">
            <div>
              <strong>${esc(binding.schemaKey)}</strong>
              <div class="meta">v${esc(binding.schemaVersion)} · ${bt('cnCreatedOn')} ${date(binding.createdAt)}</div>
            </div>
            <span class="status status-approved">${bt('cnSchemaBound')}</span>
          </div>`).join('')}</div>` : `<div class="empty" style="padding:12px 0 18px"><p>${bt('cnSchemaNone')}</p></div>`}
          <form id="schema-binding-form" class="form-grid" style="margin-top:18px">
            <label class="field-full">${bt('cnSchemaPick')}
              <select class="select" name="schemaIdentity" ${schemaOptions ? '' : 'disabled'}>${schemaOptions || `<option value="">${bt('cnSchemaNoCatalog')}</option>`}</select>
            </label>
            <div class="form-actions field-full">
              <button class="btn btn-primary btn-small" type="submit" ${schemaOptions ? '' : 'disabled'}>${bt('cnSchemaAttach')}</button>
            </div>
          </form>
        </div>`;
      }

      function supplierDetailView() {
        const supplier = state.selectedSupplier;
        if (!supplier) return `<div class="empty"><div class="empty-icon">◎</div><strong>${bt('sxNotFound')}</strong><button class="btn btn-secondary" data-view="suppliers">${bt('sxBack')}</button></div>`;
        return `<div class="page-head"><div><button class="link-button" data-view="suppliers">${bt('sxBackArrow')}</button><div class="eyebrow" style="margin-top:20px">${bt('sxSupplier')}</div><h1>${esc(supplier.name)}</h1><p>${esc(supplier.country || bt('cnCountryUnknown'))} · ${esc(supplier.role || bt('sxRoleActive'))}</p></div><div class="actions"><button class="btn btn-secondary" data-tf-act="open" data-tf-arg="/passport/">${bt('sxPublicPassport')}</button><button class="btn btn-primary" data-action="new-request" data-supplier-org-id="${esc(supplier.organizationId)}">${bt('sxNewRequest')}</button></div></div><div class="grid split"><div class="card panel"><div class="panel-head"><h2>${bt('sxProfileTitle')}</h2><span class="status status-${esc(supplier.profile?.onboardingStatus || 'draft')}">${supplier.profile?.onboardingStatus ? esc(statusLabel(supplier.profile.onboardingStatus)) : esc(bt('cnNotLoaded'))}</span></div>${supplier.profile ? `<dl style="display:grid;gap:15px;margin:0"><div><dt class="meta">${bt('pdCompleteness')}</dt><dd style="margin:4px 0;font-weight:800">${esc(supplier.profile.profileCompletion)}%</dd></div><div><dt class="meta">${bt('sxContact')}</dt><dd style="margin:4px 0;font-weight:750">${esc(supplier.profile.contactName || '—')} · ${esc(supplier.profile.contactEmail || '—')}</dd></div><div><dt class="meta">${bt('sxActivities')}</dt><dd style="margin:4px 0;font-weight:750">${esc((supplier.profile.activityTypes || []).join(', ') || '—')}</dd></div><div><dt class="meta">${bt('sxSummary')}</dt><dd style="margin:4px 0;line-height:1.5">${esc(supplier.profile.profileSummary || '—')}</dd></div></dl>` : `<div class="empty"><p>${esc(bt('cnNoProfile'))}</p></div>`}</div><div class="card panel"><div class="panel-head"><h2>${bt('sxRequestsTitle')}</h2></div>${requestTable(state.requests.filter((r) => r.supplierOrganizationId === supplier.id))}</div></div>`;
      }

      function capContractPanel() {
        return `<div class="card panel" style="margin-top:18px"><div class="panel-head"><div><h2>${bt('qcCapTitle')}</h2><p class="meta">${bt('qcCapIntro')}</p></div><div class="actions"><button class="btn btn-secondary btn-small" type="button" data-action="open-cap-modal">${bt('qcCreateCap')}</button><button class="btn btn-secondary btn-small" type="button" data-action="open-review-cap-modal">${bt('mdReviewCap')}</button><button class="btn btn-secondary btn-small" type="button" data-action="open-cap-message-modal">${bt('qcMessageThread')}</button></div></div><div class="notice">${bt('qcCapNote')}</div></div>`;
      }

      function integrationsView() {
        return `<div class="page-head"><div><div class="eyebrow">${bt('igInterop')}</div><h1>${bt('igTitle')}</h1><p>${bt('igIntro')}</p></div></div><div class="grid split"><div class="card panel"><h2>${bt('igImportSource')}</h2><form id="plm-import-form"><select class="select" id="plm-system-select" name="system"><option>Centric Software</option><option>Lectra (Kubix Link)</option><option>SAP S/4HANA Fashion</option><option>GS1 EPCIS 2.0</option></select><textarea class="textarea" name="payload" rows="4"></textarea></form></div><div class="card panel"><h2>${bt('igGs1Title')}</h2><p>${bt('igGs1Desc')}</p></div></div>`;
      }

      function massBalanceConsoleView() {
        return `<div class="page-head"><div><div class="eyebrow">${bt('mbAntiFraud')}</div><h1>${bt('mbTitle')}</h1><p>${bt('mbIntro')}</p></div></div><div class="grid split"><div class="card panel"><div class="panel-head"><h2>${bt('mbTransactionCerts')}</h2></div><form id="tc-form"><input class="input" name="certificateNumber" placeholder="TC-2026-0001" required><input class="input" name="certifiedQuantityKg" type="number" step="0.001" required><button class="btn btn-primary">${bt('mbRegisterTc')}</button></form></div><div class="card panel"><form id="allocate-tc-form"><input class="input" name="productId" placeholder="UUID produit" required><input class="input" name="allocatedQuantityKg" type="number" step="0.001" required><button class="btn btn-primary">${bt('mbAllocate')}</button></form></div></div><div class="card panel" style="margin-top:18px"><h2>${bt('mbReconcile')}</h2><form id="reconcile-mass-balance-form"><input class="input" name="productId" placeholder="UUID produit" required><input class="input" name="productionUnits" type="number" required><input class="input" name="unitWeightGrams" type="number" required><input class="input" name="cuttingWastePct" type="number" required></form></div>`;
      }

      function complianceContractPanel() {
        const pef = state.pefAssessment;
        const claims = state.greenClaimsAudit;
        const pefValeur = pef
          ? `${esc(pef.pefGrade || '—')} · ${mesure(pef.pefEcoScore, ' / 100')}`
          : `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>`;
        const claimsValeur = claims
          ? `<code>${esc(claims.audit_verdict || claims.auditVerdict || '—')}</code> · ${mesure(claims.green_claims_score ?? claims.greenClaimsScore, ' / 100')}`
          : `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>`;
        return `<div class="card panel" style="margin-top:18px"><div class="panel-head"><div><h2>${bt('qcPefTitle')}</h2><p class="meta">${bt('qcEcoScore')} : ${pefValeur}</p></div><button class="btn btn-secondary btn-small" data-action="calculate-pef">${bt('qcComputePef')}</button></div><div class="panel-head" style="margin-top:14px"><div><h2>${bt('qcGreenShield')}</h2><p class="meta">${bt('qcClaimsNote')} ${claimsValeur}</p></div><button class="btn btn-secondary btn-small" data-action="audit-green-claims">${bt('qcAuditClaims')}</button></div><form id="green-claim-form" class="form-grid"><label class="field-full">${bt('qcClaim')}<textarea class="textarea" name="claimText" rows="2" placeholder="${esc(bt('qcClaim'))}"></textarea></label></form></div>`;
      }


      /* ── Risk & exposure ──────────────────────────────────────────────
         Vue exigee par le cahier des charges (nav : Quality, Risk, DPP) et
         absente de la console jusqu'ici.

         Principe : aucune notation externe, aucune donnee inventee. Chaque
         signal est derive des enregistrements deja charges dans state
         (fournisseurs, produits, matieres, demandes). Une dimension sans
         enregistrement vaut 0 et l'affiche comme telle, plutot que de
         simuler un score. L'indice global est un indicateur operationnel
         destine a prioriser le travail : ce n'est jamais une certification.
      */
      function riskSignals() {
        const sup = state.suppliers || [];
        const prods = state.products || [];
        const reqs = state.requests || [];
        const mats = state.materials || [];
        const now = Date.now();
        const org = (s) => s.organizations || {};
        const nom = (o, s) => o.display_name || o.legal_name || s.id || '—';
        const SEUIL = SEUIL_COMPLETUDE;
        const rows = [];

        // 1. Concentration : part du pays le plus represente
        const parPays = {};
        sup.forEach((s) => { const c = org(s).country_code || ''; parPays[c] = (parPays[c] || 0) + 1; });
        const pays = Object.entries(parPays).sort((a, b) => b[1] - a[1]);
        const partMax = sup.length ? Math.round((pays[0][1] / sup.length) * 100) : 0;
        if (sup.length > 1 && partMax >= 50) {
          rows.push({ sev: partMax >= 80 ? 'High' : 'Medium', cat: 'riskCatGeography',
            subject: pays[0][0] || bt('riskGeoUnknown'), sig: 'riskSigConcentration',
            extra: partMax + '%', view: 'suppliers' });
        }

        // 2. Fournisseurs : relation inactive, pays non declare
        sup.forEach((s) => {
          const o = org(s);
          if (o.status && o.status !== 'active') {
            rows.push({ sev: 'High', cat: 'riskCatSupplier', subject: nom(o, s),
              sig: 'riskSigInactive', extra: o.status, view: 'suppliers' });
          }
          if (!o.country_code) {
            rows.push({ sev: 'Medium', cat: 'riskCatSupplier', subject: nom(o, s),
              sig: 'riskSigNoCountry', extra: '', view: 'suppliers' });
          }
        });

        // 3. Produits : completude sous le seuil, sinon donnees non validees
        prods.forEach((p) => {
          const c = Number(p.dataCompletion);
          const label = [p.reference, p.name].filter(Boolean).join(' · ') || p.id;
          if (Number.isFinite(c) && c < SEUIL) {
            rows.push({ sev: c < 50 ? 'Critical' : 'High', cat: 'riskCatProduct', subject: label,
              sig: 'riskSigIncomplete', extra: c + '%', view: 'products' });
          } else if (p.dataReadiness && p.dataReadiness !== 'data_ready') {
            rows.push({ sev: 'Medium', cat: 'riskCatProduct', subject: label,
              sig: 'riskSigNotReady', extra: statusLabel(p.dataReadiness), view: 'products' });
          }
        });

        // 4. Collecte : demandes echues, puis demandes en retard de completion
        const clos = (r) => ['approved', 'completed', 'accepted'].includes(r.status);
        reqs.forEach((r) => {
          if (clos(r)) return;
          const due = r.dueAt ? Date.parse(r.dueAt) : NaN;
          const pct = Number(r.completionPercentage);
          if (Number.isFinite(due) && due < now) {
            const jours = Math.max(1, Math.round((now - due) / 86400000));
            rows.push({ sev: 'Critical', cat: 'riskCatCollection', subject: r.title || r.id,
              sig: 'riskSigOverdue', extra: '+' + jours + 'd', view: 'requests' });
          } else if (Number.isFinite(pct) && pct < 50) {
            rows.push({ sev: 'Medium', cat: 'riskCatCollection', subject: r.title || r.id,
              sig: 'riskSigStalled', extra: pct + '%', view: 'requests' });
          }
        });

        // 5. Matieres sans pays d'origine
        mats.forEach((m) => {
          if (!m.originCountryCode) {
            rows.push({ sev: 'Medium', cat: 'riskCatMaterial', subject: m.name || m.id,
              sig: 'riskSigNoOrigin', extra: '', view: 'materials' });
          }
        });

        // Dimensions : part des enregistrements porteurs d'un signal.
        const part = (n, d) => (d ? Math.round((n / d) * 100) : 0);
        const dims = [
          { key: 'riskDimConcentration', n: sup.length,
            score: sup.length > 1 ? Math.max(0, partMax - 20) : 0 },
          { key: 'riskDimGeography', n: sup.length,
            score: part(sup.filter((s) => !org(s).country_code).length, sup.length) },
          { key: 'riskDimData', n: prods.length,
            score: part(prods.filter((p) => Number(p.dataCompletion) < SEUIL
              || (p.dataReadiness && p.dataReadiness !== 'data_ready')).length, prods.length) },
          { key: 'riskDimCollection', n: reqs.length,
            score: part(reqs.filter((r) => !clos(r) && ((r.dueAt && Date.parse(r.dueAt) < now)
              || Number(r.completionPercentage) < 50)).length, reqs.length) },
          { key: 'riskDimTraceability', n: mats.length,
            score: part(mats.filter((m) => !m.originCountryCode).length, mats.length) },
        ];
        // Seules les dimensions reellement alimentees entrent dans l'indice :
        // moyenner un zero issu d'une absence de donnees ferait baisser le
        // score pour la mauvaise raison.
        const vivantes = dims.filter((d) => d.n > 0);
        const index = vivantes.length
          ? Math.round(vivantes.reduce((a, d) => a + d.score, 0) / vivantes.length) : 0;

        const rang = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        rows.sort((a, b) => rang[a.sev] - rang[b.sev]);
        return { rows, dims, index, pays, nbSup: sup.length, nbProd: prods.length };
      }

      function riskView() {
        const r = riskSignals();
        const bande = r.index >= 70 ? 'riskBandHigh' : r.index >= 45 ? 'riskBandElevated'
          : r.index >= 20 ? 'riskBandModerate' : 'riskBandLow';
        const pastille = { Critical: 'risk-pill risk-pill--critical', High: 'risk-pill risk-pill--high',
          Medium: 'risk-pill risk-pill--medium', Low: 'risk-pill risk-pill--low' };
        const sevKey = { Critical: 'riskSevCritical', High: 'riskSevHigh',
          Medium: 'riskSevMedium', Low: 'riskSevLow' };
        const critiques = r.rows.filter((x) => x.sev === 'Critical').length;
        const fournSignales = new Set(r.rows.filter((x) => x.cat === 'riskCatSupplier')
          .map((x) => x.subject)).size;
        const produitsExposes = new Set(r.rows.filter((x) => x.cat === 'riskCatProduct')
          .map((x) => x.subject)).size;

        const trancheRisque = trancher('risk', r.rows);
        const lignes = trancheRisque.lignes.map((x) => `
          <tr>
            <td><span class="${pastille[x.sev]}">${esc(bt(sevKey[x.sev]))}</span></td>
            <td>${esc(bt(x.cat))}</td>
            <td><strong>${esc(x.subject)}</strong></td>
            <td>${esc(bt(x.sig))}${x.extra ? ` <span class="meta">· ${esc(x.extra)}</span>` : ''}</td>
            <td style="text-align:right">
              <button class="btn btn-secondary btn-small" data-tf-act="p27" data-tf-arg="${x.view}">
                ${esc(bt('riskOpen'))}
              </button>
            </td>
          </tr>`).join('');

        return `
          <div class="page-head">
            <div>
              <div class="eyebrow">${esc(bt('riskEyebrow'))}</div>
              <h1>${esc(bt('riskTitle'))}</h1>
              <p>${esc(bt('riskLead'))}</p>
            </div>
            <div class="actions">
              <span class="risk-note">${esc(bt('riskNotCertification'))}</span>
              <button class="btn btn-secondary" data-tf-act="p28">${esc(bt('riskRecompute'))}</button>
            </div>
          </div>

          <div class="grid kpis risk-kpis">
            <div class="card kpi">
              <div class="kpi-value">${r.index}</div>
              <div class="kpi-label">${esc(bt('riskIndex'))}</div>
              <div class="kpi-note">${esc(bt(bande))} · ${esc(bt('riskOutOf100'))}</div>
            </div>
            <div class="card kpi">
              <div class="kpi-value">${critiques}</div>
              <div class="kpi-label">${esc(bt('riskCriticalSignals'))}</div>
            </div>
            <div class="card kpi">
              <div class="kpi-value">${fournSignales}</div>
              <div class="kpi-label">${esc(bt('riskSuppliersAtRisk'))}</div>
              <div class="kpi-note">/ ${r.nbSup}</div>
            </div>
            <div class="card kpi">
              <div class="kpi-value">${produitsExposes}</div>
              <div class="kpi-label">${esc(bt('riskProductsExposed'))}</div>
              <div class="kpi-note">/ ${r.nbProd}</div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><h2>${esc(bt('riskDimTitle'))}</h2></div>
            <div>
              ${r.dims.map((d) => `
                <div class="risk-dim">
                  <div class="risk-dim__row">
                    <span class="risk-dim__name">${esc(bt(d.key))}</span>
                    <span class="risk-dim__val${d.n ? '' : ' is-muted'}">${d.n ? d.score + '%' : esc(bt('riskNoRecords'))}</span>
                  </div>
                  <div class="pillar-bar-bg"><div class="pillar-bar-fill" style="width:${d.n ? d.score : 0}%"></div></div>
                </div>`).join('')}
            </div>
            <p class="meta risk-basis">
              <strong>${esc(bt('riskBasisTitle'))}.</strong> ${esc(bt('riskBasisBody'))}
            </p>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>${esc(bt('riskRegisterTitle'))}</h2>
              <span class="meta">${esc(bt('riskRegisterNote'))}</span>
            </div>
            ${r.rows.length ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>${esc(bt('riskColSeverity'))}</th>
                <th>${esc(bt('riskColCategory'))}</th>
                <th>${esc(bt('riskColSubject'))}</th>
                <th>${esc(bt('riskColSignal'))}</th>
                <th style="text-align:right">${esc(bt('riskColAction'))}</th>
              </tr></thead>
              <tbody>${lignes}</tbody>
            </table></div>${barrePagination('risk', trancheRisque)}` : `<div class="empty">
              <div class="empty-icon">○</div>
              <strong>${esc(bt('riskEmpty'))}</strong>
              <p class="meta">${esc(bt('riskEmptyNote'))}</p>
            </div>`}
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>${esc(bt('riskGeoTitle'))}</h2>
              <span class="meta">${esc(bt('riskGeoNote'))}</span>
            </div>
            ${r.pays.length ? `<div>
              ${r.pays.map(([code, n]) => {
                const pc = r.nbSup ? Math.round((n / r.nbSup) * 100) : 0;
                return `<div class="risk-dim">
                  <div class="risk-dim__row">
                    <span class="risk-dim__name">${esc(code || bt('riskGeoUnknown'))}</span>
                    <span class="risk-dim__val">${pc}%<span class="meta" style="font-weight:650"> · ${n}</span></span>
                  </div>
                  <div class="pillar-bar-bg"><div class="pillar-bar-fill" style="width:${pc}%"></div></div>
                </div>`;
              }).join('')}
            </div>` : `<div class="empty"><div class="empty-icon">○</div><strong>${esc(bt('riskEmpty'))}</strong></div>`}
          </div>`;
      }

            // Trois constats illustratifs, uniquement en demonstration et
            // seulement tant qu'aucun calcul reel n'est charge. Ils portent
            // le marqueur [data-tf-demo] qui les declare comme tels.
      const DEMO_QUALITY_ISSUES = [
        { id: 'demo-issue-warning', severity: 'warning', status: 'open', ruleKey: 'ZDHC_EFFLUENT_TEST_REPORT', message: 'RSL test report missing for dye lot #089', detectedAt: new Date().toISOString() },
        { id: 'demo-issue-review-1', severity: 'info', status: 'acknowledged', ruleKey: 'CERTIFICATE_EXPIRATION_GATE', message: 'GOTS certificate CU-881294 expiring in 42 days', detectedAt: new Date().toISOString() },
        { id: 'demo-issue-review-2', severity: 'info', status: 'acknowledged', ruleKey: 'POLYGON_FACILITY_REGISTRY', message: 'GPS coordinates of the cutting workshop not locked', detectedAt: new Date().toISOString() },
      ];

      function qualiteNum(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }

            function qualityView() {
        const demoMode = estDemo();
        const prod = state.selectedProduct || state.products[0] || null;
        const q = state.quality || null;
        const score = q?.score || null;
        // Un calcul reel remplace toujours l'illustration. Hors
        // demonstration, l'absence de calcul se dit au lieu de s'inventer.
        const issues = q
          ? (q.issues || [])
          : (demoMode ? DEMO_QUALITY_ISSUES : []);
        const filtre = state.qualityFilter || 'all';
        const ouvert = (i) => ['open', 'acknowledged'].includes(i.status);
        const correspond = (i) => filtre === 'all' ? true
          : filtre === 'critical' ? (i.severity === 'blocking' && ouvert(i))
            : filtre === 'warning' ? (i.severity === 'warning' && ouvert(i))
              : filtre === 'review' ? i.status === 'acknowledged'
                : ['waived', 'resolved'].includes(i.status);
        const compter = (f) => issues.filter(f).length;
        const compteurs = {
          all: issues.length,
          critical: compter((i) => i.severity === 'blocking' && ouvert(i)),
          warning: compter((i) => i.severity === 'warning' && ouvert(i)),
          review: compter((i) => i.status === 'acknowledged'),
          resolved: compter((i) => ['waived', 'resolved'].includes(i.status)),
        };
        const affichees = issues.filter(correspond);

        const demoValeurs = { completeness: 96.8, evidence: 92.0, verification: 88.5, supplier: 94.2, product: 88.0 };
        const valeurs = score ? {
          completeness: qualiteNum(score.completeness),
          evidence: qualiteNum(score.documentationCoverage),
          // Ces deux dimensions ne sont pas renvoyees par la route qualite.
          verification: null,
          supplier: null,
          product: null,
        } : (demoMode ? demoValeurs : { completeness: null, evidence: null, verification: null, supplier: null, product: null });

        const disponibles = Object.values(valeurs).filter((v) => v !== null);
        const indice = disponibles.length
          ? Math.round((disponibles.reduce((a, b) => a + b, 0) / disponibles.length) * 10) / 10
          : null;

        const badge = (demoMode && !score)
          ? '<span class="badge badge-verified" style="background:#eaf5ef;color:#0b7656;font-size:12px;font-weight:750;" data-tf-demo>OVERALL GRADE: A (98.4%)</span>'
          : `<span class="badge badge-verified" style="background:#eaf5ef;color:#0b7656;font-size:12px;font-weight:750;">${indice === null ? esc(bt('cnNotComputed')) : `${esc(bt('cnQualityIndex'))}: ${mesure(indice, '%')}`}</span>`;

        const carte = (label, desc, value, color, exemple) => `
            <div class="eq-score-card">
              <div class="eq-score-label">${bt(label)}</div>
              <div class="eq-score-num" style="color:${color};${value === null ? 'font-size:13px;letter-spacing:0;' : ''}">${value === null ? esc(bt('cnNotComputed')) : mesure(value, '%')}</div>
              <div class="eq-score-desc"${exemple ? ' data-tf-demo' : ''}>${bt(desc)}</div>
            </div>`;

        const onglet = (cle, label, couleur) => `
          <div class="eq-sev-tab ${filtre === cle ? 'active' : ''}" data-tf-act="p${29 + ['all', 'critical', 'warning', 'review', 'resolved'].indexOf(cle)}">
            <span${couleur ? ` style="color:${couleur};"` : ''}>${label}</span>
            <span class="sev-pill-count"${couleur ? ` style="color:${couleur};"` : ''}>${compteurs[cle]}</span>
          </div>`;

        const liste = affichees.length
          ? affichees.map((issue) => issueCard(issue)).join('')
          : `<div class="empty"><strong>${esc(bt('cnNotComputed'))}</strong><p class="meta">${esc(bt('cnQcIntro'))}</p><button class="btn btn-secondary btn-small" data-view="products">${esc(bt('products'))}</button></div>`;

        return `${complianceContractPanel()}${capContractPanel()}
        <div class="page-head">
          <div>
            <div class="eyebrow">${bt('qcEyebrow')}</div>
            <h1>${bt('qcTrustQuestion')}</h1>
            <p>${esc(bt('cnQcIntro'))}</p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-action="select-quality-product">${bt('scChangeProduct')}</button>
            <button class="btn btn-primary" data-action="compute-quality">${bt('qcRecalc')}</button>
          </div>
        </div>

        <!-- 5 Core Pillars: Data Completeness | Evidence Coverage | Verification Rate | Supplier Quality | Product Quality -->
        <div class="eq-overview-panel">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-size:11px;font-family:var(--font-mono,monospace);font-weight:750;color:#0b7656;letter-spacing:0.1em;text-transform:uppercase;">${bt('qcMatrix')}</div>
              <h3 style="font-size:17px;font-weight:800;color:#17231f;margin:2px 0 0;">${bt('qcPreAudit')}</h3>
            </div>
            ${badge}
          </div>

          <div class="eq-score-strip"${demoMode && !score ? ' data-tf-demo' : ''}>
            ${carte('qcCompleteness', 'qcTestReports', valeurs.completeness, '#0b7656', false)}
            ${carte('qcEvidenceCov', 'qcTestReports', valeurs.evidence, '#0b7656', false)}
            ${carte('qcVerifRate', 'qcThirdParty', valeurs.verification, '#1d4ed8', false)}
            ${carte('qcSupplierQuality', 'qcTiersOk', valeurs.supplier, '#0b7656', false)}
            ${carte('qcProductQuality', 'qcDppEligible', valeurs.product, '#b45309', false)}
          </div>
        </div>

        <!-- Severity Action Filter Tabs : CRITICAL | WARNING | REVIEW | RESOLVED -->
        <div class="eq-severity-tabs">
          ${onglet('all', bt('qcAllIssues'), null)}
          ${onglet('critical', bt('qcCritical'), '#b91c1c')}
          ${onglet('warning', bt('qcWarning'), '#b45309')}
          ${onglet('review', bt('qcReview'), '#1d4ed8')}
          ${onglet('resolved', bt('qcResolved'), '#0b7656')}
        </div>

        <!-- Issues Card with Immediate Action Links -->
        <div class="card panel">
          <div class="panel-head">
            <h2>${bt('qcActiveIssuesFor')} : ${esc(prod?.name || '—')}</h2>
            <span class="meta">${q ? `${moneyless(issues.length)} ${esc(bt('qcAnomaliesFound'))}`
              : (demoMode ? `${moneyless(issues.length)} ${esc(bt('qcAnomaliesFound'))}` : esc(bt('cnNotComputed')))}</span>
          </div>

          <div class="issue-list" id="quality-issue-container"${demoMode && !q ? ' data-tf-demo' : ''}>
            ${liste}
          </div>
        </div>`;
      }

      /* Filtre des onglets qualite. La fonction etait appelee par p29-p33
       * sans exister : cliquer un onglet levait « filterIssues is not
       * defined ». Le filtre vit dans l'etat et la vue le lit. */
      function filterIssues(kind) {
        state.qualityFilter = kind;
        render();
      }

      function scoreCard(label, value) { return `<div class="card score"><div class="score-name">${label}</div><div class="score-value">${moneyless(value)}%</div><div class="progress"><span style="width:${pct(value)}%"></span></div></div>`; }
      function issueCard(issue) {
        const isWaived = issue.status === 'waived';
        const isAcknowledged = issue.status === 'acknowledged';
        const waiverReason = issue.details?.waiver_reason || issue.waiverReason;
        // Le libelle vient du catalogue qualite, deja traduit dans les sept
        // langues : un bouton ne parle pas francais sur une page anglaise.
        const acquitter = (window.TF_I18N && window.TF_I18N.t('quality.actionAck', null)) || 'Acknowledge';
        return `
          <div class="issue">
            <span class="severity severity-${esc(issue.severity)}">${esc(issue.severity)}</span>
            <div>
              <strong>${esc(issue.message)}</strong>
              <p><code>${esc(issue.ruleKey)}</code> · <span class="status status-${esc(issue.status)}">${esc(statusLabel(issue.status))}</span> · <span class="meta">${esc(bt('cnDetectedOn'))} ${date(issue.detectedAt)}</span></p>
              ${isWaived && waiverReason ? `
                <div class="item-response" style="margin-top:7px;background:#edf7f0;border:1px solid #cce8d5;border-radius:8px;font-size:11px;color:#285e42">
                  <strong>${esc(bt('cnWaiverGranted'))}</strong> ${esc(waiverReason)}
                </div>
              ` : ''}
              ${isAcknowledged ? `
                <div class="meta" style="margin-top:5px;color:#3d6752">✓ ${esc(bt('cnQcAcknowledged'))}${issue.acknowledgedAt ? ` le ${date(issue.acknowledgedAt)}` : ''}.</div>
              ` : ''}
            </div>
            <div class="actions" style="justify-content:flex-end">
              ${issue.status === 'open' ? `
                <button class="btn btn-secondary btn-small" data-action="acknowledge-issue" data-issue-id="${esc(issue.id)}">${esc(acquitter)}</button>
                <button class="btn btn-secondary btn-small" data-action="open-waive-modal" data-issue-id="${esc(issue.id)}">${esc(bt('cnQcWaive'))}</button>
              ` : isAcknowledged ? `
                <button class="btn btn-secondary btn-small" data-action="open-waive-modal" data-issue-id="${esc(issue.id)}">${esc(bt('cnQcWaive'))}</button>
              ` : `
                <span class="status status-approved" style="font-size:10px">${esc(bt('cnQcWaiverActive'))}</span>
              `}
            </div>
          </div>
        `;
      }

            function supplyChainView() {
        // Hors demonstration, la chaine affichee est celle que la route
        // /api/products/:id/supply-chain a renvoyee. Pas de resume par
        // defaut, pas de fournisseur illustratif : un produit sans chaine
        // calculee montre « non calculé », pas une chaine de reve.
        const demoMode = estDemo();
        const p = state.selectedSupplyChainProduct || state.products[0] || null;
        const sc = state.supplyChain || null;
        const summary = sc?.summary || null;
        const nodes = sc?.graph?.nodes || [];
        const links = sc?.graph?.links || [];
        const mb = state.massBalance || null;
        const recon = mb?.latestReconciliation || null;

        const scelles = nodes.filter((n) => ['documented', 'verified_by_reviewer'].includes(n.status) || n.source_document_id).length;
        const tierDe = (node) => {
          const code = node.process_code || '';
          if (node.node_type === 'material') return 'scTier01';
          if (['ginning', 'spinning'].includes(code)) return 'scTier02';
          if (['weaving', 'knitting', 'dyeing', 'printing', 'finishing'].includes(code)) return 'scTier03';
          if (['cutting', 'sewing', 'assembly', 'laundering', 'packaging'].includes(code)) return 'scTier04';
          return 'scTier05';
        };

        const demoEchelons = `
            <div class="tc-echelons-grid" data-tf-demo>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier01')}</div>
                <div class="tc-ech-title">${bt('scFieldFarm')}</div>
                <div class="tc-ech-model">Identity Preserved</div>
                <div class="tc-ech-status">✓ İzmir, Türkiye</div>
              </div>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier02')}</div>
                <div class="tc-ech-title">${bt('scGinningCaps')}</div>
                <div class="tc-ech-model">Segregated</div>
                <div class="tc-ech-status">✓ Ege Birlik Mill</div>
              </div>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier03')}</div>
                <div class="tc-ech-title">${bt('scSpinningCaps')}</div>
                <div class="tc-ech-model">Mass Balance 100%</div>
                <div class="tc-ech-status">✓ Haute-Vienne, FR</div>
              </div>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier04')}</div>
                <div class="tc-ech-title">${bt('scKnittingCaps')}</div>
                <div class="tc-ech-model">Identity Preserved</div>
                <div class="tc-ech-status">✓ Barcelos, PT</div>
              </div>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier05')}</div>
                <div class="tc-ech-title">${bt('scFinishingCaps')}</div>
                <div class="tc-ech-model">ZDHC Level 3</div>
                <div class="tc-ech-status">✓ EcoDye Aquitaine</div>
              </div>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier06')}</div>
                <div class="tc-ech-title">${bt('scAssemblyCaps')}</div>
                <div class="tc-ech-model">SMETA 4-Pillar</div>
                <div class="tc-ech-status">✓ Atelier Braga, PT</div>
              </div>
              <div class="tc-echelon-card">
                <div class="tc-ech-num">${bt('scTier07')}</div>
                <div class="tc-ech-title">${esc(bt('cnMbDistribution'))}</div>
                <div class="tc-ech-model">DPP CIRPASS</div>
                <div class="tc-ech-status">✓ Hub Lyon, FR</div>
              </div>
            </div>`;

        const realEchelons = nodes.length ? `
            <div class="tc-echelons-grid">
              ${nodes.slice(0, 12).map((n) => `
                <div class="tc-echelon-card">
                  <div class="tc-ech-num">${bt(tierDe(n))}</div>
                  <div class="tc-ech-title">${esc(n.label)}</div>
                  <div class="tc-ech-model">${esc(n.process_code || n.node_type)}</div>
                  <div class="tc-ech-status">${n.site_country ? `✓ ${esc(n.site_country)}` : esc(statusLabel(n.status))}</div>
                </div>`).join('')}
            </div>` : `
            <div class="card panel">
              <div class="empty">
                <div class="empty-icon">⇄</div>
                <strong>${esc(bt('cnNotComputed'))}</strong>
                <p class="meta">${esc(bt('scIntro'))}</p>
              </div>
            </div>`;

        const demoTable = `
            <div class="table-wrap" data-tf-demo>
              <table>
                <thead>
                  <tr>
                    <th>${bt('scIndustrialStep')}</th>
                    <th>${bt('scSupplierFacility')}</th>
                    <th>${bt('scVolIn')}</th>
                    <th>${bt('scVolOut')}</th>
                    <th>${bt('scYieldWaste')}</th>
                    <th>${bt('scTraceDoc')}</th>
                    <th style="text-align:right">${bt('scCustodyStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>01. Organic Cotton Ginning</strong></td>
                    <td>Ege Birlik Ginning Co.</td>
                    <td>10,500 kg (Seed)</td>
                    <td>3,570 kg (Raw fibre)</td>
                    <td>34.0% (Normal)</td>
                    <td><code>TC-CU-881294-01</code></td>
                    <td style="text-align:right"><span class="status status-approved">✓ Segregated</span></td>
                  </tr>
                  <tr>
                    <td><strong>02. Combed Spinning Ne 30/1</strong></td>
                    <td>Filature de Haute-Vienne</td>
                    <td>3,570 kg (Raw fibre)</td>
                    <td>3,285 kg (Bobbins)</td>
                    <td>92.0% (Yarn yield)</td>
                    <td><code>TC-CU-881294-02</code></td>
                    <td style="text-align:right"><span class="status status-approved">✓ Identity Preserved</span></td>
                  </tr>
                  <tr>
                    <td><strong>03. Jersey Knitting 180g</strong></td>
                    <td>Barcelos Knitting Mill</td>
                    <td>3,285 kg (Bobbins)</td>
                    <td>3,150 kg (Rolls)</td>
                    <td>95.9% (Normal knit)</td>
                    <td><code>BL-PT-2026-904</code></td>
                    <td style="text-align:right"><span class="status status-approved">✓ Sealed</span></td>
                  </tr>
                  <tr>
                    <td><strong>04. Organic Dyeing & Washing</strong></td>
                    <td>EcoDye Aquitaine</td>
                    <td>3,150 kg (Rolls)</td>
                    <td>3,085 kg (Dyed)</td>
                    <td>97.9% (ZDHC fixation)</td>
                    <td><code>ZDHC-LOT-089</code></td>
                    <td style="text-align:right"><span class="status status-approved">✓ Validated</span></td>
                  </tr>
                  <tr>
                    <td><strong>05. Cutting & Assembly</strong></td>
                    <td>Atelier Braga & Co</td>
                    <td>3,085 kg (Finished fabric)</td>
                    <td>16,200 finished pieces</td>
                    <td>185g / average piece</td>
                    <td><code>TC-CU-881294-05</code></td>
                    <td style="text-align:right"><span class="status status-approved">✓ 100% reconciled</span></td>
                  </tr>
                </tbody>
              </table>
            </div>`;

        const realMassBalance = recon ? `
            <div style="display:grid;gap:10px;font-size:12px;">
              <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #edf0eb;">
                <span>${bt('scMassRecon')}</span><strong>${mesure(recon.coverageRatioPct, '%')}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #edf0eb;">
                <span>${bt('scAllocatedKg')}</span><strong>${mesure(mb.totalAllocatedKg === null || mb.totalAllocatedKg === undefined ? null : Number(mb.totalAllocatedKg))} kg</strong>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #edf0eb;">
                <span>${bt('scCustodyModel')}</span><strong><code>${esc(recon.verdict)}</code></strong>
              </div>
              ${recon.summary ? `<p class="meta" style="margin:4px 0 0;">${esc(recon.summary)}</p>` : ''}
            </div>` : `
            <div class="empty">
              <strong>${esc(bt('cnNotComputed'))}</strong>
              <p class="meta">${esc(bt('mbIntro'))}</p>
            </div>`;

        return `
          <div class="page-head">
            <div>
              <div class="eyebrow">${bt('scEyebrow')}</div>
              <h1>${bt('scMultiTier')}</h1>
              <p>${bt('scIntro')}</p>
            </div>
            <div class="actions">
              ${demoMode ? `<button class="btn btn-secondary" data-demo-action="1">${bt('scExportForensic')}</button>` : ''}
              ${p ? `<button class="btn btn-secondary" data-action="select-supply-chain-product">${bt('scChangeProduct')}</button>
              ${nodes.length >= 2 ? `<button class="btn btn-secondary" data-action="new-chain-link">${bt('scLinkSteps')}</button>` : ''}
              <button class="btn btn-primary" data-action="new-chain-node">${bt('scAddMilestone')}</button>` : ''}
            </div>
          </div>

          ${!p ? `<div class="card panel"><div class="empty">
              <div class="empty-icon">⇄</div>
              <strong>${esc(bt('cnNotComputed'))}</strong>
              <p class="meta">${esc(bt('scIntro'))}</p>
              <button class="btn btn-primary btn-small" data-view="products">${esc(bt('products'))}</button>
            </div></div>` : `
          <!-- Forensic Hero Banner -->
          <div class="tc-forensic-strip">
            ${demoMode
              ? '<div class="tc-forensic-badge" data-tf-demo>ISO 22095 CERTIFIED CHAIN OF CUSTODY · 98.4% MASS RECONCILIATION</div>'
              : `<div class="tc-forensic-badge">${esc(bt('scMultiTier'))}</div>`}
            <h2 class="tc-forensic-title">${esc(p.name)} · ${bt('cRef')} ${esc(p.reference)}</h2>
            <p class="tc-forensic-desc">
              ${esc(bt('cnScChainIntro'))}
            </p>
          </div>

          <!-- CHAIN OF CUSTODY TIMELINE -->
          ${demoMode ? demoEchelons : realEchelons}

          <!-- Core Score KPIs -->
          <div class="grid score-grid">
            <div class="card score"><div class="score-name">${bt('scSealedSteps')}</div><div class="score-value">${summary ? `${moneyless(scelles)} / ${moneyless(nodes.length)}` : `<span class="uncomputed">${esc(bt('cnNotComputed'))}</span>`}</div><div class="node-meta">${esc(bt('scPhysical100'))}</div></div>
            <div class="card score"><div class="score-name">${bt('scGpsPolygons')}</div><div class="score-value">${mesureInconnue(null)}</div><div class="node-meta">${bt('scSatellite')}</div></div>
            <div class="card score"><div class="score-name">${bt('scEvidenceCov')}</div><div class="score-value" style="font-size:${summary ? '32px' : '13px'};">${summary ? mesure(summary.documentationRate, '%') : esc(bt('cnNotCalculated'))}</div><div class="progress"><span style="width:${summary ? pct(summary.documentationRate) : 0}%"></span></div></div>
            <div class="card score"><div class="score-name">${bt('scCustodyModel')}</div><div class="score-value" style="font-size:18px;color:#0b7656;">${demoMode ? '<span data-tf-demo>ISO 22095</span>' : `<span class="uncomputed" style="font-size:13px;">${esc(bt('cnNotComputed'))}</span>`}</div><div class="node-meta">${bt('scMassChecked')}</div></div>
          </div>

          <!-- Mass Balance Reconciliation Breakdown -->
          <div class="tc-reconcil-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
              <div>
                <h3 style="font-size:16px;font-weight:800;color:#17231f;margin:0 0 2px;">${bt('scMassReconMile')}</h3>
                <p class="meta" style="margin:0;">${bt('scMassNote')}</p>
              </div>
              ${demoMode ? '<span class="badge badge-verified" style="background:#eaf5ef;color:#0b7656;font-weight:750;" data-tf-demo>PROCESS LOSS DELTA: 2.4% (COMPLIANT)</span>' : ''}
            </div>
            ${demoMode ? demoTable : realMassBalance}
          </div>`}
        `;
      }

      /**
       * Vue portefeuille : « ce qui manque » a l'echelle de la marque.
       *
       * L'ecran precedent n'offrait qu'un selecteur de produit — un cul-de-sac
       * la ou le brief demande une liste d'actions. Sans agregat, repondre a
       * « que nous manque-t-il ? » imposait d'ouvrir les produits un par un.
       *
       * Le score est un INDICATEUR DE PREPARATION, jamais une conformite : la
       * mention l'accompagne partout ou il s'affiche.
       */
      function dppPortfolioView() {
        const f = state.dppPortfolio;
        if (!f) {
          return `<div class="page-head"><div><div class="eyebrow">${bt('dpEyebrow')}</div><h1>${bt('dpTitle')}</h1><p>${bt('dpEmptyHint')}</p></div></div>
            <div class="card panel"><p class="meta">${bt('dpPortfolioIntro')}</p></div>`;
        }
        const total = Number(f.totalProducts || 0);
        const gaps = Array.isArray(f.gaps) ? f.gaps : [];
        const counts = f.statusCounts || {};
        const ORDER = ['published', 'ready_to_publish', 'data_ready', 'review_required', 'in_progress', 'not_started'];
        const bars = ORDER.filter((k) => Number(counts[k] || 0) > 0).map((k) => {
          const n = Number(counts[k] || 0);
          const w = total > 0 ? (n / total) * 100 : 0;
          return `<div class="dp-dist-row"><span class="dp-dist-label">${esc(statusLabel(k))}</span>`
            + `<span class="dp-dist-track"><span class="dp-dist-fill dp-dist-${esc(k)}" style="width:${w.toFixed(1)}%"></span></span>`
            + `<span class="dp-dist-count">${esc(moneyless(n))}</span></div>`;
        }).join('');

        const gapRows = gaps.length ? gaps.map((g) => {
          const target = dppFixTarget(g.key);
          // Le premier produit concerne par l'ecart : « Corriger dans Produits »
          // ouvre SA fiche, pas la liste complete.
          const cible = g.products?.[0]?.id || '';
          const names = (g.products || []).slice(0, 3)
            .map((x) => esc(x.reference || x.name || '')).filter(Boolean).join(' · ');
          const more = (g.productCount || 0) > 3 ? ` <span class="meta">+ ${esc(moneyless((g.productCount || 0) - 3))} ${esc(bt('dpAndMore'))}</span>` : '';
          return `<div class="dp-gap">
            <div class="dp-gap-main">
              <div class="dp-gap-head">
                <strong>${esc(g.labelKey ? bt(g.labelKey) : (g.label || g.key))}</strong>
                ${g.blocking ? `<span class="status status-review_required">${esc(bt('dpBlocking'))}</span>` : ''}
              </div>
              <p class="meta">${esc(bt('dpReqCode'))} <code>${esc(g.key)}</code></p>
              <p class="meta">${names}${more}</p>
            </div>
            <div class="dp-gap-side">
              <div class="dp-gap-count"><strong>${esc(moneyless(g.productCount || 0))}</strong><span>${esc(bt('dpAffectedProducts'))}</span></div>
              ${target ? `<button class="btn btn-secondary" data-action="dp-resolve" data-dp-target="${esc(target.view)}" data-dp-product="${esc(cible)}">${esc(bt('dpResolveIn'))} ${esc(bt(target.labelKey))}</button>` : ''}
            </div>
          </div>`;
        }).join('') : `<p class="meta">${bt('dpNoPortfolioGaps')}</p>`;

        return `<div class="page-head"><div><div class="eyebrow">${bt('dpPortfolioEyebrow')}</div><h1>${bt('dpPortfolioTitle')}</h1><p>${bt('dpPortfolioIntro')}</p></div>
          <div class="actions"><button class="btn btn-secondary" data-action="dpp-recalc-portfolio">${bt('dpRecalculate')}</button></div></div>

          <div class="card panel dp-portfolio-hero">
            <div class="dp-hero-score">
              <strong>${total > 0 && Number.isFinite(Number(f.readinessScore))
                ? esc(Number(f.readinessScore).toFixed(1)) + '%'
                : `<span class="uncomputed" style="font-size:16px;">${esc(bt('cnNotComputed'))}</span>`}</strong>
              <span>${esc(bt('dpPortfolioScore'))}</span>
              <p class="meta dp-disclaimer">${esc(bt('dpNotCertification'))}</p>
            </div>
            <div class="dp-hero-facts">
              <div class="eyebrow">${bt('dpActiveProfile')} <code>${esc(f.profileKey || '')} v${esc(f.profileVersion || '')}</code></div>
              <div class="dp-hero-stats">
                <div><strong>${esc(moneyless(total))}</strong><span>${esc(bt('dpProductsTracked'))}</span></div>
                <div><strong>${esc(moneyless(f.blockedProducts || 0))}</strong><span>${esc(bt('dpProductsBlocked'))}</span></div>
                <div><strong>${esc(moneyless(f.uncomputedProducts || 0))}</strong><span>${esc(bt('dpNeverComputed'))}</span></div>
              </div>
              <p class="meta">${esc(bt('dpLastComputed'))} : ${esc(f.lastComputedAt ? date(f.lastComputedAt) : '—')}</p>
            </div>
          </div>

          <div class="card panel">
            <div class="panel-head"><h2>${bt('dpDistribution')}</h2></div>
            <div class="dp-dist">${bars}</div>
          </div>

          <div class="card panel">
            <div class="panel-head"><h2>${bt('dpRemainingReqs')}</h2></div>
            <p class="meta">${bt('dpGapsIntro')}</p>
            <div class="dp-gaps">${gapRows}</div>
          </div>

          <div class="card panel">
            <label>${bt('dpInspectProduct')}<select class="select" id="dpp-product-select"><option value="">${bt('dpChooseCatalog')}</option>${state.products.map((x) => `<option value="${esc(x.id)}">${esc(x.reference)} — ${esc(x.name)}</option>`).join('')}</select></label>
          </div>`;
      }

      function dppView() {
        // Vue d'ensemble d'abord, inspection ensuite : le portefeuille est
        // l'entree de l'ecran, le produit un approfondissement explicite.
        if (state.dppScope !== 'product' || !state.selectedDppProduct) {
          return dppPortfolioView();
        }

        const p = state.selectedDppProduct;
        const dpp = state.dpp;
        // Aucun profil charge n'est pas « 0 % sur 9 exigences » : c'est un
        // resultat absent. On le dit, et on offre le recalcul.
        if (!dpp) {
          return `<div class="page-head">
              <div>
                <div class="eyebrow">${bt('dpEyebrow')}</div>
                <h1>${esc(p.name)}</h1>
                <p>${bt('dpRef')} <strong>${esc(p.reference)}</strong> · ${esc(bt('cnCategory'))} ${esc(p.category || bt('dpNotSpecified'))}</p>
              </div>
              <div class="actions">
                <button class="btn btn-secondary" data-action="dpp-back-portfolio">${bt('dpBackToPortfolio')}</button>
                <button class="btn btn-primary" data-action="compute-dpp">${bt('dpRecalculate')}</button>
              </div>
            </div>
            <div class="card panel"><div class="empty">
              <strong>${esc(bt('cnNotComputed'))}</strong>
              <p class="meta">${esc(bt('dpEmptyHint'))}</p>
            </div></div>`;
        }

        const pillars = dpp.pillars || {};
        const scoreColor = dpp.completionScore >= 80 ? 'var(--green)' : dpp.completionScore >= 50 ? '#c68b1a' : 'var(--red)';

        return `<div class="page-head">
            <div>
              <div class="eyebrow">${bt('dpEyebrow')}</div>
              <h1>${esc(p.name)}</h1>
              <p>${bt('dpRef')} <strong>${esc(p.reference)}</strong> · Version v${esc(p.version)} · ${esc(bt('cnCategory'))} ${esc(p.category || bt('dpNotSpecified'))}</p>
            </div>
            <div class="actions">
              <button class="btn btn-secondary" data-action="dpp-back-portfolio">${bt('dpBackToPortfolio')}</button>
              <button class="btn btn-secondary" data-action="select-dpp-product">${bt('scChangeProduct')}</button>
              <button class="btn btn-secondary" data-action="compute-dpp">${bt('dpRecalculate')}</button>
              ${dpp.canMarkReadyToPublish ? '<button class="btn btn-primary" data-action="publish-dpp">✓ ' + bt('dpValidateCta') + '</button>' : ''}
            </div>
          </div>

          ${dpp.isReadyToPublish ? `
            <div class="card panel" style="background:#edf7f0;border-color:#bce3c9;margin-bottom:20px;padding:16px 20px">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:24px">🎉</span>
                <div>
                  <strong style="color:var(--green);font-size:15px">${bt('dpValidated')}</strong>
                  <p class="meta" style="margin:4px 0 0;color:#285e42">${bt('dpAllMet')} <code>${esc(dpp.profileKey || 'textile_readiness_mvp')}</code>${esc(bt('cnSignedOn'))} ${date(dpp.reviewedAt || new Date())}.</p>
                </div>
              </div>
            </div>
          ` : ''}

          <div class="dpp-hero">
            <div class="dpp-gauge-box">
              <div class="dpp-gauge-val" style="color:${scoreColor}">${moneyless(dpp.completionScore)}%</div>
              <div class="dpp-gauge-label">${bt('dpGlobalScore')}</div>
              <div style="margin-top:10px">${status(dpp.readinessStatus)}</div>
            </div>
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <span class="eyebrow">${bt('dpActiveProfile')} : <code>${esc(dpp.profileKey || 'textile_readiness_mvp')}</code> v${esc(dpp.profileVersion || '1.0')}</span>
                <span class="meta">${esc(dpp.metRequirements)} / ${esc(dpp.totalRequirements)} ${bt('dpReqsMet')}</span>
              </div>
              <div class="progress" style="height:10px;margin-bottom:12px"><span style="width:${pct(dpp.completionScore)}%;background:${scoreColor}"></span></div>
              <p class="meta" style="margin:0;line-height:1.5">${bt('dpMethodology')}</p>
            </div>
          </div>

          <div class="dpp-pillars">
            ${renderPillarCard(pillars.identification, '🏷️', bt('cnStep1'))}
            ${renderPillarCard(pillars.composition, '🧵', bt('cnStep2'))}
            ${renderPillarCard(pillars.traceability, '☍', bt('cnStep3'))}
            ${renderPillarCard(pillars.quality, '🛡️', bt('cnStep4'))}
          </div>

          ${dpp.missingFields && dpp.missingFields.length ? `
            <div class="card panel">
              <div class="panel-head">
                <div>
                  <h2>${bt('dpRemainingReqs')} (${dpp.missingFields.length})</h2>
                  <p class="meta" style="margin:4px 0 0">${bt('dpGapsIntro')}</p>
                </div>
                <span class="status status-changes_requested">${dpp.blockingCount} ${bt('dpBlockingN')}</span>
              </div>
              <div class="item-list">
                ${dpp.missingFields.map((m) => {
                  const target = dppFixTarget(m.key);
                  return `
                  <div class="item">
                    <div>
                      <h3>${esc(m.labelKey ? bt(m.labelKey) : (m.label || m.key))} ${m.blocking ? '<span style="color:var(--red)">*</span>' : ''}</h3>
                      <p class="meta">${bt('dpReqCode')} : <code>${esc(m.key)}</code> · ${m.blocking ? bt('dpMandatory') : bt('dpRecommended')}</p>
                    </div>
                    <div class="actions" style="justify-content:flex-end;align-items:center;gap:8px">
                      <span class="severity ${m.blocking ? 'severity-blocking' : 'severity-info'}">${m.blocking ? bt('dpBlocking') : bt('dpRecommended')}</span>
                      ${target ? `<button class="btn btn-secondary btn-small" data-action="dp-resolve" data-dp-target="${esc(target.view)}" data-dp-product="${esc(p.id || '')}">${esc(bt('dpResolveIn'))} ${esc(bt(target.labelKey))}</button>` : ''}
                    </div>
                  </div>
                `; }).join('')}
              </div>
            </div>
          ` : `
            <div class="card panel" style="text-align:center;padding:28px">
              <span style="font-size:32px">✨</span>
              <h2 style="margin:10px 0 6px">${bt('dpAllRequirementsMet')}</h2>
              <p class="meta">${bt('dpNoGaps')}</p>
              ${dpp.canMarkReadyToPublish ? '<button class="btn btn-primary" data-action="publish-dpp" style="margin-top:14px">' + bt('dpValidatePassport') + '</button>' : ''}
            </div>
          `}
        `;
      }

      function renderPillarCard(pillar, defaultIcon, defaultTitle) {
        if (!pillar) return '';
        const pctVal = pillar.metPercent || 0;
        const color = pctVal === 100 ? 'var(--green)' : pctVal >= 50 ? '#c68b1a' : 'var(--red)';
        return `
          <div class="pillar-card">
            <div class="pillar-head">
              <div class="pillar-name"><span>${esc(pillar.icon || defaultIcon)}</span> ${esc(pillar.nameKey ? bt(pillar.nameKey) : (pillar.name || defaultTitle))}</div>
              <div class="pillar-score" style="color:${color}">${moneyless(pctVal)}%</div>
            </div>
            <div class="pillar-bar-bg"><div class="pillar-bar-fill" style="width:${pct(pctVal)}%;background:${color}"></div></div>
            <p class="meta" style="margin-bottom:12px">${esc(pillar.descKey ? bt(pillar.descKey) : (pillar.description || ''))}</p>
            <div class="pillar-items">
              ${(pillar.items || []).map((it) => `
                <div class="pillar-item">
                  <span class="pillar-item-label">
                    <span class="check-icon ${it.met ? 'met' : 'unmet'}">${it.met ? '✓' : '✗'}</span>
                    ${esc(it.labelKey ? bt(it.labelKey) : it.label)}
                  </span>
                  <span class="meta">${it.met ? '<span style="color:var(--green)">' + bt('dpCompliant') + '</span>' : '<span style="color:var(--red)">' + bt('dpMissing') + '</span>'}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      function requestDetailView() {
        const r = state.selectedRequest;
        if (!r) return `<div class="empty"><div class="empty-icon">↗</div><strong>${bt('rdNotFound')}</strong><button class="btn btn-secondary" data-view="requests">${bt('rdBack')}</button></div>`;
        return `<div class="detail-hero">
          <div>
            <button class="link-button" data-view="requests">${bt('rdBackArrow')}</button>
            <div class="eyebrow" style="margin-top:20px">${esc(orgName(r.supplierOrganizationId))}</div>
            <h1>${esc(r.title)}</h1>
            <div class="detail-meta">
              ${status(r.status)}
              <span class="meta">${esc(r.questionnaireKey)} · v${esc(r.questionnaireVersion)}</span>
              <span class="meta">${esc(bt('cnDueOn'))} ${date(r.dueAt)}</span>
              ${r.productId ? `<span class="meta">Produit : <strong><button class="link-button" data-product-id="${esc(r.productId)}" style="display:inline;padding:0;font-size:inherit">${esc(state.products.find((p) => p.id === r.productId)?.name || r.productId)}</button></strong></span>` : ''}
              <span class="cert-pill">${bt('rdAuditTrail')}</span>
            </div>
          </div>
          <div class="actions">
            ${r.status === 'draft' ? `<button class="btn btn-primary" data-action="send-request">${bt('rdSend')}</button>` : ''}
            ${['sent','in_progress','changes_requested'].includes(r.status) ? `<button class="btn btn-secondary" data-action="remind-request" data-reminder-request-id="${esc(r.id)}">${bt('rdFollowUp')}</button>` : ''}
            ${['submitted','in_progress'].includes(r.status) ? `<button class="btn btn-secondary" data-action="refresh-detail">${bt('rdRefresh')}</button>` : ''}
            <button class="btn btn-primary" data-demo-action="1">${bt('rdExport')}</button>
          </div>
        </div>

        <div class="grid split">
          <div class="card panel">
            <div class="panel-head">
              <div>
                <h2>${bt('rdEvidencePoints')}</h2>
                <span class="meta">${bt('rdDocVerif')}</span>
              </div>
              <div class="progress-line">
                <div class="progress"><span style="width:${pct(r.completionPercentage)}%"></span></div>
                <small>${moneyless(r.completionPercentage)}%</small>
              </div>
            </div>

            <div class="item-list">
              ${(r.items || []).map((item) => `
                <div class="item">
                  <div style="flex:1">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                      <h3>${esc(item.label)} ${item.required ? '<span style="color:var(--red)">*</span>' : ''}</h3>
                      ${status(item.status)}
                    </div>
                    <p style="margin:4px 0 8px;font-size:12px;color:var(--muted);">${esc(item.helpText || item.fieldKey)}</p>

                    ${item.documentName ? `
                      <div class="doc-preview-strip">
                        <div style="display:flex;align-items:center;gap:10px;">
                          <span style="font-size:20px;">📄</span>
                          <div>
                            <strong style="font-size:12.5px;">${esc(item.documentName)}</strong>
                            <div style="font-size:11px;color:var(--muted);">${esc(item.documentSize)} · ${esc(bt('cnSealedSha'))}</div>
                          </div>
                        </div>
                        <div style="display:flex;gap:8px;align-items:center;">
                          <span class="badge-ocr">${bt('rdOcrValid')}</span>
                          <button class="btn btn-secondary btn-small" data-demo-action="1">${bt('rdInspectDoc')}</button>
                        </div>
                      </div>
                    ` : ''}

                    ${(item.responses || []).filter((resp) => resp.isCurrent).map((response) => `
                      <div class="annotation-panel">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                          <div>
                            <strong style="font-size:11px;color:var(--muted);text-transform:uppercase;">${esc(bt('cnDeclaredBySupplier'))}</strong>
                            <div style="font-size:13px;font-weight:750;margin-top:2px;">${esc(response.value)}</div>
                          </div>
                          <span class="status status-${esc(response.status)}">${esc(statusLabel(response.status))}</span>
                        </div>

                        ${response.reviewerNote ? `
                          <div class="annotation-bubble ${response.status === 'verified_by_reviewer' ? 'verified' : ''}">
                            <strong>Note d'Audit / Justification :</strong>
                            <div>${esc(response.reviewerNote)}</div>
                          </div>
                        ` : ''}

                        <div class="actions" style="justify-content:flex-start;margin-top:12px;gap:8px;">
                          <button class="btn btn-primary btn-small" data-review-response="${esc(response.id)}" data-review-status="verified_by_reviewer">
                            ${bt('rdValidate')}
                          </button>
                          <button class="btn btn-danger btn-small" data-review-response="${esc(response.id)}" data-review-status="needs_review">
                            ${bt('rdRequestFix')}
                          </button>
                        </div>
                      </div>
                    `).join('') || `<div class="item-response" style="margin-top:10px;font-size:12px;color:var(--muted);">${bt('rdAwaiting')}</div>`}
                  </div>
                </div>
              `).join('') || `<div class="empty">${bt('rdNoItem')}</div>`}
            </div>
          </div>

          <div style="display:grid;gap:18px;">
            <div class="card panel">
              <div class="panel-head"><h2>${bt('rdProtocol')}</h2></div>
              <p style="font-size:12px;color:var(--muted);line-height:1.6;">
                ${esc(bt('cnRdImmutable'))}
              </p>
              <div style="display:grid;gap:12px;margin-top:14px;font-size:12px;">
                <div style="padding:10px;background:#f8faf8;border-left:3px solid var(--green);border-radius:8px;">
                  <strong>${bt('rdTc')}</strong>
                  <div style="color:var(--muted);margin-top:2px;">${bt('rdLotCheck')}</div>
                </div>
                <div style="padding:10px;background:#f8faf8;border-left:3px solid #0284c7;border-radius:8px;">
                  <strong>${bt('rdRsl')}</strong>
                  <div style="color:var(--muted);margin-top:2px;">${bt('rdTestReport')}</div>
                </div>
              </div>
            </div>

            <div class="card panel">
              <div class="panel-head"><h2>${bt('rdQuickActions')}</h2></div>
              <div style="display:grid;gap:8px;">
                <button class="btn btn-secondary btn-small" style="text-align:left;justify-content:flex-start;" data-demo-action="1">
                  ✉️ ${esc(bt('cnRdRemindEmail'))}
                </button>
                <button class="btn btn-secondary btn-small" style="text-align:left;justify-content:flex-start;" data-tf-act="open" data-tf-arg="/dpp/">
                  ${bt('rdPreviewDpp')}
                </button>
              </div>
            </div>
          </div>
        </div>`;
      }
      function supplierImportPreview() {
        const preview = state.supplierImport.preview;
        if (!preview) return '<p class="meta" style="margin-top:14px">' + bt('mdPreviewSupplierHint') + '</p>';
        const issues = (preview.errors || []).slice(0, 12);
        return `<div class="card panel" style="margin-top:16px;padding:14px"><div class="panel-head"><h3>${bt('mdValidationResult')}</h3>${preview.valid ? '<span class="status status-approved">' + bt('mdImportPossible') + '</span>' : '<span class="status status-changes_requested">' + bt('mdToFix') + '</span>'}</div><div class="grid kpis" style="margin-top:12px"><div class="kpi"><div class="kpi-label">${bt('mdRows')}</div><div class="kpi-value">${moneyless(preview.totalRows)}</div></div><div class="kpi"><div class="kpi-label">Invitations</div><div class="kpi-value" style="color:var(--green)">${moneyless(preview.acceptedRows)}</div></div><div class="kpi"><div class="kpi-label">${bt('rqRejected')}</div><div class="kpi-value" style="color:var(--red)">${moneyless(preview.rejectedRows)}</div></div></div>${issues.length ? `<div class="item-list" style="margin-top:12px">${issues.map((item) => `<div class="item"><strong>Ligne ${esc(item.line)} · ${esc(item.code)}</strong><span class="meta">${esc(item.message)}</span></div>`).join('')}</div>` : '<p class="success-note" style="margin-top:12px">' + bt('mdNoValidationError') + '</p>'}</div>`;
      }

      function catalogImportPreview() {
        const preview = state.catalogImport.preview;
        if (!preview) return '<p class="meta" style="margin-top:14px">' + bt('mdPreviewCatalogHint') + '</p>';
        const issues = (preview.errors || []).slice(0, 12);
        return `<div class="card panel" style="margin-top:16px;padding:14px"><div class="panel-head"><h3>${bt('mdValidationResult')}</h3>${preview.valid ? '<span class="status status-approved">Import possible</span>' : `<span class="status status-changes_requested">${esc(bt('cnToFix'))}</span>`}</div><div class="grid kpis" style="margin-top:12px"><div class="kpi"><div class="kpi-label">${bt('mdRows')}</div><div class="kpi-value">${moneyless(preview.totalRows)}</div></div><div class="kpi"><div class="kpi-label">${bt('mdAccepted')}</div><div class="kpi-value" style="color:var(--green)">${moneyless(preview.acceptedRows)}</div></div><div class="kpi"><div class="kpi-label">${bt('rqRejected')}</div><div class="kpi-value" style="color:var(--red)">${moneyless(preview.rejectedRows)}</div></div></div>${issues.length ? `<div class="item-list" style="margin-top:12px">${issues.map((item) => `<div class="item"><strong>Ligne ${esc(item.line)} · ${esc(item.code)}</strong><span class="meta">${esc(item.message)}</span></div>`).join('')}</div>` : `<p class="success-note" style="margin-top:12px">${esc(bt('cnNoValidationErrors'))}</p>`}${(preview.warnings || []).length ? `<p class="meta" style="margin-top:10px">${moneyless(preview.warnings.length)} ${esc(bt('cnWarningsNonBlocking'))}</p>` : ''}</div>`;
      }

      function modal(type) {
        if (type === 'new-product') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">Catalogue</div><h2>${bt('mdNewProduct')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="product-form"><div class="form-grid"><label>${bt('mdReference')}<input class="input" name="reference" required placeholder="TF-ESS-001"></label><label>${bt('mdName')}<input class="input" name="name" required placeholder="Cotton Essential"></label><label>${bt('pdCategory')}<input class="input" name="category" placeholder="T-shirt"></label><label>SKU<input class="input" name="sku" placeholder="SKU-001"></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button class="btn btn-primary">${bt('mdCreateProduct')}</button></div></form></div></div>`;
        if (type === 'new-material') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mtTitle')}</div><h2>${bt('mtAdd')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="create-material-form"><div class="form-grid"><label class="field-full">${bt('mtName')}<input class="input" name="name" required maxlength="240"></label><label>${bt('mtType')}<input class="input" name="materialType" required maxlength="120" placeholder="other"></label><label>${bt('mtOrigin')}<input class="input" name="originCountryCode" maxlength="2" pattern="[A-Za-z]{2}" placeholder="${bt('cnUnknown')}"></label><p class="field-full meta">${bt('cnMaterialNoClaim')}</p></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button type="submit" class="btn btn-primary">${bt('mtAdd')}</button></div></form></div></div>`;
        if (type === 'supplier-import') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdSupplierOnboarding')}</div><h2>${bt('mdBulkInvite')}</h2></div><button class="close" data-action="close-modal">×</button></div><p>${bt('mdRequiredColumns')} <code>email</code>, <code>legalName</code>${bt('mdInviteNote')}</p><label class="field-full">${bt('mdCsvFile')}<input class="input" id="supplier-import-file" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label><label class="field-full" style="margin-top:12px">${bt('mdOrPasteCsv')}<textarea class="textarea" id="supplier-import-content" rows="8" placeholder="email,legalName,displayName,countryCode\ncontact@example.com,Example Textiles,Example,PT">${esc(state.supplierImport.content)}</textarea></label><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="preview-supplier-import">${bt('mdPreview')}</button><button type="button" class="btn btn-primary" data-action="commit-supplier-import" ${state.supplierImport.preview?.acceptedRows > 0 ? '' : 'disabled'}>${bt('mdCreateValidInvites')}</button></div>${supplierImportPreview()}</div></div>`;
        if (type === 'catalog-import') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('pdEyebrow')}</div><h2>${bt('mdImportCatalogue')}</h2></div><button class="close" data-action="close-modal">×</button></div><p>${bt('mdImportNote')}</p><div class="notice" style="margin:14px 0">${bt('mdRequiredColumns')} <code>reference</code>, <code>name</code>${bt('mdExtraColumnsNote')}</div><label class="field-full">${bt('mdCsvFile')}<input class="input" id="catalog-import-file" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label><label class="field-full" style="margin-top:12px">${bt('mdOrPasteCsv')}<textarea class="textarea" id="catalog-import-content" rows="8" placeholder="reference,name,category,sku\nAT-NEW-001,Sample product,T-shirt,SKU-001">${esc(state.catalogImport.content)}</textarea></label><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="preview-catalog-import">${bt('mdPreview')}</button><button type="button" class="btn btn-primary" data-action="commit-catalog-import" ${state.catalogImport.preview?.acceptedRows > 0 ? '' : 'disabled'}>${bt('mdImportValidRows')}</button></div>${catalogImportPreview()}</div></div>`;
        if (type === 'invite-supplier') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdEcosystem')}</div><h2>${bt('mdInviteSupplier')}</h2></div><button class="close" data-action="close-modal">×</button></div><p>${bt('mdActivationNote')}</p><form id="supplier-form"><div class="form-grid"><label class="field-full">${bt('mdBusinessEmail')}<input class="input" name="email" type="email" required placeholder="contact@supplier.com"></label><label>${bt('mdLegalName')}<input class="input" name="legalName" required placeholder="Nhãn Textile Ltd"></label><label>${bt('mdDisplayName')}<input class="input" name="displayName" placeholder="Nhãn Textile"></label><label>${bt('mdCountry')}<input class="input" name="countryCode" maxlength="2" placeholder="PT"></label><label>${bt('mdBrandOrg')}<select class="select" name="organizationId" required>${brands().map((m) => `<option value="${esc(m.organization_id)}">${esc(m.organizations.display_name || m.organizations.legal_name)}</option>`).join('')}</select></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button class="btn btn-primary">${bt('mdSendInvite')}</button></div></form></div></div>`;
        if (type === 'new-questionnaire') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">Form Studio</div><h2>${bt('mdCreateAuditProtocol')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="questionnaire-builder-form"><div class="form-grid"><label class="field-full">${bt('mdQuestionnaireTitle')}<input class="input" name="title" required placeholder="${bt('mdPhAuditTitle')}"></label><label>${bt('mdUniqueSlug')}<input class="input" name="key" required placeholder="ex: dyeing-water-effluents"></label><label>${bt('mdEsgCategory')}<select class="select" name="category"><option value="Chemistry &amp; Effluents">${bt('mdCatChemistry')}</option><option value="${esc(bt('cnGrpMaterials'))}">${bt('mdCatMaterials')}</option><option value="${esc(bt('cnGrpSocial'))}">${bt('mdCatSocial')}</option><option value="Empreinte Carbone">${bt('mdCatCarbon')}</option></select></label><label class="field-full">${bt('mdAuditDescription')}<textarea class="textarea" name="description" rows="3" required placeholder="${bt('mdPhAuditDesc')}"></textarea></label><label>${bt('mdFirstFieldType')}<select class="select" name="firstFieldType"><option value="document_proof">${bt('mdFieldDocProof')}</option><option value="composition_table">${bt('mdFieldComposition')}</option><option value="facility_select">${bt('mdFieldSitePicker')}</option></select></label><label>${bt('mdRequiredField')}<select class="select" name="required"><option value="true">${bt('mdYesBlocking')}</option><option value="false">${bt('mdOptional')}</option></select></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button type="submit" class="btn btn-primary">${bt('mdPublishQuestionnaire')}</button></div></form></div></div>`;
        if (type === 'new-request') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdCollection')}</div><h2>${bt('mdNewDataRequest')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="request-form"><div class="form-grid"><label class="field-full">${bt('mdTitle')}<input class="input" name="title" required placeholder="${bt('mdPhRequestTitle')}"></label><label>${bt('sxSupplier')}<select class="select" name="supplierOrganizationId" required>${suppliers().map((m) => `<option value="${esc(m.organization_id)}" ${state.modalSupplierId === m.organization_id ? 'selected' : ''}>${esc(m.organizations.display_name || m.organizations.legal_name)}</option>`).join('')}</select></label><label>Questionnaire<select class="select" name="questionnaireKey" required>${state.questionnaires.map((q) => `<option value="${esc(q.key)}" data-version="${esc(q.version)}">${esc(q.title)} · v${esc(q.version)}</option>`).join('')}</select></label><label class="field-full">${bt('mdLinkedProduct')}<select class="select" name="productId"><option value="">${bt('mdNoLinkedProduct')}</option>${state.products.map((p) => `<option value="${esc(p.id)}" ${state.modalProductId === p.id ? 'selected' : ''}>${esc(p.reference)} — ${esc(p.name)}</option>`).join('')}</select></label><label>${bt('mdDueDate')}<input class="input" name="dueAt" type="date"></label><label>${bt('mdBrandOrg')}<select class="select" name="brandOrganizationId" required>${brands().map((m) => `<option value="${esc(m.organization_id)}" ${m.organization_id === state.activeOrganizationId ? 'selected' : ''}>${esc(m.organizations.display_name || m.organizations.legal_name)}</option>`).join('')}</select></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button class="btn btn-primary">${bt('mdCreateAndPrepare')}</button></div></form></div></div>`;
        if (type === 'new-chain-node') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">Supply Chain</div><h2>${bt('mdAddNode')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="chain-node-form"><div class="form-grid"><label class="field-full">${bt('mdNodeLabel')}<input class="input" name="label" required placeholder="${bt('mdPhNodeLabel')}"></label><label>${bt('mdNodeType')}<select class="select" name="nodeType" required><option value="process">${bt('mdProcessTransform')}</option><option value="site">${bt('mdSupplierSite')}</option><option value="material">${bt('mdRawMaterial')}</option><option value="organization">${bt('mdPartnerOrg')}</option></select></label><label>${bt('mdTextileProcess')}<select class="select" name="processCode"><option value="">${bt('mdNoneOther')}</option><option value="other">${bt('mdOtherDeclared')}</option><option value="ginning">${bt('mdGinning')}</option><option value="spinning">${bt('mdSpinning')}</option><option value="weaving">${bt('mdWeaving')}</option><option value="knitting">${bt('mdKnitting')}</option><option value="dyeing">${bt('mdDyeing')}</option><option value="finishing">${bt('mdFinishing')}</option><option value="cutting">${bt('mdCutting')}</option><option value="sewing">${bt('mdSewing')}</option><option value="assembly">${bt('mdAssembly')}</option><option value="packaging">${bt('mdPackaging')}</option></select></label><label class="field-full">${bt('mdLinkedMaterial')}<select class="select" name="materialId"><option value="">${bt('mdNone')}</option>${state.materials.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label><label class="field-full">${bt('mdSupplierOrg')}<select class="select" name="organizationId"><option value="">${bt('mdNone')}</option>${suppliers().map((m) => `<option value="${esc(m.organization_id)}">${esc(m.organizations.display_name || m.organizations.legal_name)}</option>`).join('')}</select></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button type="submit" class="btn btn-primary">${bt('mdAddNodeCta')}</button></div></form></div></div>`;
        if (type === 'new-chain-link') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">Supply Chain</div><h2>${bt('mdLinkTwoSteps')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="chain-link-form"><div class="form-grid"><label class="field-full">${bt('mdSourceStep')}<select class="select" name="sourceNodeId" required>${(state.supplyChain?.graph?.nodes || []).map((n) => `<option value="${esc(n.id)}">${esc(n.label)} (${esc(n.node_type)})</option>`).join('')}</select></label><label class="field-full">${bt('mdTargetStep')}<select class="select" name="targetNodeId" required>${(state.supplyChain?.graph?.nodes || []).map((n, index) => `<option value="${esc(n.id)}" ${index === 1 ? 'selected' : ''}>${esc(n.label)} (${esc(n.node_type)})</option>`).join('')}</select></label><label>${bt('mdRelationType')}<select class="select" name="linkType" required><option value="next_step">${bt('mdRelNextStep')}</option><option value="transformed_at">${bt('mdRelTransformedAt')}</option><option value="manufactured_at">${bt('mdRelManufacturedAt')}</option><option value="sourced_from">${bt('mdRelSourcedFrom')}</option><option value="contains">${bt('mdRelContains')}</option></select></label><label>${bt('mdSequenceOrder')}<input class="input" name="sequenceNumber" type="number" min="1" step="1" placeholder="1"></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button class="btn btn-primary">${bt('mdCreateLink')}</button></div></form></div></div>`;
        if (type === 'create-cap') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdQualityCap')}</div><h2>${bt('mdCreateCap')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="create-cap-form"><div class="form-grid"><label>${bt('mdQualityIssue')}<input class="input" name="issueId" required placeholder="${bt('mdPhIssueUuid')}"></label><label>${bt('mdSupplierOrganisation')}<input class="input" name="supplierOrganizationId" required placeholder="${bt('mdPhSupplierUuid')}"></label><label class="field-full">${bt('mdTitle')}<input class="input" name="title" required></label><label class="field-full">Instructions<textarea class="textarea" name="instructions" rows="4" required></textarea></label></div><div class="form-actions"><button class="btn btn-primary">${bt('mdCreateCapCta')}</button></div></form></div></div>`;
        if (type === 'review-cap') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdQualityCap')}</div><h2>${bt('mdReviewCap')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="review-cap-form"><label>CAP<input class="input" name="capId" required placeholder="${bt('mdPhCapUuid')}"></label><label>Verdict<select class="select" name="verdict"><option value="approved">${bt('mdApprove')}</option><option value="rejected">${bt('mdRequestRework')}</option></select></label><label>Notes<textarea class="textarea" name="reviewNotes" rows="4" required></textarea></label><div class="form-actions"><button class="btn btn-primary">${bt('mdSaveReview')}</button></div></form></div></div>`;
        if (type === 'cap-message') return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdQualityCap')}</div><h2>${bt('mdCapThread')}</h2></div><button class="close" data-action="close-modal">×</button></div><form id="cap-message-form"><label>CAP<input class="input" name="capId" required placeholder="${bt('mdPhCapUuid')}"></label><label>Message<textarea class="textarea" name="message" rows="4" required></textarea></label><div class="form-actions"><button class="btn btn-primary">${bt('mdSend')}</button></div></form></div></div>`;
        if (type === 'waive-issue') {
          const issue = state.quality?.issues?.find((i) => i.id === state.modalIssueId);
          return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">${bt('mdQualityWaiver')}</div><h2>${bt('mdGrantWaiver')}</h2></div><button class="close" data-action="close-modal">×</button></div><p>${bt('mdWaiverNote')}</p>${issue ? `<div class="notice" style="margin-bottom:15px;background:#fdfcf9;border:1px solid #f1ece1;padding:10px 14px;border-radius:8px"><strong>${esc(issue.message)}</strong><div class="meta">${esc(issue.ruleKey)} · ${esc(bt('cnSeverity'))} ${esc(issue.severity)}</div></div>` : ''}<form id="waive-issue-form"><input type="hidden" name="issueId" value="${esc(state.modalIssueId)}"><div class="form-grid"><label class="field-full">${bt('mdWaiverReason')}<textarea class="textarea" name="reason" rows="3" required minlength="10" placeholder="${bt('mdPhWaiverReason')}"></textarea></label></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">${bt('mdCancel')}</button><button class="btn btn-primary">${bt('mdValidateWaiver')}</button></div></form></div></div>`;
        }
        return '';
      }

      function demoCatalogPreview(content) {
        const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
        const delimiter = (lines[0] || '').includes(';') ? ';' : ',';
        const headers = (lines[0] || '').split(delimiter).map((value) => value.trim().toLowerCase());
        const referenceIndex = headers.indexOf('reference');
        const nameIndex = headers.indexOf('name');
        const errors = [];
        const rows = [];
        if (referenceIndex < 0 || nameIndex < 0) errors.push({ line: 1, code: 'required_column_missing', message: bt('mdColsRefNameRequired') });
        for (let index = 1; index < lines.length && errors.length < 100; index += 1) {
          const cells = lines[index].split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ''));
          if (!cells[referenceIndex] || !cells[nameIndex]) errors.push({ line: index + 1, code: 'required_value_missing', message: bt('mdValRefNameRequired') });
          else rows.push({ reference: cells[referenceIndex], name: cells[nameIndex], category: cells[headers.indexOf('category')] || null, sku: cells[headers.indexOf('sku')] || null });
        }
        return { valid: errors.length === 0 && rows.length > 0, totalRows: Math.max(0, lines.length - 1), acceptedRows: rows.length, rejectedRows: Math.max(0, lines.length - 1 - rows.length), errors, warnings: [], rows };
      }

      function demoSupplierPreview(content) {
        const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
        const delimiter = (lines[0] || '').includes(';') ? ';' : ',';
        const headers = (lines[0] || '').split(delimiter).map((value) => value.trim().toLowerCase());
        const emailIndex = headers.indexOf('email'); const legalNameIndex = headers.indexOf('legalname'); const errors = []; const rows = [];
        if (emailIndex < 0 || legalNameIndex < 0) errors.push({ line: 1, code: 'required_column_missing', message: bt('mdColsEmailLegalRequired') });
        for (let index = 1; index < lines.length; index += 1) {
          const cells = lines[index].split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ''));
          const email = cells[emailIndex]?.toLowerCase(); const legalName = cells[legalNameIndex];
          if (!email || !legalName) errors.push({ line: index + 1, code: 'required_value_missing', message: bt('mdValEmailLegalRequired') });
          else rows.push({ email, legalName });
        }
        return { valid: errors.length === 0 && rows.length > 0, totalRows: Math.max(0, lines.length - 1), acceptedRows: rows.length, rejectedRows: Math.max(0, lines.length - 1 - rows.length), errors, rows };
      }

      async function previewSupplierImport() {
        const content = state.supplierImport.content || document.getElementById('supplier-import-content')?.value || '';
        if (!content.trim()) { notify(bt('mdSelectSupplierCsv'), true); return; }
        state.supplierImport.content = content; state.supplierImport.loading = true; render();
        try {
          state.supplierImport.preview = state.demo
            ? demoSupplierPreview(content)
            : await api('/api/catalog/suppliers/import', { method: 'POST', body: JSON.stringify({ brandOrganizationId: state.activeOrganizationId, csvContent: content, filename: state.supplierImport.filename || 'suppliers.csv', dryRun: true }) });
        } finally { state.supplierImport.loading = false; render(); }
      }

      async function commitSupplierImport() {
        const content = state.supplierImport.content || document.getElementById('supplier-import-content')?.value || '';
        if (!(state.supplierImport.preview?.acceptedRows > 0) || !content.trim()) { notify(bt('cnNPreviewSupplierRow'), true); return; }
        state.supplierImport.loading = true; render();
        try {
          if (state.demo) {
            const preview = demoSupplierPreview(content);
            preview.rows.forEach((row, index) => state.suppliers.push({ id: `demo-supplier-import-${Date.now()}-${index}`, organization_id: `demo-supplier-import-${Date.now()}-${index}`, relationship_id: null, organizations: { display_name: row.legalName, legal_name: row.legalName, type: 'supplier', country_code: null, status: 'invited' } }));
            state.supplierImport.delivery = { total: preview.acceptedRows, pending: preview.acceptedRows, sent: 0, failed: 0 };
            state.supplierImport.job = { status: 'completed', acceptedRows: preview.acceptedRows, rejectedRows: preview.rejectedRows };
          } else {
            const result = await api('/api/catalog/suppliers/import', { method: 'POST', body: JSON.stringify({ brandOrganizationId: state.activeOrganizationId, csvContent: content, filename: state.supplierImport.filename || 'suppliers.csv', idempotencyKey: `brand-suppliers-${Date.now()}-${content.length}` }) });
            state.supplierImport.job = result.job; state.supplierImport.delivery = result.delivery; await sync();
          }
          state.modal = null; const delivery = state.supplierImport.delivery; notify(`Import fournisseurs terminé : ${state.supplierImport.job?.acceptedRows || 0} ${esc(bt('cnInvitesCreated'))}${delivery ? ` ${delivery.sent || 0} ${esc(bt('cnSentPlural'))} ${delivery.pending || 0} en attente manuelle, ${delivery.failed || 0} en échec.` : ''}`);
        } finally { state.supplierImport.loading = false; render(); }
      }

      async function previewCatalogImport() {
        const content = state.catalogImport.content || document.getElementById('catalog-import-content')?.value || '';
        if (!content.trim()) { notify(bt('mdSelectCsv'), true); return; }
        state.catalogImport.content = content;
        state.catalogImport.loading = true;
        render();
        try {
          state.catalogImport.preview = state.demo
            ? demoCatalogPreview(content)
            : await api('/api/catalog/products/import', { method: 'POST', body: JSON.stringify({ brandOrganizationId: state.activeOrganizationId, csvContent: content, filename: state.catalogImport.filename || 'catalog.csv', dryRun: true }) });
        } finally {
          state.catalogImport.loading = false;
          render();
        }
      }

      function downloadTextFile(filename, content, mime = 'text/csv;charset=utf-8') {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      function demoCatalogCsv() {
        const headers = ['reference', 'name', 'category', 'sku', 'description', 'productFamily', 'colorName', 'sizeRange', 'countryOfDesign', 'countryOfManufacture', 'weightGrams', 'careInstructions', 'dataReadiness', 'dataCompletion', 'version', 'compositionJson'];
        const cell = (value) => { const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
        const rows = state.products.map((product) => headers.map((header) => cell(product[header] ?? (header === 'sizeRange' ? (product.sizeRange || []).join('|') : header === 'careInstructions' || header === 'compositionJson' ? {} : ''))).join(','));
        return `\uFEFF${[headers.join(','), ...rows].join('\r\n')}\r\n`;
      }

      async function exportCatalog() {
        if (state.demo) { downloadTextFile('tracefab-product-catalog-demo.csv', demoCatalogCsv()); notify(bt('cnNCatalogExportedDemo')); return; }
        const token = await state.clerk?.session?.getToken();
        const response = await fetch(`/api/catalog/products/export?organizationId=${encodeURIComponent(state.activeOrganizationId)}`, { headers: Object.assign(token ? { Authorization: `Bearer ${token}` } : {}, state.activeOrganizationId ? { [TENANT_HEADER]: state.activeOrganizationId } : {}) });
        if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || payload.error || `request_failed_${response.status}`); }
        downloadTextFile('tracefab-product-catalog.csv', await response.text());
        notify(bt('cnNCatalogExported'));
      }

      async function exportAudit() {
        if (state.demo) { downloadTextFile('tracefab-audit-export-demo.csv', 'recordType,productReference,productName,dataStatus,action,recordedAt\\r\\nPRODUCT,TF-DEMO-001,Produit démonstration,declared,catalog_demo_export,2026-10-06T00:00:00.000Z\\r\\n'); notify('Export audit simulé en mode démonstration.'); return; }
        const token = await state.clerk?.session?.getToken();
        const response = await fetch(`/api/catalog/audit-export?organizationId=${encodeURIComponent(state.activeOrganizationId)}`, { headers: Object.assign(token ? { Authorization: `Bearer ${token}` } : {}, state.activeOrganizationId ? { [TENANT_HEADER]: state.activeOrganizationId } : {}) });
        if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || payload.error || `request_failed_${response.status}`); }
        downloadTextFile('tracefab-audit-export.csv', await response.text());
        notify(bt('cnNAuditExported'));
      }

      async function commitCatalogImport() {
        const content = state.catalogImport.content || document.getElementById('catalog-import-content')?.value || '';
        if (!(state.catalogImport.preview?.acceptedRows > 0) || !content.trim()) { notify(bt('cnNPreviewRow'), true); return; }
        state.catalogImport.loading = true;
        render();
        try {
          if (state.demo) {
            const preview = demoCatalogPreview(content);
            preview.rows.reverse().forEach((row) => state.products.unshift({ id: `demo-import-${Date.now()}-${row.reference}`, brandOrganizationId: state.activeOrganizationId, reference: row.reference, name: row.name, category: row.category, sku: row.sku, status: 'draft', version: 1, dataReadiness: 'in_progress', dataCompletion: '0' }));
            state.catalogImport.job = { status: 'completed', totalRows: preview.totalRows, acceptedRows: preview.acceptedRows, rejectedRows: preview.rejectedRows };
          } else {
            const result = await api('/api/catalog/products/import', { method: 'POST', body: JSON.stringify({ brandOrganizationId: state.activeOrganizationId, csvContent: content, filename: state.catalogImport.filename || 'catalog.csv', idempotencyKey: `brand-console-${Date.now()}-${content.length}` }) });
            state.catalogImport.job = result.job;
            await sync();
          }
          state.modal = null;
          notify(`Import catalogue terminé : ${state.catalogImport.job?.acceptedRows || 0} ligne(s) acceptée(s).`);
        } finally {
          state.catalogImport.loading = false;
          render();
        }
      }

      async function createProduct(form) {
        const data = Object.fromEntries(new FormData(form));
        if (state.demo) { state.products.unshift({ id: `demo-${Date.now()}`, brandOrganizationId: state.activeOrganizationId, reference: data.reference, name: data.name, category: data.category, status: 'draft', version: 1, dataReadiness: 'in_progress', dataCompletion: '0' }); state.modal = null; notify('Produit créé en mode démonstration.'); return; }
        await api('/api/products', { method: 'POST', body: JSON.stringify({ ...data, brandOrganizationId: state.activeOrganizationId }) });
        state.modal = null; await sync(); notify(bt('cnNProductCreated'));
      }
      async function inviteSupplier(form) {
        const data = Object.fromEntries(new FormData(form));
        if (state.demo) { state.modal = null; notify(bt('cnNInviteDemo')); return; }
        await api(`/api/organizations/${encodeURIComponent(data.organizationId)}/invitations`, { method: 'POST', body: JSON.stringify(data) });
        state.modal = null; await sync(); notify(bt('cnNSupplierInvited'));
      }
      async function createRequest(form) {
        const data = Object.fromEntries(new FormData(form));
        const questionnaire = state.questionnaires.find((q) => q.key === data.questionnaireKey);
        const productId = data.productId ? String(data.productId).trim() : null;
        const body = { ...data, productId: productId || null, questionnaireVersion: questionnaire?.version || '1.0', dueAt: data.dueAt ? `${data.dueAt}T23:59:59.000Z` : null, idempotencyKey: `brand-console-${Date.now()}` };
        if (state.demo) { const request = { id: `demo-${Date.now()}`, ...body, status: 'draft', completionPercentage: '0', createdAt: new Date().toISOString() }; state.requests.unshift(request); state.modal = null; state.modalProductId = null; notify('Demande créée en mode démonstration.'); return; }
        const created = await api('/api/data-requests', { method: 'POST', body: JSON.stringify(body) });
        await api(`/api/data-requests/${created.request.id}/items/from-template`, { method: 'POST', body: '{}' });
        state.modal = null; state.modalProductId = null; await sync(); await openRequest(created.request.id); notify(bt('cnNRequestCreated'));
      }
      async function openRequest(id) {
        state.view = 'requestDetail';
        if (state.demo) {
          state.selectedRequest = state.requests.find((r) => r.id === id);
          if (state.selectedRequest && !state.selectedRequest.items) {
            state.selectedRequest.items = state.requests.find((r) => r.id === 'demo-request-2')?.items || [];
          }
          render();
          return;
        }
        state.selectedRequest = (await api(`/api/data-requests/${encodeURIComponent(id)}`)).request;
        render();
      }
      async function openProduct(id) {
        state.view = 'productDetail';
        state.selectedProduct = state.products.find((p) => p.id === id) || null;
        persistRoute('productDetail', state.selectedProduct?.id || null);
        state.productDetailError = null;
        state.schemaBindings = [];
        state.schemaBindingsError = null;
        if (state.demo) {
          state.selectedProductDetail = { product: state.selectedProduct, identifiers: [], materials: [] };
          state.schemaBindings = [];
          render();
          return;
        }
        // Chargement ESSENTIEL : la fiche sans lui n'existe pas. Un echec est
        // affiche comme tel (etat d'erreur explicite), jamais comme une fiche
        // vide ni comme un ecran fige sur la vue precedente.
        try {
          state.selectedProductDetail = await api(`/api/products/${encodeURIComponent(id)}`);
        } catch (error) {
          state.selectedProductDetail = null;
          state.productDetailError = error.message || 'product_detail_unavailable';
        }
        // La fiche est rendue AVANT le chargement auxiliaire : un 504 lent sur
        // /api/schema-bindings ne peut plus tenir la fiche otage pendant toute
        // la duree du timeout de la passerelle.
        render();
        await loadSchemaBindings(id);
      }
      async function loadSchemaBindings(id) {
        // Chargement AUXILIAIRE : cette fonction ne jette jamais. Elle met a
        // jour l'etat (succes ou degrade) puis re-rend. C'est la correction du
        // blocage Production du 2026-10-17 : avant, l'echec de cette seule
        // route rejetait openProduct() entier et la fiche restait invisible.
        if (!id) return;
        state.schemaBindings = null;
        state.schemaBindingsError = null;
        render();
        try {
          const payload = await api(`/api/schema-bindings?subjectType=product&subjectId=${encodeURIComponent(id)}`);
          state.schemaBindings = payload.bindings || [];
        } catch (error) {
          // L'erreur n'est ni masquee ni transformee en « aucune liaison » :
          // elle est exposee dans l'etat degrade, avec un bouton de reessai.
          state.schemaBindings = null;
          state.schemaBindingsError = error.message || 'schema_bindings_unavailable';
        }
        render();
      }
      async function retrySchemaBindings() {
        const productId = state.selectedProductDetail?.product?.id || state.selectedProduct?.id;
        if (!productId) return;
        await loadSchemaBindings(productId);
      }
      async function openSupplier(id) { const supplierRecord = suppliers().find((s) => s.id === id || s.organization_id === id); const supplierId = supplierRecord?.id || id; state.selectedSupplier = { id: supplierRecord?.organization_id || id, supplierId, organizationId: supplierRecord?.organization_id, name: supplierRecord?.organizations?.display_name || supplierRecord?.organizations?.legal_name || id, country: supplierRecord?.organizations?.country_code, role: bt('sxPartnerActive') }; state.view = 'supplierDetail'; if (!state.demo) { try { const supplier = await api(`/api/suppliers/${encodeURIComponent(supplierId)}/profile`); state.selectedSupplier.profile = supplier.profile; } catch (error) { state.selectedSupplier.profileError = error.message; } } render(); }
      async function saveProduct(form) {
        const current = state.selectedProductDetail.product;
        const data = Object.fromEntries(new FormData(form));
        const body = {};
        const errorBox = form.querySelector('#product-field-error');
        errorBox.textContent = '';
        // Explicit allowlist: never spread arbitrary form keys into the API.
        for (const key of ['name', 'reference', 'category', 'colorName', 'description', 'countryOfManufacture', 'weightGrams', 'sizeRange']) {
          const raw = String(data[key] ?? '').trim();
          let value = /^(inconnu|unknown)$/i.test(raw) ? null : raw || null;
          if (key === 'countryOfManufacture' && value) value = value.toUpperCase();
          if (key === 'weightGrams') value = value === null ? null : Number(raw);
          if (key === 'sizeRange') value = value === null ? [] : raw.split(',').map((x) => x.trim());
          const previous = key === 'weightGrams' ? (current[key] == null ? null : Number(current[key])) : key === 'sizeRange' ? current[key] || [] : current[key] ?? null;
          if (JSON.stringify(value) !== JSON.stringify(previous)) body[key] = value;
        }
        if (!Object.keys(body).length) return;
        try {
          if (state.demo) {
            Object.assign(current, body);
            state.selectedProduct = current;
          } else {
            state.selectedProductDetail = await api(`/api/products/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
            await sync();
          }
          notify('Données produit enregistrées.'); render();
        } catch (err) {
          errorBox.textContent = err.message;
        }
      }
      async function reviseProduct() { if (!state.selectedProductDetail?.product) return; if (state.demo) { state.selectedProductDetail.product.version = Number(state.selectedProductDetail.product.version || 1) + 1; notify(bt('cnNRevisionDemo')); render(); return; } const result = await api(`/api/products/${encodeURIComponent(state.selectedProductDetail.product.id)}/revision`, { method: 'POST' }); state.selectedProductDetail.product = result.product; await sync(); notify(bt('cnNRevisionCreated')); render(); }
      async function saveSchemaBinding(form) {
        if (!state.selectedProductDetail?.product) return;
        const [schemaKey, schemaVersion] = String(new FormData(form).get('schemaIdentity') || '').split('|');
        if (!schemaKey || !schemaVersion) return;
        if (state.demo) { state.schemaBindings.push({ id: `demo-schema-${Date.now()}`, schemaKey, schemaVersion, subjectType: 'product', subjectId: state.selectedProductDetail.product.id, createdAt: new Date().toISOString() }); notify(bt('cnNSchemaLinkedDemo')); render(); return; }
        const result = await api('/api/schema-bindings', { method: 'POST', body: JSON.stringify({ schemaKey, schemaVersion, subjectType: 'product', subjectId: state.selectedProductDetail.product.id }) });
        state.schemaBindings = [...state.schemaBindings.filter((binding) => binding.id !== result.binding.id), result.binding];
        notify(bt('cnNSchemaLinked')); render();
      }
      async function refreshProductDetail() {
        if (!state.selectedProductDetail?.product) return;
        if (!state.demo) state.selectedProductDetail = await api(`/api/products/${encodeURIComponent(state.selectedProductDetail.product.id)}`);
        state.selectedProduct = state.selectedProductDetail.product;
        render();
      }
      async function createMaterial(form) {
        const data = Object.fromEntries(new FormData(form));
        const body = {
          ownerOrganizationId: state.activeOrganizationId,
          materialType: String(data.materialType || '').trim(),
          name: String(data.name || '').trim(),
          composition: {},
          originCountryCode: String(data.originCountryCode || '').trim() || null,
        };
        if (state.demo) {
          state.materials.unshift({ id: `demo-material-${Date.now()}`, ...body });
        } else {
          const result = await api('/api/materials', { method: 'POST', body: JSON.stringify(body) });
          state.materials.unshift(result.material);
        }
        state.modal = null;
        notify(bt('cnNMaterialCreated'));
        render();
      }
      async function saveMaterial(form) {
        if (!state.selectedProductDetail?.product) return;
        const data = Object.fromEntries(new FormData(form));
        const body = {
          materialId: data.materialId,
          materialRole: data.materialRole,
          percentage: data.percentage === '' ? null : Number(data.percentage),
          unit: data.unit || '%',
          productVersion: data.productVersion ? Number(data.productVersion) : undefined,
        };
        const productId = state.selectedProductDetail.product.id;
        const isUpdate = Boolean(form.classList.contains('material-edit-form'));
        if (state.demo) {
          const material = state.materials.find((entry) => entry.id === body.materialId);
          const existing = state.selectedProductDetail.materials.find((entry) => entry.materialId === body.materialId && entry.role === body.materialRole && (!isUpdate || entry.productVersion === body.productVersion));
          if (existing) Object.assign(existing, { percentage: body.percentage === null ? null : String(body.percentage), unit: body.unit });
          else state.selectedProductDetail.materials.push({ ...body, percentage: body.percentage === null ? null : String(body.percentage), productVersion: state.selectedProductDetail.product.version, role: body.materialRole, material: material ? { name: material.name, materialType: material.materialType, id: material.id } : { id: body.materialId } });
          notify(isUpdate ? bt('cnNCompositionUpdatedDemo') : bt('cnNMaterialAddedDemo'));
          render();
          return;
        }
        const method = isUpdate ? 'PATCH' : 'POST';
        await api(`/api/products/${encodeURIComponent(productId)}/materials`, { method, body: JSON.stringify(body) });
        await refreshProductDetail();
        notify(isUpdate ? bt('cnNCompositionUpdated') : bt('cnNMaterialAdded'));
      }
      async function saveIdentifier(form) {
        if (!state.selectedProductDetail?.product) return;
        const data = Object.fromEntries(new FormData(form));
        const identifierId = form.dataset.identifierId;
        const body = { identifierType: data.identifierType, identifierValue: data.identifierValue, isPrimary: data.isPrimary === 'on' };
        const productId = state.selectedProductDetail.product.id;
        if (state.demo) {
          if (identifierId) {
            const existing = state.selectedProductDetail.identifiers.find((entry) => entry.id === identifierId);
            if (existing) Object.assign(existing, { value: body.identifierValue, isPrimary: body.isPrimary });
          } else {
            state.selectedProductDetail.identifiers.push({ id: `demo-identifier-${Date.now()}`, type: body.identifierType, value: body.identifierValue, isPrimary: body.isPrimary, createdAt: new Date().toISOString() });
          }
          notify(identifierId ? bt('cnNIdUpdatedDemo') : bt('cnNIdAddedDemo'));
          render();
          return;
        }
        const path = `/api/products/${encodeURIComponent(productId)}/identifiers${identifierId ? `?identifierId=${encodeURIComponent(identifierId)}` : ''}`;
        await api(path, { method: identifierId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        await refreshProductDetail();
        notify(identifierId ? bt('cnNIdUpdated') : bt('cnNIdAdded'));
      }
      async function refreshDetail() { if (!state.selectedRequest) return; if (!state.demo) state.selectedRequest = (await api(`/api/data-requests/${encodeURIComponent(state.selectedRequest.id)}`)).request; render(); }
      async function sendRequest() { if (!state.selectedRequest) return; if (!state.demo) await api(`/api/data-requests/${encodeURIComponent(state.selectedRequest.id)}/send`, { method: 'POST' }); state.selectedRequest.status = 'sent'; state.modal = null; await refreshDetail(); notify(bt('cnNRequestSent')); }
      async function remindRequest(requestId) {
        const id = requestId || state.selectedRequest?.id;
        if (!id) return;
        if (state.demo) {
          notify(bt('cnNReminderQueuedDemo'));
          return;
        }
        await api(`/api/data-requests/${encodeURIComponent(id)}/remind`, { method: 'POST' });
        notify(bt('cnNReminderQueued'));
      }
      async function loadQuality(id) {
        state.selectedProduct = state.products.find((p) => p.id === id);
        state.view = 'quality';
        persistRoute('quality', state.selectedProduct?.id || null);
        state.quality = null;
        state.pefAssessment = null;
        state.greenClaimsAudit = null;
        state.qualityFilter = 'all';
        render();
        if (!state.demo) {
          try {
            // PEF et green claims sont deux lectures independantes du meme
            // produit : un echec de l'une ne doit pas masquer l'autre.
            const [qualite, pef, claims] = await Promise.all([
              api(`/api/quality/products/${encodeURIComponent(id)}`),
              api(`/api/products/${encodeURIComponent(id)}/pef`).catch(() => null),
              api(`/api/products/${encodeURIComponent(id)}/green-claims`).catch(() => null),
            ]);
            state.quality = qualite;
            state.pefAssessment = pef?.assessment || null;
            state.greenClaimsAudit = claims?.audit || null;
            render();
          } catch (e) {
            notify(e.message, true);
          }
        } else {
          state.quality = {
            score: { completeness: 82, freshness: 78, documentationCoverage: 61, consistency: 80 },
            issues: [
              { id: 'demo-issue-1', severity: 'warning', status: 'open', ruleKey: 'product_missing_evidence', message: 'Some product data does not yet have documentary evidence.', detectedAt: new Date().toISOString() },
              { id: 'demo-issue-2', severity: 'blocking', status: 'open', ruleKey: 'product_expired_certification', message: 'The GOTS certificate for the main component has expired.', detectedAt: new Date().toISOString() },
            ],
          };
          render();
        }
      }

      async function calculatePef() {
        if (!state.selectedProduct) return;
        if (state.demo) { notify(bt('demoUnavailable')); return; }
        const res = await api(`/api/products/${encodeURIComponent(state.selectedProduct.id)}/pef/calculate`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        state.pefAssessment = res.assessment || null;
        notify(bt('qcComputePef'));
        render();
      }

      async function auditGreenClaims(form) {
        if (!state.selectedProduct) return;
        if (state.demo) { notify(bt('demoUnavailable')); return; }
        const data = new FormData(form);
        const claimText = String(data.get('claimText') || '').trim();
        if (!claimText) { notify(bt('qcClaim'), true); return; }
        const res = await api(`/api/products/${encodeURIComponent(state.selectedProduct.id)}/green-claims`, {
          method: 'POST',
          body: JSON.stringify({ claimText }),
        });
        state.greenClaimsAudit = res.audit || null;
        notify(bt('qcAuditClaims'));
        render();
      }

      async function computeQuality() {
        if (!state.selectedProduct) return;
        if (state.demo) {
          if (state.quality?.score) {
            const hasBlocking = (state.quality.issues || []).some((i) => i.severity === 'blocking' && ['open', 'acknowledged'].includes(i.status));
            state.quality.score.consistency = hasBlocking ? 70 : 100;
          }
          notify(bt('cnNQualityRecalculatedDemo'));
          render();
          return;
        }
        state.quality = await api(`/api/quality/products/${encodeURIComponent(state.selectedProduct.id)}`, {
          method: 'POST',
          body: JSON.stringify({ calculationVersion: 'product_quality_v1' }),
        });
        notify(bt('cnNQualityRecalculated'));
        render();
      }

      async function acknowledgeIssue(issueId) {
        if (!state.selectedProduct) return;
        if (state.demo) {
          const issue = state.quality?.issues?.find((i) => i.id === issueId);
          if (issue) {
            issue.status = 'acknowledged';
            issue.acknowledgedAt = new Date().toISOString();
          }
          notify(bt('cnNIssueResolvedDemo'));
          render();
          return;
        }
        await api(`/api/quality-issues/${encodeURIComponent(issueId)}/acknowledge`, { method: 'POST' });
        await loadQuality(state.selectedProduct.id);
        notify(bt('cnNIssueResolved'));
      }

      async function waiveIssue(form) {
        if (!state.selectedProduct) return;
        const data = Object.fromEntries(new FormData(form));
        const issueId = data.issueId;
        const reason = (data.reason || '').trim();
        if (reason.length < 10) {
          notify(bt('cnNWaiverTooShort'), true);
          return;
        }
        if (state.demo) {
          const issue = state.quality?.issues?.find((i) => i.id === issueId);
          if (issue) {
            issue.status = 'waived';
            issue.details = { waiver_reason: reason, waived_at: new Date().toISOString() };
            if (state.quality?.score) {
              const hasBlocking = (state.quality.issues || []).some((i) => i.severity === 'blocking' && ['open', 'acknowledged'].includes(i.status));
              state.quality.score.consistency = hasBlocking ? 70 : 100;
            }
          }
          state.modal = null;
          notify(bt('cnNWaiverGrantedDemo'));
          render();
          return;
        }
        await api(`/api/quality-issues/${encodeURIComponent(issueId)}/waive`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        state.modal = null;
        await computeQuality();
        notify(bt('cnNWaiverSaved'));
      }
      async function reviewResponse(responseId, reviewStatus) {
        const comment = window.prompt(reviewStatus === 'verified_by_reviewer' ? bt('cnPhVerifyComment') : bt('cnPhCorrection'), '') || '';
        if (state.demo) {
          if (state.selectedRequest?.items) {
            for (const item of state.selectedRequest.items) {
              const resp = item.responses?.find((r) => r.id === responseId);
              if (resp) {
                resp.status = reviewStatus;
                resp.reviewerNote = comment || (reviewStatus === 'verified_by_reviewer' ? bt('cnNEvidenceApproved') : bt('cnNCorrectionRequested'));
                break;
              }
            }
          }
          notify(reviewStatus === 'verified_by_reviewer' ? bt('cnNEvidenceSealed') : 'Demande de correction transmise.');
          render();
          return;
        }
        await api(`/api/data-responses/${encodeURIComponent(responseId)}/review`, { method: 'POST', body: JSON.stringify({ status: reviewStatus, reviewComment: comment }) });
        await refreshDetail();
        notify(reviewStatus === 'verified_by_reviewer' ? bt('cnNAnswerVerified') : bt('cnNCorrectionSent'));
      }

      function demoSupplyChain() {
        const p = state.selectedSupplyChainProduct || state.products[0];
        const nodes = [
          { id: 'node-raw', node_type: 'material', label: 'GOTS-certified organic cotton', process_code: 'ginning', status: 'documented', material_name: 'Organic cotton', source_document_id: 'demo-doc-1' },
          { id: 'node-spin', node_type: 'process', label: 'Spinning · high-tenacity combed yarn 30/1', process_code: 'spinning', status: 'documented', source_document_id: 'demo-doc-2' },
          { id: 'node-weav', node_type: 'process', label: 'Jersey knitting & OEKO-TEX certified dyeing', process_code: 'weaving', status: 'verified_by_reviewer', source_document_id: 'demo-doc-3' },
          { id: 'node-site', node_type: 'site', label: 'Garment Workshop · Nhãn Textile (Barcelos, PT)', process_code: 'sewing', status: 'verified_by_reviewer', site_name: 'Nhãn Textile Factory', site_country: 'PT', site_city: 'Barcelos' },
          { id: 'node-prod', node_type: 'product', label: `Produit fini · ${p?.name || 'T-Shirt Essentiel'}`, process_code: 'packaging', status: 'documented' },
        ];
        const links = [
          { id: 'link-1', source_node_id: 'node-raw', target_node_id: 'node-spin', link_type: 'transformed_at', sequence_number: 1, status: 'documented' },
          { id: 'link-2', source_node_id: 'node-spin', target_node_id: 'node-weav', link_type: 'next_step', sequence_number: 2, status: 'documented' },
          { id: 'link-3', source_node_id: 'node-weav', target_node_id: 'node-site', link_type: 'next_step', sequence_number: 3, status: 'verified_by_reviewer' },
          { id: 'link-4', source_node_id: 'node-site', target_node_id: 'node-prod', link_type: 'manufactured_at', sequence_number: 4, status: 'verified_by_reviewer' },
        ];
        return {
          product: p,
          graph: { product_id: p?.id || 'demo-p1', nodes, links },
          stages: {
            tier4_raw_materials: [nodes[0]],
            tier3_spinning: [nodes[1]],
            tier2_fabric: [nodes[2]],
            tier1_assembly: [nodes[3]],
            tier0_product: [nodes[4]],
            other_nodes: [],
          },
          summary: {
            nodeCount: 5,
            linkCount: 4,
            documentationRate: 100,
            stagesCoveredCount: 5,
            isCompleteChain: true,
          },
        };
      }

      /**
       * Chaque exigence DPP manquante doit mener a l'ecran qui la corrige :
       * le brief impose une liste d'actions, pas un constat. On indexe sur le
       * prefixe de la cle d'exigence pour couvrir celles que le backend
       * ajoutera. Sans correspondance, aucun bouton n'est rendu — un bouton
       * qui ne mene nulle part est pire que pas de bouton.
       */
      const DP_FIX_TARGETS = {
        supply_chain: { view: 'supplyChain', labelKey: 'supplyChain' },
        traceability: { view: 'supplyChain', labelKey: 'supplyChain' },
        quality:      { view: 'quality',     labelKey: 'quality' },
        composition:  { view: 'materials',   labelKey: 'materials' },
        product:      { view: 'products',    labelKey: 'products' },
      };
      function dppFixTarget(key) {
        return DP_FIX_TARGETS[String(key || '').split('.')[0]] || null;
      }
      async function resolveDppRequirement(view, productId) {
        // Cible du correctif : le produit vise, pas seulement l'ecran liste.
        // « Corriger dans Produits » ouvrait le catalogue (state.view =
        // 'products') et laissait l'utilisateur re-chercher la fiche qu'on
        // venait de lui designer : le bouton ne tenait pas sa promesse.
        // Desormais la fiche elle-meme s'ouvre — l'exigence DPP porte sur CE
        // produit, c'est donc sa fiche qu'il faut corriger.
        const cible = productId || state.selectedDppProduct?.id || state.selectedProduct?.id;
        if (view === 'products' && cible) { await openProduct(cible); return; }
        if (view === 'supplyChain' && cible) { await loadSupplyChain(cible); return; }
        if (view === 'quality' && cible) { await loadQuality(cible); return; }
        state.view = view;
        render();
      }

      async function loadSupplyChain(productId) {
        state.selectedSupplyChainProduct = state.products.find((p) => p.id === productId) || null;
        state.view = 'supplyChain';
        persistRoute('supplyChain', state.selectedSupplyChainProduct?.id || null);
        state.supplyChain = null;
        state.massBalance = null;
        render();
        if (state.demo) {
          state.supplyChain = demoSupplyChain();
          render();
          return;
        }
        try {
          // Le bilan matiere est une seconde lecture, non bloquante : une
          // absence de reconciliation ne doit pas masquer la chaine.
          const [chaine, bilan] = await Promise.all([
            api(`/api/products/${encodeURIComponent(productId)}/supply-chain`),
            api(`/api/products/${encodeURIComponent(productId)}/mass-balance`).catch(() => null),
          ]);
          state.supplyChain = chaine;
          state.massBalance = bilan;
          render();
        } catch (e) {
          notify(e.message, true);
        }
      }

      async function generateBaselineChain() {
        if (!state.selectedSupplyChainProduct) return;
        if (state.demo) {
          state.supplyChain = demoSupplyChain();
          notify(bt('cnNChainGeneratedDemo'));
          render();
          return;
        }
        try {
          state.supplyChain = await api(`/api/products/${encodeURIComponent(state.selectedSupplyChainProduct.id)}/supply-chain/generate-baseline`, { method: 'POST' });
          notify(bt('cnNChainGenerated'));
          render();
        } catch (e) {
          notify(e.message, true);
        }
      }

      function refreshLocalSupplyChainSummary() {
        if (!state.supplyChain?.graph) return;
        const nodes = state.supplyChain.graph.nodes || [];
        const links = state.supplyChain.graph.links || [];
        const documentedNodes = nodes.filter((node) => ['documented', 'verified_by_reviewer'].includes(node.status) || node.source_document_id);
        const documentedLinks = links.filter((link) => ['documented', 'verified_by_reviewer'].includes(link.status) || link.evidence_document_id);
        const total = nodes.length + links.length;
        state.supplyChain.summary = {
          nodeCount: nodes.length,
          linkCount: links.length,
          documentedNodeCount: documentedNodes.length,
          documentedLinkCount: documentedLinks.length,
          documentationRate: total ? Math.round(((documentedNodes.length + documentedLinks.length) / total) * 100) : 0,
        };
      }

      async function addChainNode(form) {
        if (!state.selectedSupplyChainProduct) return;
        const data = Object.fromEntries(new FormData(form));
        const body = {
          label: data.label,
          nodeType: data.nodeType,
          processCode: data.processCode || null,
          materialId: data.materialId || null,
          organizationId: data.organizationId || null,
        };
        if (state.demo) {
          const newNode = { id: `node-${Date.now()}`, node_type: body.nodeType, label: body.label, process_code: body.processCode, status: 'declared' };
          state.supplyChain.graph.nodes.push(newNode);
          state.modal = null;
          notify(bt('cnNNodeAddedDemo'));
          render();
          return;
        }
        const result = await api(`/api/products/${encodeURIComponent(state.selectedSupplyChainProduct.id)}/supply-chain/nodes`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        // Un nœud déclaré n'appartient au graphe lisible qu'après sa première
        // liaison. Recharger ici le faisait disparaître et empêchait donc de
        // sélectionner deux nœuds pour créer ce lien. La réponse authentifiée
        // du POST reste affichée localement jusqu'à la liaison, après laquelle
        // addChainLink recharge le graphe persistant complet.
        if (!state.supplyChain?.graph) state.supplyChain = { graph: { nodes: [], links: [] }, summary: null };
        const nodes = state.supplyChain.graph.nodes || (state.supplyChain.graph.nodes = []);
        if (result.node && !nodes.some((node) => node.id === result.node.id)) nodes.push(result.node);
        refreshLocalSupplyChainSummary();
        state.modal = null;
        notify(bt('cnNNodeAdded'));
        render();
      }

      async function addChainLink(form) {
        if (!state.selectedSupplyChainProduct) return;
        const data = Object.fromEntries(new FormData(form));
        const body = {
          sourceNodeId: data.sourceNodeId,
          targetNodeId: data.targetNodeId,
          linkType: data.linkType,
          sequenceNumber: data.sequenceNumber ? Number(data.sequenceNumber) : null,
        };
        if (state.demo) {
          const newLink = { id: `link-${Date.now()}`, source_node_id: body.sourceNodeId, target_node_id: body.targetNodeId, link_type: body.linkType, sequence_number: body.sequenceNumber, status: 'declared' };
          state.supplyChain.graph.links.push(newLink);
          state.modal = null;
          notify(bt('dpToastLinkAdded'));
          render();
          return;
        }
        const result = await api(`/api/products/${encodeURIComponent(state.selectedSupplyChainProduct.id)}/supply-chain/links`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        // Le POST et le rechargement sont deux opérations distinctes. Un GET
        // auxiliaire en échec ne doit jamais présenter un lien effectivement
        // créé comme un échec de création. Publier d'abord la réponse du POST,
        // puis tenter une réconciliation non destructive avec le serveur.
        const links = state.supplyChain?.graph?.links || [];
        if (result.link && !links.some((link) => link.id === result.link.id)) links.push(result.link);
        if (state.supplyChain?.graph) state.supplyChain.graph.links = links;
        refreshLocalSupplyChainSummary();
        state.modal = null;
        notify(bt('dpToastLinkCreated'));
        render();
      }

      async function deleteChainLink(linkId) {
        if (!state.selectedSupplyChainProduct) return;
        if (state.demo) {
          state.supplyChain.graph.links = state.supplyChain.graph.links.filter((l) => l.id !== linkId);
          notify(bt('dpToastLinkDeletedDemo'));
          render();
          return;
        }
        await api(`/api/products/${encodeURIComponent(state.selectedSupplyChainProduct.id)}/supply-chain/links/${encodeURIComponent(linkId)}`, {
          method: 'DELETE',
        });
        await loadSupplyChain(state.selectedSupplyChainProduct.id);
        notify(bt('dpToastLinkDeleted'));
      }

      /**
       * Ecarts du jeu de demonstration, source unique.
       *
       * Le portefeuille les agrege, la vue produit les applique : sans source
       * commune, la liste annonçait 524 produits sans origine tier 4 et le
       * produit ouvert s'affichait complet a 100 %. Deux ecrans qui se
       * contredisent ne valent pas mieux qu'un seul faux.
       *
       * Parts calibrees pour retomber sur les 88,0 % affiches par l'Overview :
       * 9 exigences par produit, somme des parts = 1,08 -> (9 - 1,08) / 9 = 88,0 %.
       */
      const DPP_DEMO_GAPS = [
        { key: 'traceability.tier4_raw_material', labelKey: 'dpItemRawOrigin',      blocking: true,  share: 0.42, pillar: 'traceability',   item: 'traceability.graph' },
        { key: 'quality.lab_test_report',         labelKey: 'dpItemLabTest',        blocking: false, share: 0.28, pillar: 'quality',        item: 'quality.lab_test_report' },
        { key: 'composition.recycled_share',      labelKey: 'dpItemRecycledShare',  blocking: false, share: 0.18, pillar: 'composition',    item: 'composition.recycled_share' },
        { key: 'supply_chain.tier3_spinning',     labelKey: 'dpItemMultiTierGraph', blocking: true,  share: 0.12, pillar: 'traceability',   item: 'traceability.graph' },
        { key: 'product.detailed_description',    labelKey: 'dpItemDetailedDesc',   blocking: false, share: 0.08, pillar: 'identification', item: 'product.description' },
      ];

      // Affectation deterministe : le meme produit porte toujours les memes
      // ecarts, sinon un rechargement deplacerait les manques sous l'oeil de
      // l'utilisateur.
      function demoGapsForProduct(productId, index) {
        const seed = String(productId || index);
        let h = 0;
        for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        return DPP_DEMO_GAPS.filter((g, gi) => (((h >>> (gi * 3)) % 100) / 100) < g.share);
      }

      function applyDemoGaps(dpp, productId, index) {
        const applicable = demoGapsForProduct(productId, index);
        if (!applicable.length) return dpp;
        const missing = [];
        applicable.forEach((g) => {
          const pillar = dpp.pillars?.[g.pillar];
          const item = pillar?.items?.find((x) => x.key === g.item);
          if (!item) return;
          item.met = false;
          missing.push({ key: g.key, labelKey: g.labelKey, blocking: g.blocking });
        });
        Object.values(dpp.pillars || {}).forEach((pillar) => {
          const met = (pillar.items || []).filter((x) => x.met).length;
          pillar.met = met;
          pillar.total = (pillar.items || []).length;
          pillar.metPercent = pillar.total ? Math.round((met / pillar.total) * 100) : 0;
          pillar.score = pillar.metPercent;
        });
        dpp.missingFields = missing;
        dpp.blockingIssues = missing.filter((m) => m.blocking)
          .map((m) => ({ key: m.key, labelKey: m.labelKey, reasonKey: 'dpMandatory' }));
        dpp.metRequirements = Math.max(0, (dpp.totalRequirements || 9) - missing.length);
        dpp.completionScore = Math.round((dpp.metRequirements / (dpp.totalRequirements || 9)) * 100);
        dpp.blockingCount = dpp.blockingIssues.length;
        dpp.canMarkReadyToPublish = dpp.blockingCount === 0;
        dpp.readinessStatus = dpp.blockingCount ? 'review_required' : (missing.length ? 'in_progress' : 'data_ready');
        return dpp;
      }

      function demoDpp() {
        const p = state.selectedDppProduct || state.products[0];
        const idx = Math.max(0, (state.products || []).findIndex((x) => x.id === p?.id));
        return applyDemoGaps(demoDppBase(p), p?.id, idx);
      }
      function demoDppBase(p) {
        return {
          id: 'demo-dpp-rec-1',
          productId: p?.id || 'demo-p1',
          productVersion: p?.version || 1,
          profileKey: 'textile_readiness_mvp',
          profileVersion: '1.0',
          readinessStatus: 'data_ready',
          statusLabel: 'Ready for validation',
          completionScore: 100,
          totalRequirements: 9,
          metRequirements: 9,
          blockingCount: 0,
          missingFields: [],
          blockingIssues: [],
          canMarkReadyToPublish: true,
          isReadyToPublish: false,
          computedAt: new Date().toISOString(),
          reviewedAt: null,
          reviewedBy: null,
          pillars: {
            identification: {
              key: 'identification',
              nameKey: 'dpPillar1Short',
              descriptionKey: 'dpQ1Desc',
              icon: '🏷️',
              score: 100, total: 6, met: 6, metPercent: 100,
              items: [
                { key: 'product.reference', labelKey: 'dpItemSku', met: true, blocking: true },
                { key: 'product.name', labelKey: 'dpItemCommercialName', met: true, blocking: true },
                { key: 'product.description', labelKey: 'dpItemDetailedDesc', met: true, blocking: true },
                { key: 'product.category', labelKey: 'dpItemTextileCategory', met: true, blocking: true },
                { key: 'product.country_of_manufacture', label: 'Country of manufacture (ISO-2 code)', met: true, blocking: true },
                { key: 'product.data_ready', labelKey: 'dpOverallPrep', met: true, blocking: true },
              ],
            },
            composition: {
              key: 'composition',
              nameKey: 'dpPillar2Short',
              descriptionKey: 'dpQ2Desc',
              icon: '🧵',
              score: 100, total: 1, met: 1, metPercent: 100,
              items: [
                { key: 'composition.complete', labelKey: 'dpItemFullComposition', met: true, blocking: true },
              ],
            },
            traceability: {
              key: 'traceability',
              nameKey: 'dpPillar3Short',
              descriptionKey: 'dpQ3Desc',
              icon: '☍',
              score: 100, total: 1, met: 1, metPercent: 100,
              items: [
                { key: 'traceability.graph', labelKey: 'dpItemMultiTierGraph', met: true, blocking: true },
              ],
            },
            quality: {
              key: 'quality',
              nameKey: 'dpPillar4Short',
              description: 'Absence d’anomalies critiques et validation documentaire.',
              icon: '🛡️',
              score: 100, total: 1, met: 1, metPercent: 100,
              items: [
                { key: 'quality.no_blocking_issues', labelKey: 'dpItemNoBlocking', met: true, blocking: true },
              ],
            },
          },
        };
      }

      /**
       * Agregat de demonstration calcule a partir des produits en memoire.
       * On ne fabrique aucun chiffre : les ecarts proviennent du meme profil
       * que la vue produit, et le denominateur est le catalogue reel.
       */
      function demoDppPortfolio() {
        const products = state.products || [];
        const GAPS = DPP_DEMO_GAPS;
        const total = products.length;
        const gaps = GAPS.map((g, i) => {
          const n = Math.max(1, Math.round(total * g.share));
          return {
            key: g.key,
            labelKey: g.labelKey,
            blocking: g.blocking,
            productCount: n,
            products: products.slice(i * 3, i * 3 + Math.min(3, n)).map((x) => ({ id: x.id, reference: x.reference, name: x.name })),
          };
        });
        const missingTotal = gaps.reduce((acc, g) => acc + g.productCount, 0);
        const denominator = Math.max(1, total * 9);
        // Repartition ponderee : six colonnes egales se lisent comme une maquette.
        const MIX = [['published', .12], ['ready_to_publish', .18], ['data_ready', .22],
                     ['review_required', .14], ['in_progress', .24], ['not_started', .10]];
        const counts = {};
        let assigned = 0;
        MIX.forEach(([k, w], i) => {
          counts[k] = i === MIX.length - 1 ? Math.max(0, total - assigned) : Math.round(total * w);
          assigned += counts[k];
        });
        return {
          profileKey: 'textile_readiness_mvp',
          profileVersion: '1.0',
          totalProducts: total,
          computedProducts: total,
          uncomputedProducts: 0,
          // Un produit porte souvent plusieurs ecarts : sommer les colonnes le
          // compterait plusieurs fois. On retient le plus grand ecart bloquant.
          blockedProducts: Math.max(0, ...gaps.filter((g) => g.blocking).map((g) => g.productCount)),
          readinessScore: Math.round(((denominator - missingTotal) / denominator) * 1000) / 10,
          statusCounts: counts,
          gaps,
          lastComputedAt: new Date().toISOString(),
        };
      }

      async function loadDppPortfolio(options = {}) {
        if (state.demo) { state.dppPortfolio = demoDppPortfolio(); render(); return; }
        if (state.dppPortfolioLoading) return;
        state.dppPortfolioLoading = true;
        try {
          const organisation = state.activeOrganizationId || state.selectedOrganizationId;
          const org = organisation ? `?organizationId=${encodeURIComponent(organisation)}` : '';
          state.dppPortfolio = await api(`/api/dpp/portfolio${org}`);
          render();
        } catch (e) {
          // Le chargement d'arriere-plan ne doit pas remplacer le tableau de
          // bord par une erreur : l'indicateur reste « non calculé ».
          if (!options.silent) notify(e.message, true);
        } finally {
          state.dppPortfolioLoading = false;
        }
      }

      async function loadDpp(productId) {
        state.selectedDppProduct = state.products.find((p) => p.id === productId) || null;
        state.view = 'dpp';
        persistRoute('dpp', state.selectedDppProduct?.id || null);
        state.dpp = null;
        render();
        if (state.demo) {
          state.dpp = demoDpp();
          render();
          return;
        }
        try {
          const res = await api(`/api/products/${encodeURIComponent(productId)}/dpp`);
          state.dpp = res.dpp;
          render();
        } catch (e) {
          notify(e.message, true);
        }
      }

      async function computeDpp() {
        if (!state.selectedDppProduct) return;
        if (state.demo) {
          state.dpp = demoDpp();
          notify(bt('dpToastRecalcDemo'));
          render();
          return;
        }
        try {
          const res = await api(`/api/products/${encodeURIComponent(state.selectedDppProduct.id)}/dpp`, {
            method: 'POST',
          });
          state.dpp = res.dpp;
          notify(bt('dpToastRecalc'));
          render();
        } catch (e) {
          notify(e.message, true);
        }
      }

      async function publishDpp() {
        if (!state.selectedDppProduct) return;
        if (!confirm(bt('dpConfirmValidate'))) return;
        if (state.demo) {
          state.dpp.readinessStatus = 'ready_to_publish';
          state.dpp.statusLabel = 'Validated & ready to publish';
          state.dpp.isReadyToPublish = true;
          state.dpp.canMarkReadyToPublish = false;
          state.dpp.reviewedAt = new Date().toISOString();
          notify(bt('dpToastValidatedDemo'));
          render();
          return;
        }
        try {
          const res = await api(`/api/products/${encodeURIComponent(state.selectedDppProduct.id)}/dpp/publish-review`, {
            method: 'POST',
          });
          state.dpp = res.dpp;
          notify(bt('cnNDppPublished'));
          render();
        } catch (e) {
          notify(e.message, true);
        }
      }

      async function submitCapConsoleForm(form, kind) {
        const data = Object.fromEntries(new FormData(form));
        if (!state.demo) {
          const path = kind === 'create' ? `/api/quality/issues/${encodeURIComponent(data.issueId)}/cap` : kind === 'review' ? `/api/quality/caps/${encodeURIComponent(data.capId)}/review` : `/api/quality/caps/${encodeURIComponent(data.capId)}/messages`;
          await api(path, { method: 'POST', body: JSON.stringify(data) });
        }
        state.modal = null;
        notify(kind === 'create' ? bt('cnNCapCreated') : kind === 'review' ? bt('cnNCapReviewed') : bt('cnNCapMessageSent'));
        render();
      }

      let delegatedFormsBound = false;
      function bindPersistentForms() {
        if (delegatedFormsBound) return;
        delegatedFormsBound = true;
        // Les modales sont recréées à chaque render(). Une délégation durable
        // empêche le navigateur d'effectuer une soumission HTML native si un
        // rendu intermédiaire intervient avant les bindings locaux. C'était la
        // cause du retour automatique vers la vue d'ensemble.
        document.addEventListener('submit', async (event) => {
          const form = event.target;
          if (!(form instanceof HTMLFormElement) || !['chain-node-form', 'chain-link-form'].includes(form.id)) return;
          event.preventDefault();
          event.stopPropagation();
          if (form.dataset.submitting === 'true') return;
          form.dataset.submitting = 'true';
          const submit = form.querySelector('button[type="submit"]');
          if (submit) submit.disabled = true;
          try {
            if (form.id === 'chain-node-form') await addChainNode(form);
            else await addChainLink(form);
          } catch (error) {
            notify(error instanceof Error ? error.message : 'request_failed', true);
            form.dataset.submitting = 'false';
            if (submit) submit.disabled = false;
          }
        }, true);
      }

      function bind() {
        bindPersistentForms();

        // Buttons that used to alert() a fake success now say what is actually true.
        document.querySelectorAll('[data-demo-action]').forEach((el) => el.addEventListener('click', (event) => {
          event.preventDefault(); notify(bt('demoUnavailable'));
        }));
        document.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => {
          state.view = el.dataset.view;
          state.selectedRequest = null;
          persistRoute(state.view);
          render();
          // Le portefeuille se charge a l'arrivee, pas au demarrage : inutile
          // d'agreger tout le catalogue pour qui n'ouvre jamais cet ecran.
          // Le garde suit dppScope, pas selectedDppProduct : un produit reste
          // pre-selectionne en memoire alors que l'ecran montre l'ensemble.
          if (state.view === 'dpp' && state.dppScope !== 'product' && !state.dppPortfolio) loadDppPortfolio();
          // Les ecrans qualite et tracabilite ont besoin d'un produit : on
          // charge celui qui est affiche au lieu de laisser « non calculé »
          // alors qu'une route peut repondre.
          if (state.view === 'quality' && !state.quality) {
            const candidat = state.selectedProduct || state.products[0];
            if (candidat) loadQuality(candidat.id);
          }
          if (state.view === 'supplyChain' && !state.supplyChain) {
            const candidat = state.selectedSupplyChainProduct || state.products[0];
            if (candidat) loadSupplyChain(candidat.id);
          }
        }));
        document.querySelectorAll('[data-action]').forEach((el) => el.addEventListener('click', async (event) => {
          const action = el.dataset.action;
          try {
            if (action === 'new-product') { state.modal = 'new-product'; render(); }
            if (action === 'new-material') { state.modal = 'new-material'; render(); }
            if (action === 'catalog-import') { state.catalogImport = { filename: '', content: '', preview: null, job: null, loading: false }; state.modal = 'catalog-import'; render(); }
            if (action === 'supplier-import') { state.supplierImport = { filename: '', content: '', preview: null, job: null, delivery: null, loading: false }; state.modal = 'supplier-import'; render(); }
            if (action === 'dpp-back-portfolio') { state.dppScope = 'portfolio'; render(); if (!state.dppPortfolio) await loadDppPortfolio(); }
            if (action === 'dp-resolve') await resolveDppRequirement(el.dataset.dpTarget, el.dataset.dpProduct);
            if (action === 'retry-schema-bindings') await retrySchemaBindings();
            if (action === 'retry-product-detail') { const id = state.selectedProduct?.id; if (id) await openProduct(id); }
            if (action === 'dpp-recalc-portfolio') { state.dppPortfolio = null; render(); await loadDppPortfolio(); notify(bt('dpToastRecalc')); }
            if (action === 'catalog-export') await exportCatalog();
            if (action === 'audit-export') await exportAudit();
            if (action === 'preview-catalog-import') await previewCatalogImport();
            if (action === 'commit-catalog-import') await commitCatalogImport();
            if (action === 'preview-supplier-import') await previewSupplierImport();
            if (action === 'commit-supplier-import') await commitSupplierImport();
            if (action === 'new-request') { state.modal = 'new-request'; state.modalSupplierId = el.dataset.supplierOrgId || el.dataset.supplierId; state.modalProductId = null; render(); }
            if (action === 'product-new-request') { state.modal = 'new-request'; state.modalProductId = el.dataset.productId; render(); }
            if (action === 'invite-supplier') { state.modal = 'invite-supplier'; render(); }
            if (action === 'open-cap-modal') { state.modal = 'create-cap'; render(); }
            if (action === 'open-review-cap-modal') { state.modal = 'review-cap'; render(); }
            if (action === 'open-cap-message-modal') { state.modal = 'cap-message'; render(); }
            if (action === 'close-modal') { state.modal = null; state.modalProductId = null; render(); }
            if (action === 'retry') { state.configError = null; state.tenantError = null; boot(); }
            if (action === 'refresh-detail') await refreshDetail();
            if (action === 'send-request') await sendRequest();
            if (action === 'remind-request') { event.stopPropagation(); await remindRequest(el.dataset.reminderRequestId); }
            if (action === 'select-quality-product') { state.selectedProduct = null; state.quality = null; render(); }
            if (action === 'select-supply-chain-product') { state.selectedSupplyChainProduct = null; state.supplyChain = null; render(); }
            if (action === 'select-dpp-product') { state.selectedDppProduct = null; state.dpp = null; render(); }
            if (action === 'compute-quality') await computeQuality();
            if (action === 'calculate-pef') await calculatePef();
            if (action === 'audit-green-claims') {
              const greenForm = document.getElementById('green-claim-form');
              if (greenForm) await auditGreenClaims(greenForm);
            }
            if (action === 'compute-dpp') await computeDpp();
            if (action === 'publish-dpp') await publishDpp();
            if (action === 'generate-baseline-chain') await generateBaselineChain();
            if (action === 'new-chain-node') { state.modal = 'new-chain-node'; render(); }
            if (action === 'new-chain-link') { state.modal = 'new-chain-link'; render(); }
            if (action === 'product-revision') await reviseProduct();
            if (action === 'product-quality-from-detail') { state.selectedProduct = state.selectedProductDetail?.product; await loadQuality(state.selectedProduct?.id); }
            if (action === 'product-supply-chain-from-detail') { await loadSupplyChain(state.selectedProductDetail?.product?.id); }
            if (action === 'product-dpp-from-detail') { await loadDpp(state.selectedProductDetail?.product?.id); }
            if (action === 'signout' && state.clerk) {
              cachedSessionToken = null;
              cachedSessionTokenAt = 0;
              await state.clerk.signOut();
            }
          } catch (error) { notify(error.message, true); }
        }));
        document.querySelectorAll('[data-request-id]').forEach((el) => el.addEventListener('click', (event) => { event.stopPropagation(); openRequest(el.dataset.requestId); }));
        document.querySelectorAll('[data-quality-product]').forEach((el) => el.addEventListener('click', () => loadQuality(el.dataset.qualityProduct)));
        document.querySelectorAll('[data-dpp-product]').forEach((el) => el.addEventListener('click', () => loadDpp(el.dataset.dppProduct)));
        document.querySelectorAll('[data-product-id]').forEach((el) => el.addEventListener('click', (event) => { event.stopPropagation(); openProduct(el.dataset.productId); }));
        document.querySelectorAll('[data-supplier-id-view]').forEach((el) => el.addEventListener('click', (event) => { event.stopPropagation(); openSupplier(el.dataset.supplierIdView); }));
        document.querySelectorAll('[data-review-response]').forEach((el) => el.addEventListener('click', () => reviewResponse(el.dataset.reviewResponse, el.dataset.reviewStatus).catch((error) => notify(error.message, true))));
        document.querySelectorAll('[data-delete-chain-link]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteChainLink(el.dataset.deleteChainLink); }));
        document.querySelectorAll('[data-action="acknowledge-issue"]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); acknowledgeIssue(el.dataset.issueId).catch((err) => notify(err.message, true)); }));
        document.querySelectorAll('[data-action="open-waive-modal"]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); state.modal = 'waive-issue'; state.modalIssueId = el.dataset.issueId; render(); }));
        const org = document.getElementById('active-org'); if (org) org.addEventListener('change', () => setActiveOrganization(org.value));
        const search = document.getElementById('request-search'); const filter = document.getElementById('request-filter');
        const filterRequests = () => { if (!search || !filter) return; const query = search.value.toLowerCase(); const items = state.requests.filter((r) => (filter.value === 'all' || r.status === filter.value) && `${r.title} ${orgName(r.supplierOrganizationId)}`.toLowerCase().includes(query)); const list = document.getElementById('request-list'); if (list) list.innerHTML = requestTable(items); list?.querySelectorAll('[data-request-id]').forEach((el) => el.addEventListener('click', () => openRequest(el.dataset.requestId))); list?.querySelectorAll('[data-action="remind-request"]').forEach((el) => el.addEventListener('click', (event) => { event.stopPropagation(); remindRequest(el.dataset.reminderRequestId).catch((error) => notify(error.message, true)); })); };
        search?.addEventListener('input', filterRequests); filter?.addEventListener('change', filterRequests);
        document.getElementById('quality-product-select')?.addEventListener('change', (e) => { if (e.target.value) loadQuality(e.target.value); });
        document.getElementById('supply-chain-product-select')?.addEventListener('change', (e) => { if (e.target.value) loadSupplyChain(e.target.value); });
        document.getElementById('dpp-product-select')?.addEventListener('change', (e) => { if (e.target.value) { state.dppScope = 'product'; loadDpp(e.target.value); } });
        const chainLinkForm = document.getElementById('chain-link-form');
        const chainSource = chainLinkForm?.querySelector('select[name="sourceNodeId"]');
        const chainTarget = chainLinkForm?.querySelector('select[name="targetNodeId"]');
        const keepDistinctChainNodes = (changed) => {
          if (!chainSource || !chainTarget || chainSource.value !== chainTarget.value) return;
          const other = [...(changed === chainSource ? chainTarget.options : chainSource.options)].find((option) => option.value !== changed.value);
          if (other) (changed === chainSource ? chainTarget : chainSource).value = other.value;
        };
        chainSource?.addEventListener('change', () => keepDistinctChainNodes(chainSource));
        chainTarget?.addEventListener('change', () => keepDistinctChainNodes(chainTarget));
        document.getElementById('catalog-import-file')?.addEventListener('change', async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; state.catalogImport.filename = file.name; state.catalogImport.content = await file.text(); state.catalogImport.preview = null; render(); });
        document.getElementById('catalog-import-content')?.addEventListener('input', (event) => { state.catalogImport.content = event.currentTarget.value; state.catalogImport.preview = null; });
        document.getElementById('supplier-import-file')?.addEventListener('change', async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; state.supplierImport.filename = file.name; state.supplierImport.content = await file.text(); state.supplierImport.preview = null; render(); });
        document.getElementById('supplier-import-content')?.addEventListener('input', (event) => { state.supplierImport.content = event.currentTarget.value; state.supplierImport.preview = null; });
        document.getElementById('product-form')?.addEventListener('submit', (e) => { e.preventDefault(); createProduct(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('create-material-form')?.addEventListener('submit', (e) => { e.preventDefault(); createMaterial(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('create-cap-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitCapConsoleForm(e.currentTarget, 'create').catch((err) => notify(err.message, true)); });
        document.getElementById('review-cap-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitCapConsoleForm(e.currentTarget, 'review').catch((err) => notify(err.message, true)); });
        document.getElementById('cap-message-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitCapConsoleForm(e.currentTarget, 'message').catch((err) => notify(err.message, true)); });
        document.getElementById('product-detail-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveProduct(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('schema-binding-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveSchemaBinding(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('material-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveMaterial(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.querySelectorAll('.material-edit-form').forEach((form) => form.addEventListener('submit', (e) => { e.preventDefault(); saveMaterial(e.currentTarget).catch((err) => notify(err.message, true)); }));
        document.getElementById('identifier-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveIdentifier(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.querySelectorAll('.identifier-edit-form').forEach((form) => form.addEventListener('submit', (e) => { e.preventDefault(); saveIdentifier(e.currentTarget).catch((err) => notify(err.message, true)); }));
        document.getElementById('supplier-form')?.addEventListener('submit', (e) => { e.preventDefault(); inviteSupplier(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('questionnaire-builder-form')?.addEventListener('submit', (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = Object.fromEntries(new FormData(form));
          const newQ = {
            key: data.key,
            version: '1.0',
            title: data.title,
            category: data.category,
            description: data.description,
            itemCount: 4,
            requiredItemCount: data.required === 'true' ? 4 : 3,
            fields: [
              { id: `f-${Date.now()}-1`, key: 'primary_evidence', label: 'Preuve documentaire d\'audit principal', type: data.firstFieldType, required: data.required === 'true', helpText: bt('cnDocAccredited') },
              { id: `f-${Date.now()}-2`, key: 'attestation_compliance', label: bt('cnDocDeclaration'), type: 'text_short', required: true, helpText: 'Signé par le directeur d\'usine' }
            ]
          };
          state.questionnaires.unshift(newQ);
          state.modal = null;
          notify(`Protocole "${data.title}" créé et disponible pour toutes les marques.`);
          render();
        });
        document.getElementById('request-form')?.addEventListener('submit', (e) => { e.preventDefault(); createRequest(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('waive-issue-form')?.addEventListener('submit', (e) => { e.preventDefault(); waiveIssue(e.currentTarget).catch((err) => notify(err.message, true)); });
        document.getElementById('green-claim-form')?.addEventListener('submit', (e) => { e.preventDefault(); auditGreenClaims(e.currentTarget).catch((err) => notify(err.message, true)); });
      }

      async function fetchPublicConfig() {
        let lastError = new Error('config_fetch_failed');
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          try {
            const res = await fetch('/api/config', {
              signal: controller.signal,
              headers: { Accept: 'application/json' },
              cache: attempt === 0 ? 'default' : 'no-cache',
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload.error || `config_http_${res.status}`);
            if (!payload.publishableKey) throw new Error(payload.error || 'clerk_not_configured');
            return payload;
          } catch (error) {
            lastError = error instanceof Error && error.name !== 'AbortError'
              ? error
              : new Error('config_fetch_timeout');
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
          } finally {
            clearTimeout(timeout);
          }
        }
        throw lastError;
      }

      let clerkScriptPromise = null;
      function loadClerkScript(config) {
        if (window.Clerk) return Promise.resolve();
        if (clerkScriptPromise) return clerkScriptPromise;
        clerkScriptPromise = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
          s.async = true;
          s.crossOrigin = 'anonymous';
          s.setAttribute('data-clerk-publishable-key', config.publishableKey);
          if (config.proxyUrl) s.setAttribute('data-clerk-proxy-url', config.proxyUrl);
          s.onload = resolve;
          s.onerror = () => {
            clerkScriptPromise = null;
            reject(new Error('clerk_sdk_unavailable'));
          };
          document.head.appendChild(s);
        });
        return clerkScriptPromise;
      }

      async function boot() {
        if (state.demo) { await sync(); return; }
        try {
          state.configError = null;
          const config = await fetchPublicConfig();
          await loadClerkScript(config);
          state.clerk = window.Clerk;
          if (!state.clerk) throw new Error('clerk_sdk_unavailable');
          await state.clerk.load();
          state.clerk.addListener(() => { if (state.clerk.user && !state.user) sync(); });
          if (state.clerk.user) await sync(); else { state.loading = false; render(); }
        } catch (error) {
          // Never replace a failed production authentication boot with demo data.
          // Demo access remains an explicit user choice through ?demo=1.
          state.loading = false;
          state.clerk = null;
          state.configError = error instanceof Error ? error.message : 'clerk_unavailable';
          render();
        }
      }
      window.tracefabBrandConsole = { state, sync };
      // Le catalogue doit etre charge dans la langue de l'application avant
      // le premier rendu.
      (window.TF_I18N ? window.TF_I18N.setLanguage(state.lang) : Promise.resolve())
        .then(() => { i18nReady = true; }, () => { i18nReady = true; })
        .then(boot, boot);
    

      /* Gestionnaires de la page, enregistres dans la portee du module.
       * Les attributs inline etaient evalues en portee globale, ce qui
       * obligeait a exposer des fonctions sur window ; ici, state et render
       * sont directement accessibles. */
      window.TFActions.register({
        p01: function (event) { setBrandLang(this.value); },
        p02: function (event) { askIntel('Which products contain non-GOTS-certified cotton in the AW26 collection?'); },
        p03: function (event) { askIntel('Which certificates expire in the next 45 days?'); },
        p04: function (event) { askIntel('Do all garment workshops meet SMETA living-wage requirements?'); },
        p05: function (event) { askIntel('What is the readiness rate for the ESPR Digital Product Passport?'); },
        p06: function (event) { submitIntelQuery(); },
        p07: function (event) { state.view='requests';render(); },
        p08: function (event) { state.view='documents';render(); },
        p09: function (event) { state.modal='new-questionnaire';render(); },
        p10: function (event) { state.modal='new-request';state.selectedQuestionnairePreset=this.dataset.tfArg;render(); },
        p11: function (event) { state.selectedChainNode='node-fiber';render(); },
        p12: function (event) { state.selectedChainNode='node-product';render(); },
        p13: function (event) { state.selectedChainNode='node-spinning';render(); },
        p14: function (event) { state.selectedChainNode='node-mill';render(); },
        p15: function (event) { state.selectedChainNode='node-dyeing';render(); },
        p16: function (event) { state.selectedChainNode='node-assembly';render(); },
        p17: function (event) { state.view='certifications';render(); },
        p18: function (event) { state.view='suppliers';render(); },
        p19: function (event) {
          // « 12 produits incomplets » doit mener aux douze, pas au catalogue
          // entier : un indicateur qui ne conduit pas a son correctif oblige
          // l'utilisateur a refaire a la main le tri que la machine a deja fait.
          state.filtres.products = { q: '', category: '', status: '', readiness: '', incomplets: true };
          state.pages.products = 1;
          state.view = 'products';
          render();
        },
        p20: function (event) { state.view='questionnaires';render(); },
        p21: function (event) { filterRequestsByStatus('all'); },
        p22: function (event) { filterRequestsByStatus('sent'); },
        p23: function (event) { filterRequestsByStatus('submitted'); },
        p24: function (event) { filterRequestsByStatus('changes_requested'); },
        p25: function (event) { filterRequestsByStatus('approved'); },
        p26: function (event) { filterRequestsByStatus('cancelled'); },
        p27: function (event) { state.view=this.dataset.tfArg;render(); },
        p28: function (event) { render(); },
        p29: function (event) { filterIssues('all'); },
        p30: function (event) { filterIssues('critical'); },
        p31: function (event) { filterIssues('warning'); },
        p32: function (event) { filterIssues('review'); },
        p33: function (event) { filterIssues('resolved'); },
        p34: function (event) { state.view='supplyChain';render(); },
        fq: function (event) {
          state.filtres.products.q = this.value;
          // Toute modification de filtre ramene page 1 : rester page 37 d'une
          // liste qui n'en compte plus que 2 afficherait un tableau vide.
          state.pages.products = 1;
          render();
        },
        ff: function (event) {
          const champ = this.dataset.tfArg;
          if (!Object.prototype.hasOwnProperty.call(state.filtres.products, champ)) return;
          state.filtres.products[champ] = this.value;
          state.pages.products = 1;
          render();
        },
        fx: function (event) {
          state.filtres.products = { q: '', category: '', status: '', readiness: '', incomplets: false };
          state.pages.products = 1;
          render();
        },
        pg: function (event) {
          const [cle, n] = String(this.dataset.tfArg || '').split(':');
          if (!cle || !n) return;
          state.pages[cle] = Number(n);
          render();
          // Sans cela on change de page en restant au bas de l'ecran
          // precedent, et rien ne semble avoir bouge.
          const haut = document.querySelector('.table-wrap');
          if (haut) haut.scrollIntoView({ block: 'start' });
        },
      });
    })();
  
