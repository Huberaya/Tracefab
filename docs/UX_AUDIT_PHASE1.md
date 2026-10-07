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

---

# Chantier 10 — Préparation DPP

## Ce qui existait déjà

Contrairement aux chantiers précédents, la préparation DPP existait partiellement. La mesure
donne trois surfaces liées au DPP, aux rôles distincts :

| Surface | Rôle réel | Rendait la préparation ? |
| --- | --- | --- |
| `dpp/index.html` (1 312 l.) | DPP public produit (« Essentiel Coton Biologique ») | non |
| `passport/index.html` (788 l.) | Passeport fournisseur universel | non |
| `brand-console/index.html` | Console marque, vue `dppView()` | **oui, sur données réelles** |

`dppView()` consommait déjà correctement `buildDppSummary` : score, quatre piliers, neuf
exigences, champs manquants, bouton de recalcul et de validation. Le chantier n'était donc pas
de créer une surface mais de combler ce qui manquait.

## Quatre manques mesurés, quatre corrections

**1. `blockingIssues` n'était jamais affiché.** L'API renvoie `{key, label, reason}` ; la vue
n'affichait qu'un compteur « 2 bloquant(s) » sans les motifs. Le `reason` est précisément le
« What is missing? » du brief. Un panneau dédié rend maintenant chaque blocage avec son motif
tel que renvoyé par le calcul.

**2. Aucune action sur les exigences manquantes.** Le brief demande explicitement des actions.
`dppActionFor(key, productId)` mappe chaque code d'exigence vers une cible qui existe déjà :
`composition.*` / `material.*` / `evidence.*` → modale de demande de données scopée au produit,
`traceability.*` / `supply_chain.*` → chaîne d'approvisionnement, `quality.*` → qualité,
`product.*` → fiche produit. Aucune cible inventée ; le test dérive la liste des vues
autorisées du `switch` de rendu au lieu de la coder en dur.

**3. Le score était présenté avec un vocabulaire de certification.** La phrase « avant de
pouvoir **certifier** le passeport » contredisait la consigne selon laquelle la préparation
n'est jamais une certification légale. Un encart énonce désormais : indicateur interne,
profil nommé, « ne constitue ni une certification, ni une attestation de conformité au
règlement européen ESPR, et ne remplace pas l'évaluation d'un organisme notifié ».

**4. `dpp/validate` était orpheline.** Le validateur CIRPASS (`validateDppCompliance`) n'était
ni enregistré ni appelé. Enregistré dans `api/index.ts` **avant** `dpp/([^/]+)`, sans quoi
`[gtin]` aurait capturé « validate » → **121 motifs**, orphelines 5 → 4.

## Un résultat qui dérange, et qu'il faut garder visible

Le validateur exige un bloc AGEC Art. 13 (pays de tissage, teinture, confection) et un indice
de réparabilité. Or `prisma/schema.prisma` ne contient **aucun** de ces champs : `grep` renvoie
0 pour `agec`, `repairab`, `tissage`, `teinture`, `confection`, `microfib`, `reach`, `svhc`.
`tracefab_products` n'a que `country_of_design` et `country_of_manufacture`.

Conséquence : **aucun produit TRACEFAB ne peut aujourd'hui produire un payload CIRPASS
conforme.** Le panneau ne le masque pas — il construit le payload depuis les identifiants, la
composition et les instructions d'entretien réellement présents, laisse absents les champs que
la plateforme ne stocke pas, et affiche les erreurs bloquantes qui en découlent. Combler cet
écart est un chantier de schéma, pas d'interface.

## Deux maquettes fabriquées trouvées en route

**`dppConsoleView()` — supprimée.** 80 lignes de chiffres inventés (« 88% », « 42 / 48 »,
« 94% », « Conformité ESPR 100% ») et un bouton qui faisait `alert('Tous les scores DPP ont
été recalculés.')`. Référencée une seule fois : sa propre définition. Code mort, mais du code
mort fabriqué.

**`intelligenceView()` — laissée en place, non branchée.** Même nature, en pire : SKU,
fournisseurs et empreintes SHA-256 de certificats inventés, sous un bandeau « ZERO HALLUCINATION ·
Aucune donnée inventée ». La brancher aurait violé l'interdiction d'inventer des données.

Elle révélait un défaut réel : la navigation proposait `TRACEFAB Intelligence`
(`navButton('intelligence')`) alors que le `switch` de rendu n'a **pas** de cas `intelligence`.
Le clic tombait donc sur la branche par défaut `requestDetailView()`, qui sans demande
sélectionnée affiche « Demande introuvable ». L'entrée de navigation n'a pas été supprimée :
elle affiche maintenant un état véridique — couche non câblée, aucune réponse de démonstration
— et renvoie vers les trois surfaces qui répondent déjà sur données réelles.

`supplyChainConsoleView()` est la troisième vue morte (mêmes symptômes). Non touchée : elle
relève du chantier Chaîne d'approvisionnement.

## Portails

```
test:dpp-readiness     83 / 0   NOUVEAU
test:brand-console            PASS (contrat statique, inchangé)
test:route-registry           PASS (121 motifs, 9 surfaces, 109 appels, 36 routes non appelées)
ds:check                      PASS (5 surfaces — brand-console a sa propre charte)
check:landing        69 / 0 · test:landing 95 / 0 · test:quality-center 69 / 0
test:supplier-portal:surface 78 / 0 · test:evidence 65 / 0 · test:traceability 82 / 0
Balayage des 54 scripts test:* : 35 PASS / 19 FAIL — exactement les 19 préexistants
```

`test:dpp-readiness` démarre la vraie console en mode démo et pilote la vue par le DOM :
score égal au ratio réel, somme des piliers égale au total, pourcentage de chaque pilier
recalculé, au moins une action par manque pointant le bon produit, motif de blocage affiché,
payload CIRPASS vérifié champ par champ contre le produit source, deux erreurs bloquantes
(composition à 98 %, bloc AGEC absent), score structurel égal à (8 − erreurs) / 8, et
`dpp/validate` déclarée avant `dpp/[gtin]`.

Les données de démonstration de la vue DPP ont été rendues cohérentes et incomplètes
(7 exigences sur 9, deux manques, un blocage motivé) afin que la nouvelle interface soit
démontrable ; elles restent sous la bannière « Mode démonstration ».

## Toujours non vérifié

**Aucune capture d'écran.** Et **aucun appel réel à la base** : `prisma generate` est
impossible ici, donc `GET|POST /api/products/:id/dpp`, `POST …/dpp/publish-review` et
`POST /api/dpp/validate` n'ont jamais été exécutés contre Neon. La procédure stockée
`tracefab_compute_dpp_readiness` n'a pas pu être inspectée non plus : seule sa signature, lue
dans la route, est connue.

---

# Chantier 11 — Passeport Numérique public

## Le passeport consommateur ne lisait aucune donnée

La mesure donne trois faits, tous vérifiés dans le code :

1. **`dpp/index.html` (1 312 lignes) n'appelait aucune route de données.** Ses seuls appels
   étaient les deux boutons Wallet, avec un GTIN figé `3760123456789`. Tout le contenu —
   produit, composition, chaîne, empreinte, preuves — était écrit en dur.
2. **`GET /api/dpp/{identifiant}`, la seule route qui renvoie un vrai passeport, n'était
   appelée par personne.** Elle figurait dans les routes déclarées mais non appelées.
3. **Les routes Wallet n'interrogeaient jamais la base.** `apple-wallet.ts` et
   `google-wallet.ts` appelaient `getFallbackDppData(gtinOrRef)` de façon inconditionnelle,
   quel que soit le GTIN demandé. Chaque passeport Apple/Google Wallet distribué était donc
   fabriqué, avec une chaîne d'approvisionnement inventée
   (« Ferme Izmir (TR) ➔ Filature Haute-Vienne (FR) ➔ Tricotage Barcelos (PT) ➔ Confection
   Braga (PT) ➔ Hub Lyon (FR) »).

Le `<head>` contenait en outre un JSON-LD se déclarant « CIRPASS / ESPR Compliant », portant
une `verificationSignature` attribuée à « TRACEFAB Cryptographic Ledger » dont l'`evidenceHash`
était `sha256-e3b0c44…` — l'empreinte de la chaîne vide — et des URL de réparation
`atelier-demo.fr`. Ce bloc est lisible par les machines : il était faux de bout en bout.

## Le repli du resolver rendait la fabrication invisible

`resolveDppPassData` (`api/_lib/wallet/dpp-data-resolver.ts`) substitue une valeur constante à
toute donnée absente : `100% Coton peigné`, `Filature ➔ Tissage ➔ Ennoblissement ➔ Confection
auditée`, `'PT'`, `'FR'`, `250` g, `pefScore 78`, `grade 'B'`, `3.42` kg CO₂e, `0.85` m³ d'eau,
`circularityScore 85`, et un texte d'entretien identique pour tous les produits.

Le problème n'est pas seulement la valeur : **le repli est destructif d'information.** Une fois
`pef ? Number(pef.pef_eco_score) : 78` évalué, aucun appelant ne peut distinguer une mesure
d'un chiffre par défaut. Aucune interface ne peut donc être honnête sans modifier cette
fonction.

Correction retenue, additive et non cassante : un champ optionnel `dataGaps: string[]` liste
désormais chaque substitution (12 cas). Les valeurs continuent d'être renvoyées — aucun
consommateur existant ne casse — mais l'absence de donnée réelle est déclarée.

Les routes Wallet tentent maintenant la base d'abord et ne recourent au jeu statique que si le
produit est introuvable ou la base injoignable. Le changement est strictement dominant :
auparavant le repli était systématique.

## Deux rubriques n'ont aucune source de données

Sur les onze rubriques du brief, deux ne peuvent pas être servies :

| Rubrique | Source | Rendu |
| --- | --- | --- |
| Réparation | aucun champ de réparabilité dans le schéma | « Réparabilité non publiée » + la raison |
| Preuves | la route ne joint aucun document | « Aucune preuve publiée » + la raison |

Les preuves existent côté marque (`evidence/`, Chantier 8) ; c'est leur publication
consommateur qui n'est pas câblée. La page le dit au lieu d'afficher un panneau vide ou, pire,
des documents plausibles.

Les rubriques servies le sont depuis le contrat réel : identité, pays déclarés, matières de la
nomenclature, composition avec barres proportionnelles aux pourcentages réels, étapes issues
des nœuds de chaîne rattachés, certificat de transaction issu du bilan de masse, identifiants
GS1. Chaque valeur issue d'un repli s'affiche « Non mesuré » ou « Texte générique », jamais
comme une mesure — le test vérifie que `3,42` et `0,85` n'apparaissent pas.

