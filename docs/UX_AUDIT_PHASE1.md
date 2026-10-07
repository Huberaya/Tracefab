# TRACEFAB — Phase 1 · UX/UI Audit

Audit réalisé sur `arena/e72cecf4-tracefab`, commit de base `4ddf5f5`.
Chaque constat ci-dessous est **vérifié par commande** (grep / script), pas déduit. Les commandes de
vérification sont rappelées à la fin du document.

---

## 1. Ce qui existe réellement (inventaire)

Le repository n'est **pas** une application Next.js classique : c'est un **backend API headless +
surfaces HTML statiques autonomes**. C'est la contrête structurante de tout le travail de design.

| Surface | Fichier | Taille | Nature |
|---|---|---|---|
| Landing | `index.html` | 2 211 l. / 74 Ko | Marketing, CSS inline |
| Brand Console | `brand-console/index.html` | 4 302 l. / 266 Ko | App métier, appelle ~20 routes `/api/*` |
| Supplier Portal | `supplier-portal/index.html` | 1 272 l. / 134 Ko | App fournisseur, wrapper `fetch` générique |
| DPP consumer | `dpp/index.html` | 1 312 l. / 51 Ko | Passeport public |
| DPP legacy | `passport/index.html` | 788 l. / 28 Ko | Variante |
| Produit public | `p/at-ess-001.html` | 1 062 l. / 35 Ko | Exemple GTIN |
| Quality Center | `quality-center/index.html` | **49 l. / 15 Ko** | Coquille |
| Operations | `operations/index.html` | **14 l. / 8 Ko** | Coquille |
| Invitations | `invitations/accept/index.html` | 69 l. | Fonctionnel |

Backend : `api/index.ts` dispatche **~190 routes** (`api/_routes/**`) via un routeur regex maison,
48 modules dans `api/_lib/`, schéma Prisma + 39 migrations SQL, 26 documents d'architecture.
C'est un vrai produit : **ne rien casser, ne rien recréer.**

### Écart fonctionnel vs. la cible du brief

| Cible brief | État réel |
|---|---|
| Nav app : 13 domaines | Brand Console expose **3 vues** (`products`, `suppliers`, `requests`) |
| Supplier Portal riche | **2 vues** (`overview`, `requests`) |
| Quality Center fort | 49 lignes, pas de design system |
| Overview "mission control" | Absent |
| Product Intelligence / Lineage | Absent |
| Supplier Intelligence | Absent |
| Evidence Center | Absent |
| Intelligence Layer | Absent |
| Public DPP premium | Existe (`dpp/`), à requalifier |

---

## 2. Défauts bloquants vérifiés

### 🔴 B1 — Le `#why` est illisible (contraste 1.08:1)

`index.html` contient **deux blocs `:root`** (lignes **33** et **777**) issus de deux design systems
différents — un clair (`--tf-bone: #f8faf8`, `body{background:#ffffff}`) et un sombre
(`--tf-void-bg: #050f0b`, `body{background:#050f0b; color:#f5f8f5}`). Le second, plus tardif, gagne
la cascade sur `body`.

Or `.section-editorial-row` (ligne **430**, la section `#why`) **ne déclare aucun `background`** et
hérite donc du fond quasi noir, alors que `.editorial-headline` (ligne 451) reste en
`--tf-text-dark: #121814`.

Contraste mesuré (WCAG 2.1, luminance relative) :

| Paire | Ratio | AA (4.5) |
|---|---|---|
| `.editorial-headline` `#121814` sur `#050f0b` | **1.08:1** | **ÉCHEC** |
| `.section-eyebrow-chip` `#215c42` sur `#050f0b` | **2.48:1** | **ÉCHEC** |
| `.btn-pill-dark` `#163627` sur `#050f0b` | **1.47:1** | **ÉCHEC** |
| `.centered-title-big` sur `#f2f5f2` | 16.39:1 | OK |
| Hero `#ffffff` sur `#050f0b` | 19.45:1 | OK |

**La première section sous le hero est actuellement du texte noir sur fond noir.** C'est le défaut le
plus grave du site et il est invisible sans cascade CSS.

### 🔴 B2 — Le design system n'est branché nulle part

`assets/design-system/tracefab-ds.css` (187 l., v2.0) et `docs/DESIGN_SYSTEM.md` (v2.4) existent, mais
`grep -rn "tracefab-ds.css" --include=*.html --include=*.tsx --include=*.ts` renvoie **0 résultat**.
Aucune surface ne le charge. Pire, son vocabulaire de tokens (`--tf-primary`, `--tf-forest`) **n'est
utilisé nulle part** : les 4 surfaces ont chacune leur `:root` inline et **0 variable `--tf-`** partagée
(brand-console, supplier-portal et dpp ont 0 occurrence de `--tf-`).

Il n'y a donc **aucun design system en vigueur**. Il y a 4 systèmes de fait.

### 🔴 B3 — Aucune navigation mobile

`grep -in 'hamburger|menu-toggle|aria-expanded|mobile-nav|burger' index.html` → **0 résultat**.
Le header est une rangée flex de 6 liens + sélecteur de langue + "Sign in" + CTA. Sur 375 px, cela
déborde ou se replie en désordre, sans aucun moyen d'ouvrir la navigation.

Le brief (§28) exige une landing excellente sur mobile.

### 🟠 B4 — Les assets statiques ne sont probablement pas déployés

`vercel.json` déclare explicitement `builds` :

```json
{ "src": "api/index.ts", "use": "@vercel/node" },
{ "src": "**/*.html",    "use": "@vercel/static" }
```

Dès qu'un projet déclare `builds`, Vercel ne publie **que** la sortie de ces builders — la convention
`public/` ne s'applique plus. Or `index.html` charge `<script src="/i18n-engine.js">` (ligne 1458),
fichier qui vit dans `public/`. Aucune route ne le sert non plus.

**Risque : 404 en production → sélecteur de langue mort.** Non vérifiable ici (pas de déploiement
possible dans la sandbox) : c'est un risque à confirmer, pas une certitude. Corrigé de façon
additive en Phase 3.

### 🟠 B5 — i18n : quatre mécanismes concurrents

1. `public/i18n-engine.js` — dictionnaire `UI_DICTIONARY` **codé en dur**, 7 langues, 556 lignes.
2. `locales/{en,fr,de,it,es,nl,pt}/translation.json` — 143 clés plates, structuré, propre… mais
   `grep -rn "locales/"` ne le trouve que dans `scripts/test_p1_i18n.mjs`. **Jamais chargé au runtime.**
3. `public/auto-translate.js` + `public/translations_deep.json` (889 + 809 lignes) — troisième voie.
4. Un objet `translations` **inline** en bas de `index.html` (7 langues, clés `headline`/`lead`)
   qui ne correspond plus à aucun élément du DOM.

Le brief (§20) exige une architecture i18n native sans contenu métier codé en dur dans les composants.
L'état actuel est l'inverse : le runtime utilise le dictionnaire codé en dur et ignore le catalogue propre.

