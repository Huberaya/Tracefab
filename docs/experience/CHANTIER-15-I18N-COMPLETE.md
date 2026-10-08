# Chantier 15 — i18n complet : métadonnées localisées, extraction des textes d'interface, retrait de tr/zh

> Statut : **LIVRÉ** · Dépendance 04 déjà livrée.
> Exécuté le 2026-10-08 sur instruction utilisateur, avant les chantiers 13–14.
> Audit détaillé : `docs/experience/CHANTIER-15-AUDIT.md`.

## 1. État de départ (étape A)

- `assets/js/tf-i18n.js` est un moteur réel, en production dans les pages
  actuelles : sept langues complètes (en, fr, de, it, es, nl, pt),
  `?lang=`/stockage, bundles, `data-i18n*`, métadonnées `meta.*` et garde
  `TF_I18N_SKIP_META`.
- Environ 2 600 clés à parité stricte existaient déjà dans `en.js` + six JSON.
  Les traductions des pages/vues principales avaient été posées par les
  chantiers 03→12. L'estimation initiale « ~466 chaînes » de l'audit de base
  est historique ; ce n'était pas le nombre résiduel de chaînes après ces
  chantiers.
- `tr.json` / `zh.json` n'avaient que 412 clés (~16 %) mais le portail les
  proposait comme locales complètes ; une grande partie de l'interface
  retombait silencieusement en anglais. Des locales partielles ne sont pas
  présentées comme complètes.
- Derniers écarts vérifiés : labels, compteurs, états vides, placeholders et
  notifications résiduels dans les SPA ; fallback strings redondantes dans
  `bc/tcc/ia` ; métadonnées EN ou héritées de la landing sur plusieurs pages.

## 2. Ce qui a été livré

### 2.1 Runtime et métadonnées

- `assets/js/tf-i18n.js` prend maintenant en charge
  `window.TF_I18N_PAGE_META = { title, description }` par page ; il applique
  ces clés au boot et à chaque `setLanguage()`, sans modifier le repli global
  `meta.*`.
- Titres/descriptions localisés pour Platform, Security, Resources, About et
  Contact (`siteMeta.*`, déclaration avant le runtime).
- Métadonnées localisées pour Brand Console, Supplier Portal, Quality Center,
  Operations et Product Intelligence ; description localisée pour Accept
  Invitation. Les identités de marque dans l'entête de ces surfaces sont
  également traduites.
- Les métadonnées DPP et Supplier Passport étaient déjà gérées par
  `dpp.*` / `passport.*` via `data-i18n*` : ces mécanismes restent intacts.

### 2.2 Namespace `i18n15` — **118 clés × 7 langues**

- `siteMeta.*` : **10** clés (titre + description × 5 pages site).
- `appMeta.*` : **14** clés (métadonnées et identités de SPA).
- `console.*` : **57** clés (titres, labels, compteurs, notifications,
  placeholders, audit, import, revue, cycle de demandes, métadonnées produit).
- `portal.*` : **36** clés (labels, compteurs, invitations/token à usage
  unique, expiration, BOM, erreurs de validation, CSV, états de demande).
- `qc.*` : **1** clé (identité du Quality Center).

Source unique : `scripts/_chantier15_i18n.json` ; générateur idempotent :
`scripts/build_i18n_chantier15.mjs`.

### 2.3 Accès dans les composants

- `b15(key, vars)` dans la Brand Console ; `s15(key, vars)` dans le portail ;
  `q15(key)` dans Quality Center ; `o15(key)` dans Operations.
- Compteurs `{count}`, dates `{date}`, retours de validation `{errors}` et
  autres variables sont interpolés depuis le catalogue de la langue active.
- Les fallback literals redondants de 57 `bc()`, 35 `tcc()` et 26 `ia()` sites
  d'appel ont été retirés : leurs clés existent dans les bundles complets.
- Les noms de pays du dataset de démonstration console sont formatés par
  `Intl.DisplayNames(locale)`, au lieu d'une liste de noms français fixés.

### 2.4 Retrait de tr / zh (choix explicite permis par la roadmap)

- Options tr/zh + override `TF_I18N_SUPPORTED` retirés du portail ; tables
  `BCP47` alignées sur les sept langues.
- `assets/i18n/tr.json` et `assets/i18n/zh.json` supprimés.
- `build_app_i18n.mjs`, `build_portal_overview_i18n.mjs` et les générateurs
  i18n de namespaces ne réintroduisent plus ces locales ; les contrats des
  chantiers 04→12 vérifient leur absence.
- Le test runtime vérifie qu'une ancienne préférence `tr` retombe sur l'anglais
  par défaut, sans langue fantôme dans le sélecteur.

## 3. Fichiers et changements notables

- Runtime/pages : `assets/js/tf-i18n.js`, `brand-console/index.html`,
  `supplier-portal/index.html`, `quality-center/index.html`,
  `operations/index.html`, `product-intelligence/index.html`,
  `invitations/accept/index.html`, `passport/index.html`, cinq pages marketing.
- Catalogues : `assets/i18n/en.js` et `fr/de/it/es/nl/pt.json` mis à jour ;
  `tr.json`/`zh.json` supprimés.
- Sources, générateurs, tests et chaîne npm : voir l'audit §C et
  `scripts/test_i18n_chantier15.mjs`.

## 4. Non-régression vérifiée