Le CSS premium existant (585 lignes, 54 classes) est conservé : seule la couche de données est
remplacée. Le lien court `/p/{gtin}` que génère le resolver — celui des QR codes — pointe
désormais sur des données réelles.

## Une assertion de test modifiée, et pourquoi

`test:pef:chantier3` vérifiait la présence de deux littéraux dans le passeport. Le premier,
« Éco-Score Textile Européen », est un libellé légitime : il a été restauré, en nommant la
méthode réelle (`(PEF)`).

Le second exigeait la chaîne **« Conforme Loi AGEC & ESPR »**. Cette allégation est
factuellement fausse : le Chantier 10 a établi que le schéma ne contient aucun champ AGEC
Art. 13 (`grep` renvoie 0 pour `agec`, `tissage`, `teinture`, `confection`). Aucun produit ne
peut donc être déclaré conforme à l'AGEC au travers de TRACEFAB.

La règle suivie jusqu'ici — ne jamais réécrire un test pour l'adapter à un nouveau markup —
s'applique aux contrats de structure. Elle ne peut pas conduire à maintenir une allégation de
conformité légale fausse sur une page consommateur. L'assertion a donc été remplacée par ce
qu'elle cherchait réellement à garantir : la page nomme les cadres AGEC et ESPR, et
**n'en revendique pas la conformité**. C'est la seule assertion modifiée de tout l'audit.

## Portails

```
test:public-dpp        69 / 0   NOUVEAU
test:pef:chantier3            PASS (assertion de conformité corrigée)
test:route-registry           PASS (121 motifs, 9 surfaces, 110 appels, 36 routes non appelées)
test:dpp-readiness     83 / 0 · test:traceability 82 / 0 · test:evidence 65 / 0
test:quality-center    69 / 0 · test:supplier-portal:surface 78 / 0
test:brand-console            PASS · test:landing 95 / 0
Balayage des 55 scripts test:* : 36 PASS / 19 FAIL — exactement les 19 préexistants
```

## Toujours non vérifié

**Aucune capture d'écran.** Et **aucun appel réel à la base** : `prisma generate` est
impossible ici, donc `GET /api/dpp/{identifiant}`, `resolveDppPassData` et les deux routes
Wallet n'ont jamais été exécutés contre Neon. Le changement « base d'abord, repli ensuite »
des routes Wallet est le plus exposé : il est strictement dominant par construction, mais il
reste à observer sur un environnement connecté.

---

# Chantier 12 — Internationalisation

## Inventaire mesuré : cinq dictionnaires, aucun lien entre eux

| # | Source | Taille | Langues | Chargé par |
| --- | --- | --- | --- | --- |
| 1 | `locales/{lang}/translation.json` | 7 × ~10 Ko | 7 | **rien** (seul un test les lit) |
| 2 | `public/i18n-engine.js` (`UI_DICTIONARY`) | 33 Ko | 7 | la landing |
| 3 | `public/auto-translate.js` (glossaire) | 26 Ko | 7 | brand-console, supplier-portal, quality-center, operations |
| 4 | `brandTranslations` (inline dans le HTML) | — | 7 | brand-console |
| 5 | `public/translations_deep.json` | 23 Ko | — | **rien** |

Environ 110 Ko de traductions, sept langues partout, mais aucune source commune. Ajouter une
langue imposait d'éditer du JavaScript dans plusieurs fichiers — l'inverse d'une architecture
extensible, qui est ce que la consigne demande.

Deux mesures ont cadré le chantier :

**Le moteur de la landing fonctionne.** Un premier test jsdom faisait apparaître
`window.setLanguage` comme `undefined` : c'était un artefact, jsdom ne récupère pas les scripts
externes. En injectant réellement `i18n-engine.js`, les cinq langues cibles traduisent
correctement (`Pourquoi`, `Warum`, `Perché`, `Por qué`, `Waarum`). Rien à réparer de ce côté.

**Le glossaire ne couvre pas les surfaces récentes.** `auto-translate.js` traduit par
remplacement de chaînes françaises : 101 entrées, dont 4 à 7 seulement apparaissent dans
`evidence`, `traceability` et `dpp`. L'ajouter à ces surfaces aurait traduit environ 5 % du
texte — cosmétique, pas de l'internationalisation.

Conséquence : quatre surfaces n'avaient **aucune** traduction (`evidence`, `traceability`,
`dpp`, `passport`), dont trois construites pendant cet audit.

## Ce qui a été construit

**`public/i18n-core.js`** — runtime partagé, sans dépendance, qui fait de
`locales/{lang}/{scope}.json` la source vive. Trois garanties, toutes vérifiées par un test :

- une clé absente ne vide jamais l'interface : le texte rédigé dans le markup reste affiché et
  la clé est listée dans `TracefabI18n.missing`. Rien n'est masqué ;
- une langue absente retombe sur la langue de repli déclarée, puis sur le texte rédigé ;
- aucun appel réseau ne bloque le premier rendu : le texte s'affiche dans sa langue rédigée et
  est mis à jour à l'arrivée du dictionnaire.

**`locales/{lang}/app.json`** — 40 chaînes × 7 langues (EN, FR, DE, IT, ES, NL, PT), jeu de
clés strictement identique d'une langue à l'autre, vérifié par assertion. Aucune chaîne vide,
et chaque langue est réellement traduite plutôt que copiée (contrôlé sur l'allemand et le
néerlandais).

**Trois surfaces câblées** — `traceability`, `evidence`, `dpp` — avec un sélecteur de langue
qui énumère `TracefabI18n.LANGS` : aucun bouton de langue codé en dur, ajouter une langue reste
ajouter un dossier.

## Un oubli rattrapé avant livraison

`/i18n-core.js` renvoyait 404 : chaque fichier de `public/` exige sa route explicite dans
`vercel.json`, comme `/i18n-engine.js` et `/auto-translate.js` ont la leur. Sans cette route,
les trois surfaces se seraient chargées en français en production — proprement, grâce au repli,
mais sans traduction. Route ajoutée : **16 routes**, JSON revalidé.

## Ce qui n'est pas fait

Les cinq dictionnaires ne sont **pas** unifiés. La landing conserve `i18n-engine.js`,
brand-console conserve `brandTranslations` et le glossaire, `passport` n'a toujours aucune
traduction. Le runtime est en place et trois surfaces le prouvent ; migrer les autres est un
travail de contenu (extraire les chaînes, les traduire) et non d'architecture. `locales/` et
`translations_deep.json` restent chargés par rien d'autre que ce runtime pour le premier.

## Portails

```
test:i18n              75 / 0   NOUVEAU
test:p1-i18n                  PASS (contrat existant sur 7 langues, inchangé)
test:traceability      82 / 0 · test:evidence 65 / 0 · test:public-dpp 69 / 0
test:dpp-readiness     83 / 0 · test:route-registry PASS
test:landing           95 / 0 · check:landing 69 / 0
Balayage des 56 scripts test:* : 37 PASS / 19 FAIL — exactement les 19 préexistants
```

`test:i18n` charge le vrai runtime et les vrais fichiers JSON, puis vérifie : les 7 langues
présentes, le même jeu de clés partout, le changement de langue modifie réellement le texte
rendu dans les 7 langues, `<html lang>` suit, tous les onglets sont traduits et pas seulement
le premier, une clé inconnue laisse le texte rédigé intact et se signale, et les trois surfaces
traduisent dans le DOM rendu avec aucun élément resté en français alors que sa clé existe.

## Toujours non vérifié

**Aucune capture d'écran.** Le rendu des langues à caractères spéciaux (umlauts allemands,
`ij` néerlandais) et le comportement du sélecteur au clic réel restent à confirmer visuellement
: `jsdom` ne calcule aucune mise en page.

---

## Chantier 13 — Le pipeline de chaîne d'approvisionnement rendu réel, et purge du contenu fabriqué de la console

`test:supplychain:chantier3` échouait depuis **avant le début de ces travaux** (`4ddf5f5`, premier commit cloné).
Trois réponses étaient possibles : corriger la vue, corriger le test, ou supprimer le test. **La vue a été corrigée.**

### Ce que la mesure a établi

| Objet | Avant | Constat |
|---|---|---|
| `supplyChainView()` | 158 lignes | **ne rendait ni pipeline ni niveaux** |
| `.pipeline` | CSS 5 colonnes | définie, **jamais utilisée** (0 `class="pipeline"`) |
| `sc.stages` | déstructuré | **jamais référencé** dans le rendu |
| Ce qui était rendu | une maquette | « 7-ECHELON CHAIN OF CUSTODY TIMELINE » |

La maquette affichait `ÉCHELON 01 · CULTURE`, `Izmir, Turquie`, `Ege Birlik Mill`, `ÉCHELON 07 · CONFECTION`,
`Haute-Vienne, FR` et des cartes de score (`7 / 7 · 100% de la chaîne physique`, `Polygones GPS vérifiés 100%`,
`Couverture de preuves 98.4%`). **Aucun de ces lieux, ateliers ni chiffres n'existe dans le jeu de démonstration.**
Le test avait donc raison sur le fond : les cinq libellés décrivaient un pipeline qui n'avait jamais été rendu.

### Ce qui a été fait

1. **Pipeline réel à cinq niveaux** — `Tier 4 · Matières`, `Tier 3 · Filature`, `Tier 2 · Tissage`,
   `Tier 1 · Confection`, `Tier 0 · Produit Fini`, rendus depuis `state.supplyChain.stages`
   (les clés exactes du contrat `GET /api/products/{id}/supply-chain`). Chaque niveau affiche le
   **nombre réel de nœuds** et ses nœuds réels ; un niveau vide indique « Aucun nœud rattaché »
   plutôt que de disparaître silencieusement.
2. **Cartes de score calculées** — nœuds documentés, liaisons documentées, couverture documentaire
   et taux de complétion proviennent de `summary`, produit par `computeTraceabilitySummary()`
   (`api/_lib/supply-chain.ts`), au lieu de constantes.
3. **Deux actions rendues atteignables** — `generate-baseline-chain` et `new-chain-link` avaient
   gestionnaire et fonction mais **aucun bouton** : la génération de chaîne de référence était
   inaccessible depuis l'interface.
4. **`intelligenceView()` supprimée** — 126 lignes de maquette sous un bandeau se réclamant de
   n'inventer aucune donnée, et qui inventait des SKU, des fournisseurs et des empreintes de
   certificats (`TC-CU-881294-01/02/05`) absents de toute table. L'entrée de menu appelle désormais
   `intelligenceUnavailableView()`, qui dit la vérité et renvoie vers les surfaces réelles.
   Du contenu fabriqué qui se déclare exact est un risque, pas une réserve.
5. **Deux autres maquettes retirées** — la table de « Réconciliation de la Balance Massique par
   Jalon » (73 lignes, mêmes certificats inventés) est remplacée par un renvoi vers
   `/traceability/`, qui calcule le bilan sur données réelles.