### 🟠 B6 — Conflit de portée JS sur la langue

`public/i18n-engine.js` expose `window.setLanguage` (l.538) et `window.toggleLangMenu` (l.544).
`index.html` redéclare `function setLanguage()` et `function toggleLangMenu()` **après** le chargement
du moteur (ligne 1923+). Les déclarations de fonction deviennent propriétés de `window` et **écrasent**
celles du moteur. Le comportement de bascule de langue dépend donc de l'ordre de chargement.

---

## 3. Défauts non bloquants vérifiés

| # | Constat | Preuve |
|---|---|---|
| N1 | `switchMockupTab()` cible `.rail-icon`, `.panorama-tag`, `.panorama-title` → **0 occurrence** dans le DOM | grep = 0 ; la fonction elle-même n'est jamais appelée (1 occurrence = sa définition) |
| N2 | Attribut `data-i18n` **dupliqué** dans le footer : `data-i18n="nav_platform" data-i18n="nav_platform"` | grep direct, 2 cas |
| N3 | `#demo-modal` porte `display:none` **deux fois** dans le même attribut `style` | grep direct |
| N4 | `<html lang="fr">` sur les **6 surfaces**, alors que le hero et le marketing sont en anglais | grep `<html lang=` |
| N5 | `inspectCoreNode(5)` (nœud « DPP READY ») appelle `showChainNode(5)` = `chainNodesData[5]` = *« PRODUCT RECONCILIATION LAYER »* ; le vrai nœud DPP est l'index **6**. Désalignement d'un cran | lecture `chainNodesData` |
| N6 | Emoji dans les données métier (`📍`, `⚡`, `🌍`) — contraire à la direction « editorial / precise » | grep |
| N7 | Le hero visuel est une **grille de 6 cartes** étiquetées `LAYER 01…07` : il confond les 7 couches d'architecture avec des domaines métier, et n'a **ni connecteurs ni flux de données** | lecture `.tf-radial-core-grid` |
| N8 | `assets/design-system/i18n.js` (131 l.) — quatrième artefact i18n, non chargé | grep |
| N9 | Seulement **3 media queries** dans 1 432 lignes de CSS (`1024px`, `640px`) pour 2 211 lignes de page | grep `@media` |

---

## 4. Ce qui est bon et doit être préservé

- **Le routeur API** (`api/index.ts`) : dispatch regex + imports dynamiques, ~190 routes, typé.
- **Le modèle de confiance à 6 niveaux** (`Declared → Documented → Verified → Certified`, + `Needs
  Review` / `Missing`) : c'est un vrai différenciateur produit, documenté dans `docs/DESIGN_SYSTEM.md`.
  Il doit devenir le vocabulaire visuel central, pas une note en bas de page.
- **La chaîne multi-échelons** `Fiber → Material → Mill → Dyeing → Manufacturing → Brand → Product` :
  concept juste, exécution à refaire.
- **`vercel.json` headers** : HSTS, CSP, COOP/CORP, nosniff — solides, à ne pas dégrader.
- **La base typographique** : Plus Jakarta Sans + JetBrains Mono est un bon choix. À pousser en
  hiérarchie éditoriale (titres très grands, labels techniques très petits).
- **Les tests** : 30+ scripts `scripts/test_*` couvrant sécurité, RLS, DPP, mass-balance, storage.
  Toute phase de design doit les laisser verts.

---

## 5. Priorisation

| Priorité | Item | Phase |
|---|---|---|
| P0 | B1 illisibilité `#why` | Phase 3 |
| P0 | B2 design system unique | Phase 2 |
| P0 | B3 navigation mobile | Phase 3 |
| P1 | B5/B6 i18n unifié sur `locales/` | Phase 12 (cadré dès la Phase 2) |
| P1 | B4 assets déployés | Phase 3 |
| P2 | N1–N9 | Phases 3 et suivantes |

---

## 6. Commandes de vérification

```bash
# B1 — cascade et contraste
grep -n ':root' index.html                       # → lignes 33 et 777
python3 - <<'EOF'                                # ratios WCAG (voir scripts/check_landing.mjs)
EOF

# B2 — design system orphelin
grep -rn "tracefab-ds.css" --include=*.html --include=*.tsx --include=*.ts .

# B3 — navigation mobile
grep -in 'hamburger|menu-toggle|aria-expanded|mobile-nav|burger' index.html

# B5 — locales non chargées au runtime
grep -rn "locales/" --include=*.js --include=*.mjs --include=*.html .

# N1 — cibles mortes
grep -c 'rail-icon\|panorama-tag\|panorama-title' index.html
```

Les vérifications sont désormais automatisées par `npm run check:landing`
(`scripts/check_landing.mjs`) : contraste WCAG, structure, i18n, routes, responsive.

---

# Phases 2 → 4 — exécutées

## Phase 2 — Design system

`assets/design-system/tracefab-ds.css` réécrit en **v3.0** : tokens (couleur, type, espace, radius,
shadow, motion, z), contextes de surface `light`/`dark`, typographie éditoriale, composants, textures
textiles SVG, motion + garde `prefers-reduced-motion`.

Source de vérité unique, propagée par `scripts/sync_design_system.mjs` :

```bash
npm run ds:sync     # écrit le fichier canonique dans les surfaces entre markers
npm run ds:check    # échoue si une surface a dérivé (branché sur build + test)
```

`docs/DESIGN_SYSTEM.md` mis à jour en v3.0.

## Phase 3 — Header, Hero, visuel Supply Chain, première section

`index.html` reconstruit (2 211 → 2 340 lignes).

**Header** — nav complète, sélecteur de langue accessible (`aria-haspopup`, `aria-expanded`,
`menuitemradio`, fermeture Escape + clic extérieur), **menu mobile** avec burger et
`aria-expanded`/`aria-controls`.

**Hero** — label, titre en 3 lignes, lead, 2 CTA, puis le **core de données TRACEFAB** : noyau
central + 10 domaines satellites (Suppliers, Products, Materials, Facilities, Documents,
Certifications, Evidence, Quality, Traceability, DPP), connecteurs SVG avec flux animé, déploiement
progressif au scroll. Le noyau sert de zone de lecture : survoler un domaine affiche son état et sa
valeur.

**Visuel signature** — la chaîne en 9 étapes (Fiber → Material → Spinning → Weaving → Dyeing →
Cutting → Assembly → Product → DPP) sous forme de **matrice** : 7 lignes d'attributs
(Supplier, Country, Facility, Certificate, Document, Data quality, Status) × 9 colonnes, visibles
simultanément. Sélection d'une colonne → colonne entière surlignée + fiche détaillée. Sous 720 px la
matrice devient une **pile verticale interactive**, une carte par étape.

**Première section** — les 7 couches d'architecture en colonne vertébrale, chacune avec sa question et
ses entités.

Sections suivantes réécrites sur le design system : Why (Overview → Explore → Inspect → Act),
Product Intelligence (aperçu produit + lineage), portée mondiale, promesse
« See it. Structure it. Verify it. Trace it. Prove it. », Resources, footer.

