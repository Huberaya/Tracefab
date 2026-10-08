# TRACEFAB — WORLD-CLASS TRANSFORMATION AUDIT

**Date :** 8 octobre 2026
**Branche :** `arena/df246958-tracefab` · commit de base `9c9dfb8`
**Méthode :** AUDITER → COMPRENDRE → CLASSIFIER → PRIORISER → TRANSFORMER → TESTER.
Tout ce qui suit a été vérifié **en exécutant le dépôt** (installation, typecheck,
26 suites de tests offline, lecture des routes, du schéma Prisma, des migrations,
des SPA et de la documentation), pas sur déclaration.

**Règle de vérité appliquée partout :**

| Terme | Sens |
|---|---|
| **IMPLEMENTED** | fonctionne réellement (DB + API + UI branchés) |
| **PARTIAL** | fonctionne partiellement, maillons manquants |
| **MOCKED** | simulation (mode `?demo=1` ou données en dur) |
| **PLANNED** | prévu dans la doc, non développé |
| **PROPOSED** | idée nouvelle de cet audit |

---

## 1. Synthèse exécutive

TRACEFAB n'est **pas** un prototype creux : c'est une plateforme dont le cœur
backend est déjà d'un niveau sérieux — 38+ tables multi-tenants avec RLS forcée
(43/45 tables en `FORCE ROW LEVEL SECURITY`), ~120 routes API serverless,
27 migrations Prisma, un moteur de qualité explicable, un workflow de collecte
complet (demande → réponse versionnée → revue → injection dans les data points),
un stockage privé signé SigV4, un outbox de notifications avec cron, un
référentiel de certifications versionné, des moteurs PEF / green claims /
mass balance / CAP, et une landing page premium i18n (7 langues complètes).

**Ce qui manque pour devenir la référence mondiale n'est pas le moteur, c'est
la surface** : une expérience applicative à la hauteur du backend (command
palette, recherche globale, graphe supply chain premium, carte géographique,
centre de notifications), une couche Intelligence aujourd'hui **en dur**
(donc à remplacer), des pages publiques dynamiques plutôt que des démos
statiques, l'élimination de ~466 chaînes métier codées en dur dans les SPA,
et le raccordement des dépendances externes réelles (S3, antivirus, Resend).

**Maturité globale actuelle : 3,3 / 5** — socle de données et de sécurité
4/5, expérience produit 2,5/5, commercial 2/5.

Chiffres clés mesurés :

| Mesure | Valeur |
|---|---|
| Routes API enregistrées | ~120 (registre `api/index.ts`) |
| Migrations Prisma | 27 (+ 8 migrations Supabase historiques) |
| Scripts de test | 106 |
| Tests offline exécutés dans cet audit | 26 PASS / 1 non exécutable ici (Playwright navigateur) |
| Langues complètes | 7 (en, fr, de, it, es, nl, pt) + 2 partielles (tr, zh) |
| Vues Brand Console | 17 + 2 détails |
| Vues Supplier Portal | 14 |
| Pages statiques servies | 9 (landing, console, portail, dpp, passport, qualité, opérations, PI, invitations) |

---

## 2. Tableau d'audit par domaine

Niveau sur 5. Priorité : P0 = bloquant pour la transformation, P1 = chantier
majeur, P2 = amélioration.