6. **Trois notes codées en dur supprimées** — « Indice Qualité : 98.4 / 100 », « NOTE GLOBALE :
   GRADE A (98.4%) » et « RECONCILIATION MASSIQUE 98.4% » : les deux premières dérivent désormais
   de `p.score`, la troisième ne revendique plus ni certification ni réconciliation.
7. **Deux chutes fabriquées neutralisées** — `supplyChainView` et `massBalanceConsoleView`
   affichaient `{nodeCount: 14, linkCount: 13, documentationRate: 98, stagesCoveredCount: 7}`
   quand aucune donnée n'était chargée : remplacées par des zéros explicites.
8. **La démo alignée sur le contrat API** — `demoSupplyChain()` n'exposait pas
   `documentedNodeCount` ni `documentedLinkCount`, que `computeTraceabilitySummary()` renvoie.
9. **CSS nettoyée** — 25 règles mortes retirées (`.intel-*`, `.tc-echelon*`, `.tc-reconcil-card`),
   accolades équilibrées (241/241), plus aucun avertissement du parseur.

### Garde-fou ajouté

`scripts/test_supply_chain_surface.mjs` (`npm run test:supplychain:surface`) — **56 contrôles**.
Il suit le parcours réel (catalogue → fiche produit → ouvrir la chaîne), vérifie les cinq niveaux
dans l'ordre, que chaque compte correspond au nombre réel de nœuds, que les scores viennent du
résumé calculé, que les trois actions ont un bouton, et que le contenu fabriqué ne revient pas.

### Mesures

| Portail | Résultat |
|---|---|
| `test:supplychain:surface` (nouveau) | **56 contrôles, 0 échec** |
| `test:supplychain:chantier3` | **vert** (était rouge avant ces travaux) |
| `test:brand-console` | vert |
| `test:dpp-readiness` | 83 / 0 |
| `test:quality-center` | 69 / 0 |
| `test:landing` | 95 / 0 |
| `test:i18n` | 75 / 0 |
| `test:route-registry`, `test:supplier-portal` | verts |

Balayage : **39 PASS / 18 FAIL** (était 37 / 19). **Aucun nouvel échec.**

Les six vues principales (`overview`, `products`, `supplyChain`, `dpp`, `quality`, `intelligence`)
rendent sans erreur sous jsdom.

### Ce qui reste ouvert

- **Une lignée fabriquée subsiste dans `productDetailView()`** : « Lignée Complète de Transformation »
  avec des `alert()` codés en dur (Ferme Izmir, Filature de Haute-Vienne) et un badge
  « ✓ 100% Vérifié & Scellé ». Elle est hors du périmètre de la surface chaîne testée ici,
  mais elle relève du même défaut et doit être traitée.
- **`fallback-data.ts`** fournit toujours une chaîne inventée en dernier recours, sans marqueur de démonstration.
- Le score de qualité produit n'est qu'une moyenne de scores de lignes ; les trois personnes
  distinctes de la fiche produit rendent le même score.

---

## Chantier 14 — Lignée de la fiche produit rendue réelle, et matrice de qualité alignée sur son contrat

### Ce que la mesure a établi

`productDetailView()` (142 lignes) rendait un bloc « Lignée Complète de Transformation » de
**45 lignes, 8 échelons codés en dur**, dont **7 `alert()`** affichant du contenu absent de toute
table : `Ferme Izmir, Turquie`, `Filature de Haute-Vienne (Combed Ring Spun Ne 30/1)`,
`Portugal Textile Mill (Jersey 185g/m²)`, `EcoDye Aquitaine (ZDHC Level 3)`,
`Atelier Confection SAS (Barcelos, SMETA 4-Pillar)`, `AT-ESS-001 réconciliée à 100%`,
`3.42 kg CO2e / pièce`, sous un badge `✓ 100% Vérifié & Scellé`.

Le contrat réel `GET /api/products/{id}` renvoie `{ product, identifiers, materials }`, où
`materials[]` porte `{materialId, role, percentage, unit, productVersion, material: {name,
material_type, origin_country_code, normalized_name}}`. **Aucun échelon de transformation n'y
figure** : la lignée complète fibre→DPP ne peut pas être construite depuis cette fiche.

### Découverte : un correctif précédent était faux

`serializeProduct` (`api/_lib/products.ts:32`) **ne renvoie pas `score`**. Le remplacement de
« Indice Qualité : 98.4 / 100 » par `${p.score ?? 0}` affichait donc `0 / 100` sur données réelles
— un zéro honnête, mais présenté comme une mesure qui n'existe pas. Le contrat expose en revanche
`dataCompletion` et `dataReadiness` (`enum product_data_readiness`: `not_started`, `in_progress`,
`data_ready`, `needs_review`). Les deux affichages utilisent désormais ces champs.

### Bug de portée introduit puis corrigé

Le remplacement de « NOTE GLOBALE : GRADE A (98.4%) » ciblait la ligne 2542, qui appartient à
**`qualityView()`** et non à `productDetailView()` : les constantes `readinessLabel` et
`completionPct` n'y sont pas définies, ce qui aurait levé une `ReferenceError` au rendu.
`qualityView()` calcule maintenant ses propres valeurs depuis `prod` et `state.quality`.

### Ce qui a été fait