### Défauts de l'audit corrigés

| # | État |
|---|---|
| B1 illisibilité `#why` (1.08:1) | **corrigé** — un seul `:root`, surfaces explicites, plus faible ratio mesuré 4.63:1 |
| B2 design system orphelin | **corrigé** — canonique + `ds:sync` / `ds:check` |
| B3 navigation mobile absente | **corrigé** — burger + panneau, testé |
| B4 assets non déployés | **corrigé** — `vercel.json` publie `public/**` et `assets/**` + routes `/i18n-engine.js`, `/auto-translate.js`, `/translations_deep.json` |
| B6 conflit `setLanguage` | **corrigé** — la page consomme `window.setLanguage`, ne le redéfinit plus |
| N1 `switchMockupTab` mort | **supprimé** |
| N2 attributs `data-i18n` dupliqués | **corrigé** (vérifié par `check:landing`) |
| N3 `display:none` dupliqué | **corrigé** — `<dialog>` natif |
| N4 `lang="fr"` incohérent | **corrigé** — `lang="en"`, piloté par le moteur i18n |
| N5 désalignement `inspectCoreNode` | **corrigé** — un seul tableau `STAGES` indexé 0–8 |
| N6 emoji | **supprimés** (vérifié) |
| N7 hero = grille sans connexions | **corrigé** — graphe radial connecté |
| N9 3 media queries | 6 breakpoints, graphes → vues verticales |

**B5 (i18n : 4 mécanismes concurrents)** n'est pas résolu : c'est le périmètre de la **Phase 12**.
Cadré dès maintenant par `test:landing` section K, qui vérifie que toute clé `data-i18n` de la landing
existe dans les 7 langues du moteur.

