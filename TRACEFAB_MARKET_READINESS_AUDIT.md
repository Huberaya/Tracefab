# TRACEFAB — MARKET READINESS AUDIT
## Audit Produit, Technique, UX/UI, Données, Sécurité et Plan de Finalisation Commerciale

**Date de l'audit :** 6 octobre 2026  
**Repository audité :** [Huberaya/Tracefab](https://github.com/Huberaya/Tracefab)  
**Rôle d'audit :** Lead Software Architect, Senior Full-Stack Developer, Product Manager SaaS B2B, UX/UI Designer Senior, Data Architect, Security Engineer, Fashion Tech & DPP Expert  
**Statut global :** Prototype avancé / Fondations techniques solides — Incomplet pour commercialisation immédiate  
**Maturité globale :** **2.4 / 5** (Prototype fonctionnel sur le coeur collecte/profil, avec ruptures critiques sur la chaîne Supply Chain / DPP / Data Points)

---

## SOMMAIRE EXÉCUTIF (EXECUTIVE SUMMARY)

### 1. Synthèse globale
Le projet **TRACEFAB** a été conçu avec une ambition claire et différenciante : devenir une **infrastructure de données B2B pour la supply chain textile**, axée sur la collecte, la structuration, la qualification et la traçabilité des données fournisseurs en vue du Digital Product Passport (DPP), et non un simple générateur de QR codes ou un dashboard cosmétique.

L'analyse intégrale du repository révèle une **dualité marquée** :
1. **Un socle de conception et de base de données d'un très bon niveau conceptuel :**
   - Schéma relationnel PostgreSQL / Prisma riche (25 tables, contraintes strictes, enums précis, statuts de qualification de données fins).
   - Fonctions SQL stockées (`SECURITY DEFINER`) encadrant les transitions sensibles du cycle de vie fournisseur, produit, collecte, qualité, outbox notifications.
   - Système de notification transactionnelle avec table Outbox (`tracefab_notification_outbox`), idempotence, gestion des relances et worker dédié.
   - Intégration S3 avec calcul de signature SigV4 natif sans SDK lourd pour le stockage privé des preuves.
   - Gestion fine des identités Clerk synchronisées dans PostgreSQL avec contexte de transaction (`withTracefabUserContext`).
2. **Des ruptures d'architecture logicielle majeures et des maillons manquants bloquants pour la commercialisation :**
   - **Rupture critique de la chaîne de données :** Les réponses aux questionnaires (`data_responses`) vérifiées par la marque ne sont **jamais injectées** dans les `data_points` du produit ni dans le graphe de traçabilité.
   - **Le moteur de qualité produit est bloqué par conception :** La fonction SQL `tracefab_compute_product_quality` exige que des `data_points` soient rattachés au produit (`WHERE product_id = p_product_id`). Or, **aucun endpoint d'API n'existe** pour rattacher un point de donnée à un produit (l'API fournisseur restreint les points aux `supplier` et `site`, et l'API marque ne gère aucun data point direct). Tout produit calculé génère donc obligatoirement un finding bloquant `product_no_data_points`.
   - **Traçabilité & DPP non exposés :** Les tables et fonctions SQL du graphe de traçabilité (`tracefab_get_product_traceability`, etc.) et du DPP (`tracefab_compute_dpp_readiness`) existent dans les migrations SQL mais **n'ont aucun endpoint d'API dans `api/` et aucune interface utilisateur** dans le Brand Console ou le Supplier Portal.
   - **Faiblesse de sécurité multi-tenant :** Bien que PostgreSQL RLS soit activé, les tables n'ont pas `FORCE ROW LEVEL SECURITY`. Les requêtes exécutées par Prisma via l'utilisateur `neondb_owner` (propriétaire de la base) **court-circuitent les RLS policies**. Sur certains endpoints comme `/api/documents/:documentId/download`, aucun contrôle d'appartenance tenant n'est réalisé au niveau applicatif, ouvrant une faille de téléchargement inter-organisations sur simple UUID.
   - **Frontends monolithiques en vanilla JS dans des fichiers HTML uniques :** `brand-console/index.html` (69 Ko) et `supplier-portal/index.html` (86 Ko) réécrivent l'intégralité du DOM via `innerHTML`, détruisant le state des formulaires, sans framework réactif moderne, et reposent sur un mode `?demo=1` pour leurs tests Playwright.
   - **Onboarding fournisseur autonome impossible :** Un fournisseur qui se connecte via Clerk sans invitation active préalable se heurte à une erreur bloquante `supplier_organization_not_found`, sans écran de création d'organisation.
   - **Contrôles de partage (`data_shares`) inexistants dans l'API et l'UI :** La promesse fournisseur de "renseigner ses données une fois et contrôler ce qu'il partage par marque" est codée en base mais totalement inactive.

---

## 2. RAPPORT DE MATURITÉ (NOTATION 0 À 5)

| Domaine | Note (/5) | Niveau | Justification détaillée |
| :--- | :---: | :--- | :--- |
| **Authentication** | **3.5** | Fonctionnel mais incomplet | Clerk configuré côté serveur et client. Synchronisation automatique des utilisateurs en base. Manque : gestion multi-comptes, SSO SAML pour grands comptes, flux d'invitation sans Clerk préalable, et suppression du fallback demo en prod. |
| **Multi-tenancy** | **2.5** | Prototype fragile | Modélisé en base avec RLS et fonctions de vérification des rôles. Contexte injecté via `tracefab.user_id`. **Faiblesse critique :** Absence de `FORCE RLS` sous `neondb_owner`, bypass possible sur requêtes directes Prisma, et absence d'API/UI pour `data_shares`. |
| **Brand Console** | **2.5** | Prototype | Monolithe HTML/JS. Gère création produit, révision, composition, identifiants, invitation fournisseur, demandes de données, revue d'items, affichage score qualité. **Manque :** Vues Supply Chain Graph, DPP Readiness, gestion documentaire, qualification et relances fournisseurs. |
| **Supplier Portal** | **2.5** | Prototype | Monolithe HTML/JS. Gère profil, sites, certificats déclarés, matériaux, preuves, données fournisseur/site, équipe, réponses aux demandes. **Manque :** Onboarding autonome, vue produits, sélection du périmètre de partage par marque, upload direct dans les items. |
| **Supplier onboarding** | **3.0** | Fonctionnel mais incomplet | Parcours sur invitation sécurisé par token SHA-256 avec livraison email Resend. Validation des champs de profil et contrainte sur site actif. **Manque :** Inscription libre de fournisseur, validation des registres légaux (VIES/SIRET), import d'organisations. |
| **Product management** | **3.5** | Fonctionnel mais incomplet | Création, mise à jour, révision avec incrémentation de version, rattachement de matières avec pourcentages, identifiants multiples (GTIN, EAN, UPC, interne). **Manque :** Import/export CSV, déclinaisons/variantes, médias/photos, arborescence de catégories. |
| **Material management** | **3.0** | Fonctionnel mais incomplet | Création de matériaux avec composition JSON et pays d'origine. Association produit versionnée. **Manque :** Bibliothèque standard textile (GOTS, rPET, etc.), lien direct fournisseur-matière partagé, traçabilité des lots/certificats matières. |
| **Data collection** | **3.5** | Fonctionnel mais incomplet | Cycle complet : création demande, items depuis template, envoi, réponses versionnées, soumission, revue item par item, approbations. **Manque :** Constructeur de formulaires dynamique (catalogue codé en dur), rattachement automatique des réponses aux Data Points produit. |
| **Documents** | **2.5** | Prototype | Signature AWS SigV4 native pour URLs présignées (PUT/GET), contrat d'antivirus et hash SHA-256. **Manque :** Infra S3/Antivirus non provisionnée, absence de visionneuse intégrée, **faille d'isolation tenant sur download marque**. |
| **Certifications** | **2.5** | Prototype | Déclaration fournisseur (standard, organisme, dates, document lié). **Manque :** Référentiel normé des standards textiles (OEKO-TEX, GOTS, etc.), validation automatique, vue marque des certificats, gestion des alertes d'expiration. |
| **Data quality** | **3.0** | Fonctionnel mais incomplet | Moteur SQL explicable à 4 dimensions (complétude, fraîcheur, preuves, cohérence) avec détection d'issues et scoring. **Manque :** Déclenchement automatique (uniquement calcul manuel), actions de waiver/acquittement absentes de l'UI Brand, bug d'absence de data points produit. |
| **Traceability** | **1.0** | Conceptuel (SQL seul) | Tables `supply_chain_nodes` et `supply_chain_links` et fonctions SQL écrites. **Zéro endpoint d'API, zéro interface UI, aucune mise à jour automatique depuis les collectes.** |
| **DPP readiness** | **1.0** | Conceptuel (SQL seul) | Tables `dpp_requirement_profiles` et `dpp_records`, fonction `tracefab_compute_dpp_readiness` écrite en SQL. **Zéro endpoint d'API, zéro UI, pas de restitution de score DPP pour la marque.** |
| **Notifications** | **3.5** | Fonctionnel mais incomplet | File transactionnelle Outbox, worker de traitement, relances automatiques programmées via Vercel Cron, intégration Resend, observabilité JSON. **Manque :** Centre de notifications in-app, webhook externe non branché, relances manuelles par la marque. |
| **API** | **3.0** | Fonctionnel mais incomplet | 43 routes serverless bien découpées, validation métier, conversion d'erreurs SQL en codes HTTP propres. **Manque :** Pagination (risque d'effondrement sur gros volumes), rate limiting, OpenAPI/Swagger, routes Supply Chain & DPP manquantes. |
| **Security** | **3.0** | Fonctionnel mais incomplet | Clerk côté serveur, tokens d'invitation hashés SHA-256, comparaison en temps constant sur secrets workers, pas de secrets dans le git. **Manque :** `FORCE RLS` manquant en base, faille sur `/api/documents/:documentId/download`, démo-mode exposé dans le bundle. |
| **UX/UI** | **2.0** | Prototype | Design sobre et épuré. **Mais :** Absence de framework moderne (SPA vanilla sur innerHTML), pertes d'état, formulaires non modulaires, a11y déficiente, responsive incomplet sur smartphone, aucun wizard guidé. |
| **Performance** | **2.5** | Prototype | Réponses rapides sur de petits jeux de données. **Mais :** Requêtes API sans pagination, multiples requêtes non parallélisées au chargement, rendu DOM synchrone lourd si plus de 20 produits/fournisseurs. |
| **Testing** | **3.0** | Fonctionnel mais incomplet | Tests d'intégration SQL Neon très complets (`test_neon_*.mjs`), tests de contrats fonctionnels. **Mais :** Tests frontend Playwright basés uniquement sur `?demo=1` (mock), aucun test E2E réel avec DB et API assemblées. |
| **Production deployment** | **2.0** | Prototype | `vercel.json` et schéma Prisma prêts. **Mais :** Dépendances externes (Neon réel, S3 privé, Scanner antivirus, Resend, Clerk production, Alert Webhook) non déployées/connectées en production. |
| **Commercial readiness** | **1.5** | Non commercialisable | Inutilisable par une marque textile en l'état : absence de Supply Chain, absence de DPP, pas d'import/export de catalogue, pas d'onboarding fournisseur fluide, rupture des Data Points produit. |