1. **Lignée réelle** — une carte par matière réellement rattachée (rôle, nom, pourcentage, pays
   d'origine), ou une carte « Aucune matière rattachée » si la liste est vide ; un échelon
   « TRANSFORMATION » qui dit « Non renseignée dans cette fiche » et renvoie vers le graphe de
   traçabilité ; un échelon produit (référence et lieu de fabrication réels) ; un échelon DPP.
   Les 7 `alert()` et le badge « ✓ 100% Vérifié & Scellé » sont supprimés.
2. **Complétude réelle** — « Indice Qualité : X / 100 » et « NOTE GLOBALE : GRADE A » deviennent
   « Complétude des données : X% » et « ÉTAT : <état réel> », depuis `dataCompletion` et
   `dataReadiness`.
3. **Matrice de qualité alignée sur `serializeQualityScore`** (`api/_lib/quality.ts:48`), qui
   renvoie `completeness`, `freshness`, `documentationCoverage` et `consistency` en chaînes.
   COMPLÉTUDE DONNÉES et COUVERTURE PREUVES affichent les valeurs réelles ; TAUX VÉRIFICATION,
   QUALITÉ FOURNISSEUR et RÉGULARITÉ ESPR affichent **« Non mesuré »** au lieu de `88.5%`,
   `94.2%` et `88.0%`, car ces indicateurs ne figurent pas dans le contrat. `96.8%` et `92.0%`
   sont remplacés de même.

### Mesures

`test:supplychain:surface` passe de 56 à **76 contrôles, 0 échec** (sections H et I ajoutées :
lignée de la fiche produit, centre de qualité). Balayage : **39 PASS / 18 FAIL**, aucun nouvel échec.

Sonde jsdom : fiche produit → lignée réelle, 4 cartes, « Complétude 82% », aucun lieu inventé ;
qualité → 5 « Non mesuré », « ÉTAT : À revoir », 0 erreur.

### Ce qui reste fabriqué ailleurs dans la console (mesuré, non corrigé)

| Ligne | Contenu | Vue |
|---|---|---|
| 1719, 1733 | `Jersey 185g/m²`, `ZDHC Level 3` dans un SVG | diagramme |
| 1938, 1948 | `Filature de Haute-Vienne`, `EcoDye Aquitaine` dans un tableau | à identifier |
| 2158, 2160 | `88.0%` « Passeports prêts » | `mc-stat-huge` |
| 2625, 2649 | `teinturerie EcoDye`, `Atelier de Barcelos` | `qualityView` |

`brand-console/index.html` contient encore **22 `alert()`** réparties sur 8 vues
(`documentsConsoleView` 6, `materialsConsoleView` 3, `reportsConsoleView` 3, `requestDetailView` 3,
`questionnairesBuilderView` 2, `supplyChainConsoleView` 2, `certificationsConsoleView` 1,
`settingsConsoleView` 1, `supplyChainView` 1).

---

## Chantier 15 — Phase 5 : le centre de pilotage rendu réel

### Ce que la mesure a établi

`overview()` faisait 147 lignes et référençait `state` **deux fois** (`state.products.length`,
`state.requests`). Tous les autres chiffres étaient les exemples du brief, codés en dur :

| Domaine | Valeurs codées en dur |
|---|---|
| 01 / SUPPLY CHAIN | `1 248` produits, `86` fournisseurs, `214` sites, `18 pays` |
| 02 / DATA QUALITY | `92.4%`, `84.0%`, `78.0%`, `142` certificats |
| 03 / TRACEABILITY | `91.0%`, `100%`, `214 sites`, `97.6%` |
| 04 / DPP READINESS | `88.0%`, `1 098 styles`, `Conformité AGEC Art. 13 : 100%`, `Calculs PEF validés : Échelon 3` |
| ATTENTION | `17`, `8`, `5`, `12` |

Le repli lui-même était fabriqué : `const prodCount = state.products.length || 1248;` — un
catalogue vide affichait les 1 248 produits du brief.

La revendication la plus grave était **« Conformité AGEC Art. 13 : 100% »** : un pourcentage de
conformité affiché alors qu'aucune donnée AGEC n'est saisie nulle part. Le tableau de bord
affirmait une conformité que rien ne mesurait.

> **Correction apportée au Chantier 21.** Ce paragraphe affirmait que `frenchAgecArt13` « vaut
> structurellement `false` » faute de colonnes `agec` au schéma. **C'est faux.**
> `validateDppCompliance()` ne lit pas la base : `api/_routes/dpp/validate.ts` reçoit un
> `CirpassDppPayload` dans le corps d'un `POST`, et un appelant qui envoie
> `frenchAgecArticle13: { tissageTricotage, teintureImpression, confection }` obtient bien
> `frenchAgecArt13: true`. Le critère est satisfaisable. Ce qui est vrai, c'est que **rien ne
> collecte ni ne persiste** ces données : aucun produit du système n'en porte, donc en pratique le
> critère n'est jamais rempli. La suppression du « 100% » affiché reste justifiée, mais au motif
> « aucune donnée », pas « impossible ».

### Ce qui a été fait

`overviewMetrics()` calcule tout depuis les quatre listes chargées au démarrage
(`/api/products`, `/api/suppliers`, `/api/materials`, `/api/data-requests`) :

- **01 / SUPPLY CHAIN** — produits, fournisseurs, matières, et pays réellement déclarés
  (union de `organizations.country_code` et `countryOfManufacture`).
- **02 / DATA QUALITY** — complétude moyenne réelle sur `dataCompletion`, et répartition par
  `dataReadiness` (`data_ready`, `in_progress`, `needs_review`, `not_started` — l'enum Prisma).
- **03 / TRACEABILITY** et **04 / DPP READINESS** — **« Non mesuré »**, avec l'explication et un
  renvoi vers la vue qui les calcule. Ces deux indicateurs sont évalués produit par produit depuis
  le graphe de nœuds et la préparation DPP ; ils ne sont pas agrégables au démarrage. Le badge DPP
  rappelle que le degré de préparation est un indicateur, pas une certification.
- **ATTENTION** — demandes ouvertes et échéances sous 7 jours via `requestCounts()`, produits
  incomplets (`dataCompletion < 100`) et produits à revoir (`needs_review`), chacun cliquable.
- Le bandeau d'accroche ne promet plus de « conformité ESPR / AGEC ».

### Mesures

Sonde jsdom sur `?demo=1` (2 produits à 82% et 46%, 1 fournisseur, 1 matière, 2 demandes) :
chiffres rendus `2 | 64% | Non mesuré | Non mesuré`, points d'attention `2 | 2 | 2 | 1`.
**64% = round((82 + 46) / 2)** — la moyenne est bien recalculée. Aucun des chiffres du brief
n'apparaît. 0 erreur.

`test:dashboard:overview` — **37 contrôles, 0 échec** : chaque comptage est comparé à la liste
réelle correspondante, la moyenne est recalculée indépendamment, et les dix chiffres du brief sont
assertés absents.

Portails : brand-console, dashboard:overview 37/0, supplychain:surface 76/0,
supplychain:chantier3, dpp-readiness 83/0, route-registry, landing 95/0, quality-center 69/0,
i18n 75/0. Balayage : **40 PASS / 18 FAIL** (était 37 / 19 au début), aucun nouvel échec.

---

## Chantier 16 — Phase 5 : intelligence produit, et un formulaire qui n'écrivait plus de fausses données

### Bug de corruption de données trouvé et corrigé

La « Fiche Technique & Attributs Réglementaires » pré-remplissait ses `<input>` avec des valeurs
inventées :

```
name="colorName"            value="${esc(p.colorName || 'Navy Deep')}"
name="countryOfSpinning"    value="${esc(p.countryOfSpinning || 'PT')}"
name="countryOfManufacture" value="${esc(p.countryOfManufacture || 'PT')}"
name="weightGrams"          value="${esc(p.weightGrams || '185')}"
name="sizeRange"            value="${esc((p.sizeRange || ['XS','S','M','L','XL']).join(', '))}"
name="category"             value="${esc(p.category || 'Prêt-à-porter')}"
```

`saveProduct()` envoie `...data` (tous les champs du formulaire) au PATCH
`api/_routes/products/[productId].ts`, qui **accepte et valide** `colorName`, `sizeRange`,
`countryOfDesign`, `countryOfManufacture`, `weightGrams` et `careInstructions` (l. 113–147).
Ouvrir un produit dont ces champs sont vides puis cliquer sur « Mettre à jour la fiche produit »
**écrivait donc `Navy Deep`, `PT`, `185` et `XS, S, M, L, XL` dans l'enregistrement réel**.
`countryCode()` validait `'PT'` sans difficulté.

Ce n'était pas cosmétique : c'était une écriture de données fabriquées dans la base.

### Corrections

1. **Plus aucune valeur par défaut inventée** — un champ absent de la donnée reste vide, avec un
   `placeholder` explicite (« Non renseignée », « Code ISO, ex. FR »). La soumission ne peut plus
   fabriquer de valeur.
2. **Champ fantôme supprimé** — `countryOfSpinning` n'existe dans aucun contrat : ni dans
   `serializeProduct` (`api/_lib/products.ts:32`), ni dans la liste de champs acceptés par le PATCH.
   Il est remplacé par `countryOfDesign`, qui existe réellement.
3. **Total de nomenclature calculé** — le badge `100% Reconcilié` ne sommait rien. Il affiche
   maintenant `Somme des parts : N%` calculé sur `detail.materials[].percentage`, ou
   « Aucune matière rattachée » si la liste est vide. `bomTotal` vaut `null` sans matière : aucun
   total n'est décrété.
4. **Repli de type de matière** — `materialType(m.material) || 'Fibre certifiée'` devenait
   `|| 'Type non déclaré'` : une matière sans type n'est pas une fibre certifiée.
5. **Fonctionnalité morte exposée** — le gestionnaire `product-quality-from-detail` existait
   (dispatcheur l. 4054) **sans aucun bouton** : la qualité n'était pas atteignable depuis la fiche
   produit. Le bouton est ajouté, et un clic bascule bien vers la vue qualité (vérifié).
6. **Périmètre explicite** — un bandeau « Explorer ce produit » regroupe les quatre actions réelles
   (chaîne, qualité, préparation DPP, demande de preuve) et **dit ce que la fiche ne porte pas** :
   fournisseurs rattachés, preuves, certifications et historique ne figurent pas dans
   `GET /api/products/{id}`, et sont renvoyés vers les vues documents, certifications et demandes.

### Mesures

Sonde jsdom sur `?demo=1`, produit `demo-product-1` (couleur, pays, poids et tailles absents) :

```
name                 = "Essentiel coton"     <- réel
reference            = "AT-ESS-001"          <- réel
category             = "T-shirt"             <- réel
colorName            = ""                    <- vide, comme la donnée
countryOfDesign      = ""
countryOfManufacture = ""
weightGrams          = ""
sizeRange            = ""
badge BOM            = "Aucune matière rattachée"
```

Clic sur « Qualité des données » → `state.view === 'quality'`. 0 erreur.

`test:product:intelligence` — **36 contrôles, 0 échec**. Il compare chaque champ du formulaire à
la donnée réelle, asserte l'absence des six valeurs fabriquées, recalcule le total de nomenclature
indépendamment, vérifie que les quatre actions ont à la fois un bouton **et** un gestionnaire, et
que le clic qualité bascule réellement de vue.

Portails (11) : brand-console, product:intelligence 36/0, dashboard:overview 37/0,
supplychain:surface 76/0, supplychain:chantier3, dpp-readiness 83/0, route-registry, landing 95/0,
quality-center 69/0, i18n 75/0, supplier-portal. Balayage : **41 PASS / 18 FAIL**
(était 37 / 19 au début de ces travaux), aucun nouvel échec.

### Phase 5 — état

Les trois domaines de la Phase 5 sont livrés : **Dashboard** (centre de pilotage calculé,
Chantier 15), **Overview** (idem) et **Product Intelligence** (lignée réelle Chantier 14,
formulaire et exploration Chantier 16). Les 11 domaines de navigation du brief étaient déjà tous
présents — mesuré : 16 entrées `navButton`, 18 vues dans le routeur ternaire, aucune vue sans cible.

---

## Chantier 17 — Les 22 fausses annonces de succès, et 54 gestionnaires de clic qui ne faisaient rien

### Ce que la mesure a établi

Les 22 `alert()` n'étaient pas des traces de débogage : c'étaient des **annonces de succès pour
des opérations jamais exécutées**.

| Bouton | Ce qu'il affichait | Ce qu'il faisait |
|---|---|---|
| Exporter CSV | « Exportation CSV générée. » | rien |
| + Ajouter un matériau | « Nouveau matériau enregistré. » | rien |
| Vérifier (×4) | « Certificat vérifié. », « Rapport de laboratoire conforme. », « Audit social approuvé sans non-conformité. », « Preuve inspectée avec succès. » | rien |
| Générer le rapport CSRD | « Rapport CSRD exporté avec succès. » | rien |
| Télécharger XLSX / PDF | « Export CSRD lancé. », « Fiche AGEC générée. » | rien |
| Enregistrer (paramètres) | « Paramètres sauvegardés. » | rien |
| Rappel fournisseur | « Rappel email envoyé à Rui Silva (Nhãn Textile). » | rien — et la personne est inventée |

### La cause, plus large que les 22 boutons

Le script de la console est une IIFE : `(() => { 'use strict'; … })()`. Un gestionnaire
`onclick` **inline** s'exécute hors de cette portée. Sur **59 `onclick` inline**, seuls
**5** référençaient un global du navigateur (`window.open`) : les **54 autres levaient une
`ReferenceError` au clic**, silencieusement.

Les 22 `alert()` « fonctionnaient » **par accident** : `alert` est une globale du navigateur.
C'est précisément pourquoi les fausses annonces de succès marchaient pendant que les vrais
gestionnaires, eux, échouaient. Parmi les 32 préexistants cassés : `state.view='…';render();`,
`state.selectedChainNode='…';render();`, `filterRequestsByStatus('…')`, `filterIssues('…')`.

### Corrections

1. **Exposition des identifiants** utilisés par les gestionnaires inline (`state`, `render`,
   `notify`, `esc`, `pendingAction`, `filterIssues`, `filterRequestsByStatus`, les fonctions
   d'export, `verifyDocument`). Un seul point de correction règle les 54.
2. **`pendingAction(label)`** — une action non reliée au serveur affiche
   « … — action non reliée au serveur, rien n'a été effectué. » (toast d'erreur) au lieu d'un
   succès. Aucun fichier n'est produit.
3. **Trois exports rendus réels**, en réutilisant `downloadTextFile()` déjà présent :
   gabarits de questionnaire en JSON, matières en CSV, synthèse de la demande en JSON.
   `Exporter Audit Complet` est câblé sur `exportAudit()` (endpoint réel existant).
4. **`filterIssues()` n'existait nulle part** — les cinq onglets de sévérité du centre de
   qualité appelaient une fonction absente. Elle est implémentée, pilotée par
   `state.issueFilter`.
5. **Les onglets portaient des valeurs hors enum.** Ils filtraient sur `critical` et `review`,
   alors que l'enum Prisma `quality_issue_severity` vaut `info`, `warning`, `blocking`.
   Réécrits sur l'enum réel, avec **compteurs calculés** au lieu de `3, 0, 1, 2, 14` codés en dur.
6. **`issueCard()` était défini mais jamais appelé.** Le conteneur
   `#quality-issue-container` contenait 39 lignes de « Simulated High-Impact Actionable Issues »
   (`ZDHC_EFFLUENT_TEST_REPORT`, « lot de teinture #089 », « Document AI », « teinturerie
   EcoDye Aquitaine »), avec un compteur `${q ? q.issues.length : 3}` retombant sur 3.
   Le renderer réel est maintenant utilisé.
7. **`state.documents` n'était ni déclaré ni assigné** — `documentsConsoleView` rendait un
   tableau de 42 lignes codées en dur (SGS, Control Union, Intertek, CITEVE, Portugal Textile
   Mill, Filature de Haute-Vienne, EcoDye Aquitaine) sous un badge
   « ✓ Contrôle d'intégrité Neon & Document AI validé ». `GET /api/documents` existe pourtant
   et renvoie `{documents, count, byKind, byStatus, byVerification, expiringWithin90Days}`.
   La vue est câblée sur ce contrat, avec un état vide honnête, et **« Vérifier » appelle
   réellement `GET /api/documents/{id}/verification-report`** et télécharge le rapport.

### Mesures

Sonde jsdom sur `?demo=1` :

```
alert() dans le source        : 0
export gabarits               : tracefab-questionnaire-templates.json, 4 gabarits, JSON valide
export matières               : tracefab-materials.csv
                                id,name,normalized_name,materialType,originCountryCode
                                demo-material-1,Coton biologique,,fiber,PT
Générer le rapport CSRD       : aucun fichier produit
                                toast « … — action non reliée au serveur, rien n'a été effectué. »
Enregistrer (paramètres)      : aucun fichier produit, même toast
onglets qualité               : 2 | 1 bloquant | 1 avertissement | 0 info | 0 résolues  (= 2 réelles)
filtre « Bloquant »           : issueFilter=blocking, 1 carte
filtre « Avertissement »      : issueFilter=warning, 1 carte
retour « Toutes »             : issueFilter=all, 2 cartes
centre de preuves             : 0 document, état vide honnête, aucune preuve inventée
erreurs                       : aucune
```

`test:console:actions` — **64 contrôles, 0 échec**. Il asserte l'absence des 22 annonces,
vérifie que **chaque `onclick` inline résout** (aucun identifiant non exposé), capture le blob
réellement produit par les exports et compare son contenu aux listes réelles, vérifie qu'une
action non reliée ne produit **aucun fichier**, que les compteurs d'onglets somment au total
réel, et que le centre de preuves ne contient plus aucune ligne inventée.

Portails (12) : brand-console, console:actions 64/0, product:intelligence 36/0,
dashboard:overview 37/0, supplychain:surface 76/0, supplychain:chantier3, dpp-readiness 83/0,
route-registry, landing 95/0, quality-center 69/0, i18n 75/0, supplier-portal.
Balayage : **42 PASS / 18 FAIL** (était 37 / 19 au début de ces travaux), aucun nouvel échec.

### Ce qui reste

- Le bouton **+ Déposer une nouvelle preuve** et **+ Déclarer un certificat** signalent
  honnêtement qu'ils ne font rien, mais `POST /api/documents/upload-intent` existe : ils
  peuvent être câblés.
- `fallback-data.ts` sert toujours une chaîne inventée en dernier recours.
- Le bug `|| true` de `api/_lib/dpp.ts` (~192) rend toute exigence DPP bloquante en permanence.
- Les cinq dictionnaires i18n ne sont pas unifiés ; `passport/` n'a aucun i18n.

---

## Chantier 18 — La tautologie `|| true` de la préparation DPP

### Le bug

`api/_lib/dpp.ts:196` :

```ts
const isBlocking = blockingList.some((b) => b.key === key) || true;
```

`X || true` vaut **toujours** `true`. Les neuf exigences standard étaient donc toutes déclarées
bloquantes — y compris celles qui étaient satisfaites — et `blockingList` n'était jamais consulté.

### Portée réelle, mesurée

| Consommateur | Lit `items[].blocking` ? |
|---|---|
| `brand-console` `renderPillarCard` (l. 3056) | non — lit `it.met` et `it.label` |
| `brand-console` panneau « Ce qui bloque » (l. 2935–2942) | non — itère `dpp.missingFields`, dont le `blocking` vient correctement de l'enregistrement |
| `dpp/index.html` | non — aucune occurrence de `blocking` |
| **`GET /api/gs1/digital-link/{gtin}`** | **oui — publie `pillars` intégralement** |

Aucune page TRACEFAB n'était trompée, mais **le champ faux était publié aux tiers** par la route
GS1 : toute exigence y était annoncée bloquante.

### Modèle réel, lu dans la migration

`supabase/migrations/20260922070000_tracefab_dpp_readiness.sql` :

- le profil vit dans la **table** `dpp_requirement_profiles(profile_key, profile_version, definition)` ;
  `textile_readiness_mvp` / `1.0` déclare `"blocking": true` pour les 9 exigences (l. 77–85) ;
- `requirement_results[]` ne porte que `{key, met}` (l. 236–240) — **pas** `blocking` ;
- `missing_fields[]` porte `{key, label, blocking}`, **seulement pour les exigences non satisfaites**,
  avec `'blocking', COALESCE((v_requirement ->> 'blocking')::boolean, true)` (l. 244–249) ;
- `blocking_issues[]` ne reçoit une entrée que si l'exigence est bloquante **et** non satisfaite.

Le caractère bloquant est donc une **propriété du profil**, pas un état courant — et il ne survit
dans l'enregistrement que pour les exigences non satisfaites.

### Correction

1. **`fetchDppRequirementProfile(tx, profileKey, profileVersion)`** lit
   `dpp_requirement_profiles.definition -> 'requirements'`. La base reste l'unique source de
   vérité ; le module ne duplique pas le profil.
2. **`buildDppSummary` accepte un `profile` optionnel** (4ᵉ paramètre) : les quatre appelants
   existants continuent de compiler et de fonctionner sans modification.
3. **Résolution dans l'ordre du SQL** : déclaration du profil, puis valeur persistée dans
   `missing_fields`, puis `true` — exactement `COALESCE(…, true)`.
4. **Les deux routes qui publient le champ sont câblées** :
   `api/_routes/products/[productId]/dpp.ts` (POST calcul et GET lecture) lit le profil avec la
   clé et la version demandées ; `api/_routes/gs1/digital-link/[gtin].ts` le lit avec
   `requirement_profile_key` / `requirement_profile_version` de l'enregistrement.

`blockingCount` et `blockingIssues` étaient déjà corrects (`blockingList.length`) : inchangés.

### Mesures

`npm run api:typecheck` : **98 erreurs avant, 98 après, aucune nouvelle**. Les 98 sont
préexistantes et toutes dues au client Prisma non généré dans cet environnement. **Mes trois
fichiers (`api/_lib/dpp.ts`, les deux routes) ne produisent aucune erreur.**

`test:dpp-blocking` — **23 contrôles, 0 échec**. Il **compile le vrai `api/_lib/dpp.ts` et appelle
la vraie `buildDppSummary`** ; il ne réimplémente pas la logique. Il vérifie :

- sans profil, les neuf exigences sont bloquantes (défaut du SQL) ;
- un profil déclarant deux exigences `blocking: false` est **respecté** — ce que `|| true` rendait
  impossible — et les autres retombent sur `true` ;
- la valeur persistée dans `missing_fields` est respectée ;
- en cas de conflit, **le profil prime** sur la valeur persistée ;
- `blockingCount`, `blockingIssues`, `totalRequirements`, `metRequirements` et la somme des piliers
  sont inchangés ;
- le champ publié peut désormais exprimer « recommandé ».

**Contre-épreuve** : le bug réintroduit temporairement, le test échoue de **7 façons**, dont
« une exigence déclarée recommandée n'est plus bloquante » et « la valeur persistée par la fonction
SQL prime ». Le test épingle donc bien le comportement, pas seulement le texte.

Portails (12) verts, dont `dpp-readiness` 83/0 et `dpp-chantier4` (passe en direct ; non
enregistré dans `package.json`). Balayage : **43 PASS / 18 FAIL** (était 37 / 19 au début de ces
travaux), aucun nouvel échec.

### Ce que ce correctif ne change pas aujourd'hui

Le profil `textile_readiness_mvp` déclare les 9 exigences bloquantes : la sortie observable est
donc identique **pour ce profil**. Ce qui change, c'est que la valeur n'est plus une tautologie :
elle exprime la règle réelle, respecte le profil dès qu'une exigence devient recommandée, et n'est
plus contradictoire avec `blockingCount`.

---

## Chantier 19 — Les 18 « échecs » de la suite étaient des blocages d'environnement, et un runner pour le dire

### Correction d'une affirmation fausse

J'avais écrit que les 18 tests en échec étaient « pour l'essentiel des scripts non enregistrés dans
`package.json` ». **C'est faux, et la mesure le contredit** : les **18 sont enregistrés**, aucun ne
manque.

### Causes réelles, mesurées une par une

| Cause | Nb | Message réel |
|---|---|---|
| Client Prisma non généré | 5 | `@prisma/client did not initialize yet. Please run "prisma generate"` |
| Base Neon requise | 6 | `DATABASE_URL is required` |
| Navigateur Playwright absent | 4 | `Executable doesn't exist at …/ms-playwright/chromium_headless_shell-1243/…` |
| Environnement de staging requis | 3 | `requires TRACEFAB_STAGING_URL … ; no mock/demo fallback is allowed` |

Les deux premières tentatives de réparation ont été **mesurées, pas supposées** :

```
$ npx prisma generate
Error: request to https://binaries.prisma.sh/all_commits/…/schema-engine.sha256 failed

$ npx playwright install chromium-headless-shell
Error: Download failure — host: 'cdn.playwright.dev'  code: 'ECONNRESET'
```

Ni `binaries.prisma.sh` ni `cdn.playwright.dev` ne font partie des hôtes joignables depuis cet
environnement. La catégorie « staging » est un **choix assumé du dépôt** : le message dit
explicitement qu'aucun repli mock ou démo n'est autorisé.

**Aucune des 18 n'est un défaut de code.**

### Découverte connexe : `npm test` ne s'exécute jamais

`npm test` enchaîne **25 étapes** avec `&&`. Mesuré : il s'arrête à l'**étape 2** (`api:typecheck`,
98 erreurs de types Prisma préexistantes). Les étapes 3 à 25 — dont 19 suites de tests — **ne sont
jamais exécutées** dans cet environnement.

### Ce qui a été fait

`scripts/run_test_suite.mjs` (`npm run test:suite`) exécute les **61 scripts `test:*`**
indépendamment et classe chaque résultat :

- **PASS** — le script a tourné et réussi ;
- **SKIP** — le script n'a pas pu tourner, et la cause correspond à un motif **mesuré** (les
  quatre du tableau ci-dessus), avec la raison et le remède affichés ;
- **FAIL** — tout le reste. **Un motif non reconnu est un échec**, jamais un SKIP.

Le code de sortie n'est non nul qu'en présence d'un FAIL. Options : `--only <sous-chaîne>`,
`--json`, `TRACEFAB_TEST_TIMEOUT_MS`.

Deux pièges corrigés en cours de construction :

1. **`npm run` lance un node enfant** : tuer `npm` seul laissait l'enfant tenir les pipes ouverts
   et le runner attendait indéfiniment. Corrigé par `detached: true` + `process.kill(-pid)`.
   Un dépassement de délai est classé **FAIL**, jamais SKIP.
2. **`test:suite` est lui-même un `test:*`** : le premier lancement s'est exécuté récursivement et
   ne s'est jamais terminé. Le runner s'exclut désormais lui-même.

### Mesures

```
PASS 43 · SKIP 18 · FAIL 0 — sur 61 scripts

  4 × browser        cdn.playwright.dev injoignable
  5 × prisma-engine  binaries.prisma.sh injoignable
  6 × database       DATABASE_URL non défini
  3 × staging        environnement de staging requis (par conception)
```

**Zéro échec réel.** Les 43 scripts qui peuvent tourner ici tournent et passent.

**Contre-épreuve** : un échec réel injecté dans `test:route-registry` (sortie `FAILED` +
`process.exit(1)`) est bien classé **FAIL** avec un code de sortie **1**, et non avalé en SKIP.
Le fichier a ensuite été restauré : `npm run test:route-registry` repasse (exit 0) et
`git diff` sur ce fichier est vide.

### Ce que cela ne règle pas

Les 18 SKIP restent **non exécutés**. Ce chantier les rend lisibles et distinguables d'une
régression ; il ne les fait pas tourner. Pour les exécuter il faut, selon la catégorie :
`npx prisma generate`, un `DATABASE_URL` de test, `npx playwright install chromium`, ou un
environnement de staging avec ses jetons.

---

## Chantier 20 — Un pass Wallet signé n'a jamais affirmé une mesure inventée

### Ce qui a été trouvé

Trois couches de fabrication se superposaient, et non une seule comme signalé.

**1. `api/_lib/wallet/fallback-data.ts` (36 lignes, supprimé)** — un `DppPassData`
entièrement inventé : `pefScore: 84`, `pefGrade: 'A'`, `carbonFootprintKgCo2e: 2.15`,
`waterScarcityM3: 1.48`, `circularityScore: 92`, `transactionCertificateNumber:
'TC-CU-881294-GOTS-2026'`, une chaîne d'approvisionnement à 5 nœuds, `certifiedComposition:
'100% Coton Biologique Régénératif'`, et un texte d'entretien affirmant un « Bonus Refashion
éligible ».

**2. `api/_lib/wallet/dpp-data-resolver.ts` — le résolveur « réel » inventait aussi.**
`pefScore: 78`, `pefGrade: 'B'`, `carbonFootprintKgCo2e: 3.42`, `waterScarcityM3: 0.85`,
`circularityScore: 85`, `weightGrams: 250`, `countryOfManufacture || 'PT'`,
`countryOfDesign || 'FR'`, `'100% Coton peigné'` en composition de repli, `'Filature ➔ Tissage
➔ Ennoblissement ➔ Confection auditée'` en chaîne de repli, et deux textes constants
affirmant une recyclabilité. Il consignait pourtant honnêtement ces lacunes dans `dataGaps[]`
— mais les valeurs inventées partaient quand même dans le pass.

**3. Les deux générateurs ajoutaient la leur.** Apple : `certifiedComposition || 'Fibres
naturelles certifiées'`, `supplyChainSummary || 'Traçabilité complète … confection auditée.'`,
`transactionCertificateNumber || 'Validé sous registre bilanciel anti-double dépense'`,
`countryOfManufacture || 'UE'`. Google : `'Fibres certifiées'`, `'Nœuds certifiés GOTS/GRS
auditables.'`, `|| 'UE'`.

**La plus grave était une déclaration légale.** Le pass Apple portait : *« Ce passeport produit
est certifié conforme au Règlement Écoconception ESPR 2024/1781 et à la loi AGEC article 13. »*
Le pass Google portait un module `CONFORMITÉ — ESPR UE 2024 / Loi AGEC Art. 13`.

> **Correction apportée au Chantier 21.** J'écrivais ici que le critère était « structurellement
> toujours faux » parce que `dpp-validator.ts:134` lirait des colonnes `agec.*` absentes du schéma.
> **C'est faux** : le validateur est sans état et travaille sur un payload fourni par l'appelant,
> jamais sur Prisma. L'affirmation du pass restait néanmoins injustifiée — elle sortait d'un
> générateur qui ne consultait **aucune** évaluation de conformité, `standardsPassed` n'existant
> pas dans `DppPassData`. Le pass déclarait une conformité qu'il n'avait pas vérifiée ; il ne
> déclarait pas une conformité impossible.

Enfin, les deux routes `api/_routes/dpp/[gtin]/{apple,google}-wallet.ts` faisaient
`resolved || getFallbackDppData(gtinOrRef)` puis **généraient un pass signé et répondaient
200** — Google redirigeait même le navigateur vers l'URL d'enregistrement. Les deux prenaient
`gtinOrRef` par défaut à `'3760123456789'` codé en dur. Leurs propres routes sœurs
(`products/[productId]/wallet/{apple,google}.ts` et `dpp/[gtin].ts`) faisaient déjà
correctement 400/404 : la divergence était un défaut, pas un choix.

### Ce qui a été décidé et appliqué

- Les 5 champs environnementaux de `DppPassData` passent **optionnels**. C'est leur caractère
  obligatoire qui contraignait le résolveur à inventer — alors que son propre commentaire
  disait « un chiffre de repli n'est pas une mesure ».
- Le résolveur **omet** au lieu d'inventer, et conserve `dataGaps[]`. `careInstructions` est
  servi depuis la vraie colonne `care_instructions` ; `recyclingInstructions` n'a aucune
  source et n'est plus émis.
- Les deux générateurs affichent **« Non mesuré » / « Non déclaré »** et perdent tous leurs
  replis `||` affirmatifs.
- La déclaration de conformité devient factuelle : *« préparé au format du Règlement
  Écoconception ESPR 2024/1781 — ce document ne constitue pas une certification de
  conformité. »*
- Les deux routes répondent **404 `product_passport_not_found`** quand la résolution échoue et
  **400 `missing_identifier`** sans GTIN. **Aucun pass de repli n'est plus signé.**
- `fallback-data.ts` est supprimé (ses deux seuls importeurs étaient ces deux routes).

### Vérification

`npm run test:wallet:honesty` — `scripts/test_wallet_pass_honesty.mjs`, **82/82**. Il compile
et exécute les deux générateurs réels, sans base :

- données **trouées** → aucune valeur inventée, aucune déclaration de conformité, chaque champ
  environnemental contrôlé **par son libellé** vaut « Non mesuré » ;
- données **mesurées** → les valeurs réelles sont restituées (Grade C, 7,4 kg CO₂e, 12,9 m³,
  41/100, PT, TC-2026-00042) et aucune n'est masquée : le correctif n'a pas simplement tout
  remplacé par « Non mesuré ».

**Contre-épreuve** : avec le code d'origine restauré depuis git, le test tombe à **43/82,
exit 1**. Avec le correctif, **82/82, exit 0**.

`api:typecheck` **98 = 98** (référence Chantier 18) — aucune erreur nouvelle ; les 8 erreurs
du wallet sont les types `Buffer`/`zlib` de `@types/node ^20` sur Node 22, préexistantes et
situées dans le code ZIP, pas dans le contenu. Suite complète : **PASS 44 · SKIP 18 · FAIL 0
sur 62**.

### Deux pièges de test rencontrés

- Une recherche de chiffres nus sur le JSON produit des faux positifs : le GTIN
  `3760123456789` **et** le numéro du règlement **ESPR 2024/1781** contiennent « 78 ». Les
  contrôles portent désormais sur des motifs contextuels (`3.42 kg`, `Grade A`, `84/100`).
- Le répertoire de compilation doit rester **dans** le projet : le générateur Google importe
  `jsonwebtoken`, que Node ne résout pas depuis `/tmp`. Compilation dans `.cache/` (ignoré par
  git), supprimé en fin de test.

### Ce que cela ne règle pas

Le pass n'affirme plus rien de faux, mais il n'affirme **rien** tant que l'ACV n'est pas
saisie : la plupart des produits réels produiront un pass entièrement « Non mesuré ». Combler
cela demande une saisie PEF, pas un correctif.

> **Correction apportée au Chantier 21** : cette phrase ajoutait que `frenchAgecArt13` resterait
> « structurellement insatisfaisable » tant que les colonnes AGEC manquent au schéma. Faux, pour la
> raison donnée plus haut. Le vrai manque est une **saisie** AGEC, pas une migration.

---

## Chantier 21 — Le dernier appelant qui laissait le résumé deviner le profil

### Correction d'une affirmation fausse, répétée depuis le Chantier 10

Trois passages de ce document (Chantiers 10 et 20) affirmaient que `frenchAgecArt13` était
**structurellement toujours faux**, au motif que `dpp-validator.ts:134` lirait des colonnes
`agec.*` absentes de `prisma/schema.prisma`.

**C'est faux.** Vérifié : `validateDppCompliance()` est sans état et ne touche jamais à Prisma.
Son seul appelant, `api/_routes/dpp/validate.ts`, reçoit un `CirpassDppPayload` dans le corps
d'un `POST` (`body.payload`). Un appelant qui envoie
`frenchAgecArticle13: { tissageTricotage, teintureImpression, confection }` obtient bien
`frenchAgecArt13: true`. Le critère est satisfaisable ; il n'est simplement **jamais rempli en
pratique**, parce que rien ne collecte ni ne persiste ces données. Les corrections sont
insérées aux trois endroits, sans réécrire l'histoire.

J'ai failli enchaîner sur une migration de schéma AGEC pour « réparer » cette impossibilité
inexistante. Ajouter 8 colonnes à `prisma/schema.prisma` sans pouvoir appliquer la migration
aurait cassé toutes les requêtes sur le modèle concerné.

### Ce qui était réellement cassé

`buildDppSummary(record, id, version, profile)` prend un profil optionnel ; sans lui, la
résolution retombe sur `declaredBlocking ?? persistedBlocking ?? true`, donc **les neuf
exigences deviennent bloquantes**. C'est le bug du Chantier 18.

Sur les **quatre** points d'appel de route, trois passaient le profil. Le quatrième non :

| Fichier | Profil passé |
|---|---|
| `api/_routes/gs1/digital-link/[gtin].ts:106` | oui |
| `api/_routes/products/[productId]/dpp.ts:82` | oui |
| `api/_routes/products/[productId]/dpp.ts:87` | oui |
| `api/_routes/products/[productId]/dpp/publish-review.ts:82` | **non** |

Et c'était précisément **l'endpoint qui valide la publication** — celui où un ensemble
d'exigences bloquantes erroné a le plus de portée.

### Ce qui a été fait

`publish-review.ts` relit le profil et le transmet. Point important : il le relit depuis
**l'enregistrement** que `tracefab_mark_dpp_ready_to_publish()` vient de produire
(`requirement_profile_key` / `requirement_profile_version`), et non depuis le corps de la
requête — c'est le profil que le calcul de readiness a réellement appliqué. Le
`product_version` est lui aussi repris de l'enregistrement au lieu du `1` codé en dur ailleurs.

### La garde qui manquait

Les 23 contrôles de `test:dpp-blocking` exerçaient la fonction réelle mais **n'auraient pas
détecté** ce bug : ils appellent `buildDppSummary` directement, jamais via une route.

Section **I** ajoutée : elle parcourt tout `api/_routes/`, extrait chaque appel
`buildDppSummary(` avec un parseur de parenthèses appariées, compte les arguments de premier
niveau et exige `>= 4`. **28 contrôles, 0 échec.**

**Contre-épreuve** : avec `publish-review.ts` débranché (restauré depuis git), la section I
tombe — `FAIL … (2 arguments)`, **exit 1**. Rebranché, **28/28, exit 0**.

### Vérification

`api:typecheck` **98 = 98**, aucune erreur sur `publish-review`. `test:dpp-blocking`
**28/28**. Suite complète : voir le résultat ci-dessous.

### Ce que cela ne règle pas

Comme au Chantier 18, le profil semé déclare les neuf exigences bloquantes : la sortie
observable ne change donc pas encore. Le correctif supprime une divergence latente qui se
manifestera dès qu'un profil non bloquant sera semé. Et la saisie AGEC reste à construire —
c'est une collecte de données, pas une migration.

---

## Chantier 22 — 346 lignes de chaîne d'approvisionnement inventée que personne ne voyait

### La demande portait sur deux chaînes ; le problème était plus vaste

L'objectif annoncé était `Jersey 185g/m²` (l. 1750) et `ZDHC Level 3` (l. 1764), présentés
comme « les dernières fabrications de `supplyChainConsoleView` ». Les deux étaient bien là.
Mais elles n'étaient pas isolées : **tout le diagramme SVG de six nœuds était codé en dur** —
`São Martinho` / `GOTS v6.0 Audité`, `Fiação Norte` / `Fil peigné 30/1` / `OEKO-TEX 100`,
`Malhas do Ave` / `BCI & GOTS Mill`, `Tinturaria Braga` / `Circuit fermé STeP`, `Nhãn Textile`
/ `SMETA 4-Pillar` — plus une barre d'outils affirmant « Chaîne de confiance active (6 échelons
audités) » et un nœud par défaut portant des coordonnées GPS (`38.0151° N, 7.8632° W`), un
numéro de lot (`LOT-PT-2026-CTN-089`), un auditeur (`Control Union`) et un score
(`100% Conforme`).

