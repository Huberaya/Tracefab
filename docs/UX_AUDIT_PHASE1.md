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