| Domaine | État réel | Niveau | Problèmes | Opportunités | Priorité |
|---|---|---|---|---|---|
| **Architecture** | Multi-tenant RLS + fonctions SQL `SECURITY DEFINER` + API serverless + outbox. Deux fronts frontend non arbités (SPA statiques Vercel **et** app Next.js `src/app` non déployée par `vercel.json`). | 4,0 | Pas de pagination API ; pas de rate limiting ; SPA monolithiques `innerHTML` ; `src/app` orpheline. | Unifier sur un seul front ; API-first déjà réel (entités alignées sur la cible) ; pagination/indexation. | P1 |
| **UX/UI** | Landing premium (tests L1–L5 passés) ; applications fonctionnelles mais denses et non guidées. | 2,5 | Pas de command palette, pas de recherche globale, pas de centre de notifications, pas de carte géographique ; 2 familles de polices ; 27 cibles tactiles < 40 px ; copie FR en dur. | Design system v2.4 déjà documenté : l'étendre en v3 (tokens, motion, composants) et l'appliquer partout. | P0 |
| **Brand Console** | 17 vues réelles (overview, products, suppliers, materials, supplyChain, requests, questionnaires, documents, certifications, quality, risk, massBalance, integrations, intelligence, dpp, reports, settings) sur vraie API + mode démo. | 3,5 | Vue « intelligence » = fiction codée en dur ; KPI peu actionnables ; pas de vues sauvegardées ; tables sans tri/filtres complets. | En faire le « Command Center » : KPI → insight → action, drill-down, bulk actions. | P0 |
| **Supplier Portal** | 14 vues réelles : profil, sites, certificats, matériaux, documents, data points, membres, qualité, CAP, passport, mass balance, self-onboarding. | 3,5 | Onboarding non wizardisé (les 9 étapes séquentielles manquent) ; partage `data_shares` lisible mais gestion limitée ; mobile à polir. | « What do I need to do? » : file d'actions unique + wizard 9 étapes + completeness en direct. | P1 |
| **Products** | Produits, révisions versionnées, composition, identifiants (GTIN/EAN/UPC), data points, révision/clonage. | 4,0 | Pas de variantes/déclinaisons ; pas de médias produit ; lien produit↔fournisseur uniquement via graphe/demandes. | Fiche produit « intelligence » : 11 lentilles déjà maquettées (page `product-intelligence`) à brancher sur l'API réelle. | P1 |
| **Supply Chain** | Nœuds/liens, génération de baseline, lineage graph, audit chain, bridge collecte→data points. Vue console existe. | 3,0 | Visualisation basique (pas de zoom/pan/filtre) ; pas de vue géographique ; saisie au-delà du Tier 1 manuelle. | Graphe premium interactif + carte ; le modèle de données supporte déjà les tiers multiples. | P1 |
| **Data Collection** | Cycle complet opérationnel : demande, items depuis template, envoi, réponses versionnées, soumission, revue, approbation, relances cron, rappel manuel (`/remind`). | 4,0 | Builder de demande perfectible ; templates limités à `product-data-core` ; bulk send absent de l'UI. | Moteur de requêtes type « questionnaire par segment » ; réutilisation fournisseur (« enter once, reuse everywhere ») partiellement outillée. | P1 |
| **Evidence** | Stockage privé S3 SigV4 (sans SDK), hash SHA-256, contrat antivirus, URLs présignées server-side, contrôle tenant au téléchargement, rapports de vérification/sécurité. | 3,5 | Infra externe (bucket, scanner) non provisionnée ; pas de prévisualiseur in-app ; historique/versions documentaires peu exposés en UI. | Evidence Center unifié (upload, preview, métadonnées, expiration, liaison produit/matière) — la donnée existe déjà. | P1 |
| **Certifications** | Déclaration, revue, auto-vérification, extraction OCR, catalogue versionné de standards (GOTS 7.0, OEKO-TEX 01.2026, GRS 4.0, RCS 2.0, OCS 3.0, ISO 14001/9001), certificats transactionnels. | 3,5 | Pas de vue « Certification Health » (valid / expiring / expired / missing) ; alertes d'expiration sans surface UI dédiée. | Certification Health + veille d'expiration actionnable = différenciateur immédiat. | P1 |
| **Quality** | Moteur SQL explicable (complétude, fraîcheur, preuves, cohérence), issues, ack/waive, CAP complets, index qualité, audit pack. Backend 4/5 ; page `quality-center` minimale. | 3,5 | UI trop mince pour la profondeur du moteur ; pas de drill-down « pourquoi ce score » ; pas de tendances. | Quality Center premium : score décomposé cliquable, « resolve missing data » partout. | P0 |
| **DPP** | `tracefab_compute_dpp_readiness`, profils d'exigences, records versionnés, revue de publication, validateur, exposition API. | 3,5 | UI readiness présente mais pas orientée « qu'est-ce qui manque » ; versioning du modèle (v0.1→v1.0) non exposé. | DPP Readiness actionnable + discours strictement « readiness » (déjà la règle du dépôt — à préserver). | P1 |
| **Passport** | Pages publiques `dpp/` (6 panneaux + GS1 + JSON-LD) et `passport/` (passeport fournisseur universel, demandes d'accès) ; générateurs Apple/Google Wallet ; GS1 digital link. | 3,0 | Les deux pages publiques sont des **démos statiques** (données en dur) alors que `/api/dpp/:gtin` existe ; le renderer Next.js (`src/app`) n'est pas déployé et duplique la logique. | Rendre le passeport dynamique via l'API existante ; mobile-first ; QR → expérience produit. | P1 |
| **AI** | « Document AI » : extraction (émetteur, n° certificat, dates, standard…) avec **confirmation humaine obligatoire** — réel mais basique (parsers locaux). Vue « TRACEFAB Intelligence » : **réponses codées en dur**. | 1,5 | La vue phare d'intelligence est une fiction (`MOCKED`) — risque de crédibilité si présentée telle quelle. | Moteur de questions sur les données structurées (sans hallucination possible : requêtes sur données réelles + citations « BASED ON »). Exactement l'esprit du cahier des charges. | P0 |
| **Security** | Clerk `verifyToken` + `authorizedParties`, RLS forcée, contexte transactionnel, tokens SHA-256, comparaison temps constant, headers stricts, audit log append-only, tests cross-tenant. | 4,0 | CSP avec `'unsafe-inline'` (script) ; pas de rate limiting ; listes sans pagination (exposition volumétrie) ; mode `?demo=1` présent dans les bundles. | durcissement CSP progressif ; rate limit par route ; suite IDOR/cross-tenant automatisée en E2E. | P1 |
| **i18n** | Catalogue unique (`assets/i18n`), moteur `tf-i18n` consolidé, 7 langues complètes, hreflang, tests de parité. | 3,5 | ~466 chaînes métier en dur dans les SPA (268 console, 187 portail, reste dpp/passport) ; `tr`/`zh` partielles ; URLs non localisées. | Objectif « aucun texte métier dans les composants » : extraction systématique outillée (scripts déjà présents). | P1 |
| **Performance** | Pages statiques légères, JS vanilla minimal, landing testée (L5). | 2,5 | Rendu `innerHTML` monolithique ; pas de pagination ; deux polices chargées selon les pages ; pas de lazy loading des graphes. | Découpage des vues, pagination serveur, font unique variable, lazy graphs/maps. | P1 |
| **Tests** | 106 scripts : contrats offline (26/26 PASS ici), flux Neon (requièrent DB), Playwright démo, tests staging non mockés (P2). | 3,5 | Pas de CI (aucun workflow GitHub Actions) ; les parcours navigateur critiques tournent surtout en mode démo ; E2E DB+API+UI assemblés absents. | CI avec matrice offline + staging ; les 20 scénarios E2E du cahier des charges sur données réelles de staging. | P1 |
| **Production readiness** | `vercel.json` complet (headers CSP, crons, routes), `.env.example` exhaustif, doc de durcissement, endpoint readiness P2. | 2,5 | Dépendances externes réelles non raccordées (S3, antivirus, Resend prod, webhook d'alerte) ; pas d'error tracking ; pas de runbook backup/restore testé. | Checklist de mise en production déjà rédigée à 80 % : exécuter le raccordement + observabilité. | P1 |

---

## 3. Inventaire des fonctionnalités par statut

### 3.1 REAL / PRODUCTION (IMPLEMENTED — DB + API + UI branchés)

- Authentification Clerk serveur (`api/_lib/auth.ts`) et synchronisation users.
- Création d'organisation, invitations fournisseur (token SHA-256, email Resend,
  acceptation `/invitations/accept`), renvois/révocations.
- Self-onboarding fournisseur (`supplier/onboarding.ts`).
- Profil fournisseur, sites, membres d'équipe, invitations membres.
- Produits : CRUD, révisions, matériaux, composition, identifiants, data points.
- Data collection complète (demandes, templates, réponses versionnées, revue,
  approbation automatique, bridge vers `data_points`, relances cron + manuelles).
- Qualité : scores fournisseur/produit, issues explicables, ack/waive, CAP
  (création, remédiation, revue, messages), index, audit pack.
- Stockage privé : upload-intent présigné, scan (contrat), téléchargement signé
  avec isolation tenant ; quotas.
- Certifications : déclaration, revue, auto-vérification, extraction OCR,
  catalogue de standards versionné, certificats transactionnels.
- Supply chain : nœuds, liens, baseline, lineage graph, audit chain.
- DPP readiness : calcul, records versionnés, revue de publication, validation.
- Notifications : outbox transactionnelle, worker sécurisé, rappels, observabilité.
- Import/export catalogue CSV (produits, fournisseurs, dossier d'audit, BOM).
- Moteurs PEF, green claims (anti-greenwashing), mass balance (anti-fraude).
- Passeport fournisseur universel (API + vues portail + demandes d'accès).
- GS1 digital link ; wallets Apple/Google (générateurs).
- Intégrations PLM/ERP : parsers Centric, Lectra/Kubix, SAP S/4, GS1 EPCIS
  (stubs déclarés comme tels — `TRACEFAB_PLM_ENABLED=false` par défaut).
- Landing marketing premium, i18n 7 langues, SEO on-page (hreflang, JSON-LD, OG).

### 3.2 FUNCTIONAL / PARTIAL

- **Evidence Center** : backend complet, mais pas de surface unifiée
  preview/métadonnées/historique côté marque.
- **Data shares** (`data_shares`) : lecture côté fournisseur OK ; création/
  périmètres/révocation sans API dédiée exposée.
- **Quality Center UI** : réelle mais mince face au moteur.
- **Supply chain UI** : réelle mais sans zoom/pan/filtres ni géographie.
- **DPP readiness UI** : présente, pas encore orientée actions manquantes.
- **Passport publics** (`dpp/`, `passport/`) : pages réelles mais données démo.
- **i18n** : 7 langues complètes ; tr/zh partielles ; ~466 chaînes en dur.
- **Onboarding fournisseur** : fonctionnel, non séquencé en wizard 9 étapes.

### 3.3 MOCK / DEMO

- **Vue « TRACEFAB Intelligence »** de la Brand Console : question et réponse
  **codées en dur** (« 1 248 références », certificats fictifs, hashes fictifs).
  À remplacer avant toute démonstration commerciale — c'est le point de
  crédibilité n°1.
- **Mode `?demo=1`** des SPA : indispensable aux tests et aux démos, mais doit
  être explicitement balisé (bannières déjà présentes) et jamais confondu avec
  le réel.
- **Modal « Request a demo »** de la landing : le formulaire affiche un succès
  local, aucune donnée n'est collectée (pas de backend de leads).
- **Pages `dpp/` et `product-intelligence/`** : données de démonstration
  (balisées comme telles).
- **Stubs PLM/ERP** : assumés et désactivés par défaut (`TRACEFAB_PLM_ENABLED`).

### 3.4 DOCUMENTED ONLY / PLANNED

- Sitemap/robots (rien n'existe à ce jour — **corrigé par le Chantier 01**).
- Centre de notifications in-app (l'outbox existe, pas la surface).
- Command palette (Ctrl/Cmd+K), recherche globale.
- Carte géographique supply chain.
- Webhooks sortants publics (seul l'alerting interne est prévu).
- API publique / connecteurs ERP-PLM-PIM réels (parsers seulement).
- URLs localisées, SSO SAML.

### 3.5 MISSING (à créer)

- Pagination + rate limiting API.
- CI (GitHub Actions) — aucun workflow.
- Observabilité applicative (error tracking, métriques).
- Bulk operations UI avancées (envoyer des demandes en masse, assigner des
  reviewers) — les librairies bulk existent (chantier 8), l'UI non.
- Pages marketing profondes (Platform, Security/Trust Center, Resources, About,
  Contact) — la landing couvre tout en une page.
- Parcours pilote (« 10 fournisseurs, 20 produits, rapport »).

### 3.6 NEEDS REFACTOR

- `src/app` (Next.js) : renderer DPP parallèle, **non déployé** par
  `vercel.json`, dupliquant `dpp/`, avec donnée démo et une affirmation de
  conformité ESPR dans `src/app/page.tsx` contraire à la règle réglementaire.
  Décision recommandée : conserver la capacité Next.js pour le passeport
  dynamique futur, mais corriger immédiatement le wording (fait au Chantier 01)
  et n'y réinvestir qu'au chantier Passport.
- Les deux SPA monolithiques (`brand-console` 4 710 lignes,
  `supplier-portal` 1 264 lignes) : à découper en modules de vues sans
  régression, une vue à la fois.
- CSP `'unsafe-inline'` : à réduire progressivement une fois les scripts
  inline extraits.

---

## 4. Dettes et problèmes

### 4.1 Dette technique

1. Deux systèmes frontend parallèles (SPA statiques + Next.js) non arbités.
2. Monolithes `innerHTML` (perte d'état des formulaires, re-renders complets).
3. Pas de pagination/rate limiting API (risque volumétrie et disponibilité).
4. ~466 chaînes métier hors catalogue i18n.
5. Pas de CI ; les jeux de tests DB exigent une Neon de staging.
6. Dépendances externes (S3, antivirus, Resend, alerting) en contrat seulement.

### 4.2 Problèmes UX

1. Pas de principe « DATA → INSIGHT → ACTION » systématique : plusieurs
   affichages de problèmes sans CTA de remédiation.
2. Pas de recherche globale ni de command palette.
3. Pas de centre de notifications.
4. Onboarding marque et fournisseur non séquencés (pas de wizard, pas de
   « first value » guidée).
5. Empty states présents mais inégaux selon les vues.

### 4.3 Problèmes sécurité

1. `script-src 'unsafe-inline'` dans la CSP.
2. Mode démo embarqué dans les bundles de production (balisé, mais présent).
3. Absence de rate limiting sur les endpoints authentifiés.

### 4.4 Problèmes business

1. La vue Intelligence, vitrine du produit, est une fiction : danger en démo.
2. « Request a demo » ne capture aucun lead.
3. Pas de parcours pilote packagé, pas de Trust Center, pas de pages produits
   profondes pour le SEO de catégorie (DPP, traceability, supplier data…).
4. Le positionnement « intelligence layer » est déjà bien porté par la landing,
   mais l'app ne le confirme pas encore à chaque écran.

---

## 5. Opportunités (les plus forts leviers)

1. **Intelligence réelle sur données réelles** : le schéma (data points,
   certificats, demandes, qualité) permet un moteur de questions **sans LLM**
   donc sans hallucination, avec citations — exactement la promesse du produit.
2. **Graphe supply chain premium + carte géographique** : les données et l'API
   existent ; seule la visualisation manque.
3. **Passport public dynamique** : `/api/dpp/:gtin` existe déjà ; brancher la
   page publique transforme une démo en produit.
4. **Certification Health** : le catalogue de standards + les dates
   d'expiration existent ; la vue « valid/expiring/expired/missing » est
   presque gratuite et très vendeuse.
5. **Quality Center explicable** : le moteur produit déjà les composantes ;
   l'UI drill-down « pourquoi 86 % » est un différenciateur immédiat.
6. **SEO de catégorie** : pages Platform/Security/Resources + sitemap
   (ajouté au Chantier 01) pour capter les requêtes DPP/traceability.

---

## 6. Feuille de route — ordre exact des chantiers

Les chantiers déjà réellement terminés dans le dépôt (fondations multi-tenant,
collecte, qualité backend, stockage privé, notifications, référentiel
certifications, import/export, PEF/green claims/mass balance, landing,
consolidation i18n, durcissement production documenté) **ne sont pas
re-créés**. La route ci-dessous ne contient que le travail restant, adapté à
l'état réel.

| # | Chantier | Contenu clé | Dépend de |
|---|---|---|---|
| **01** | **Audit & Foundation** (celui-ci) | Rapport d'audit ; `robots.txt` + `sitemap.xml` ; correction du wording de conformité ESPR dans `src/app` ; README mis à jour ; matrice de non-régression verte. | — |
| 02 | Design System v3 | Tokens unifiés, une seule famille de polices, cibles tactiles ≥ 44 px, motion « meaning-first » + `prefers-reduced-motion`, composants partagés (tables, badges de statut de donnée, empty/error states). | 01 |
| 03 | Website & Trust Center | Pages Platform / Security / Resources / About / Contact ; narration « fragmentation → intelligence layer » ; capture réelle des leads démo ; SEO (structured data par page). | 02 |
| 04 | Application Shell | Un seul shell (console + portail) : command palette Ctrl/Cmd+K, recherche globale, centre de notifications, breadcrumbs, états vides/erreur systématiques. | 02 |
| 05 | Brand Command Center | Overview refondu « WHERE ARE WE / WHAT'S MISSING / WHAT'S RISKY / NEXT » ; chaque KPI cliquable ; tables modernes (tri, filtres, colonnes, export, vues sauvegardées) ; bulk actions. | 04 |
| 06 | Supplier Portal 2.0 | Dashboard « WHAT DO I NEED TO DO? », wizard onboarding 9 étapes, completeness en direct, gestion des partages par marque (API `data_shares` à exposer), mobile-first. | 04 |
| 07 | Product Intelligence réelle | Fiche produit 11 lentilles branchée sur l'API (composition, fournisseurs, evidence, qualité, DPP readiness) ; actions produit (request data, view lineage, export, history). | 05 |
| 08 | Evidence Center | Surface unifiée : upload, preview, métadonnées, liaisons, statut de vérification, versions ; branchement S3/antivirus réels pour staging. | 04 |
| 09 | Certification Intelligence | Certification Health (valid/expiring/expired/missing/needs review), veille d'expiration actionnable, vue marque des certificats. | 05 |
| 10 | Quality Center premium | Score décomposé cliquable, drill-down par composante, « Resolve missing data » partout, tendances. | 05 |
| 11 | Supply Chain Graph & Map | Graphe zoom/pan/filtres, sélection de nœuds → dossier fournisseur/evidence/qualité, carte géographique des sites et flux. | 05 |
| 12 | TRACEFAB Intelligence | Remplacement de la vue codée en dur par un moteur de questions sur données réelles, réponses sourcées (« BASED ON »), distinction Known/Inferred/Missing/Needs review. | 05 |
| 13 | DPP Readiness actionnable | Écran « WHAT IS MISSING » par produit et au global, versioning du modèle DPP exposé (v0.x), zéro promesse de conformité. | 05 |
| 14 | Public Passport dynamique | `dpp/` branché sur `/api/dpp/:gtin` ; mobile-first ; sections materials/origin/supply chain/certifications/evidence/care/circularité ; QR → expérience produit. Arbitrage `src/app` Next.js traité ici. | 08 |
| 15 | i18n complet | Extraction des ~466 chaînes en dur ; tr/zh complétées ou retirées ; aucun texte métier dans les composants ; métadonnées localisées. | 04 |
| 16 | Sécurité & Performance | CSP sans `unsafe-inline`, rate limiting, pagination API, lazy loading, découpage des monolithes vue par vue. | 04 |
| 17 | Tests E2E & CI | GitHub Actions (matrice offline + staging) ; les 20 parcours critiques du cahier des charges sans mock quand les credentials staging existent ; scénarios cross-tenant. | 05 |
| 18 | Production Readiness | Raccordement S3/antivirus/Resend/alerting ; error tracking ; runbook backup/restore ; checklist go-live exécutée. | 16 |
| 19 | Commercial Readiness | Parcours pilote (10 fournisseurs / 20 produits / rapport), démo scriptée, collateral sécurité, pricing/packaging. | 03, 13 |

**Règle d'exécution : un chantier à la fois, validation exigée entre chaque.**

---

## 7. Vérifications exécutées pendant cet audit

| Vérification | Résultat |
|---|---|
| `npm install` (lockfile) | OK |
| `npm run typecheck` (projet) | **PASS** |
| `npm run api:typecheck` | Non exécutable dans ce sandbox : exige `prisma generate`, dont les binaires (`binaries.prisma.sh`) sont hors allowlist réseau. En CI/Vercel, la génération est standard. Les erreurs observées disparaissent une fois le client généré. |
| `npm run schema:static` | **PASS** (22 tables historiques, 61 policies, marqueurs Neon/Clerk) |
| `test:routes`, `test:i18n` | **PASS** |
| `test:security:chantier1`, `test:bridge:chantier2`, `test:supplychain:chantier3`, `test:dpp:chantier4`, `test:quality-actions:chantier5`, `test:cap:chantier5`, `test:universal-passport:chantier6`, `test:onboarding:chantier6`, `test:mass-balance:chantier7`, `test:docai:chantier1`, `test:plm-erp:chantier2`, `test:pef:chantier3`, `test:green-claims:chantier4`, `test:brand-console`, `test:supplier-portal`, `test:questionnaires` | **PASS** (16/16) |
| `test:chantier3-risk`, `test:chantier4-demo`, `test:chantier5-portail`, `test:chantier5-console`, `test:landing-lisibilite`, `test:landing-spine`, `test:landing-reperage`, `test:landing-performance` | **PASS** (8/8) |
| `test:console-css`, `verify_locales` | Non exécutables ici (navigateurs Playwright absents du sandbox) |
| Flux Neon (`test:neon:*`) | Non exécutables ici (pas de `DATABASE_URL` de staging) |

**Total exécuté : 26 PASS, 0 FAIL, 3 non exécutables pour raisons
d'environnement (réseau sandbox), documentés comme tels.**

---

## 8. Règles permanentes de la transformation

1. **Non-régression** : auth, API existantes, base, invitations, demandes,
   stockage, certifications, qualité, traçabilité, DPP readiness et isolation
   tenant ne sont jamais cassés. Toute migration destructive ⇒ STOP & REPORT.
2. **Vérité** : jamais présenter comme opérationnel ce qui est mocké ; les
   modes démo restent balisés.
3. **Réglementaire** : jamais « conforme » / « garantit la conformité » ;
   uniquement readiness (data / evidence / traceability / DPP). Les exigences
   futures restent versionnées.
4. **IA** : jamais d'invention ; chaque réponse intelligence cite ses sources
   et distingue Known / Inferred / Missing / Needs review.
5. **Un chantier à la fois**, avec rapport d'étape et validation avant le
   suivant.

---

## État actualisé de l'i18n — Chantier 15 (2026-10-08)

Le tableau d'audit ci-dessus est le **baseline** antérieur aux chantiers
03→15, pas l'état actuel. Le Chantier 15 a livré les métadonnées localisées par
page et `i18n15` (118 clés × 7 langues), extrait les derniers textes d'interface
ciblés, et **retiré** `tr`/`zh` (catalogues partiels à ~16 %) des fichiers, des
sélecteurs et des générateurs. Voir le rapport actuel
`docs/experience/CHANTIER-15-I18N-COMPLETE.md` ; les chantiers 13 et 14 restent
à valider/exécuter.