### La découverte qui change l'action à mener

`supplyChainConsoleView()` n'est appelée **par aucun dispatcher**. Ses occurrences dans
`brand-console/index.html` se réduisaient à **une seule : sa propre déclaration**, ligne 1662.

Le rendu de la vue « Supply Chain » passe par la ligne 1514 :
`state.view === 'supplyChain' ? supplyChainView() : …` — une **autre** fonction (l. 2750), qui
elle consomme bien `state.supplyChain`, alimenté par `loadSupplyChain()` via
`GET /api/products/:productId/supply-chain`. J'ai vérifié l'absence de dispatch dynamique : la
seule expression `[state.view]` du fichier (l. 1227) est une carte de **titres de page**, pas
un sélecteur de fonction.

La console avait donc **deux surfaces chaîne** : l'une réelle et testée, l'autre entièrement
fabriquée et **morte**. `state.chainNodes` (l. 926-1036) n'alimentait que la fonction morte.

**Conséquence sur la décision** : réécrire 233 lignes de code mort pour les rendre honnêtes
aurait été du travail perdu, et aurait laissé en place un diagramme de six fournisseurs
inventés, prêt à être rebranché par accident. La bonne action était la **suppression**.

### Ce qui a été fait

- `supplyChainConsoleView()` supprimée (l. 1662-1894, 233 lignes).
- `state.chainNodes` et `state.selectedChainNode` supprimés (l. 925-1036, 112 lignes).
- **346 lignes retirées**, `4218 → 3872`. Références résiduelles aux trois identifiants : **0**.
- `supplyChainView()` — la vue réelle — **intacte** : le test de surface continue de vérifier
  qu'elle affiche le ratio `documentedNodeCount / nodeCount` et le `documentationRate` calculés,
  et non des valeurs fixes.