- Contrats Chantiers **04, 05, 06, 07, 08, 09, 10, 11 et 12 : OK**.
- `test:brand-console`, `test:supplier-portal`, `test:i18n`,
  `test:website:chantier3`, `test:portal2:chantier6` : **OK**.
- `build_portal_overview_i18n.mjs --check` : **OK**, 17 clés × 7 langues.
- Syntaxe JavaScript des blocs inline : **OK**.
- `README.md` conserve littéralement « Notification Observability » ;
  namespaces antérieurs conservés.

## 5. Contrat et tests

`scripts/test_i18n_chantier15.mjs` (plus de 100 assertions, 9 volets) :
`TF_I18N_PAGE_META`, parité stricte **118 clés × 7 langues**, absence tr/zh
(fichiers, langues supportées, sélecteur, générateurs), extraction console,
portail, Quality Center, Operations et métadonnées des pages site, cohérence
DPP/passeport, idempotence du générateur et non-régression. **OK, stable ×3.**
Nouveau script npm : `test:i18nchantier15`, inclus dans `npm test`.

## 6. Limites assumées

- Les **données de démonstration** (noms d'organisations, SKU, lots, noms
  propres de fabricants, exemples de certificats et exemples de CSV/schema)
  restent des données d'exemple dans leur langue source ; elles ne sont pas
  présentées comme une traduction métier ou une donnée réelle. Les noms de
  pays dans les agrégats console, eux, suivent la locale.
- Les endonymes du sélecteur (« Français », « Português »…) restent dans leur
  forme universelle.
- `src/app` (Next.js, futur renderer public arbitré au chantier 14) n'a pas
  reçu de moteur i18n dans ce chantier : ne pas lui attribuer une prise en
  charge multilingue avant son chantier.
- Les mots-clés multilingues de TRACEFAB Intelligence restent des données de
  matching, pas du texte affiché.

## 7. Suite

- Chantiers **13** (DPP Readiness actionnable) et **14** (Public Passport
  dynamique, incluant `src/app`) restent à faire.
- Pour réintroduire tr/zh : traduire intégralement les catalogues requis et
  ajouter une parité automatisée AVANT de réexposer une option de langue.

## 8. TRACEFAB WORLD-CLASS SCORE — checkpoint provisoire

> Ce score est un **instantané**, pas la validation finale du programme : les
> chantiers 13–14 et 16–19 ne sont pas exécutés. Moyenne arithmétique simple
> des 19 dimensions ; domaines évalués selon leur état courant, non selon les
> seuls livrables du chantier 15.

| Dimension | /100 | Justification courte |
|---|---:|---|
| Architecture | 76 | Socle multi-tenant solide ; arbitrage SPA/Next, pagination et rate limiting restent ouverts. |
| UX/UI | 70 | Shell/design system et vues métier améliorés ; densité et cohérence cross-surface à poursuivre. |
| Brand Console | 82 | Nombreuses vues branchées aux APIs ; qualité d'ensemble bonne, bulk/saved views et monolithe restant. |
| Supplier Portal | 80 | Parcours mobile et données réels ; wizard complet et gestion de partages restent incomplets. |
| Products | 82 | Données/révisions et intelligence produit ; variantes et médias manquent. |
| Supply Chain | 80 | Graphe, carte, API et dossiers de nœuds livrés ; profondeur géographique/données amont limitée. |
| Data Collection | 82 | Cycle demande→réponse→revue réel ; segmentation/templates restent limités. |
| Evidence | 80 | Centre unifié et accès privés ; prévisualisation et raccordements staging restent à valider. |
| Certifications | 82 | Santé et revue actionnable ; vérification externe automatique non revendiquée. |
| Quality | 80 | Score explicable et actions renforcés ; tendances et drill-downs restent à compléter. |
| DPP Readiness | 64 | Calcul readiness versionné existe ; écran manquant-orienté du Chantier 13 reste à faire. |
| Public Passport | 52 | Pages et données d'exemple existent ; raccordement dynamique du Chantier 14 reste à faire. |
| AI / Intelligence | 82 | Questions déterministes sourcées, zéro LLM ; couverture volontairement limitée à six intentions. |
| Security | 78 | RLS/auth solides ; CSP, rate limiting et pagination restent des dettes. |
| i18n | 94 | 7 locales complètes, 118 nouvelles clés, métadonnées localisées ; `src/app` reste à arbitrer au Chantier 14. |
| Performance | 56 | Pages statiques légères ; vues monolithiques, pagination et lazy loading à traiter. |
| Tests | 78 | Contrats offline nombreux ; CI et E2E staging complets manquent, quatre suites restent dépendantes de Prisma/DB. |
| Production Readiness | 56 | Déploiement configuré ; stockage/scanner/alerting de production et runbooks à exécuter. |
| Commercial Readiness | 58 | Parcours web/leads existent ; pilote 10 fournisseurs / 20 produits, packaging et collateral restent à bâtir. |
| **TRACEFAB WORLD-CLASS SCORE (checkpoint)** | **74/100** | Bon socle produit, mais readiness DPP/public passport, production et commercial empêchent encore de le qualifier de plateforme world-class complète. |

La note **94/100 i18n** porte sur les surfaces couvertes par les catalogues
actuels ; elle ne signifie pas que le renderer Next.js `src/app` est traduit.
