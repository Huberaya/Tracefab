# Chantier 05 — Brand Command Center

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif

Faire de l'écran d'accueil de la Brand Console un véritable centre de
commande — **WHERE ARE WE / WHAT'S MISSING / WHAT'S RISKY / NEXT** — où
chaque chiffre est calculé depuis l'état réel et chaque KPI est cliquable,
et doter les grandes tables (produits, fournisseurs, demandes) des outils
attendus d'un produit de niveau supérieur : tri, filtre, colonnes, export,
vues sauvegardées, actions de groupe.

## Principes directeurs

1. **Vérité des données.** Aucun chiffre en dur. L'ancienne overview
   affichait des valeurs fabriquées (« 214 sites », « 97.6 % »,
   « 1 098 styles », badges « GRADE A », « COMPLET », « CIRPASS 1.2 »,
   alertes 17/8/5/12) : elles ont toutes été supprimées et remplacées par
   des métriques dérivées de `state` (produits, fournisseurs, demandes,
   certifications) ou par un tiret « non mesuré » quand la donnée manque.
2. **Le moteur de tables n'invente rien.** `tf-tables.js` est purement DOM :
   aucun appel réseau ; il n'opère que sur les lignes déjà rendues par la
   console. Les actions de groupe appellent des fonctions réelles
   (`remindRequest`) — jamais de simulation de succès.
3. **Additif uniquement.** Vues et handlers existants conservés (le filtre
   statut/recherche de la vue Demandes reste en place, les quick actions
   aussi) ; l'i18n injecté par générateur additif idempotent.
4. **i18n complet.** Namespace `command` : 45 clés × 7 langues
   (EN/FR/DE/IT/ES/NL/PT), FR irréprochable ; TR/ZH exclues (repli anglais).
5. **Accessibilité.** Tri au clavier avec `aria-sort`, filtres étiquetés,
   respect de `prefers-reduced-motion`.

## Ce qui existait avant

- Overview « Mission Control » : hero + 4 cartes domaines + panneau
  d'attention, truffés de chiffres en dur non dérivés de l'état.
- Tables produits/fournisseurs/demandes sans tri ni gestion de colonnes ;
  filtre manuel propre à la seule vue Demandes ; export CSV catalogue/audit
  existant mais global.
- Pas de vues sauvegardées, pas de sélection massive.

## Ce qui a été ajouté

| Fichier | Rôle |
| --- | --- |
| `assets/js/tf-tables.js` | Moteur de tables : tri (numérique-aware, `aria-sort`), filtre insensible aux accents, visibilité des colonnes, export CSV (lignes visibles ou sélection), vues sauvegardées (`localStorage` `tracefab.tableViews.<id>`), sélection massive + barre d'actions de groupe ; état tri/filtre mémorisé en mémoire par table pour survivre aux re-rendus. |
| `assets/design-system/tracefab-command.css` | Styles `.cc-*` (sections, KPI, pastilles de sévérité, chips calculés, actions prioritaires) et `.tft-*` (toolbar, menus, barre bulk, indicateurs de tri). |
| `scripts/_chantier05_command_i18n.json` | Source unique des 45 clés × 7 langues. |
| `scripts/build_command_i18n.mjs` | Générateur additif/idempotent borné au namespace `command` (compatible garde de consolidation). |
| `scripts/test_command_chantier5.mjs` | Test de contrat (voir ci-dessous). |
| `package.json` | Script `test:command:chantier5` ajouté à la chaîne `npm test`. |

## Ce qui a été modifié (brand-console/index.html uniquement)

