# TRACEFAB — Proposition produit issue de l'audit UI/UX

**Date : 2026-10-26**
**Branche : `arena/63303a21-tracefab`**
**Références :** `01-RAPPORT-DIAGNOSTIC.md`, `02-RAPPORT-CORRECTIONS.md`.

Cette proposition hiérarchise des **fonctionnalités à construire**, distinctes des corrections déjà livrées. Elle ne formule aucune obligation juridique nouvelle et ne déclare pas le produit prêt à commercialiser.

---

## 0. Ce que l'audit change dans la lecture produit

Le produit possède déjà une colonne vertébrale solide : collecte fournisseur, qualité expliquée, traçabilité déclarée, préparation DPP interne, passeport public. Le risque commercial observé n'est pas l'absence de fonctionnalités : c'est **la frontière floue entre ce qui est réel, ce qui est préparatoire et ce qui est une maquette**. Trois exemples mesurés :

- un bouton « Preview DPP · draft » qui ouvre une URL publique exigeant une publication ;
- un « Evidence Centre » dont l'upload, le téléchargement et la vérification sont désactivés ;
- un Form Studio qui annonçait la création d'un protocole « disponible pour toutes les marques » sans aucune écriture serveur.

La priorité produit n'est donc pas « plus d'écrans », mais **la continuité du parcours marque : déclarer → prouver → contrôler → publier → revoir**. Chaque proposition ci-dessous ferme une rupture de cette chaîne.

**Utilisateurs cibles :** responsable conformité / RSE d'une marque (utilisateur principal), responsable qualité, acheteur / sourcing, fournisseur (contributeur), administrateur d'organisation, direction (arbitrage commercial).

---

## 1. P0 — Indispensables avant mise en avant commerciale

### P0-1. Dépôt, consultation et validation des preuves dans la console marque

| Champ | Contenu |
| --- | --- |
| **Problème** | L'« Evidence Centre » affiche des statistiques mais aucun document réel : upload, téléchargement et vérification sont désactivés, et aucune route ne liste les documents d'une organisation. La promesse « preuve documentaire » n'est pas tenue dans l'écran principal de la marque. |
| **Utilisateur** | Responsable conformité, responsable qualité. |
| **Valeur commerciale** | C'est l'argument central de différenciation : passer d'une donnée déclarée à une donnée documentée. Sans cela, le score de complétude reste perçu comme une opinion. |
| **Dépendances** | Backend : route de liste tenant-scopée, réutilisation de `upload-intent` du portail, stockage privé, antivirus, signatures d'accès temporaires, RLS, journalisation d'audit, rôles. Frontend : états de chargement, progression, erreurs, vide, succès. |
| **Risques** | Fuite inter-locataires si la liste n'est pas strictement bornée ; exposition de fichiers privés ; faux sentiment de vérification si le scan échoue silencieusement. |
| **Effort** | **L** (backend + frontend + sécurité, ~2 à 3 sprints). |
| **Critères d'acceptation** | 1. Un utilisateur peut déposer un PDF, voir la progression, un succès ou une erreur explicite. 2. Un échec d'antivirus ou de stockage n'est jamais présenté comme « vérifié ». 3. La liste n'affiche que les documents du locataire actif (test multi-locataire). 4. Chaque preuve porte un statut distinct : `declared`, `documented`, `verified_by_reviewer`. 5. Téléchargement par URL signée à durée limitée, journalisé. 6. Les états vide/erreur/chargement sont traduits dans 7 langues. |

### P0-2. Modèles de questionnaires versionnés côté serveur

| Champ | Contenu |
| --- | --- |
| **Problème** | Le catalogue `GET /api/questionnaires` est réel et versionné, mais aucune écriture n'existe. Le Form Studio créait un objet local perdu au rechargement avec un message de succès trompeur. La création est désormais désactivée honnêtement, ce qui laisse un besoin métier ouvert. |
| **Utilisateur** | Responsable conformité, administrateur d'organisation. |
| **Valeur commerciale** | Permet à chaque marque d'adapter ses campagnes de collecte (chimie, social, carbone) sans développement ; c'est un levier de rétention et de montée en gamme. |
| **Dépendances** | Schéma + migration + RLS + rôles, API `POST/PATCH/GET` avec version immuable, validation des champs et des types, garde-fou « un modèle publié n'est plus modifiable », frontend déjà structuré. |
| **Risques** | Modification d'un modèle utilisé par des demandes en cours ; conflits de clés ; régression sur les réponses existantes. |
| **Effort** | **M–L**. |
| **Critères d'acceptation** | 1. Créer un modèle puis recharger la page : il est toujours là, avec sa version. 2. Un modèle utilisé par une demande ne peut pas être modifié en place (nouvelle version). 3. Un contributeur sans droit reçoit un refus explicite, pas une mutation locale. 4. Le catalogue reste trié par version et localisé. 5. Aucune clé de formulaire n'est envoyée à l'API avant validation serveur. |