### Garde

Onze chaînes ajoutées à la section F de `test:supplychain:surface` : les trois identifiants
(`supplyChainConsoleView`, `state.chainNodes`, `selectedChainNode`) et huit contenus fabriqués.
**87 contrôles, 0 échec** (76 auparavant).

**Contre-épreuve** : fichier d'origine restauré → **11 échecs, exit 1** ; version corrigée →
**87/87, exit 0**.

### Vérification

Suite complète **PASS 44 · SKIP 18 · FAIL 0 sur 62** — aucune régression malgré 346 lignes
retirées d'un fichier de 4 218 lignes.

### Ce que cela ne règle pas, et une leçon

**Aucun utilisateur ne voyait ces fabrications.** Elles étaient du code mort. Ce chantier
supprime un risque latent, pas un mensonge affiché — il faut le dire tel quel plutôt que le
présenter comme un assainissement visible.

Les données de démonstration restantes (`demoSupplyChain()`, `demoProductDetail()`, le jeu
seedé l. 839-970) **subsistent volontairement** : elles sont dans des fonctions explicitement
documentées comme fictives et ne servent que lorsque `state.demo` est vrai. Conformément à la
contrainte « les valeurs de démonstration doivent être clairement identifiées ».

**Leçon enregistrée** : pendant la contre-épreuve, un `git checkout -- brand-console/index.html`
a restauré la version **commitée** et annulé ma suppression, qui n'était pas encore commitée.
Le test a alors échoué sur la « version corrigée ». Toujours restaurer depuis une copie
explicite (`/tmp/bc.fixed`), jamais depuis git, tant que le travail n'est pas commité.

