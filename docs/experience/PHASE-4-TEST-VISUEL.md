# PHASE 4 — Test visuel & porte de non-régression

**Date :** 2026-10-07 · **Périmètre :** validation de la PHASE 2 (design system) + de la PHASE 3
(header, hero, visuel chaîne d'approvisionnement, première section) et du catalogue i18n
(EN/FR/DE/IT/ES/NL).
**Statut :** ✅ toutes les portes automatisées sont vertes — en attente de votre validation avant la PHASE 5.

---

## 1 · Résultats des portes de contrôle

| Porte | Commande | Résultat |
|---|---|---|
| TypeScript (app) | `npm run typecheck` | ✅ 0 erreur |
| TypeScript (API) | `npm run api:typecheck` | ✅ 0 erreur |
| Contrat de schéma | `npm run schema:static` | ✅ 22 tables cœur, 61 politiques cœur, marqueurs Neon/Clerk intacts |
| Suite de tests | `npm test` | ✅ sortie 0 — les ~24 suites passent (Chantiers 1–10, Brand Console, Portail Fournisseur, questionnaires, …) |
| Capture des routes | `node scripts/visual_capture.mjs --out .visual/after` | ✅ 6/6 routes, desktop 1440×900 + mobile 390×844@2x |
| Vérification des locales | `node scripts/verify_locales.mjs` (+ `--mobile`) | ✅ 12/12 (6 langues × 2 viewports) |

Aucun fichier produit, API, Prisma ou migration n'a été modifié. `git status` ne signale que
`index.html` et `vercel.json` parmi les fichiers suivis.

---

## 2 · Diff de non-régression — `.visual/before` → `.visual/after`

| Route | Nœuds DOM | CSS inline | `lang` | `<h1>` | Débordement H | Erreurs console | Requêtes en échec | Écarts a11y |
|---|---|---|---|---|---|---|---|---|
| `/` landing | 320 → **1 013** | 33 Ko → **0 Ko** | fr → **en** | 1 | aucun | 2 → **0** | 2 → **0** | 0 |
| `/brand-console/` | 170 (=) | 17 Ko (=) | fr (=) | 1 | aucun | 4 → 2* | 2 → **0** | 0 |
| `/supplier-portal/` | 136 (=) | 12 Ko (=) | fr (=) | 1 | aucun | 4 → 2* | 2 → **0** | 0 |
| `/dpp/` | 267 (=) | 14 Ko (=) | en (=) | 1 | aucun | 2 → **0** | 2 → **0** | 0 |
| `/quality-center/` | 17 (=) | 5 Ko (=) | fr (=) | 1 | aucun | 4 → 2* | 2 → **0** | 0 |
| `/operations/` | 17 (=) | 2 Ko (=) | fr (=) | 1 | aucun | 4 → 2* | 2 → **0** | 0 |

\* Les 2 erreurs restantes sur les coques authentifiées sont des `501 Not Implemented` renvoyés par
le serveur de prévisualisation **local** (`scripts/dev_static_server.mjs` ne répond à `/api/*` que
s'il existe une fixture). C'est une limite du harnais, pas un défaut produit. En revanche **les 404
qui existaient avant ont disparu** : les nouveaux globs `builds` et les nouvelles `routes` de
`vercel.json` servent désormais `assets/**`, `public/**` et les trois assets i18n historiques
(`/i18n-engine.js`, `/auto-translate.js`, `/translations_deep.json`).

**Conclusion : zéro régression.** Tous les écrans fonctionnels préexistants ont exactement la même
forme qu'avant ; seule la landing a changé, et dans la direction voulue (CSS externalisé → mis en
cache, plus aucune charge de style inline, plus aucun bruit console).

### Performance de la landing
`scrollHeight` 6 098 px desktop / 11 141 px mobile · 1 013 nœuds DOM · 0 image (tous les visuels sont
du SVG inline ou du CSS pur) · 2 polices web · pas de WebGL · ~1,6 s de chargement en local.

---

## 3 · Vérification i18n (socle de la PHASE 12, livré en avance)

`assets/i18n/{en.js,fr,de,it,es,nl}.json` — **377 clés chacun, 0 manquante, 0 en trop, 0 vide.**
Aucun contenu métier n'est codé en dur dans un composant ; le markup ne porte que des clés `data-i18n`.

```
PASS  desktop  en|fr|de|it|es|nl   empty=0  reveal=24/24  chain=matrix    core=svg   overflow=0  clipped=0  tap<24=0  err=0
PASS  mobile   en|fr|de|it|es|nl   empty=0  reveal=23/24  chain=vertical  core=list  overflow=0  clipped=0  tap<24=0  err=0
```

(`reveal=23/24` en mobile est correct : `.tf-hero__scroll` est en `display:none` sous 860 px.)

Vérifié pour chaque langue : `<html lang>`, résolution de chaque clé, absence de débordement
horizontal, absence de texte rogné, taille des cibles tactiles (WCAG 2.5.8), bascule des vues
mobiles (noyau de données SVG → liste, matrice de chaîne → cartes verticales), et zéro événement
console / pageerror / requestfailed. Captures dans `.visual/i18n/`.

---

## 4 · Défauts trouvés et corrigés pendant cette porte

| # | Défaut | Correctif |
|---|---|---|
| 1 | La matrice de chaîne en `min-width:max-content` dépassait 1440 px et coupait PRODUIT/DPP | grille `112px repeat(var(--tf-stage-count,9), minmax(116px,1fr))`, `min-width:100%`, `overflow-wrap:anywhere` |
| 2 | Colonnes de la colonne vertébrale trop serrées pour les composés DE/NL | `104px minmax(0,.82fr) minmax(0,1.3fr) 164px` |
| 3 | Le bandeau de promesse abusait de l'émeraude | `line2` → `--tf-ink-inv-soft` ; l'émeraude est réservée au seul « Prove it. » |
| 4 | La cellule d'angle de la chaîne répétait « Dimensions » | nouvelle clé `chain.stageLabel` |
| 5 | **Les compteurs animaient le markup anglais**, puis écrasaient le chiffre traduit (en FR desktop, on retombait sur `1,248` au lieu de `1 248`) | `TF_I18N.ready` est désormais créé de façon synchrone ; `initCounters()` est déplacé dans le `start()` verrouillé par la locale |
| 6 | **Le parsing des nombres était EN-only** — `92,4 %` était lu comme `924` et affichait `449%` en pleine animation | nouveau `parseLocaleNumber()` : un séparateur suivi d'exactement 3 chiffres est un séparateur de milliers, sinon c'est la virgule décimale ; NBSP et NBSP étroite gérées ; aller-retour vérifié pour `1,248 / 1.248 / 1 248 / 92.4% / 92,4 % / 9.847` |
| 7 | Le compteur écrasait la valeur si la langue changeait en cours d'animation | compteur de génération, incrémenté sur `tf:languagechange`, qui interrompt les frames périmées |
| 8 | Le burger mobile faisait 38 × 38 | `::after { inset:-3px }` → zone tactile 44 × 44, boîte visuelle de 38 px inchangée |
| 9 | Les liens du pied de page faisaient 19 px de haut (< 24 px, WCAG 2.5.8 AA) | `min-height:26px` en desktop, `40px` sous 860 px |

### Pièges de harnais consignés (ne pas re-déboguer)
- Les captures `fullPage` de Playwright **ne scrollent pas** : les révélations IntersectionObserver
  ne se déclenchent jamais et la page est capturée vide sous la ligne de flottaison.
  `visual_capture.mjs` fait désormais défiler toute la page au préalable.
- Même avec ce correctif, une bande sombre haute peut paraître vide dans le PNG `fullPage` *assemblé*.
  Vérifier avec une capture *viewport* + une sonde DOM avant de toucher au CSS.
- `.tf-layer::before` déborde volontairement de ±28 px dans la gouttière : un test naïf
  `scrollWidth > clientWidth` signale donc chaque ligne de la colonne vertébrale. Seules les
  feuilles porteuses de texte comptent.

---

## 5 · Re-notation des trois personas

| Persona | Avant | Maintenant | Preuves |
|---|---|---|---|
| **CEO / Fondateur** — comprend la valeur en < 30 s | ⚠️ partiel | ✅ **validé** | Le label donne la catégorie. Le titre en trois lignes donne toute la promesse. Le sous-texte nomme les cinq domaines. Deux CTA au-dessus de la ligne de flottaison. La barre de statistiques du noyau de données (1 248 / 214 / 92,4 %) arrive dès le premier scroll. Le bandeau de promesse conclut par Voir · Structurer · Vérifier · Prouver. |
| **Responsable durabilité / conformité** — voit la profondeur fonctionnelle | ❌ | ✅ **validé (sur la landing)** | Chaîne de 9 étapes × 7 dimensions simultanées, loupes commutables, dossier par étape (Atelier Milano · 94 % · 8 certificats · 12 produits · 4 sites). Échelle de confiance à six niveaux rendue en états colorés. Colonne vertébrale à sept couches avec, pour chacune, sa question, ses chips et son chiffre. ESPR / AGEC Art. 13 / CSRD / GS1 Digital Link nommés. Le DPP est présenté comme un **indicateur de préparation, jamais comme une certification juridique** — dans la couche DPP, dans la mention légale du pied de page et dans les six langues. |
| **Fournisseur** — sait immédiatement quoi faire | ❌ | ⚠️ **toujours ouvert** | La landing s'adresse aux marques. Un fournisseur qui arrive sur `tracefab.com` ne trouve qu'un lien en pied de page. **C'est le travail de la PHASE 6** (« Vos données. Votre profil. Réutilisables chez tous vos clients. » + barre de complétion). À arbitrer à la frontière Phase 5/6 : faut-il aussi une porte d'entrée fournisseur explicite sur la landing ? |

---

## 6 · Ce qui est prêt pour la PHASE 5

Les tokens de design, l'échelle typographique, l'échelle de confiance, les contrats d'animation
(`data-tf-reveal`, `data-tf-count`, `data-tf-bar`), le runtime i18n et un catalogue complet en six
langues sont en place et éprouvés sur la surface la plus exigeante (la landing). La PHASE 5 —
Dashboard, Overview, Product Intelligence — peut les consommer directement, sans nouveau travail de
fondation.

**Porte de phase : STOP. En attente de votre validation.**