### P0-3. Aperçu du passeport brouillon (pré-publication)

| Champ | Contenu |
| --- | --- |
| **Problème** | « Preview DPP · draft » ouvre `/dpp/?gtin=…`, une page publique qui n'affiche un passeport que s'il est publié. Il n'existe aucun aperçu de l'état non publié : l'utilisateur ne peut pas relire ce qu'il s'apprête à valider. |
| **Utilisateur** | Responsable conformité, direction, service juridique. |
| **Valeur commerciale** | Réduit la peur de publier une information erronée ; raccourcit le cycle de validation interne ; rend la préparation DPP tangible avant la mise en ligne. |
| **Dépendances** | Route de lecture de brouillon authentifiée et tenant-scopée, marqueurs de provenance et de confiance, filigrane « brouillon — non publié », frontend réutilisant le rendu public. |
| **Risques** | Fuite de données non publiées ; confusion entre brouillon et passeport public ; cache d'une URL d'aperçu. |
| **Effort** | **M**. |
| **Critères d'acceptation** | 1. L'aperçu est accessible depuis la fiche produit et la vue DPP, avec un bandeau « brouillon non publié ». 2. Aucune valeur de démonstration ne subsiste dans un aperçu réel. 3. Chaque champ affiche sa provenance et son statut de confiance. 4. Un utilisateur non autorisé ne peut pas ouvrir l'aperçu d'un autre locataire. 5. L'aperçu n'est pas indexable et n'est pas mis en cache publiquement. 6. Un bouton distinct et explicite déclenche la revue de publication. |

---

## 2. P1 — Différenciation et fiabilité perçue

### P1-1. Reprise et persistance du parcours DPP

**Problème.** Les corrections de cette mission ont rétabli les liens profonds en démonstration, mais la reprise d'un dossier en cours contre l'API réelle n'est pas vérifiable ici ; les brouillons de saisie (composition, champs longs, pièces jointes) ne sont pas conservés si l'utilisateur quitte l'écran.
**Utilisateur.** Responsable conformité, contributeur occasionnel.
**Valeur commerciale.** Moins d'abandon sur un parcours long et multi-écrans ; meilleure perception de fiabilité.
**Dépendances.** Endpoint de brouillon côté produits ou stockage local chiffré avec réconciliation explicite ; stratégie de conflits de versions ; indicateur « enregistré à … ».
**Risques.** Écraser une modification d'un autre utilisateur ; faire croire à une sauvegarde serveur qui n'a pas eu lieu.
**Effort.** **M**.
**Acceptation.** Rechargement = même produit, même onglet, mêmes champs non encore soumis ; conflit de version signalé ; indicateur d'enregistrement horodaté ; aucune donnée d'un autre locataire reprise.

### P1-2. Contrôle de composition textile assisté

**Problème.** Le formulaire de nomenclature accepte un pourcentage par composant (`min=0`, `max=100`) mais n'affiche ni somme des composants, ni écart à 100 %, ni niveau de confiance par composant. Le score DPP « composition totalisée » reste donc difficile à corriger.
**Utilisateur.** Responsable produit, conformité.
**Valeur commerciale.** Rend le calcul de préparation compréhensible et actionnable, réduit les allers-retours avec les fournisseurs.
**Dépendances.** Validation serveur de la somme, règle de tolérance, provenance par composant, affichage des écarts.
**Risques.** Imposer une somme à 100 % à des produits multi-matières incomplets ; confondre « déclaré » et « vérifié ».
**Effort.** **M**.
**Acceptation.** Somme affichée en direct, alerte si ≠ 100 %, refus serveur d'une composition incohérente, message expliquant comment corriger, aucun chiffre inventé.

### P1-3. Permissions visibles selon le rôle

**Problème.** Le frontend annonce owner/admin/manager/contributor mais laisse souvent les boutons actifs ; l'utilisateur découvre l'interdiction par un toast d'erreur API.
**Utilisateur.** Tous les rôles, en particulier les lecteurs et contributeurs.
**Valeur commerciale.** Réduit la frustration et les tickets support ; renforce la perception de gouvernance.
**Dépendances.** Exposition structurée des permissions dans `/api/me`, composant partagé `can(action)`, tests par rôle.
**Risques.** Ne jamais considérer le masquage frontend comme une sécurité : l'API reste l'autorité.
**Effort.** **M**.
**Acceptation.** Chaque action interdite est désactivée avec une raison locale ; un appel direct reste refusé par l'API ; aucun test ne contourne l'autorisation serveur.

### P1-4. États d'attente, d'erreur et de vide homogènes