- **Overview refondue** en quatre sections, toutes dérivées de l'état :
  - **WHERE** : 8 KPI cliquables (produits, fournisseurs, sites, pays,
    complétude moyenne, qualité moyenne fournisseurs, préparation DPP,
    certifications) avec chips d'état calculés (sur la bonne voie / à
    surveiller / critique / non mesuré).
  - **MISSING** : produits incomplets, demandes ouvertes, réponses à
    contrôler ; état vide dédié si rien ne manque.
  - **RISKY** : demandes en retard (critique), échéance ≤ 7 jours, produits
    « needs review », certifications expirant sous 90 jours ; état vide
    dédié si aucun risque.
  - **NEXT** : actions prioritaires conditionnelles (relancer les retards,
    contrôler les réponses soumises, lancer une collecte pour les produits
    incomplets, inviter un premier fournisseur) branchées sur les vues et
    modales existantes.
  - Hero strip et quick actions conservés ; faux chiffres et badges
    assertifs supprimés.
- **Tables** produits/fournisseurs/demandes marquées pour le moteur
  (`data-tftable`, `th[data-tfsort]`, `tr[data-tf-id]`) ; `requestTable`
  accepte un mode amélioré utilisé par la vue Demandes (et son filtre
  existant re-monte le moteur après re-rendu).
- **`bind()`** : enregistrement des trois tables auprès de TFTables,
  traduction `command.*` via TF_I18N, montage après chaque rendu ; action de
  groupe « Relancer les fournisseurs » = boucle réelle sur `remindRequest`.
- Pont public étendu : `window.tracefabBrandConsole` expose désormais aussi
  `remindRequest` (le test de contrat du chantier 04 a été mis à jour en
  conséquence).

## Ce qui a été supprimé

Uniquement les chiffres et affirmations fabriqués de l'ancienne overview
(voir « Vérité des données ») et le CSS mort associé côté rendu ; aucune
fonctionnalité retirée.

## Contrats vérifiés par `scripts/test_command_chantier5.mjs`

1. Moteur : aucun fetch/XHR/import, API setT/register/mount, export CSV
   Blob, vues sauvegardées, accessibilité tri, sélection massive.
2. CSS : classes `cc-*`/`tft-*`, `prefers-reduced-motion`.
3. Overview : 4 sections présentes, KPI cliquables, calculs depuis
   `state.requests`/`state.certifications`, six faux chiffres/affirmations
   vérifiés absents.
4. Tables : marquage, enregistrement auprès du moteur, action bulk = appel
   réel à `remindRequest`, exposition du pont public.
5. i18n : 45 clés × 7 langues paritaires, bloc présent dans en.js et les six
   locales complètes, TR/ZH exclus.
6. Générateur : idempotent, sans motif de suppression.

## Non-régression

- `npm run test:i18n` vert : parité stricte confirmée (2185 + 45 clés ×
  6 locales complètes), garde générateurs OK.
- Matrice hors-ligne : **22/24 suites PASS**. Les 2 échecs
  (`test:wallet:chantier9`, `test:storage:chantier10`) proviennent de
  l'impossibilité de générer le client Prisma dans la sandbox — échec
  identique sur le commit de base, sans lien avec ce chantier.
- Smoke Node : chargement du moteur, API complète, montage à vide et garde
  anti-double-instance vérifiés.
- Aucune route API, migration ou schéma modifiés : auth, invitations,
  demandes, documents, certifications, qualité, traçabilité, DPP et
  isolation tenant intacts.

## Limitations connues

- Les vues sauvegardées sont locales au navigateur (localStorage), pas
  synchronisées côté serveur — à brancher sur une préférence utilisateur le
  jour où l'API de préférences existera.
- L'export CSV reflète les colonnes visibles et le filtre courant (choix
  assumé : on exporte ce qu'on voit).
- Le tri/filtre opère sur les lignes rendues : pas de pagination serveur
  ajoutée ici (relève du chantier « Sécurité & Performance »).
- Le Supplier Portal n'est pas concerné par ce chantier (chantier 06 de la
  roadmap : Supplier Portal 2.0).

## Prochaine étape suggérée

Chantier 06 de la roadmap : **Supplier Portal 2.0** (dashboard
« WHAT DO I NEED TO DO? », onboarding, partages par marque, mobile-first) —
à confirmer avec l'utilisateur.