**Nouveaux défauts trouvés et corrigés pendant la Phase 4** (par le vérificateur, pas à l'œil) :
`--tf-ink-400` à 4.32:1 sur paper et 3.74:1 sur fond de chip → passé à `#5a6860` (5.60 / 4.86) ;
`--tf-review` à 3.92:1 → passé à `#8a5607` (5.35) ; `.tf-demo-mark` et `.tf-lineage__i` utilisaient
`--tf-sf-text-dim` (2.48:1 en clair) → passés sur `--tf-sf-text-mute`.

## Phase 4 — Vérification

```bash
npm run check:landing   # 55 contrôles, 0 échec
npm run test:landing    # 71 assertions comportementales, 0 échec
```

`scripts/check_landing.mjs` — 29 paires de contraste WCAG mesurées **par contexte de surface**,
intégrité des ancres, attributs dupliqués, fuites de tokens CSS, ordre de cascade mobile, navigation
mobile, marquage des données de démonstration, emoji, reduced-motion, cibles des routes `vercel.json`.

`scripts/test_landing_surface.mjs` — charge le vrai `index.html`, exécute le vrai
`public/i18n-engine.js` **et** le script inline de la page dans un DOM, puis teste : structure de
l'orbite, interaction noyau/domaines, matrice 9×7, inspecteur d'étape, pile mobile, navigation,
bascule de langue, disclosure progressif, couverture i18n.

### Suite existante

| Commande | Résultat |
|---|---|
| `npm run typecheck` | PASS |
| `npm run schema:static` | PASS |
| `npm run ds:check` | PASS |
| `npm run check:landing` | PASS |
| `npm run test:landing` | PASS |
| `npm run test:p1-i18n` | PASS |
| `npm run test:brand-console` | PASS |
| `npm run test:supplier-portal` | PASS |
| `npm run test:questionnaires` | PASS |
| `npm run test:p1-quality` | PASS |
| `npm run test:p1-catalog` | PASS |
| `npm run test:p1-bom` | PASS |
| `npm run api:typecheck` | **FAIL — préexistant, hors périmètre** |

`api:typecheck` échoue pour 97 erreurs, toutes dans `api/` (0 fichier modifié par ce travail) :

- **85** : client Prisma non généré. `prisma generate` télécharge depuis `binaries.prisma.sh`, hors
  des hôtes autorisés de cet environnement. `node_modules/.prisma/client/index.d.ts` reste le stub
  npm (3 989 o, 0 modèle exporté).
- **8** : `api/_lib/wallet/apple-pass-generator.ts` utilise `zlib.crc32`, absent des typings de
  `@types/node@20.11.0` — version **épinglée dans `package-lock.json` au commit de base**, non modifiée.
- **4** : cascade du client non généré dans `api/_routes/catalog/audit-export.ts`.

Les tests E2E Playwright ne peuvent pas tourner ici : le téléchargement de Chromium est bloqué
(`npx playwright install chromium` échoue). **Aucune capture d'écran n'a donc été produite** ; la
validation visuelle reste à faire dans le navigateur.

### Défaut préexistant découvert hors périmètre

`npm run test:supplychain:chantier3` échoue sur
`Brand console must display Tier 4 stage` (`scripts/test_supply_chain_chantier3.mjs:104`).

Le test attend les libellés français `Tier 4 · Matières`, `Tier 3 · Filature`, `Tier 2 · Tissage`,
`Tier 1 · Confection`, `Tier 0 · Produit Fini`. `brand-console/index.html` ne contient que
`Tier 1`…`Tier 4` sans suffixe.

**Préexistant, non causé par ce travail** : `git diff --stat HEAD -- brand-console/index.html`
renvoie 0 ligne — le fichier est identique au commit de base. La Phase 3 n'a pas touché la Brand
Console. À traiter en **Phase 5** (Dashboard / Overview / Product Intelligence), en décidant
explicitement si ce sont les libellés ou le test qui doivent bouger.

---

# Itération 3.1 — refonte de la landing (retour « la landing est à améliorer »)

## Diagnostic

La page était *compétente* mais se lisait comme une **spécification de système**, pas comme un
**produit qu'on voit fonctionner**. Trois défauts mesurés :

| Défaut | Preuve |
|---|---|
| Le moment fort ne se détachait pas | Hero et section WOW partageaient exactement le même fond `--tf-forest-900: #06120d`. Zéro rupture, donc aucun rythme — alors que le §24 en demande un. |
| De l'UI fausse | Les 11 onglets Product Intelligence avaient un état actif stylé (`.is-on`, bordure accent) et **0 handler JS**. Un acheteur technique clique la première chose qui a l'air interactif. |
| Aucune valeur en 30 s | Pas de chiffre clé, pas de « pour qui ». Le test CEO du §31 échouait. |
| §28 non respecté sur l'orbite | `grep tf-orbit-frame` → 2 occurrences, **0 media query**. La matrice avait son empilement vertical, l'orbite non. |

## Angle mort du vérificateur, corrigé

`check:landing` mesurait `--tf-sf-text` **à pleine opacité** et ne modélisait pas `opacity`.
Les mots de la section Promesse sont à `opacity: .42` au repos : couleur effective `#69726e` sur
`#06120d` = **3.85:1** — conforme, mais uniquement parce qu'il s'agit de texte large (≥24 px,
seuil 3.0). À 18 px ce serait un échec. Le vérificateur ne voit toujours pas l'opacité : à traiter.

Deuxième angle mort, plus grave : après avoir passé la matrice en clair, le vérificateur la mesurait
encore en contexte **dark** — **faux positif**. Les paires de contraste portent désormais leur
contexte explicitement et la matrice est mesurée en light.

## Changements

1. **Bandeau de preuve** juste après le hero, en clair : 12 chiffres clés en 4 groupes
   (Supply chain / Data / Traceability / Readiness), `tabular-nums`, marqué « Demonstration data ».
   Rupture de rythme immédiate dark → light.
2. **Section WOW en clair** (`--tf-paper-2`). Une matrice de 63 cellules se scanne sur clair.
   Rythme obtenu : dark → light → paper-2 → light → light → paper-2 → light → paper-2 → **dark** → light → **dark**.
3. **Onglets Product Intelligence réels** : 11 onglets `role="tab"`, `aria-selected`, tabindex
   rotatif, navigation clavier ←/→, panneau `role="tabpanel"` avec contenu et badges de confiance
   pour chaque onglet.
4. **Section « Who it is for »** : les 3 personas du §31 (CEO / Compliance / Fournisseur), chacun
   avec sa question et son point d'entrée réel.
5. **Traitement mobile de l'orbite** : sous 720 px le graphe radial devient une liste de domaines
   cliquables au-dessus d'une zone de lecture persistante.
6. **`--tf-ink-300` : `#97a49d` → `#647264`.** Le token « dimmest » était à **2.33:1** sur paper-2.
   Il passe à 4.56:1 tout en restant plus clair que `--tf-ink-400` (5.26:1) : la hiérarchie à trois
   niveaux est préservée au lieu d'être sacrifiée.

## Vérification

```
check:landing  67 contrôles, 0 échec   (41 paires de contraste, contextes explicites)
test:landing   95 assertions, 0 échec  (bandeau de preuve, personas, onglets réels inclus)
```

`typecheck`, `schema:static`, `ds:check`, `test:p1-*`, `test:brand-console`, `test:supplier-portal`,
`test:questionnaires` : PASS.

## Toujours non vérifié

**Aucune capture d'écran.** Tentative d'installer Chromium via `@sparticuz/chromium` (binaire
présent dans le tarball npm) : les 3 libs manquantes (`libnspr4`, `libnss3`, `libnssutil3`) sont
fournies par la couche `al2023` du package et se chargent, mais le processus reste bloqué sur
l'initialisation GPU/viz malgré `--disable-gpu`, SwiftShader et les polices du package.
`--single-process` segfault (133). WeasyPrint indisponible (ni pango ni cairo, pas de fontconfig).

**La validation visuelle reste à faire dans un navigateur.** Ce qui est prouvé : structure,
comportement, contraste, ancres, cascade, accessibilité déclarative. Ce qui ne l'est pas :
l'équilibre des masses, le rythme réel au scroll, le rendu typographique.

---

# Phase 8 — Evidence & Quality : le Quality Center

## Ce que j'avais écrit de faux

L'audit Phase 1 qualifiait le Quality Center de « coquille de 49 lignes ». **C'était faux.**
Le fichier est écrit en lignes denses : 49 lignes = 14 918 octets d'application fonctionnelle
(bootstrap Clerk, mode démo, vue d'ensemble, acquittement, waiver, scores). Compter les lignes
d'un fichier minifié ne dit rien ; il faut compter les octets et chercher les comportements.

## Le vrai manque

Le workflow CAP (Corrective Action Plan) existait **côté serveur, appelé par rien** :

| Route API | Implémentée | Appelée par l'UI |
| --- | --- | --- |
| `GET /api/quality/caps` | oui | **0** |
| `POST /api/quality/issues/:id/cap` | oui | **0** |
| `GET|POST /api/quality/caps/:id/messages` | oui | **0** |
| `POST /api/quality/caps/:id/submit-remediation` | oui | **0** |
| `POST /api/quality/caps/:id/review` | oui | **0** |

Le cycle `requested → submitted → approved|rejected`, ses deux procédures stockées et ses
gardes RLS étaient en production et inatteignables. La Phase 8 n'a donc pas ajouté de
fonctionnalité : elle a rendu visible une fonctionnalité déjà écrite.

## Ce qui a été construit

Quatre vues : **Overview** (8 indicateurs de confiance + issues critiques), **Issues**
(regroupées Critique / Avertissement / À revoir, filtres gravité et statut, Acquitter /
Waiver / créer un plan), **Plans d'action** (liste, détail, correction, revue, fil de
discussion), **Scores** (4 dimensions réelles par sujet).

**Aucune métrique inventée.** `GET /api/quality/overview` renvoie `completeness`,
`freshness`, `documentationCoverage`, `consistency` et six compteurs d'issues. Le brief
demandait un « taux de vérification » : l'API n'en fournit aucun. Il n'a donc pas été
affiché, et le test `test:quality-center` vérifie explicitement que la chaîne
« taux de vérification » n'apparaît nulle part. Les valeurs agrégées sont calculées depuis
les scores renvoyés, pas saisies en dur.

## Couche applicative du design system

Le DS v3.0 ne décrivait que la couche marketing. Une section `5b. APPLICATION LAYER`
(~250 lignes) a été ajoutée : shell, sidenav, tuiles denses, table de données, filtres,
statuts de cycle de vie, barres de score, états vides, notices, panneaux, point de rupture
1024 px. `quality-center/index.html` est inscrit dans `SURFACES` de `sync_design_system.mjs`.

Deux défauts ont été trouvés et corrigés en route :

- `.tf-wordmark*` était défini uniquement en CSS local de `index.html`, alors que le shell
  applicatif s'en sert. Le mark s'affichait donc non stylé dans le Quality Center. Promu dans
  le DS, doublon supprimé de la landing. `check:landing` et `test:landing` inchangés (67/95).
- `<th>` sans `scope` : les lecteurs d'écran ne pouvaient pas relier en-têtes et cellules.
  Le DOM rendu en affichait 10, aucun avec `scope`. Les 20 `<th>` de la source (4 en-têtes de
  5 colonnes, répartis sur les vues) portent désormais `scope="col"`, et la colonne d'actions
  vide a un nom via `.tf-visually-hidden`.

## Portails

```
ds:check                      PASS  (2 surfaces synchronisées)
check:landing        67 / 0   inchangé
test:landing         95 / 0   inchangé
test:p1-quality             PASS  (littéraux Acquitter / Waiver / certification / explicables conservés)
test:quality-center  69 / 0   NOUVEAU
test:quality-actions:chantier5  PASS
test:p1-i18n                PASS
```

`test:quality-center` exécute le vrai script de la page dans un DOM et parcourt la boucle
complète : acquitter une issue → ouvrir un plan → soumettre la correction → constater
`submitted` → poster un message → approuver → constater `approved`. Les transitions sont
lues dans l'état réel de l'application, pas supposées.

## Régression

Balayage des **49** scripts `test:*` avec et sans les modifications :

- avec les changements : 30 PASS / 19 FAIL
- à HEAD (modifications stashées) : **19 FAIL, mêmes noms**

Zéro régression. Les 19 échecs sont préexistants et tous expliqués : 5 × `prisma generate`
impossible (`binaries.prisma.sh` hors liste blanche), 6 × `test:neon:*` (base Neon requise),
4 × `:browser` (Playwright non installable), 3 × staging E2E (variables d'environnement),
et `test:supplychain:chantier3` — le litige en attente d'arbitrage.

## Toujours non vérifié

**Aucune capture d'écran du Quality Center.** Les 69 assertions sont structurelles,
comportementales et déclaratives. L'équilibre visuel des quatre vues, la lisibilité réelle
des tables denses à 13 px et le rendu du point de rupture 1024 px restent à valider dans un
navigateur.

---

# Chantier 6 — préparation : intégrité du registre de routes

Avant de toucher au Supplier Portal, mesure réelle de son exposition. Deux corrections
à mes propres notes d'audit :

- « supplier-portal = 2 vues » : **faux**. Le fichier fait 1 272 lignes / 134 414 octets et
  expose **10 vues** — overview, profile, sites, materials, documents, certifications,
  quality, passport, members, requests. Même erreur de méthode que pour le Quality Center :
  il faut lire le code, pas compter les lignes.
- « 12 routes supplier sur 22 atteintes » : **faux aussi**, artefact de ma logique
  d'appariement (`{id}` comparé à `${...}`). Appariement exact : **16/22**.

## Un bug systémique trouvé en chemin

`api/_routes/` contient **124 handlers** ; `api/index.ts` n'en déclarait que **114**.
Dix fichiers de routes entièrement écrits renvoyaient donc 404 :

| Handler | Taille | Appelé par une interface ? |
| --- | --- | --- |
| `supplier/shares` | 3 092 o | **oui — Supplier Portal, à chaque chargement** |
| `data-requests/[requestId]/remind` | 2 749 o | **oui — Brand Console** |
| `supplier/certifications/ocr-extract` | 1 524 o | non |
| `quality/audit-pack` | 1 872 o | non |
| `quality/calculate-index` | 1 957 o | non |
| `dpp/validate` | 1 447 o | non (phase 10) |
| `integrations/plm` | 2 521 o | non |
| `traceability/audit-chain` | 2 595 o | non (phase 9) |
| `traceability/lineage-graph` | 1 800 o | non (phase 9) |
| `traceability/mass-balance` | 2 148 o | non (phase 9) |

Les deux premiers ont été déclarés dans le dispatcher. Les huit autres restent orphelins :
trois d'entre eux (`traceability/*`) sont le socle de la phase 9, `dpp/validate` celui de la
phase 10 — à traiter dans leur chantier, pas avant.

`supplier/shares` était invisible parce que l'appel est dans un `Promise.allSettled` : le 404
partait dans `state.optionalErrors` et `state.shares` restait vide. La vue de partage du
portail s'affichait donc vide depuis toujours, sans erreur en console.

## Un littéral cassé dans le Supplier Portal

Ligne 1112 de `supplier-portal/index.html`, dans `manageInvitation` :

```js
await api(`/api/supplier/member-incodeURIComponent(invitationId)}`, { ... })
```

Un rechercher/remplacer a mangé `vitations/${en`. Conséquence : l'URL est un littéral,
l'identifiant n'est jamais interpolé, et Renvoyer / Révoquer une invitation renvoient 404.
Le bug était invisible en mode démonstration, qui sort de la fonction avant l'appel.
Corrigé en `/api/supplier/member-invitations/${encodeURIComponent(invitationId)}` — méthode
et forme de réponse vérifiées dans le handler.

## Nouveau portail de test

`scripts/test_route_registry.mjs` (`npm run test:route-registry`) verrouille l'invariant :
**tout `/api/*` appelé par une interface doit résoudre vers une route déclarée.** Il balaie
7 surfaces et 90 appels distincts. Les handlers orphelins restants sont signalés en
avertissement, pas en échec — une route peut légitimement précéder son interface.

Ce test aurait attrapé `supplier/shares`, `data-requests/:id/remind` **et** le littéral
cassé de `manageInvitation`.

## Portails

```
test:route-registry   PASS  (116 motifs, 90 appels résolus, 8 orphelins signalés)
Balayage des 50 scripts test:* : 31 PASS / 19 FAIL — les 19 échecs préexistants, inchangés
tsc sur api/index.ts : aucune erreur de syntaxe (uniquement des TS2792 dus à --noResolve)
```

---

# Chantier 6 — Supplier Portal

## Périmètre

`api/_lib/supplier-passport/types.ts` porte l'en-tête « Chantier 6: Write Once, Share
Everywhere & Supplier-First Virality » : le passeport fournisseur est le cœur du chantier,
ce qui recoupe le brief (« Vos données. Votre profil. Réutilisables chez tous vos clients. »).

Le portail existant est solide : 1 272 lignes, 10 vues, 60 fonctions, un contrat de test de
33 éléments. **Il n'a donc pas été réécrit** — une réécriture aurait cassé 33 contrats et
60 fonctions pour un gain nul. Le chantier a consisté à combler ses trous.

## Résultat principal

| | avant | après |
| --- | --- | --- |
| routes `supplier/*` déclarées | 22 | 23 |
| atteignables depuis le portail | 18 | **23 / 23** |
| actions exposées sur l'accueil | 4 | **8** |

## Les cinq routes rendues atteignables

| Route | Ce que l'interface fait maintenant |
| --- | --- |
| `GET/PATCH /api/supplier/passport` | réglages réels : titre, régime de secret d'affaires (3 modes), 6 sections divulguables, visibilité |
| `GET/POST /api/supplier/passport/access-requests` | demandes d'accès listées, **Accorder / Refuser** avec verdict |
| `GET /api/supplier/storage/usage` | jauge d'espace, octets et nombre de documents réels |
| `POST /api/supplier/certifications/:id/auto-verify` | bouton « Vérifier automatiquement » |
| `POST /api/supplier/documents/:id/scan` | bouton « Analyser » |

`review-passport-request` n'était qu'un stub : il affichait « revue en mode démonstration »
même en mode réel, sans aucun appel réseau.

## Les huit actions

Compléter le profil · Ajouter des sites · Ajouter des matériaux · Ajouter des produits ·
Téléverser des preuves · Gérer les certificats · Répondre aux demandes · Soumettre les données.
Chaque carte affiche un compteur lu dans l'état et mène à l'écran qui la résout.
« Ajouter des produits » pointe sur les données structurées : c'est là que les données produit
sont réellement saisies côté fournisseur (les items de demande sont `product_description`,
`country_of_manufacture`, `main_material_percentage`, `material_composition`).

## Données inventées supprimées

La barre de préparation était fausse à trois endroits :

```js
const completionPct = state.profile?.profileCompletion || 82;   // repli codé en dur
```

et quatre pills statiques : « ✓ Fiche Entreprise (100%) », « ✓ Sites de Production GPS (100%) »,
« ✓ Certificats GOTS & OEKO-TEX (100%) », « ⏳ 1 Rapport d'essais RSL à renouveler » — affichées
à l'identique quelles que soient les données.

Remplacées par `readiness()` : sept conditions évaluées sur l'état réel, chacune citant son
nombre. Le pourcentage affiché est celui de l'API quand il existe, sinon il est dérivé du
compte d'étapes — et la source est indiquée à l'utilisateur.

## Trois bugs corrigés

- **`?demo=0` activait le mode démonstration.** `new URLSearchParams(location.search).has('demo')`
  ignore la valeur. Le bandeau invitait pourtant à ouvrir `?demo=0` pour connecter Clerk.
  Corrigé : `0`, `false` et `off` désactivent.
- **`manageInvitation` appelait une URL cassée** (voir la section précédente) — Renvoyer et
  Révoquer une invitation renvoyaient 404 en mode réel.
- **Le sélecteur de langue n'avait pas de nom accessible** (`title` seul). `aria-label` ajouté.

## Deux collisions évitées

Les boutons d'accès au passeport portaient `data-request-id`, déjà branché sur `openRequest` :
un clic sur « Accorder » aurait aussi ouvert une demande de données. Idem pour l'analyse de
document, qui aurait déclenché le téléchargement via `[data-document-id]`. Attributs dédiés
`data-passport-request-id` et `data-scan-id`. Le test vérifie leur absence mutuelle.

## Design system et accessibilité

Le portail est inscrit dans `SURFACES` et reçoit le DS canonique. Ses tokens sont mappés sur
ceux du DS — ses verts (`#0b7656`, `#07523e`) étaient déjà identiques au pixel à
`--tf-emerald-600/700`.

Trois échecs WCAG AA corrigés, mesurés et non estimés :

| Couple | avant | après |
| --- | --- | --- |
| `--muted #71807a` sur `--paper` | 3.88:1 | **4.86:1** (`--tf-ink-300 #647264`) |
| `--muted #71807a` sur carte blanche | 4.14:1 | **5.08:1** |
| `.status-in_progress #3970b3` | 4.46:1 | **4.58:1** (`#386eb1`) |
| `.status-submitted #9a680e` | 4.37:1 | **4.58:1** (`#96650d`) |

Le séparateur de lignes `#edf0eb` (1.25:1) n'est **pas** corrigé : c'est une bordure
décorative qui ne porte aucune information, exemptée du 1.4.11.

## Une régression introduite, puis corrigée

Le balayage des 51 scripts a révélé `test:universal-passport:chantier6` en échec : ma
réécriture du titre avait supprimé « 1-Clic », littéral exigé par le contrat. Le titre a été
restauré — le test n'a pas été modifié.

## Portails

```
ds:check                        PASS  (3 surfaces)
check:landing          67 / 0   inchangé
test:landing           95 / 0   inchangé
test:quality-center    69 / 0   inchangé
test:supplier-portal          PASS  (contrat de 33 éléments préservé)
test:supplier-portal:surface 69 / 0  NOUVEAU
test:route-registry           PASS  (116 motifs, 95 appels résolus)
test:universal-passport:chantier6  PASS
Balayage des 51 scripts test:* : 32 PASS / 19 FAIL — les 19 préexistants, liste identique
```

`test:supplier-portal:surface` exécute le vrai script de la page dans un DOM et parcourt :
démarrage, paramètre `demo`, navigation, calcul de préparation, huit actions, enregistrement
du passeport (état réellement modifié), accord d'une demande d'accès (la bonne, retirée),
auto-vérification d'un certificat, analyse de document, stockage, tokens DS, accessibilité.

## Toujours non vérifié

**Aucune capture d'écran.** Les 69 assertions sont structurelles, comportementales et
mathématiques (contraste). L'équilibre visuel des huit cartes, le rendu de la jauge et le
comportement au point de rupture 760 px restent à valider dans un navigateur.

---

# Chantier 7 — Data Collection

## Troisième correction à mes propres notes

Ma roadmap indiquait : « phase 7 Data Collection — pas de flux Missing → … → Rejected ».
**C'était faux.** Mesuré par exécution, pas par lecture :

- 8 routes `data-request*` déclarées, **7 déjà appelées** par une surface.
- La Brand Console implémente déjà « Pilotage de la Collecte Fournisseur » avec le cycle en
  sept étapes MARQUE → FOURNISSEUR → PRODUIT → DONNÉES REQUISES → certificats OCR →
  DONNÉES VÉRIFIÉES, et les filtres de statuts (Toutes / Tous les statuts / Demandées
  (Missing) / En cours de saisie / Soumises pour revue / Rejetées).
- La revue par réponse est câblée : `POST /api/data-responses/:id/review`, appelée par la
  Brand Console avec `status` et `reviewComment`.
- Le portail fournisseur affiche ses demandes en cartes avec statut et progression
  (40 % / 100 % sur les données de démo), sans erreur de page.

Le cycle de vie réel est porté par deux enums Postgres, pas par les six mots du brief :

| Niveau | Enum | Valeurs |
| --- | --- | --- |
| demande | `data_request_status` | draft, sent, in_progress, submitted, changes_requested, approved, cancelled |
| item | `data_request_item_status` | pending, answered, needs_review, accepted, rejected |

Les six états du brief (Missing / Requested / Submitted / Under Review / Accepted / Rejected)
sont une couche de présentation sur ces deux enums — c'est ainsi qu'ils sont rendus, jamais
comme un état stocké supplémentaire.

## Les deux vrais défauts

**1. La boucle de revue était cassée.** La marque envoie `reviewComment` à la revue ;
`grep -c reviewComment supplier-portal/index.html` renvoyait **0**. Le fournisseur voyait
« Rejeté » sans jamais savoir pourquoi, alors que l'API serialise `reviewComment`,
`reviewedAt` et `reviewedBy`. La chaîne du brief s'arrête à « Review » : sans motif, le
fournisseur ne peut pas corriger à bon escient.

Corrigé par `reviewNote(response)` : le commentaire est restitué tel quel, daté, dans un
encart ambre « Correction demandée par la marque » quand le statut est `rejected`,
`changes_requested` ou `needs_review`, et vert pour une validation. `role="note"`.

**2. Trois statuts d'item sur cinq n'avaient pas de libellé.** La table `labels` couvrait
`needs_review` et `rejected` mais pas `pending`, `answered`, `accepted` : l'enum anglais brut
fuitait dans l'interface française. Trois libellés ajoutés, plus les styles
`.status-pending`, `.status-answered`, `.status-accepted`.

## Contrastes

Les couleurs de la note de relecture ont été mesurées, et mon premier commentaire CSS citait
le mauvais couple (`#e4f3ec`, l'ancienne valeur de `--green-soft`, et 8.02:1) : corrigé avec
les valeurs réelles.

| Couple | Ratio |
| --- | --- |
| titre rejeté `#5b3d05` sur `#fff3d8` | 9.02:1 |
| texte rejeté `#4a3c12` | 9.80:1 |
| titre accepté `#07523e` sur `--tf-emerald-100 #d9f3e8` | 7.85:1 |
| texte accepté `#1d3b2e` | 10.44:1 |
| `.status-pending` / `.status-answered` `#5b6962` sur `#f0f1f0` | 5.09:1 |

## `/api/data-requests/:id/items` : pas un défaut

Seule route `data-request*` qu'aucune surface n'appelle. Ce n'est pas un oubli : les items
sont instanciés depuis un questionnaire via `/items/from-template` (la Brand Console a un
constructeur de questionnaires), et le GET est couvert par `/api/data-requests/:id` qui
renvoie déjà `data_request_items`. C'est un primitive de bas niveau, documenté comme tel.

## Le portail de test voit maintenant dans les deux sens

`test:route-registry` vérifiait « tout appel d'interface aboutit à une route déclarée ».
Il signale désormais aussi l'inverse : **43 routes déclarées qu'aucune surface n'appelle**,
en avertissement. C'est la carte des chantiers restants — `documents/:id/verify-ai`,
`documents/:id/security-report`, `dpp/:id`, `gs1/digital-link/:id`, `integrations/*`,
`mass-balance/certificates`, `green-claims/rules`. Une route que personne n'appelle doit
rester visible : c'est exactement ainsi que les cinq endpoints CAP ont attendu la phase 8.

## Portails

```
ds:check                        PASS  (3 surfaces)
check:landing          67 / 0   inchangé
test:landing           95 / 0   inchangé
test:quality-center    69 / 0   inchangé
test:supplier-portal          PASS  (contrat de 33 éléments préservé)
test:supplier-portal:surface 78 / 0  (+9 : boucle de revue)
test:route-registry           PASS  (116 motifs, 95 appels, 43 routes non appelées signalées)
test:universal-passport:chantier6  PASS
Balayage des 51 scripts test:* : 32 PASS / 19 FAIL — liste identique aux 19 préexistants
```

Les neuf assertions ajoutées vérifient : aucun enum brut ne fuite, le motif du relecteur est
restitué tel quel, une correction demandée est distinguée visuellement d'une validation, et
l'encart est exposé en `role="note"`.

## Toujours non vérifié

**Aucune capture d'écran.** L'encart de relecture est prouvé présent, correctement classé et
accessible ; son rendu visuel réel reste à juger dans un navigateur.

---

# Chantier 8 — Evidence Center

Le chantier 8 du brief est « Evidence + Quality ». La moitié Quality (Quality Center) était
faite ; la moitié **Evidence** ne l'était pas. Corrigé.

## Le manque

| | avant | après |
| --- | --- | --- |
| routes `documents/*` côté marque | 5 déclarées | 6 (liste ajoutée) |
| appelées par une surface | **0** | **5** |
| surface Evidence Center | inexistante | `evidence/index.html` |

La Brand Console ne contenait **aucun** appel `/api/*document*`. Les cinq routes
(`upload-intent`, `download`, `verify-ai`, `security-report`, `verification-report`) étaient
écrites, enregistrées, testées côté serveur — et inatteignables, faute d'un écran capable
d'énumérer les documents sur lesquels elles opèrent.

## La seule route écrite

`GET /api/documents`. Aucune route de liste n'existait, côté marque, enregistrée ou non : le
seul `documents.findMany` du dépôt est borné à `owner_organization_id = fournisseur`.

L'autorisation n'est **pas** réinventée : elle est déléguée à la fonction SQL existante
`tracefab_can_access_document(uuid)`, la même que `verification-report` et `security-report`
emploient. Cette route ne peut donc pas élargir ce qu'un appelant a le droit de voir ; elle
énumère ce que cette fonction autorise déjà (membre de l'organisation propriétaire, partage
explicite via `data_shares`, preuve rattachée à une réponse de collecte, ou document adossé à
une certification accessible). Lecture seule, sans modification de schéma.

## Les catégories du brief n'existent pas toutes

Le brief cite sept catégories (Documents, Certificates, Test Reports, Declarations, Audits,
Invoices, Production Records). L'enum réel `document_kind` en a **six** : `certificate`,
`technical_spec`, `origin_proof`, `audit_report`, `invoice`, `other`. Il n'existe ni
« test report » ni « declaration » ni « production record ». L'interface affiche les six
valeurs réelles : des catégories inventées auraient produit des filtres vides.

## Ce qui est rendu

Quatre vues : vue d'ensemble (six indicateurs calculés + répartition par niveau de
vérification + échéances proches), documents (table filtrable par nature et statut),
échéances (sous 90 jours / déjà périmés), fiche document.

La fiche porte les huit attributs du brief : source, nature, statut, dates d'ajout et de
disponibilité, échéance, taille, empreinte SHA-256, visibilité — plus l'historique de
vérification et le rapport de sécurité.

Les indicateurs sont calculés sur le jeu renvoyé, jamais saisis : le test vérifie que
« Vérifiés » correspond bien à `byVerification.passed + byVerification.verified` et que le
compteur d'échéance découle de `expiresAt`.

L'échelle de couleurs reprend celle du design system (§2) : `--tf-verified`, `--tf-declared`,
`--tf-missing`. Un premier jet utilisait `var(--tf-needs-review, #b04a3f)` — **ce token
n'existe pas**, le repli codé en dur s'appliquait donc en permanence. Contrastes mesurés sur
`--tf-paper` : verified 5.62:1, declared 5.27:1, missing 6.25:1, ambre 4.58:1.

La vérification automatique est explicitement présentée comme un indice technique, « ni une
certification ni un avis juridique ».

## `documents/upload-intent` reste non appelé — volontairement

C'est le téléversement **côté marque**. Le Supplier Portal a son propre
`supplier/documents/upload-intent`, utilisé. Une marque consomme les preuves, elle ne les
produit pas : exposer un téléversement marque dans un centre de preuves serait un contresens.

## Le garde-fou corrigé

`test:route-registry` avait une liste de surfaces codée en dur qui n'incluait pas
`evidence/index.html` : il comptait donc 44 routes non appelées au lieu de 39, aveugle à la
surface qu'il était censé couvrir. Surface ajoutée, et toute surface déclarée mais absente
est désormais signalée au lieu d'être ignorée silencieusement — c'est exactement l'omission
qui venait d'être commise.

## Déploiement

`vercel.json` déclare ses `routes` explicitement. `**/*.html` publie le fichier, et un
`{"handle":"filesystem"}` sert de repli, mais toutes les autres surfaces ont une route
explicite : `/evidence(?:/)?` → `/evidence/index.html` a été ajoutée. JSON validé, 14 routes.

## Portails

```
ds:check                        PASS  (4 surfaces)
check:landing          67 / 0   inchangé
test:landing           95 / 0   inchangé
test:quality-center    69 / 0   inchangé
test:supplier-portal:surface 78 / 0  inchangé
test:evidence          65 / 0   NOUVEAU
test:route-registry           PASS  (117 motifs, 100 appels, 39 routes non appelées)
Balayage des 52 scripts test:* : 33 PASS / 19 FAIL — exactement les 19 préexistants
```

`test:evidence` exécute le vrai script de la page et vérifie : agrégats traçables au jeu de
données, six natures réelles et aucune inventée, filtrage effectif, fiche complète, action de
vérification qui modifie réellement l'état, rapport de sécurité, accessibilité, et l'absence
de tout token de design system inexistant.

## Toujours non vérifié

**Aucune capture d'écran**, et surtout **aucun appel réel à la base** : `prisma generate` est
impossible ici (`binaries.prisma.sh` hors liste blanche), donc `GET /api/documents` n'a
jamais été exécuté contre Neon. Sa requête SQL est écrite contre des colonnes et une fonction
vérifiées dans le schéma et les migrations, mais elle reste à valider sur un environnement
connecté.

---

# Chantier 9 — Traçabilité

## Ce que les données permettent, et ce qu'elles ne permettent pas

Le brief demande une chaîne en huit maillons, de la fibre au DPP, chaque étape cliquable.
La mesure du dépôt donne trois capacités de nature très différente :

| Capacité demandée | Source réelle | Verdict |
| --- | --- | --- |
| Bilan de masse | `mass_balance_allocations`, `mass_balance_reconciliations` | **réelle, en base** |
| Intégrité de la chaîne d'audit | `verifyAuditChainIntegrity` | **réelle** |
| Chaîne fibre → DPP en 8 étapes | aucune table de lot ni de généalogie | **impossible sans inventer** |

`grep` sur `prisma/schema.prisma` ne renvoie **aucune** table de lot, de traçabilité ou de
généalogie. Seules les deux tables de bilan de masse existent. Le seul lien réellement stocké
est *matière certifiée (TC) → produit*, via les allocations.

Conséquence assumée : `CHAIN_STEPS` nomme bien les huit maillons du brief, mais les six qui
n'ont aucune source sont rendus en pointillés (`chain__node--absent`) avec la mention
« aucune donnée de lot stockée », et un paragraphe énonce la limite au lieu de la masquer.
Fabriquer six étapes sur huit aurait violé l'interdiction d'inventer des données.

## Deux routes sont des auditeurs, pas des sources

`traceability/lineage-graph` et `traceability/mass-balance` ne lisent pas la base : ils
reçoivent les données du client et les vérifient. Les exposer comme s'ils produisaient une
chaîne aurait été trompeur. Ils sont donc présentés pour ce qu'ils sont :

- **Auditeur de chaîne** — l'utilisateur colle une chaîne JSON, le serveur renvoie
  profondeur, continuité et défauts. La page le dit explicitement : « un auditeur, pas une
  source ».
- **Bilan par étape** — l'utilisateur saisit entrée, sortie et tolérance de chaque étape ;
  le calcul reproduit fidèlement `reconcileMassBalance` (`api/_lib/mass-balance.ts`), y
  compris les quatre statuts réels `RECONCILED`, `WITHIN_TOLERANCE`, `SUSPECT_DISCREPANCY`,
  `OVER_EXTRACTION` et la règle `anomalie = perte > tolérance`. En démonstration le calcul
  s'exécute côté client avec la même arithmétique ; en production il appelle le serveur.

## Routes enregistrées

Trois handlers étaient présents sur disque mais absents du routeur : `traceability/audit-chain`,
`traceability/lineage-graph`, `traceability/mass-balance`. Enregistrés dans `api/index.ts` →
**120 motifs** (contre 117). Les cinq handlers orphelins restants sont inchangés
(`dpp/validate`, `integrations/plm`, `quality/audit-pack`, `quality/calculate-index`,
`supplier/certifications/ocr-extract`).

Routes désormais appelées qui ne l'étaient par aucune surface :
`/api/traceability/audit-chain`, `/api/traceability/lineage-graph`,
`/api/traceability/mass-balance`, `/api/mass-balance/certificates`,
`/api/products/{id}/mass-balance` — **+5**, soit 78 → 83 routes appelées sur 120.

## Une erreur évitée de justesse

Le premier jet appelait `/api/catalog/products`, qui **n'existe pas** : `catalog/products/*`
n'a que des sous-routes `import`/`export`. La route de liste enregistrée est `/api/products`
(celle qu'utilise la Brand Console). C'est `test:route-registry` qui l'aurait attrapée ;
elle a été corrigée avant.

## Un défaut de méthode corrigé dans trois tests

`document.body.textContent` inclut le **source du `<script>`** sous jsdom. Les assertions
textuelles passaient donc même si la vue n'était pas rendue — la chaîne cherchée existait
dans le code. Onze assertions de `test:traceability`, quatre de `test:evidence` et une de
`test:supplier-portal:surface` ont été bornées au conteneur rendu (`#app`). Les trois tests
passent toujours après resserrement : les assertions étaient justes, elles n'étaient pas
prouvées.

De même, le « `tf-8` undefined » signalé à plusieurs reprises vient de `<meta charset="utf-8">`
: le motif `tf-[A-Za-z0-9_-]+` le capture. Ce n'est pas une classe. Les audits de classes
doivent exclure `utf-`.

## Portails

```
ds:check                        PASS  (5 surfaces, traceability incluse)
check:landing          69 / 0   inchangé
test:landing           95 / 0   inchangé
test:quality-center    69 / 0   inchangé
test:supplier-portal:surface 78 / 0  inchangé après resserrement
test:evidence          65 / 0   inchangé après resserrement
test:traceability      82 / 0   NOUVEAU
test:route-registry           PASS  (120 motifs, 9 surfaces, 107 appels, 37 routes non appelées)
Balayage des 53 scripts test:* : 34 PASS / 19 FAIL — exactement les 19 préexistants
```

`test:traceability` exécute le vrai script de la page : les quatre verdicts réels de
`ReconciliationVerdict` et aucun autre, largeur de barre égale au taux de couverture réel,
déficit cohérent avec requise − allouée, recalcul qui modifie réellement l'état, huit maillons
dont au moins six marqués absents avec la mention explicite, audit de chaîne qui refuse un JSON
invalide, et pour chaque ligne du bilan par étape `perte = entrée − sortie`,
`perte % = perte / entrée` et `anomalie = perte > tolérance`.

## Toujours non vérifié

**Aucune capture d'écran** — aucun navigateur sans tête n'est installable ici. Et **aucun
appel réel à la base** : `prisma generate` est impossible (`binaries.prisma.sh` hors liste
blanche), donc `audit-chain`, `lineage-graph`, `mass-balance` et `mass-balance/certificates`
n'ont jamais été exécutés contre Neon. Leurs contrats sont lus dans le code, pas observés.