**Problème.** Certains écrans affichent un état vide sans action (portefeuille DPP), d'autres un « non calculé » sans bouton de recalcul, d'autres un spinner implicite. La grille de composants partagés existe mais n'est pas systématiquement utilisée.
**Utilisateur.** Tous.
**Valeur commerciale.** Augmente la confiance et l'autonomie ; réduit les interprétations erronées (« 0 » lu comme une vérité).
**Dépendances.** Composants partagés (empty / error / loading / retry / not-computed), recette UI, tests de non-régression.
**Risques.** Uniformiser en masquant une erreur réelle — interdit : tout état dégradé doit conserver son code d'erreur.
**Effort.** **S–M**.
**Acceptation.** Toute vue secondaire a 4 états traduits ; toute erreur expose un code et une action ; aucun « 0 » ne remplace un « non calculé ».

---

## 3. P2 — Finition, performance et dette

| ID | Proposition | Problème | Utilisateur | Valeur | Dépendances | Risque | Effort | Acceptation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P2-1 | Découpage du bundle `brand-console.1.js` | ~341 Ko bruts, `render()` reconstruit tout le DOM | Tous, mobile | FCP et réactivité sur réseaux lents | Découpage par vue, import dynamique, extraction de la couche API | Régressions de portée/événements | **M** | Taille initiale réduite mesurable, 20/20 parcours conservés, `test:assets` vert |
| P2-2 | Pictogrammes de langue au lieu des drapeaux emoji | Carrés « tofu » sur environnements sans police emoji | Tous | Finition perçue | Petits SVG locaux, catalogue i18n | Cassure de sélecteurs de langue | **S** | Rendu identique EN/FR/DE/IT/ES/NL/PT dans Chromium sans police emoji |
| P2-3 | Intégration de `test:mission-ui` et d'axe-core à l'étage CI `parcours` | Les 11 garde-fous ne sont pas encore lancés en CI | Équipe | Détection précoce des régressions | Workflow CI, temps de job | Allongement CI | **S** | Job vert, échec explicite si débordement mobile ou erreur console réapparaît |
| P2-4 | Rationalisation des routes implicites (`/passport/`) | Le README signale une route filesystem implicite | Ops | Réduction du risque de 404 en production | `vercel.json`, test de routes | Régression de routage | **S** | Route explicite documentée et testée pour `/passport/`, `/dpp/`, `/p/:gtin` |
| P2-5 | Tableau de bord de préparation (provenance par champ) | Les scores agrégés ne disent pas toujours d'où vient une valeur | Direction, conformité | Meilleure auditabilité | Agrégats de provenance | Surcharge d'information | **M** | Chaque KPI cliquable ouvre la liste des champs sources avec statut de confiance |

---

## 4. Feuille de route proposée

```
Sprint N+1 (P0)   ┌─ P0-1 preuves documentaires (backend + stockage + UI)
                  ├─ P0-2 modèles de questionnaire versionnés
                  └─ P0-3 aperçu brouillon du passeport
Sprint N+2 (P1)   ┌─ P1-1 reprise de parcours / P1-2 composition / P1-3 rôles
                  └─ P1-4 états homogènes + recettes de bout en bout
Sprint N+3 (P2)   └─ P2-1 bundle, P2-2 pictogrammes, P2-3 CI, P2-4 routes, P2-5 provenance
```

**Ordre imposé :** P0-1 avant toute mise en avant de « preuve vérifiée » ; P0-3 avant toute communication sur la publication DPP. Les trois P0 nécessitent un travail backend, donc une branche et une recette dédiées — ils ne peuvent pas être livrés par un correctif frontend.

---

## 5. Cadre de vérité — exigences, préparation, éléments non confirmés

| Catégorie | Traitement dans la feuille de route |
| --- | --- |
| **Exigences légales établies** | Aucune nouvelle obligation n'est affirmée. Les propositions P0-1 à P0-3 améliorent la traçabilité et la préparation sans prétendre à une conformité. Toute communication commerciale doit être relue par l'équipe juridique sur la base des textes officiels (non consultés depuis ce bac). |
| **Préparation recommandée** | Profil interne `textile_readiness_mvp` (9 exigences, 4 piliers), statuts de confiance, journal des décisions, relecture humaine avant publication. Les écrans doivent continuer à dire « indicateur de préparation, pas une certification ». |
| **Éléments sectoriels non confirmés** | PEF/PEFCR, GOTS, GRS, OEKO-TEX, SMETA, ZDHC, ISO 17025, GS1 Digital Link, CIRPASS JSON-LD sont cités comme **exemples** dans le dépôt. Leur caractère obligatoire, leur version et leur périmètre restent à confirmer ; ils ne doivent jamais être présentés comme une preuve de conformité. |
| **Exigences internes produit** | Locataire actif sur chaque appel privé, fail-closed, aucune démonstration injectée dans un écran réel, parité i18n stricte, états dégradés explicites, empreintes d'assets, tests de non-régression. |

**Ce que cette proposition ne dit pas :** que TRACEFAB est conforme à l'ESPR, que les passeports sont prêts pour une mise sur le marché, ou que la sécurité multi-locataire a été prouvée en production. Ces affirmations exigent une recette staging et une validation juridique externe.