---

## Chantier 23 — La géographie AGEC article 13 se déduit de la chaîne, sans migration

### Le constat mesuré

Le Chantier 21 avait établi que `frenchAgecArt13` est **satisfaisable** — le validateur
travaille sur un payload fourni par l'appelant. Restait à savoir pourquoi il n'était jamais
satisfait. Réponse vérifiée : **personne ne construisait le bloc**.

- `buildCirpassPayload()` (console) assemble `circularityAndCare` mais **jamais**
  `frenchAgecArticle13` ;
- aucun fichier de `api/` ne construit ce bloc non plus — les seules occurrences de
  `frenchAgecArticle13` sont sa déclaration de type et sa lecture par le validateur.

Conséquence mesurée sur le validateur réel : **toute** validation DPP poussait une erreur
bloquante AGEC, quelle que soit la chaîne du produit.

> Précision corrigée en cours de chantier : j'annonçais « trois erreurs bloquantes ». Mesure
> réelle — bloc **absent** → **une** erreur générique (`geographical data block is missing`) ;
> bloc **présent mais partiel** → une erreur **par étape manquante**, donc plus précise. Le
> test épingle les deux comportements.

### La décision : déduire, pas stocker

La leçon du Chantier 21 excluait d'ajouter des colonnes. Elle s'est révélée inutile : les trois
pays exigés par l'article 13 **sont déjà dans le modèle**.

`api/_lib/supply-chain.ts:202-206` classe déjà les nœuds par `process_code`
(`weaving`, `knitting`, `dyeing`, `printing`, `cutting`, `sewing`, `assembly`…), et
`supplier_sites.country_code` est une colonne **obligatoire** (`VarChar(2)`). Les trois
déclarations AGEC s'en déduisent donc directement :

| Champ AGEC | `process_code` | Pays |
|---|---|---|
| `tissageTricotage` | `weaving`, `knitting` | `supplier_sites.country_code` |
| `teintureImpression` | `dyeing`, `printing` | idem |
| `confection` | `cutting`, `sewing`, `assembly` | idem |

Et le mécanisme de **saisie** existe déjà : le modal `new-chain-node` envoie `processCode`,
`supplierSiteId` et `metadata` à `POST /api/products/:id/supply-chain/nodes`, validés par
`validateNodeInput()`. Ce qui manquait n'était pas la collecte, c'était la **dérivation**.

### Ce qui a été fait

**`api/_lib/agec.ts` (nouveau, pur).** `deriveAgecArticle13(nodes)` renvoie
`{ agec, gaps, derivedFrom }`. Règles :

- un pays n'est retenu que s'il est **univoque**. Deux nœuds de la même étape donnant deux pays
  → champ vide + lacune `ambiguous_country` **avec les deux valeurs**. Arbitrer serait inventer ;
- étape sans nœud → `no_node` ; nœuds sans pays déterminable → `no_country` ;
- `nodeCountry()` accepte `site_country`, puis `metadata.country_code`, puis `metadata.country`,
  et **rejette** tout ce qui n'est pas un code ISO 3166-1 alpha-2 (`'Portugal'` et `'PRT'`
  donnent `null`) ;
- les trois champs sans source de traçabilité (`microfibresPlastiques`,
  `substancesDangereusesReachSvhc`, `primesOuPenalitesEcoOrganisme`) remontent toujours en
  `requires_declaration`.

**`GET /api/products/:productId/dpp/agec-article13`** (nouvelle route, 122 motifs au routeur) :
lit les nœuds du produit avec leur site, dérive, renvoie `{ agec, gaps, derivedFrom, complete,
nodeCount }`. 404 si le produit n'est pas accessible.

**Console** : `validateCirpass()` appelle la route et fusionne le bloc dérivé dans le payload
avant validation ; `agecPanel()` affiche chaque étape avec son pays, les identifiants des nœuds
qui l'ont établi, ou la raison exacte de l'absence. La dérivation reste **côté serveur** : une
seule implémentation, pas de copie cliente.

### Vérification

`npm run test:agec:chantier23` — **54/54**. Il compile et exécute `api/_lib/agec.ts` **et**
`api/_lib/dpp-validator.ts` réels. La section G est la preuve de bout en bout :