---

## 3. ÉTAT RÉEL DES FONCTIONNALITÉS (A / B / C / D / E)

Pour chaque fonctionnalité, nous avons déterminé son statut réel d'implémentation :
- **A — Réellement fonctionnelle** (Code API + DB + UI branchés et opérationnels)
- **B — Partiellement fonctionnelle** (Une partie de la chaîne fonctionne, mais maillons manquants)
- **C — Mockée** (Fonctionne uniquement via des données simulées ou en mode démo)
- **D — Statique** (Éléments d'interface fixes, sans logique ni persistance)
- **E — Uniquement documentée** (Prévue dans l'architecture / README, mais absente du code effectif)

| Fonctionnalité | Statut | Justification technique |
| :--- | :---: | :--- |
| Authentification Clerk (Sign-in / Session) | **A** | Implémenté dans l'API (`api/_lib/auth.ts`) et dans les deux consoles via Clerk JS CDN. |
| Création d'organisation Marque | **B** | Endpoint `POST /api/organizations` opérationnel, mais aucun écran d'onboarding dans l'UI Brand (nécessite appel API ou seed). |
| Invitation Fournisseur par la Marque | **A** | `POST /api/organizations/:id/invitations` génère token hashé SHA-256, envoie email Resend ou renvoie token manuel. Modal UI fonctionnelle. |
| Acceptation de l'invitation Fournisseur | **A** | Page `/invitations/accept/index.html` connectée à Clerk et `POST /api/invitations/accept`. Crée le membership fournisseur et active la relation. |
| Onboarding / Création autonome Fournisseur | **C / E** | Impossible sans invitation préalable. L'UI plante sur `supplier_organization_not_found`. |
| Profil Fournisseur (Édition & Complétude) | **A** | `PATCH /api/supplier/profile` et calcul de complétude SQL fonctionnels. Formulaire UI branché. |
| Soumission de profil Fournisseur | **A** | `POST /api/supplier/profile/submit` valide les critères stricts (contact, téléphone, effectif, année, site actif). |
| Gestion des sites de production Fournisseur | **A** | CRUD sur `supplier_sites` via `GET/POST /api/supplier/sites` et formulaire UI complet. |
| Gestion des matières (Création & Consultation) | **B** | Création côté Marque et Fournisseur via `POST /api/materials`. Manque : partage explicite vers la marque. |
| Catalogue Produit (Création, Édition, SKU, Réf) | **A** | `GET/POST /api/products`, `PATCH /api/products/:id`, persistance Neon et affichage Brand Console. |
| Révisions Produit (Versioning) | **A** | `POST /api/products/:id/revision` clone la version produit et incrémente le numéro de version. |
| Composition Produit (Rattachement matières) | **A** | `GET/POST/PATCH /api/products/:id/materials` avec pourcentages et unités validés. |
| Identifiants Produit (GTIN, EAN, UPC, Interne) | **A** | `GET/POST/PATCH /api/products/:id/identifiers` avec désignation du primaire. |
| Rattachement d'un Fournisseur au Produit | **E** | Aucun champ ni endpoint d'association directe Produit <-> Fournisseur (uniquement via demandes ou graphe). |
| Création & Envoi de Data Requests | **A** | `POST /api/data-requests`, template items `from-template`, transition `draft` -> `sent`. |
| Saisie & Réponse du Fournisseur aux demandes | **A** | `POST /api/data-request-items/:id/response` avec versioning et conservation de l'historique. |
| Soumission de la demande par le Fournisseur | **A** | `POST /api/data-requests/:id/submit` vérifie que tous les items obligatoires ont une réponse. |
| Revue des réponses par la Marque | **A** | `POST /api/data-responses/:id/review` (`verified_by_reviewer` ou `needs_review`). |
| Approbation automatique de la demande | **A** | Dès que tous les items obligatoires sont vérifiés, la demande passe en `approved`. |
| Notification Outbox & Worker | **A** | Table SQL dédiée, verrouillage des jobs (`claim`), envoi Resend, retries exponentiels, observabilité JSON. |
| Relances automatiques de collecte (Reminders) | **A** | SQL `tracefab_enqueue_due_data_request_reminders`, Vercel Cron (`vercel.json`) et endpoint `/reminders`. |
| Relance manuelle d'un fournisseur par la marque | **E** | Aucun bouton ni endpoint permettant à la marque de renvoyer un rappel ponctuel. |
| Stockage privé des preuves (Upload Intent & Presign) | **B** | SigV4 implémenté (`api/_lib/storage.ts`), mais dépendance S3 externe non provisionnée. |
| Scan Antivirus des documents | **B** | Contrat HTTP défini (`/scan`), mais pas de service antivirus réel raccordé. |
| Téléchargement sécurisé des preuves Fournisseur | **A** | `GET /api/supplier/documents/:id/download` vérifie l'appartenance de l'organisation. |
| Téléchargement sécurisé des preuves Marque | **B** | `GET /api/documents/:id/download` fonctionne mais **sans vérification d'isolation tenant** ! |
| Déclaration des certifications Fournisseur | **A** | Formulaire UI et endpoints `GET/POST/PATCH /api/supplier/certifications` opérationnels. |
| Référentiel normé des certifications | **E** | Aucune table ni API de standards certifiés (saisie libre du libellé). |
| Données structurées Fournisseur (Data Points) | **B** | `GET/POST /api/supplier/data-points` fonctionne pour les fournisseurs et sites, mais **pas pour les produits**. |
| Injection des réponses de collecte en Data Points | **E** | Les réponses restent cantonnées dans `data_responses` et ne créent aucun `data_points`. |
| Partage sélectif des données (`data_shares`) | **E** | Modélisé en SQL, mais **zéro API et zéro UI** pour configurer les permissions de partage. |
| Calcul Qualité Fournisseur (Score & Issues) | **A** | Fonction SQL `tracefab_compute_supplier_quality` et endpoint `/api/quality/suppliers/:id`. |
| Calcul Qualité Produit (Score & Issues) | **B** | SQL et API existent, mais le score est faussé par l'absence d'injection de data points. |
| Acquittement & Waiver des Issues Qualité | **B** | Endpoints `/acknowledge` et `/waive` opérationnels dans l'API, mais **aucun bouton dans l'UI Brand**. |
| Graphe de Traçabilité (Supply Chain Graph) | **E** | Tables et fonctions SQL présentes, mais **aucun endpoint d'API et aucune vue UI**. |
| Visualisation graphique de la Supply Chain | **D / E** | Absente du code UI. |
| Moteur de préparation DPP (Readiness) | **E** | Tables et fonction SQL présentes, mais **aucun endpoint d'API et aucune vue UI**. |
| Affichage explicable du score DPP | **E** | Non implémenté dans le frontend. |
| Rendu public du DPP (QR Code / Consumer View) | **E** | Volontairement hors périmètre initial, documenté uniquement. |
| Gestion d'équipe Fournisseur (Membres & Rôles) | **A** | Invitation de membre, renvoi, révocation et changement d'organisation active fonctionnels. |
| Switcher multi-organisations Fournisseur | **A** | Détecte les organisations du user, permet de basculer le contexte via `X-Tracefab-Organization-Id`. |

---

## 4. AUDIT DÉTAILLÉ DU BRAND CONSOLE

Le Brand Console est hébergé sous `/brand-console/index.html`. C'est une application monopage écrite en HTML/JS vanilla d'environ 1 400 lignes de code.

### 4.1. Dashboard (Overview)
- **Ce qui fonctionne :**
  - Affichage du nom de l'organisation et du prénom de l'utilisateur.
  - 4 KPI cards : Produits actifs, Demandes ouvertes (avec count des soumises), Échéances proches (< 7 jours), Fournisseurs actifs.
  - Tableau des demandes récentes avec badge de statut.
  - Raccourcis d'actions rapides : Nouvelle demande, Créer un produit, Inviter un fournisseur.
- **Ce qui manque / Ce qui ne respecte pas le cahier des charges :**
  - **Aucun KPI de données manquantes :** Le dashboard n'indique pas combien de données critiques manquent sur le catalogue.
  - **Aucun KPI documentaire / certifications :** Aucun décompte des preuves collectées, expirées ou manquantes.
  - **Aucun KPI global de qualité :** La qualité n'est affichée que produit par produit dans un onglet séparé.
  - **Aucun indicateur de DPP Readiness :** Totalement absent du dashboard.
  - **Aucun centre d'alertes :** Pas de liste des blocages qualité, certificats arrivant à expiration ou anomalies de chaîne.

### 4.2. Suppliers (Fournisseurs)
- **Ce qui fonctionne :**
  - Bouton d'invitation avec modal (`email`, `legalName`, `displayName`, `countryCode`, choix de la marque).
  - Tableau listant les organisations fournisseurs liées avec leur pays et le nombre de demandes ouvertes.
  - Vue détail fournisseur (`supplierDetailView`) affichant la complétude du profil, les coordonnées de contact, les activités déclarées et l'historique des demandes de la marque.
- **Ce qui manque :**
  - **Suivi des invitations en attente :** Si un fournisseur a été invité mais n'a pas encore accepté, il n'apparaît pas dans la liste des fournisseurs actifs. La marque ne sait pas qui a été invité ni qui a expiré.
  - **Relance fournisseur (`relancer`) :** Aucun moyen de renvoyer l'email d'invitation ou de notifier le fournisseur depuis la console.
  - **Qualification fournisseur (`qualifier`) :** Aucun statut de qualification (ex: "Tier 1 audité", "Fournisseur stratégique", "À qualifier").
  - **Consultation des sites et certifications du fournisseur :** La vue détail marque n'affiche ni les sites de production du fournisseur ni ses certificats déclarés.

### 4.3. Products (Produits)
- **Ce qui fonctionne :**
  - Création de produit (modal : référence, nom, catégorie, SKU).
  - Liste des produits avec statut, version et complétude.
  - Fiche produit détaillée : édition des métadonnées (description, famille, couleur, tailles, pays de design/fabrication, poids).
  - Versioning : bouton "Créer une révision" qui appelle `/api/products/:id/revision` et incrémente la version.
  - Composition : sélection de matières disponibles, attribution du rôle (`main`, `lining`, etc.), pourcentage et unité.
  - Identifiants : ajout et édition de codes (EAN, GTIN, UPC, Interne) avec drapeau principal.
- **Ce qui manque :**
  - **Rattachement aux fournisseurs :** Impossible de définir quel fournisseur fabrique ou assemble ce produit directement depuis la fiche produit.
  - **Attribution de preuves ou documents au niveau du produit.**
  - **Qualité intégrée :** Le score qualité nécessite de cliquer sur un bouton qui redirige vers un autre onglet au lieu d'avoir un aperçu direct.

### 4.4. Data Requests (Demandes de données)
- **Ce qui fonctionne :**
  - Création de demande avec choix du fournisseur, du titre, de la date d'échéance et du questionnaire template (`product-data-core`).
  - Préparation automatique des items depuis le template.
  - Envoi de la demande (`send-request`) qui déclenche l'outbox notification.
  - Affichage des réponses courantes soumises par le fournisseur.
  - Revue item par item : boutons "Vérifier" (`verified_by_reviewer`) et "Demander une correction" (`needs_review`).
- **Ce qui manque :**
  - **Rattachement explicite au produit :** Bien que le champ `productId` existe dans l'API, le formulaire de création de demande dans l'UI Brand ne propose pas de sélecteur de produit !
  - **Relance manuelle :** Aucun bouton pour relancer le fournisseur si la demande tarde.
  - **Validation globale :** Aucun bouton d'approbation d'ensemble de la demande (l'approbation est conditionnée par l'acceptation de chaque item individuel).

### 4.5. Quality Center
- **Ce qui fonctionne :**
  - Sélecteur de produit.
  - Bouton "Recalculer le score" (`POST /api/quality/products/:id`).
  - Affichage de 4 jauges de score : Complétude, Fraîcheur, Preuves, Cohérence.
  - Liste des issues détectées avec leur sévérité (`blocking`, `warning`, `info`), le message et la règle.
- **Ce qui manque :**
  - **Actions d'acquittement et de dérogation (Waiver) :** Les fonctions backend `tracefab_acknowledge_quality_issue` et `tracefab_waive_quality_issue` existent, mais l'interface n'affiche **aucun bouton** pour les actionner. Les issues restent donc figées à l'écran.
  - **Historique des scores :** Seul le dernier snapshot est affiché, pas de courbe de progression.
  - **Qualité globale catalogue :** Impossible de voir la santé moyenne de la collection.

### 4.6. Supply Chain Graph
- **Constat :** **TOTALEMENT ABSENT DE LA BRAND CONSOLE.**
- Aucune vue, aucun composant de graphe (pas de SVG, pas de Canvas, pas de Mermaid, pas de Cytoscape/D3). La table SQL et la fonction existent, mais l'utilisateur marque n'a aucun moyen de visualiser les étapes de la chaîne textile (matière brute -> filature -> tissage -> ennoblissement -> confection).

### 4.7. DPP (Digital Product Passport)
- **Constat :** **TOTALEMENT ABSENT DE LA BRAND CONSOLE.**
- Aucun onglet DPP, aucune jauge de préparation DPP, aucune prévisualisation du passeport digital.

---

## 5. AUDIT DÉTAILLÉ DU SUPPLIER PORTAL

Le Supplier Portal est sous `/supplier-portal/index.html`. C'est également un monolithe HTML/JS vanilla de 1 700 lignes.

### 5.1. Évaluation des 11 fonctionnalités critiques requises

1. **Créer son organisation :**
   - **ÉCHEC.** Un utilisateur qui crée un compte Clerk et se rend sur `/supplier-portal/` sans invitation préalable voit l'écran d'erreur `supplier_organization_not_found`. Aucun flux de création d'organisation fournisseur n'est prévu dans l'UI.
2. **Compléter son profil :**
   - **FONCTIONNEL.** L'onglet "Mon profil" permet de renseigner : résumé, contact, téléphone, effectif (tranches), année de création, activités. Le calcul de complétude réagit en temps réel.
3. **Ajouter ses sites :**
   - **FONCTIONNEL.** L'onglet "Sites" permet d'ajouter des usines/ateliers avec nom, pays (ISO), ville, code postal, adresse et activités.
4. **Ajouter ses produits :**
   - **ABSENT.** Le portail fournisseur ne contient **aucun onglet ni aucune fonctionnalité de gestion de ses produits**. Dans le modèle de Tracefab, seuls les marques possèdent des produits (`brand_organization_id`). Le fournisseur ne peut pas déclarer un catalogue de produits finis ou semi-finis.
5. **Ajouter ses matériaux :**
   - **FONCTIONNEL.** L'onglet "Matériaux" permet d'enregistrer des matières (ex: Coton bio, Lin, Polyester recyclé) avec leur type et leur pays d'origine.
6. **Déclarer ses certifications :**
   - **FONCTIONNEL.** L'onglet "Certificats" permet de déclarer un standard, l'organisme émetteur, le numéro de certificat, les dates d'émission et d'expiration, et de relier un document preuve.
7. **Télécharger ses preuves :**
   - **FONCTIONNEL (sous réserve de config S3).** L'onglet "Preuves" permet l'upload de fichiers via URL présignée et scan antivirus. En mode réel sans S3, l'API renvoie 503.
8. **Répondre aux demandes des marques :**
   - **FONCTIONNEL.** L'onglet "Demandes de données" affiche les demandes reçues. En ouvrant une demande, le fournisseur saisit les valeurs champ par champ et peut associer une preuve déjà uploadée.
9. **Soumettre ses données :**
   - **FONCTIONNEL.** Bouton "Soumettre à la marque" qui vérifie la présence des réponses obligatoires et verrouille la soumission.
10. **Voir les éléments encore manquants :**
    - **PARTIELLEMENT FONCTIONNEL.** Visible sous deux formes : la jauge de complétude du profil et les champs restés vides dans les demandes. En revanche, le fournisseur ne dispose pas d'une checklist consolidée des données attendues par ses marques clientes.
11. **Contrôler ce qu'il partage avec chaque marque :**
    - **ABSENT.** Aucun écran de gestion des permissions ou des partages par marque (`data_shares`). Le fournisseur ne sait pas quelles marques ont accès à quels sites ou matériaux.

---

## 6. TEST DU PARCOURS CRITIQUE (STEP-BY-STEP BREAKDOWN)

Nous avons audité méticuleusement chaque étape du parcours de bout en bout :

```text
[1] Brand signup
       ↓
[2] Create product
       ↓
[3] Add & Invite supplier
       ↓
[4] Supplier accepts invitation
       ↓
[5] Supplier joins organization
       ↓
[6] Supplier completes profile
       ↓
[7] Supplier adds site
       ↓
[8] Supplier adds material
       ↓
[9] Supplier adds product information
       ↓
[10] Supplier uploads evidence
       ↓
[11] Supplier submits data
       ↓
[12] Brand receives data
       ↓
[13] Brand reviews data
       ↓
[14] Quality engine evaluates
       ↓
[15] Supply chain updates
       ↓
[16] Product readiness updates
```

### Analyse pas à pas et points de rupture identifiés :

| Étape | Statut | Résultat & Analyse technique |
| :--- | :---: | :--- |
| **1. Brand signup** | **OK (avec réserve)** | Fonctionne via Clerk. L'organisation Brand doit être créée par script ou seed, car l'UI Brand n'a pas de wizard d'initialisation de première organisation. |
| **2. Create product** | **OK** | Fonctionne parfaitement via le modal "+ Nouveau produit" (`POST /api/products`). La référence et le nom sont persistés. |
| **3. Add & Invite supplier** | **OK** | Fonctionne via le modal d'invitation. Génère l'organisation fournisseur, le profil `suppliers`, la relation `brand_supplier_relationships` et l'invitation avec token hashé. |
| **4. Supplier accepts invitation** | **OK** | L'URL `/invitations/accept?token=...` authentifie l'utilisateur sous Clerk et active son membership dans l'organisation fournisseur. |
| **5. Supplier joins organization** | **OK** | L'organisation fournisseur devient accessible au fournisseur via le header `X-Tracefab-Organization-Id`. |
| **6. Supplier completes profile** | **OK** | Le formulaire profil sauvegarde les données. `POST /api/supplier/profile/submit` valide les critères requis. |
| **7. Supplier adds site** | **OK** | Fonctionne parfaitement via l'onglet Sites (`POST /api/supplier/sites`). |
| **8. Supplier adds material** | **OK** | Fonctionne via l'onglet Matériaux (`POST /api/materials`). **Attention :** Le matériau reste la propriété exclusive du fournisseur. Aucun partage automatique (`data_shares`) n'est créé pour la marque, donc la marque ne peut pas l'utiliser dans sa composition produit ! |
| **9. Supplier adds product info** | **RUPTURE DE FLUX** | **Premier blocage structurel.** Le fournisseur ne peut pas déclarer de produit. Pour fournir des infos produit, il doit attendre qu'une Data Request lui soit envoyée. S'il déclare des Données Structurées ("Données"), l'API refuse de les lier à un produit (`invalid_data_point_subject`). |
| **10. Supplier uploads evidence** | **OK (conditionnel)** | Fonctionne si les variables S3 et Antivirus sont configurées. Bloqué en 503 sinon. |
| **11. Supplier submits data** | **OK** | La demande de données passe en statut `submitted`. L'outbox notification génère l'événement `request_submitted`. |
| **12. Brand receives data** | **OK** | La marque voit la demande avec son badge "Soumise" et les réponses fournies. |
| **13. Brand reviews data** | **OK** | La marque clique sur "Vérifier" (`verified_by_reviewer`). Le statut de l'item passe à `accepted`. La demande passe en `approved`. |
| **14. Quality engine evaluates** | **RUPTURE DU FLUX** | **Deuxième blocage structurel.** L'approbation de la collecte **ne déclenche pas** automatiquement le moteur qualité. La marque doit aller manuellement dans le Quality Center et cliquer sur "Recalculer". Et lors du recalcul, le moteur cherche des `data_points` associés au produit : comme la collecte n'a pas alimenté les `data_points`, le score qualité produit génère une issue bloquante `product_no_data_points` ! |
| **15. Supply chain updates** | **CASSÉ** | **Troisième blocage structurel.** Aucune mise à jour de la supply chain n'a lieu. Ni les réponses de la collecte, ni les sites déclarés par le fournisseur ne créent de `supply_chain_nodes` ou `supply_chain_links`. De plus, aucun endpoint d'API ni écran n'existe pour construire ce graphe. |
| **16. Product readiness updates** | **CASSÉ** | **Quatrième blocage structurel.** `dpp_records` et `tracefab_compute_dpp_readiness` ne sont jamais appelés. Le produit reste dans son état local de complétude de champs de base sans aucune projection DPP. |

---

## 7. AUDIT DU DATA MODEL (PRISMA & NEON POSTGRESQL)

Le schéma Prisma (`prisma/schema.prisma`) comprend **25 modèles** alignés avec les migrations PostgreSQL historiques.

### 7.1. Modèles existants et cartographie
- `User` : Utilisateurs Clerk (`clerkUserId`, `email`, `fullName`).
- `organizations` : Tenants (`brand`, `supplier`, `verifier`, `platform`).
- `organization_memberships` : Rôles (`owner`, `admin`, `manager`, `contributor`, `viewer`, `auditor`).
- `organization_invitations` : Invitations d'équipe et de fournisseurs avec `token_hash` et `expires_at`.
- `brand_supplier_relationships` : Relations B2B de la supply chain (`invited`, `active`, `suspended`, `ended`).
- `suppliers` : Profils d'onboarding, complétude, effectifs, année.
- `supplier_sites` : Sites physiques, coordonnées GPS, activités.
- `tracefab_products` : Références produits, attributs physiques, versions, statut de readiness.
- `product_materials` : Table d'association versionnée entre produits et matériaux (avec pourcentage).
- `product_identifiers` : Codes-barres et identifiants externes (GTIN, EAN, UPC, Interne).
- `materials` : Définition des matières et compositions.
- `supply_chain_nodes` : Nœuds du graphe (produit, matière, organisation, site, processus).
- `supply_chain_links` : Arêtes orientées du graphe (`sourced_from`, `transformed_at`, etc.).
- `data_requests`, `data_request_items`, `data_responses` : Workflow complet de collecte versionné.
- `documents` : Registre des fichiers (bucket, sha256, statut scan, visibilité, expiration).
- `certifications` : Certificats d'entreprises, de sites ou de produits.
- `data_points` : Faits élémentaires typés et versionnés avec niveau de qualification.
- `data_shares` : Permissions de visibilité granulaire inter-tenants.
- `verification_records` : Historique des audits et vérifications formelles.
- `data_quality_scores`, `data_quality_issues` : Snapshots de scoring et findings qualité.
- `dpp_requirement_profiles`, `dpp_records` : Règles et projections de préparation au DPP.
- `audit_logs` : Journal d'audit des actions critiques.
- `tracefab_notification_outbox` : File d'attente transactionnelle des notifications.

### 7.2. Points forts du Data Model
- **Excellente intégrité référentielle :** Clés étrangères complètes avec cascades appropriées (`ON DELETE CASCADE` sur les dépendances directes, `ON DELETE RESTRICT` sur les relations contractuelles).
- **Versioning natif :** Prévu sur les produits (`version`), les compositions (`product_version`), les réponses aux demandes (`response_version`, `supersedes_id`) et les points de données (`version`, `supersedes_id`).
- **Audit trail :** Table `audit_logs` présente avec enregistrement de `before_state`, `after_state` et `actor_user_id`.
- **Typage fort :** 17 enums PostgreSQL couvrant exhaustivement tous les statuts d'activité.

### 7.3. Faiblesses et anomalies de conception
1. **Rupture entre Collecte et Data Points :** Aucune clé étrangère ni trigger ne relie `data_responses` à `data_points`. Lorsqu'une réponse est approuvée par une marque, elle devrait automatiquement générer un `data_points` rattaché au `product_id` avec le statut `verified_by_reviewer` et la référence au `source_document_id`.
2. **Soft Delete incomplet :** Seule la table `documents` possède `deleted_at` et `deleted_by`. Les produits, fournisseurs, sites et matières ne disposent pas de colonnes de soft delete, ce qui impose soit une suppression physique (potentiellement destructrice pour l'historique de traçabilité) soit un basculement vers un statut `archived` / `suspended`.
3. **Absence de liaison directe Produit <-> Fournisseur principal :** `tracefab_products` n'a pas de colonne `supplier_organization_id` ou `supplier_id`. Une marque doit nécessairement passer par un nœud de graphe ou une relation globale pour rattacher un fabricant à une référence.
4. **Indexation manquante :**
   - Manque d'index composite sur `data_points(product_id, data_key, is_current)` pour accélérer le calcul qualité produit.
   - Manque d'index sur `documents(sha256)` pour la déduplication de preuves.
   - Manque d'index sur `data_requests(supplier_organization_id, due_at)` pour les requêtes d'échéances imminentes.

---

## 8. CYCLE DE VIE DES DATA POINTS & DATA QUALITY

### 8.1. Définition et traçabilité d'un Data Point
Dans la vision TRACEFAB, une donnée n'est pas une simple chaîne de caractères dans un formulaire, c'est un **objet auditable**.
Le modèle `data_points` répond aux questions critiques :
- **Valeur :** `value` (JSONB typé : texte, nombre, pourcentage, booléen, date, code pays).
- **Auteur :** `declared_by` (UUID de l'utilisateur).
- **Date :** `created_at` et fenêtre d'application `valid_from` / `valid_until`.
- **Rattachement :** `owner_organization_id`, `supplier_id`, `supplier_site_id`, `product_id`, `material_id`.
- **Preuve source :** `source_document_id` (lien vers `documents`).
- **Statut de qualification :** `status` (`data_value_status`).
- **Version & Historique :** `version` et `supersedes_id`.

### 8.2. Qualification de la donnée (Data Quality Tiers)
Le système distingue parfaitement en SQL les 6 états fondamentaux :
1. `DECLARED` : Donnée saisie sans justificatif associé.
2. `DOCUMENTED` : Donnée rattachée à un document disponible dans le stockage privé.
3. `CHECKED_FOR_CONSISTENCY` : Donnée ayant passé des règles de validation algorithmiques.
4. `VERIFIED_BY_REVIEWER` : Donnée formellement contrôlée et validée par un réviseur humain (la marque).
5. `CERTIFIED_BY_THIRD_PARTY` : Donnée validée par un organisme de certification accrédité.
6. `NEEDS_REVIEW` : Donnée nécessitant une action corrective.
7. `MISSING` : Donnée attendue mais non renseignée (génère un finding de complétude).

### 8.3. Règles du Quality Engine
Le moteur SQL calcule 4 métriques explicables (de 0 à 100 %) :
- **Complétude :** Pourcentage de champs obligatoires renseignés sur le profil ou le produit.
- **Fraîcheur :** Pourcentage de données dont la date de fin de validité (`valid_until`) n'est pas dépassée.
- **Preuves (Documentation Coverage) :** Ratio des données et certifications couvertes par un document disponible et scanné sans virus.
- **Cohérence :** Note dégradée de 30 points par issue bloquante (`blocking`) et de 10 points par avertissement (`warning`).

---

## 9. DOCUMENTS & PREUVES PRIVÉES

### 9.1. Chaîne de traitement d'un document
1. **Upload Intent (`POST /api/supplier/documents/upload-intent`) :**
   - Valide le type MIME (`pdf`, `png`, `jpeg`, `txt`).
   - Valide la taille max (50 Mo).
   - Génère une URL présignée AWS S3 en PUT via SigV4 natif avec expiration configurable (10 min par défaut).
   - Enregistre une entrée `documents` au statut `uploaded`.
2. **Scan Antivirus (`POST /api/supplier/documents/:id/scan`) :**
   - Télécharge le fichier depuis le bucket privé via SigV4.
   - Calcule le hash SHA-256 du contenu binaire.
   - Émet une requête POST vers le service antivirus (`X-Tracefab-Scan-Protocol: tracefab-v1`).
   - Si sain, appelle `tracefab_finalize_document_upload` et passe le statut à `available`.
3. **Téléchargement temporaire :**
   - Génère une URL présignée en GET valable 600 secondes. Le fichier n'est jamais public.

### 9.2. Vulnérabilité majeure identifiée sur le téléchargement Marque
Dans `api/_routes/documents/[documentId]/download.ts` :
```typescript
const document = await tx.documents.findFirst({
  where: { id: documentId, status: 'available' },
  select: DOCUMENT_SELECT,
});
```
**Analyse de la faille :**
Contrairement à la route fournisseur (`/api/supplier/documents/...`), cette route ne vérifie pas si l'organisation de l'utilisateur a le droit d'accéder au document (ni via propriété directe, ni via une relation marque-fournisseur active, ni via `data_shares`).
En combinant cela avec le fait que les connexions PostgreSQL via Prisma n'activent pas `FORCE ROW LEVEL SECURITY`, **n'importe quel utilisateur connecté peut télécharger n'importe quel document confidentiel de n'importe quel fournisseur** simplement en devinant ou récupérant son UUID.
**Correction requise :** Ajouter immédiatement une vérification de partage ou d'appartenance tenant.

---

## 10. CERTIFICATIONS

### 10.1. État actuel
- La table `certifications` permet d'enregistrer une certification liée à une organisation, un site ou un produit.
- Formulaire fournisseur présent dans le portail (`standardName`, `standardCode`, `issuerName`, `certificateNumber`, `issuedAt`, `expiresAt`, `documentId`).
- Le calcul de qualité vérifie si la certification est expirée (`expires_at < CURRENT_DATE`) et si elle possède un document preuve.

### 10.2. Ce qui doit être construit pour la commercialisation textile
- **Taxonomie des référentiels textiles :** Remplacer la saisie libre par un catalogue normé :
  - Environnement & Matières : GOTS, OCS, GRS, RCS, BCI / Better Cotton, Cradle to Cradle.
  - Sécurité Chimique : OEKO-TEX Standard 100, OEKO-TEX Made in Green, Bluesign, ZDHC.
  - Social & Éthique : SA8000, SMETA (Sedex), BSCI (Amfori), Fair Wear Foundation.
  - Traçabilité animale : RDS (Duvet), RWS (Laine), RMS (Mohair).
- **Extensibilité :** Permettre l'ajout de nouveaux labels personnalisés ou émergents sans migration SQL.
- **Vérification automatique :** Connecteurs d'API ou parsers pour vérifier le numéro de licence directement auprès des bases publiques (ex: base GOTS ou annuaire OEKO-TEX).

---

## 11. SUPPLY CHAIN GRAPH (TRAÇABILITÉ)

### 11.1. Modèle théorique versus réalité opérationnelle
Le modèle cible décrit :
`Matière Première → Fibre → Filature → Tissage/Tricotage → Teinture/Ennoblissement → Découpe → Assemblage → Produit Fini`

### 11.2. Ce qui est codé en SQL
- Table `supply_chain_nodes` : supporte `product`, `material`, `organization`, `site`, `process`.
- Table `supply_chain_links` : supporte `sourced_from`, `transformed_at`, `manufactured_at`, `supplied_by`, `contains`, `next_step`.
- Fonction `tracefab_get_product_traceability(p_product_id)` : renvoie une projection JSON sécurisée masquant les identifiants de documents non autorisés.

### 11.3. Ce qui manque totalement
1. **Endpoints API :**
   - `GET /api/products/:id/supply-chain`
   - `POST /api/products/:id/supply-chain/nodes`
   - `POST /api/products/:id/supply-chain/links`
2. **Construction automatique :** Les réponses aux questionnaires (ex: "Quel est votre site de confection ?", "D'où provient le fil ?") doivent automatiquement créer les nœuds et arêtes correspondants.
3. **Visualisation UI :** Un composant interactif dans la Brand Console permettant à la marque et à ses auditeurs de visualiser le graphe multi-tiers de chaque produit avec indicateurs de statut (rouge si non documenté, vert si certifié).

---

## 12. DPP READINESS & EXPLICABILITÉ DU SCORE

### 12.1. Philosophie réglementaire
Tracefab applique une règle d'or : **ne jamais promettre une "conformité réglementaire définitive"** alors que les actes délégués de l'ESPR (Ecodesign for Sustainable Products Regulation) pour le textile sont en cours de stabilisation au niveau européen.
Le système implémente donc judicieusement la notion de **"DPP Readiness"** (préparation des données).

### 12.2. Le profil `textile_readiness_mvp` v1.0
Codé dans la migration `20260923130000_tracefab_neon_initial/migration.sql`, le profil évalue :
1. Présence de la référence produit.
2. Présence du nom produit.
3. Présence d'une description exploitable.
4. Catégorie produit renseignée.
5. Pays de fabrication renseigné.
6. Complétude des données produit à 100 %.
7. Composition matières à 100 %.
8. Existence d'au moins un lien dans le graphe de traçabilité.
9. Absence d'issues bloquantes dans le dernier score qualité.

### 12.3. Explicabilité requise
Le score ne doit pas être une boîte noire. Il doit se décomposer :
- Score global : **82 %**
  - Identité & Référence : 100 %
  - Composition matières : 100 %
  - Origine & Fabrication : 80 %
  - Traçabilité amont : 70 %
  - Couverture documentaire : 65 %
  - Conformité certifications : 75 %
Chaque point perdu doit pointer vers l'action corrective exacte : *"Fournisseur Nhãn Textile : preuve manquante pour l'étape de teinture"*.

---

## 13. SYSTÈME DE NOTIFICATIONS & RELANCES

### 13.1. Architecture
- **Table Outbox (`tracefab_notification_outbox`) :** Insertion transactionnelle lors des transitions d'état métier (demande envoyée, soumise, vérifiée, relance due).
- **Worker (`POST /api/internal/notification-outbox/process`) :** Verrouille atomiquement un lot de notifications (`tracefab_claim_notification_outbox`), effectue les appels Resend, et enregistre le résultat ou planifie un retry exponentiel.
- **Scheduler de relances (`POST /api/internal/notification-outbox/reminders`) :** Recherche les demandes approchant de leur échéance (`due_at - intervalle`) ou dépassées, et injecte les notifications de rappel avec **idempotence journalière** (garantissant qu'un fournisseur ne reçoit pas deux emails de rappel le même jour).
- **Vercel Cron :** Planifié à `0 7 * * *` via `vercel.json` appelant `/api/internal/notification-outbox/schedule`.

### 13.2. Éléments à compléter
- Pas de centre de notifications visuel in-app (les utilisateurs dépendent uniquement des emails).
- Pas de déclenchement manuel d'un "Passe-plat" (relance ponctuelle par la marque en 1 clic).

---

## 14. AUDIT DE L'API

L'API est hébergée sur Vercel Node sous forme d'un dispatcher dynamique unique (`api/index.ts`) qui route vers 43 sous-modules dans `api/_routes/`.

### 14.1. Analyse des routes existantes
- `/api/config` (GET) : Publie la clé Clerk publique au navigateur.
- `/api/health` (GET) : Healthcheck simple.
- `/api/me` (GET) : Synchronisation de l'utilisateur Clerk et de ses memberships.
- `/api/organizations` (GET, POST) : Gestion des organisations et memberships.
- `/api/organizations/:id/invitations` (POST) : Invitation de fournisseur par la marque.
- `/api/invitations/accept` (POST) : Consommation du token et intégration du membre.
- `/api/products` (GET, POST, PATCH) : Catalogue produit.
- `/api/products/:id/materials` (GET, POST, PATCH) : Composition matières.
- `/api/products/:id/identifiers` (GET, POST, PATCH) : Codes-barres.
- `/api/products/:id/revision` (POST) : Versioning produit.
- `/api/materials` (GET, POST) : Bibliothèque matières.
- `/api/data-requests` (GET, POST) : Gestion des demandes de collecte.
- `/api/data-requests/:id/items/from-template` (POST) : Peuplement depuis template.
- `/api/data-requests/:id/send` (POST) : Envoi au fournisseur.
- `/api/data-requests/:id/submit` (POST) : Soumission par le fournisseur.
- `/api/data-request-items/:id/response` (POST) : Réponse fournisseur.
- `/api/data-responses/:id/review` (POST) : Revue de conformité marque.
- `/api/supplier/profile` (GET, PATCH) & `/submit` (POST) : Profil fournisseur.
- `/api/supplier/sites` (GET, POST, PATCH) : Sites de production.
- `/api/supplier/certifications` (GET, POST, PATCH) : Certifications.
- `/api/supplier/documents/upload-intent` (POST) : Init upload preuve.
- `/api/supplier/documents/:id/scan` (POST) : Finalisation & scan.
- `/api/supplier/documents/:id/download` (GET) : Téléchargement preuve fournisseur.
- `/api/documents/:id/download` (GET) : Téléchargement preuve marque.
- `/api/supplier/data-points` (GET, POST) : Données structurées fournisseur.
- `/api/supplier/members` (GET, POST) : Équipe fournisseur.
- `/api/quality/products/:id` (GET, POST) : Qualité produit.
- `/api/quality/suppliers/:id` (GET, POST) : Qualité fournisseur.
- `/api/quality-issues/:id/acknowledge` (POST) : Acquittement issue.
- `/api/quality-issues/:id/waive` (POST) : Dérogation issue.
- `/api/questionnaires` (GET) : Catalogue de questionnaires.
- `/api/internal/notification-outbox/*` : Administration des notifications et du cron.

### 14.2. Routes critiques manquantes dans l'API
1. `GET/POST /api/products/:id/supply-chain/nodes`
2. `GET/POST /api/products/:id/supply-chain/links`
3. `GET /api/products/:id/supply-chain`
4. `GET/POST /api/products/:id/dpp`
5. `GET/POST /api/products/:id/data-points`
6. `GET/POST /api/data-shares`
7. `POST /api/data-requests/:id/remind`
8. `POST /api/products/import-csv` & `POST /api/suppliers/import-csv`

---

## 15. AUDIT SÉCURITÉ

### 15.1. Matrice des contrôles de sécurité

| Vecteur | Niveau de sécurité actuel | Risque identifié & Recommandation |
| :--- | :---: | :--- |
| **Authentification** | Élevé | Géré par Clerk. Tokens JWT vérifiés cryptographiquement. Secret stocké côté serveur. |
| **Isolation Multi-tenant (Database)** | **Critique / Insuffisant** | Les RLS policies existent, mais **`FORCE ROW LEVEL SECURITY` n'est pas activé**. Prisma utilise l'utilisateur propriétaire `neondb_owner` qui outrepasse les règles RLS ! |
| **Isolation Multi-tenant (API)** | Moyen | La plupart des routes filtrent par `organization_id`, mais la route de téléchargement `/api/documents/:id/download` présente une brèche d'isolation. |
| **Contrôle d'accès basé sur les rôles (RBAC)** | Élevé | Rôles (`owner`, `admin`, `manager`, `contributor`, `viewer`, `auditor`) contrôlés en SQL via `tracefab_has_org_role`. |
| **Protection des tokens d'invitation** | Très élevé | Le token brut n'est jamais stocké en base ; seul son hash SHA-256 est persisté. Expiration à 7 jours. |
| **Sécurité des documents** | Élevé | Documents privés par défaut. Accès via URLs présignées SigV4 temporaires (10 min). |
| **Protection des routes de cron / workers** | Élevé | Comparaison des secrets avec `crypto.timingSafeEqual` prévenant les attaques par canal auxiliaire (timing attacks). |
| **Fuite de secrets dans le git** | Élevé | Aucun secret ou clé d'API en clair détecté dans le repository git. |

---

## 16. AUDIT UX / UI

### 16.1. Problèmes structurels majeurs
1. **Architecture Frontend obsolète (Monolithes HTML + Vanilla JS) :**
   - Le code UI réside dans deux fichiers uniques (`brand-console/index.html` et `supplier-portal/index.html`).
   - Le rendu se fait par injection massive de chaînes HTML via `app.innerHTML = ...`.
   - **Conséquences :** Dès qu'une action est exécutée, tout le DOM est régénéré, provoquant la perte du focus clavier, la réinitialisation des formulaires non validés, des clignotements et une dette technique ingérable.
2. **Accessibilité (a11y) dégradée :**
   - Remplacement du DOM détruisant les attributs d'accessibilité dynamiques.
   - Contrastes insuffisants sur les textes en gris clair (`#71807a` sur fond `#f7f8f4`).
   - Absence de navigation clavier cohérente dans les tableaux et formulaires.
3. **Usage mobile du Supplier Portal :**
   - Un dirigeant d'atelier ou un responsable qualité d'usine textile en Turquie, au Portugal ou au Vietnam consulte souvent ses demandes sur tablette ou smartphone.
   - Les formulaires complexes à 8 colonnes et les tableaux de réponses sont inexploitables sur écran tactile de moins de 768px.
4. **Compréhension en 30 secondes :**
   - Le Brand Console présente un niveau de jargon technique élevé (`idempotency_key`, `public_slug`, `ruleKey`).
   - Pour le fournisseur, la distinction entre "Preuves", "Données structurées", "Certificats" et "Demandes" est confuse : il ne sait pas par quoi commencer s'il n'est pas guidé par un assistant pas à pas.

---

## 17. AUDIT DE LA PERFORMANCE

1. **Absence de pagination :**
   - `/api/products` renvoie `tx.tracefab_products.findMany` sans `take` ni `skip`.
   - `/api/data-requests` renvoie toutes les demandes sans filtre de limite.
   - Sur une marque avec 500 références et 80 fournisseurs, le payload JSON dépassera plusieurs mégaoctets et bloquera le thread JavaScript du navigateur.
2. **Cascades de requêtes (Waterfall) :**
   - Dans `brand-console/index.html`, la fonction `sync()` exécute 6 requêtes réseau successives non groupées.
3. **Absence de mise en cache :**
   - Aucun en-tête `Cache-Control` optimisé sur les référentiels statiques (questionnaires, profils).

---

## 18. AUDIT DES TESTS

### 18.1. État des lieux des tests existants
- `npm run schema:static` : **Passe** (Vérifie la présence des 22 tables historiques et policies).
- `npm run test:brand-console` & `test:supplier-portal` : **Passe**, mais ce sont de simples vérificateurs syntaxiques de chaînes de caractères (ex: vérifie que le mot `tracefab` est dans le code).
- `npm run test:brand-console:browser` & `test:supplier-portal:browser` : **Passe**, mais ces tests Playwright s'exécutent en mode `?demo=1` (avec un mock mémoire) et ne testent **absolument pas** les interactions réelles avec l'API ou la base de données !
- `npm run test:neon:*` : Scripts de test d'intégration très complets mais nécessitant une instance Neon active (`DATABASE_URL`).
- **Test E2E complet manquant :** Aucun test n'exécute le parcours complet `Marque -> Invitation Fournisseur -> Réponse -> Revue -> Qualité -> Traceabilité -> DPP` avec un serveur API local et une vraie base.

---

## 19. READINESS COMMERCIAL & DÉPLOIEMENT PRODUCTION

### 19.1. Une marque textile pourrait-elle l'utiliser demain avec 50 fournisseurs ?
**RÉPONSE : NON.**
**Pourquoi ?**
1. Elle ne peut pas importer ses 50 fournisseurs ni ses 1 000 produits par fichier Excel/CSV : elle devrait saisir chaque produit et inviter chaque fournisseur un par un à la main dans des formulaires.
2. Elle ne peut pas voir le niveau de préparation DPP de ses produits (la fonction d'appel DPP n'est pas connectée).
3. Elle ne peut pas visualiser la chaîne de ses fournisseurs (Supply Chain Graph non exposé).
4. Elle ne peut pas relancer ses fournisseurs en retard d'un simple clic.

### 19.2. Un fournisseur réel accepterait-il de l'utiliser ?
**RÉPONSE : TRÈS DIFFICILEMENT.**
**Pourquoi ?**
1. S'il n'est pas invité par une marque, il ne peut même pas créer son compte fournisseur sur le portail.
2. Il ne peut pas déclarer ses propres produits pour les proposer à plusieurs marques.
3. Il n'a aucune garantie visuelle sur ce qui est partagé ou non avec telle marque (`data_shares` non visible).
4. L'interface mobile est inconfortable pour le téléversement de certificats ou la prise de photo de preuves d'atelier.

---

## 20. FICHES DÉTAILLÉES DES ANOMALIES & BLOQUANTS CRITIQUES

### Fiche 1 : Rupture d'injection des réponses de collecte dans les Data Points Produit
- **Problème :** Lorsqu'une marque valide une réponse fournisseur (`tracefab_review_data_response`), aucune donnée n'est créée dans la table `data_points`.
- **Impact :** Les données collectées ne sont pas capitalisées comme des faits traçables du produit. Le moteur de qualité produit reste bloqué.
- **Gravité :** Bloquant absolu (P0).
- **Fichiers concernés :** `prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql`, `api/_routes/data-responses/[responseId]/review.ts`.
- **Solution :** Mettre à jour `tracefab_review_data_response` ou créer un service d'injection pour créer/mettre à jour une ligne dans `data_points` avec `product_id = request.product_id`, `status = 'verified_by_reviewer'`, `source_document_id = response.source_document_id`, et lier à la version courante du produit.
- **Estimation :** 1.5 jour.
- **Priorité :** P0.

### Fiche 2 : Absence de `FORCE ROW LEVEL SECURITY` sur les tables PostgreSQL
- **Problème :** Les RLS policies ne s'appliquent pas au propriétaire de la base (`neondb_owner`). Prisma exécutant les requêtes sous ce compte, les règles RLS sont court-circuitées sur toutes les requêtes Prisma classiques.
- **Impact :** Risque critique de fuite inter-organisations (multi-tenant leak).
- **Gravité :** Bloquant de sécurité (P0).
- **Fichier concerné :** `prisma/migrations/...`.
- **Solution :** Créer une migration Prisma exécutant `ALTER TABLE ... FORCE ROW LEVEL SECURITY;` sur l'ensemble des 25 tables du schéma, et créer un rôle applicatif non-superuser dédié à la connexion de l'API.
- **Estimation :** 0.5 jour.
- **Priorité :** P0.

### Fiche 3 : Faille de contrôle d'accès sur le téléchargement de documents
- **Problème :** L'endpoint `/api/documents/:documentId/download` ne valide pas que l'organisation de l'utilisateur a accès au document demandé.
- **Impact :** Téléchargement de documents confidentiels inter-marques / inter-fournisseurs.
- **Gravité :** Bloquant de sécurité (P0).
- **Fichier concerné :** `api/_routes/documents/[documentId]/download.ts`.
- **Solution :** Vérifier dans la transaction que le document appartient à l'organisation de l'utilisateur OU qu'il est rattaché à une demande / relation / partage autorisé pour cette organisation.
- **Estimation :** 0.5 jour.
- **Priorité :** P0.

### Fiche 4 : Endpoints et interface Supply Chain Graph inexistants
- **Problème :** Les fonctions SQL du graphe ne sont connectées ni à l'API ni au Brand Console.
- **Impact :** La fonctionnalité stratégique de traçabilité textile est invisible pour les clients.
- **Gravité :** Bloquant de lancement (P0).
- **Fichiers concernés :** Création de `api/_routes/products/[productId]/supply-chain.ts`, mise à jour de `brand-console/index.html`.
- **Solution :** Créer l'endpoint API branché sur `tracefab_get_product_traceability` et intégrer un composant de visualisation interactif dans le Brand Console.
- **Estimation :** 2.5 jours.
- **Priorité :** P0.

### Fiche 5 : Endpoints et indicateurs DPP Readiness inexistants
- **Problème :** Le calcul de readiness DPP n'est pas exposé via l'API et n'a aucune interface dans la console de marque.
- **Impact :** La proposition de valeur centrale de TRACEFAB ("préparer vos Digital Product Passports") n'est pas démontrable.
- **Gravité :** Bloquant de lancement (P0).
- **Fichiers concernés :** Création de `api/_routes/products/[productId]/dpp.ts`, mise à jour de `brand-console/index.html`.
- **Solution :** Créer l'endpoint `POST/GET /api/products/:id/dpp` appelant `tracefab_compute_dpp_readiness`, et ajouter l'onglet DPP dans la fiche produit avec jauge explicable et checklist des éléments manquants.
- **Estimation :** 2 jours.
- **Priorité :** P0.

### Fiche 6 : Onboarding Fournisseur autonome bloqué
- **Problème :** Un fournisseur sans invitation préalable ne peut pas s'inscrire ou créer son entité.
- **Impact :** Empêche tout onboarding autonome ou inbound.
- **Gravité :** Bloquant (P0).
- **Fichiers concernés :** `supplier-portal/index.html`, `api/_routes/organizations.ts`.
- **Solution :** Ajouter un écran d'accueil dans le portail fournisseur permettant de créer son organisation fournisseur et d'initialiser son profil dès la première connexion Clerk.
- **Estimation :** 1 jour.
- **Priorité :** P0.

### Fiche 7 : Absence de contrôles de partage fournisseur (`data_shares`)
- **Problème :** Le fournisseur ne peut pas visualiser ni restreindre ce qu'il partage avec chaque marque.
- **Impact :** Frein majeur d'adoption pour les fabricants soucieux du secret industriel.
- **Gravité :** Important (P1).
- **Fichiers concernés :** `api/_routes/supplier/data-shares.ts`, `supplier-portal/index.html`.
- **Solution :** Implémenter l'API de gestion des partages et l'interface "Partages & Confidentialité" dans le portail fournisseur.
- **Estimation :** 2 jours.
- **Priorité :** P1.

### Fiche 8 : Actions d'acquittement et dérogation (Waiver) absentes de l'UI
- **Problème :** Les issues qualité ne peuvent pas être acquittées ou dérogées dans la Brand Console.
- **Impact :** Le Quality Center est purement informatif et ne permet pas de traiter les blocages.
- **Gravité :** Important (P1).
- **Fichiers concernés :** `brand-console/index.html`.
- **Solution :** Ajouter les boutons "Acquitter" et "Dérogation avec motif" sur chaque carte d'issue qualité.
- **Estimation :** 0.5 jour.
- **Priorité :** P1.

---

## 21. ROADMAP DE FINALISATION PAR CHANTIERS

Conformément à la règle de travail stricte : **aucun développement massif désordonné**, exécution chantier par chantier, tests systématiques et validation à chaque étape.

### CHANTIER 1 (P0) — Sécurité, Isolation Multi-Tenant & Correctifs d'API
1. Migration SQL : application de `FORCE ROW LEVEL SECURITY` sur toutes les tables.
2. Durcissement de `/api/documents/:documentId/download` avec contrôle d'autorisation strict.
3. Création des endpoints manquants pour les Data Points produit : `POST/GET /api/products/:productId/data-points`.
4. Écriture du test de sécurité automatisé sans bypass possible.

### CHANTIER 2 (P0) — Pont Collecte → Data Points & Automatisation Qualité
1. Mise à jour de la transition de revue : quand une marque vérifie une réponse, injection automatique dans `data_points` avec `product_id`.
2. Déclenchement automatique du recalcul du score qualité produit après approbation d'une demande.
3. Test d'intégration automatisé du flux complet : Réponse -> Revue -> Data Point -> Qualité à jour.

### CHANTIER 3 (P0) — Exposition & Intégration de la Traçabilité (Supply Chain Graph)
1. Création de l'API Supply Chain : `GET/POST /api/products/:productId/supply-chain`.
2. Création des endpoints de nœuds et liens de traçabilité.
3. Création de la vue Supply Chain Graph dans le Brand Console avec visualisation interactive des étapes de filature, tissage, teinture, confection.

### CHANTIER 4 (P0) — Exposition & Intégration du DPP Readiness
1. Création de l'API DPP : `GET/POST /api/products/:productId/dpp`.
2. Intégration dans le Brand Console : jauge de score explicable (Composition, Origine, Preuves, Traçabilité) et liste des données manquantes.
3. Action de validation marque : `mark_dpp_ready_to_publish`.

### CHANTIER 5 (P0) — Onboarding Fournisseur Autonome & Déblocage Portail
1. Ajout de l'écran de création d'organisation fournisseur dans le Supplier Portal.
2. Ajout de l'assistant de démarrage (Wizard : Entreprise -> Site -> Preuve -> Première donnée).
3. Suppression du blocage `supplier_organization_not_found`.

### CHANTIER 6 (P1) — Finalisation Brand Console & Quality Center
1. Ajout des boutons d'acquittement et de dérogation (Waiver) motivée sur les issues qualité.
2. Ajout du bouton de relance fournisseur manuelle en 1 clic.
3. Tableau de bord enrichi : indicateurs de DPP readiness, données manquantes et alertes d'expiration de certificats.

### CHANTIER 7 (P1) — Contrôles de Partage Fournisseur (`data_shares`) & Matériaux
1. API et écran de gestion des partages dans le portail fournisseur.
2. Partage explicite des matériaux du fournisseur vers les marques clientes.

### CHANTIER 8 (P1) — Import / Export Catalogue (Product & Supplier Onboarding en masse)
1. Import CSV/Excel de produits pour la marque.
2. Import CSV/Excel de fournisseurs avec invitation groupée.
3. Export des dossiers d'audit et fiches de données.

### CHANTIER 9 (P2) — Référentiel des Certifications & Infrastructure Staging/Prod
1. Catalogue normé des standards textiles (GOTS, OEKO-TEX, etc.).
2. Déploiement et raccordement des services réels (Bucket S3 privé, Scanner antivirus, Resend configuré, Webhook d'alerte).
3. Test E2E Playwright non-mocké sur environnement de staging complet.

---

## 22. DÉFINITION DU MVP COMMERCIAL

Le **MVP commercial** vendable à une première marque textile pilote avec 10 à 50 fournisseurs comprend obligatoirement :

### Côté Marque (Brand Console) :
- Compte organisationnel sécurisé avec rôles d'équipe.
- Import et gestion des produits (références, matières, compositions, identifiants).
- Invitation et gestion des fournisseurs (statut d'invitation, relance en 1 clic).
- Émission de demandes de données fondées sur le questionnaire textile core.
- Revue et vérification des réponses et des preuves documentaires.
- Vue du graphe de traçabilité multi-tiers du produit.
- Score explicable de préparation DPP (Readiness) avec plan d'action des données manquantes.
- Quality Center avec capacité de dérogation (Waiver) tracée.

### Côté Fournisseur (Supplier Portal) :
- Onboarding simple (soit via invitation marque, soit autonome).
- Profil d'entreprise et déclaration des sites de production.
- Référencement de ses matières et de ses certificats avec upload de justificatifs.
- Espace de réponse aux demandes marque avec sauvegarde en brouillon et soumission.
- Tableau de bord de confidentialité (contrôle de ce qui est partagé à chaque marque).

### Côté Plateforme & Données :
- Data Points immuables, qualifiés et versionnés.
- Stockage documentaire privé sécurisé (SigV4).
- Isolation multi-tenant étanche garantie par base de données.
- File d'attente d'envois d'emails et relances automatiques programmées.

### Ce qui est reporté après le lancement pilote :
- Module d'intelligence artificielle documentaire (OCR de certificats).
- Connecteurs automatiques ERP / PLM (SAP, Centric, Lectra).
- Page publique consommateur du DPP (rendu QR code public).
- Système de facturation / abonnements Stripe.

---

## 23. CHECKLIST FINALE DE LANCEMENT (PILOT LAUNCH CHECKLIST)

- [x] **Sécurité :** `FORCE ROW LEVEL SECURITY` activé sur les 25 tables Neon.
- [x] **Sécurité :** `/api/documents/:id/download` audité et hermétique entre tenants.
- [x] **Data Flow :** Réponses de collecte transformées en `data_points` produit lors de la validation.
- [x] **Qualité :** Moteur qualité produit alimenté sans issue systématique `product_no_data_points`.
- [x] **Traçabilité :** Graphe Supply Chain exposé en API et visible dans le Brand Console.
- [x] **DPP :** Jauge de score DPP Readiness visible avec ventilation explicable.
- [x] **Onboarding :** Portail fournisseur accessible aux nouveaux inscrits sans crash.
- [x] **UX :** Actions d'acquittement et de waiver accessibles dans le Quality Center.
- [ ] **Production :** Bucket S3 privé configuré avec permissions strictes.
- [ ] **Production :** Domaine d'envoi d'emails Resend validé (DKIM/SPF).
- [ ] **Tests :** Au moins un test E2E automatisé validant la traversée complète du parcours critique sur une base de données réelle.

---

**Fin du document d'audit.**  
*Rapport prêt pour validation avant le démarrage du Chantier 1 (Bloquants architecture & sécurité).*
