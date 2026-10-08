# Chantier 02 — Design System v3

_8 octobre 2026 · branche `arena/df246958-tracefab`._

## Objectif

Unifier le socle visuel sans toucher aux contrats : une seule famille
typographique, un socle tactile/motion partagé par toutes les pages, et des
composants communs (statuts de donnée, états vides/erreur, tables, KPI)
prêts pour les chantiers applicatifs suivants.

## Ce qui existait

- `tracefab-core.css` v3.0 : tokens complets (palette, typographie Inter
  Tight, échelle de confiance, motion, reduced-motion) — mais chargé
  uniquement par la landing, `passport/` et `product-intelligence/`.
- `tracefab-touch.css` : plancher tactile 40 px chargé par toutes les pages.
- Quatre SPA (Brand Console, Supplier Portal, Quality Center, Operations) +
  `invitations/accept` : CSS inline déclarant
  `font-family: Inter, ui-sans-serif…` **sans aucune police chargée** — le
  rendu basculait sur la police système, en rupture avec la landing.
- `src/app/globals.css` et `tailwind.config.js` : `Plus Jakarta Sans`,
  dernière famille concurrente du dépôt.
- Aucun composant partagé pour les sept statuts de la donnée, les états
  vides/erreur ou les tables : chaque vue réinventait les siens.

## Ce qui a changé

### 1. Famille unique — Inter Tight (variable) + JetBrains Mono

Les cinq pages ci-dessus reçoivent les `preconnect` + la feuille Google Fonts
(identique à la landing : `Inter Tight wght@400..700`, et `JetBrains Mono`
là où des données techniques sont affichées), et leur stack racine devient
`'Inter Tight', Inter, ui-sans-serif…`. Les SPA qui utilisent
`var(--font-mono)` reçoivent la définition du token.
`Plus Jakarta Sans` disparaît de `globals.css` et `tailwind.config.js`.
CSP déjà compatible (`style-src fonts.googleapis.com`, `font-src
fonts.gstatic.com`), aucun header modifié.

### 2. Socle partagé — `tracefab-touch.css` étendu (toujours chargé en dernier)

- CTA primaires à **44 px** (`--tf-touch-target`, WCAG 2.5.5) ; le plancher
  commun testé de 40 px ne bouge pas (la règle ne peut qu'agrandir).
- Focus clavier `:focus-visible` unique (contour émeraude, offset 2 px,
  variante claire sur fonds sombres).
- `::selection` aux couleurs de la marque.
- Garde `prefers-reduced-motion: reduce` **globale** : elle couvrait déjà les
  pages chargeant core.css, elle protège désormais aussi consoles, portail,
  quality-center et operations.

### 3. Composants communs — `tracefab-components.css` (nouveau)

Classes préfixées `.tf-c-*` / `.tf-status*`, zéro collision avec l'existant ;
chaque couleur emploie le token v3 avec repli hexadécimal, donc les composants
fonctionnent aussi sur les pages sans core.css.

- `.tf-status--{missing,needs-review,declared,documented,verified,third-party-certified,expired}`
  (+ variante sombre `.tf-on-dark`) — l'échelle de confiance complète,
  sans jamais confondre déclaration / preuve / certification tierce.
- `.tf-c-empty` (icône, titre, texte) et `.tf-c-error` (message + Retry) —
  les deux états que chaque écran doit savoir rendre.
- `.tf-c-table` : en-têtes sticky, tri `aria-sort`, chiffres mono tabulaires.
- `.tf-c-action` : le lien « donnée → remédiation » avec flèche animée.
- `.tf-c-kpi` : KPI cliquable (label, valeur, indice) pour le Command Center.

Feuille branchée sur : brand-console, supplier-portal, quality-center,
operations, dpp, passport, product-intelligence — toujours **avant**
`tracefab-spa-responsive.css` et `tracefab-touch.css` qui gardent la
priorité de cascade. `invitations/accept` ne la charge pas (aucun de ces
composants n'y est utilisé).

## Ce qui n'a PAS changé (non-régression)

- Aucun nom de classe existant renommé, aucun contrat d'attribut touché.
- Aucun test modifié ; les tailles minimales existantes ne peuvent que
  croître ; landing inchangée (ses tests de performance polices passent).
- Palette, tokens, structure des feuilles v3 conservés.

## Vérifications

Matrice offline complète : **31/31 PASS** — typecheck, schema:static, routes,
i18n, chantiers 1–8, docai, plm-erp, pef, green-claims, brand-console,
supplier-portal, questionnaires, risk, démo DPP/certifications, portail
mobile, console, 4 suites landing, scheduler et observabilité notifications.

Non exécutables dans ce sandbox (documenté) : parcours Playwright
(`test:console-css`, `test:touch-targets`, `verify_locales`) qui exigent des
navigateurs, et flux Neon qui exigent une base.

## Résiduel (passé aux chantiers suivants)

- L'adoption effective des composants `.tf-c-*` dans les vues se fait au fil
  des chantiers 05–13 (Quality Center, Command Center, Evidence…).
- Le re-skin complet de la Brand Console par `tracefab-console.css` reste à
  brancher (le fichier existe mais n'est chargé que par product-intelligence)
  — chantier 04/05, car il touche le rendu de 17 vues.
- `passport/` et `operations/` restent à migrer sur le catalogue i18n unique
  (chantier 15).