| payload | erreurs AGEC | `frenchAgecArt13` | score |
|---|---|---|---|
| sans bloc | 1 (générique) | `false` | 63 |
| bloc déduit complet | **0** | **`true`** | **75** |
| bloc partiel (1 pays) | 2 (nommant l'étape) | `false` | — |

**Contre-épreuve** : module modifié pour inventer `'FR'` quand le pays est indéterminable →
**3 échecs d'assertion, exit 1** ; module restauré → **54/54, exit 0**. Une première injection
plus brutale (`if (false)`) faisait crasher le test en `TypeError` plutôt que d'échouer proprement
— d'où l'ajout de deux assertions directes (« aucun pays n'est inventé », « aucune provenance
fictive »).

`api:typecheck` **98 = 98**, aucune erreur sur `agec.ts`. `test:route-registry` passe.
`test:brand-console` et `test:console:actions` (64) passent. Suite complète
**PASS 45 · SKIP 18 · FAIL 0 sur 63**.

### Ce que cela ne règle pas

Les trois champs `requires_declaration` restent à saisir par un humain : ils n'ont **aucune**
source dans le modèle, et les stocker demanderait une vraie colonne. Ce chantier dit clairement
qu'ils manquent au lieu de les laisser produire une erreur générique ; il ne les collecte pas.

Non vérifié ici, faute de base : que `tracefab_get_product_traceability()` peuple bien
`site_country`. La route ne dépend pas de cette fonction — elle interroge `supply_chain_nodes`
avec sa jointure `supplier_sites` — mais le comportement réel sur Neon reste à confirmer.

---

## Chantier 24 — Quatre API écrites, jamais déclarées, donc inatteignables

### Le constat

`test:route-registry` signalait depuis plusieurs chantiers **4 gestionnaires orphelins** sans
que ce soit traité. Vérifié : ils sont écrits, complets, adossés à de vrais modules — et
**aucun motif du registre ne les déclare**. Le routeur unique `api/index.ts` est la seule porte
d'entrée : non déclaré signifie inatteignable.

| Gestionnaire | Module métier | Lignes |
|---|---|---|
| `integrations/plm` | `plm-connector.js` (`ingestPlmProductBom`) | 69 |
| `quality/audit-pack` | `quality-index.js` + `audit-pack.js` | 54 |
| `quality/calculate-index` | `quality-index.js` (`calculateDataQualityIndex`) | 51 |
| `supplier/certifications/ocr-extract` | `certificate-ocr.js` (`parseCertificateOcr`) | 43 |

Deux précisions mesurées avant d'agir :

- **Aucun appelant** nulle part : 0 référence dans les interfaces, 0 dans `api/`. Donc pas de
  bouton qui échoue en silence — simplement quatre capacités mortes.
- **L'authentification est réellement appliquée** dans les quatre, pas seulement importée :
  `requireClerkUser` + `401`, validation `400`, et pour `ocr-extract` le cloisonnement
  `currentSupplier(tx, auth.user.id, requestedOrganizationId(req))`. `integrations/plm` ajoute
  un garde-fou `TRACEFAB_PLM_ENABLED` en production.

D'où la décision : **exposer**, pas supprimer. La logique est écrite et ses modules sont
couverts par `test:plm-erp:chantier2` et `test:docai:chantier1`, qui passaient déjà — seul
l'aiguillage manquait.

### Le piège d'ordre

Le registre est parcouru dans l'ordre et **le premier motif qui correspond gagne**. Or la ligne
104 déclarait `/^supplier\/certifications\/([^\/]+)$/` avec `params: ['certificationId']`.
Ajouter `ocr-extract` après l'aurait rendu **inatteignable** : `ocr-extract` aurait été capturé
comme un `certificationId`. Il est donc inséré **avant**, ligne 107.

Vérifié par résolution réelle des 126 motifs dans l'ordre :

| Chemin | Résout vers |
|---|---|
| `supplier/certifications/ocr-extract` | `supplier/certifications/ocr-extract` |
| `supplier/certifications/7f3a-uuid` | `supplier/certifications/[certificationId]` |
| `quality/audit-pack` | `quality/audit-pack` |
| `quality/calculate-index` | `quality/calculate-index` |
| `integrations/plm` | `integrations/plm` |

Les trois autres ne présentaient pas de conflit : il n'existe ni `quality/([^/]+)` ni
`integrations/([^/]+)` générique.

### La garde ajoutée

Section **3** de `test:route-registry` : l'invariant général, pas seulement ces quatre cas.
Elle reconstruit les 126 motifs dans l'ordre, fabrique pour chacun un chemin d'exemple, et
signale toute route qu'un **motif antérieur** capterait à sa place. Plus les quatre résolutions
attendues, et la vérification que `supplier/certifications/{id}` continue d'aller vers
`[certificationId]`. **10 contrôles, 0 échec** (2 auparavant).

**Contre-épreuve** : `ocr-extract` déplacé après `[certificationId]` →
`FAIL route(s) inatteignable(s) car masquée(s) — supplier/certifications/ocr-extract masqué par
supplier/certifications/[certificationId]`, **2 échecs, exit 1**. Ordre restauré → **10/10**.

### Vérification

`test:route-registry` : **« aucun handler orphelin »**, 10/10. `api:typecheck` **98 = 98** —
les quatre gestionnaires compilaient déjà, seule leur déclaration manquait. Suite complète
**PASS 45 · SKIP 18 · FAIL 0 sur 63**.

### Ce que cela ne règle pas

Ces quatre API sont désormais **joignables**, pas **utilisées** : aucune interface ne les
appelle encore. Le PLM reste en outre conditionné à `TRACEFAB_PLM_ENABLED`. Les brancher sur
des écrans est un chantier distinct — et il faudra alors vérifier que chaque bouton correspond
à un contrat réel, comme au Chantier 17.

Les 98 erreurs de typage sont inchangées et se répartissent : **90 Prisma** (client non généré,
`binaries.prisma.sh` injoignable) et **8 `@types/node`** (`Buffer`/`zlib` : le dépôt déclare
`^20.0.0` alors que le runtime est Node v22).

---

## Chantier 25 — Le .pkpass est valide, et le runtime qui le produit est désormais déclaré

### Le point de départ n'était pas celui annoncé

Les « 8 erreurs `@types/node` » étaient présentées comme de la simple dette de types. En
vérifiant, elles portaient sur `api/_lib/wallet/apple-pass-generator.ts` — **le générateur de
pass Apple Wallet signé**, et précisément sur son générateur ZIP écrit à la main, sans
dépendance npm. Deux questions distinctes en découlaient :

1. **Ce ZIP maison est-il réellement valide ?** Jamais vérifié. Un ZIP artisanal est le cas
   d'école du défaut silencieux : le serveur répond 200, Apple rejette le pass.
2. **Le runtime est-il garanti ?** `crc32` est importé de `node:zlib` (ligne 2, utilisé ligne
   155). Mesuré : `package.json` ne déclare **aucun** champ `engines`, et `vercel.json` ne
   précise **aucun** `runtime` (`"use": "@vercel/node"`, sans version). Le déploiement hérite
   donc du Node par défaut, sans contrainte.

### Ce qui a été mesuré

**Le ZIP est valide.** Exécuté ici sur Node v22.22.3, puis relu par un lecteur indépendant :

- signature `PK\x03\x04` en tête, EOCD présent, **7 entrées** au répertoire central ;
- `pass.json`, `manifest.json`, `signature`, `icon.png`, `icon@2x.png`, `logo.png`,
  `logo@2x.png` — toutes présentes, toutes compressées (deflate) ;
- **tous les SHA-1 de `manifest.json` correspondent au contenu réel** — c'est ce qu'Apple
  vérifie en premier ;
- `pass.json` : `formatVersion: 1`, `passTypeIdentifier` `pass.com.tracefab.dpp`,
  `serialNumber` `DPP-3760123456789`, `teamIdentifier`, `organizationName`, **exactement une**
  clé de style (`storeCard`) avec champs primaires, `barcode` pointant sur le Digital Link.

**Deux fausses alertes de ma propre sonde, corrigées** : je cherchais une clé de style
`generic` (le pass utilise `storeCard`, tout aussi valide) et un champ
`organizationPassStyleVersion` qui **n'existe pas** dans le format Apple. Ni l'un ni l'autre ne
sont des défauts du code.

### Ce qui a été fait

**`engines.node: ">=22"`** ajouté à `package.json`. Avec `@vercel/node`, c'est ce champ qui
détermine la version de Node du build **et** de l'exécution : un seul endroit à tenir. La borne
est celle du runtime **effectivement vérifié ici**.

> Honnêteté sur la borne : je n'ai pas pu vérifier dans cet environnement à partir de quelle
> version exacte `zlib.crc32` existe (pas d'accès à la documentation Node). `>=22` couvre le
> runtime mesuré ; une borne plus basse reposerait sur une affirmation non vérifiée.

**`@types/node` passé de `^20.0.0` à `^22`** — le dépôt déclarait des types Node 20 pour un
runtime Node 22. Résultat : **98 → 90 erreurs**, les 8 d'`apple-pass-generator` disparues.

**`scripts/test_pkpass_bundle.mjs`** (nouveau) — **41 vérifications**. Il compile et exécute le
vrai `generateApplePkpass()`, puis relit l'archive avec un lecteur **indépendant** : en-têtes
locaux, répertoire central, EOCD parcourus par le test, et un **CRC-32 recalculé par une table
propre au test** — pas `zlib.crc32`, qui est la fonction même employée par le générateur et ne
prouverait donc rien.

### Vérification

`npm run test:pkpass:bundle` **41/41**.

**Contre-épreuve** : `crc32(buf)` remplacé par `(crc32(buf) + 1) >>> 0` dans le générateur →
`ÉCHEC — 40/41`, avec le détail par fichier (`pass.json : CRC déclaré 609c7680, recalculé
609c767f`), **exit 1**. Générateur restauré → **41/41**, `git diff` vide.

Une première injection plus brutale (`^ 0xff`) produisait un entier négatif et faisait crasher
`writeUInt32LE` en `ERR_OUT_OF_RANGE` plutôt que d'échouer proprement — d'où le choix d'un CRC
valide mais faux, qui est le défaut réaliste.

**Diff des erreurs de typage avant/après le bump : aucune erreur nouvelle.** Les 90 restantes
se répartissent en **85 Prisma** (client non généré) et **5 préexistantes**
(`catalog/audit-export.ts` ×4 sur un type `unknown`, `documents.ts` ×1 appel non typé).

`typecheck` racine (étape 1 de `npm test`) passe toujours, exit 0. Suite complète
**PASS 46 · SKIP 18 · FAIL 0 sur 64**.

### Ce que cela ne règle pas

Le pass est testé **sans certificat** : en l'absence d'`APPLE_PASS_CERTIFICATE_PEM` et
`APPLE_PASS_KEY_PEM`, le générateur produit une signature de développement
(`PKCS7_DEV_SIGNATURE_…`). La signature PKCS#7 réelle, celle qu'Apple exige en production,
n'est donc **pas** couverte ici — le bundle est structurellement valide, pas signable tel quel.

Et les 90 erreurs restantes bloquent toujours `npm test` à l'étape 2 : les 85 Prisma ne
disparaîtront qu'avec `npx prisma generate`, injoignable d'ici.
