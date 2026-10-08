# TRACEFAB Design System Specification (v3.0)

> Chantier 02 (8 octobre 2026) : famille typographique unique, socle
> tactile/motion partagé et composants communs. Historique : v2.4 décrivait
> encore deux familles d'affichage ; c'est corrigé.

## 1. Vision & Direction Artistique

TRACEFAB est l'infrastructure technologique B2B dédiée à la traçabilité textile et à la conformité aux passeports numériques des produits (Digital Product Passport - DPP) et CSRD / ESPR.

L'identité visuelle combine l'élégance sobre de la haute confection et l'exigence mathématique d'un système RegTech :
- **Atmosphère** : Minimaliste, nette, technologique et rassurante.
- **Palette** : 
  - *Forest Dark* (`#081712`, `#0a1b14`) : Ancrage institutionnel, autorité et modernité.
  - *Deep Pine & Emerald* (`#0b7656`, `#07523e`, `#10b981`) : Énergie de durabilité sans l'écueil du "greenwashing" cliché.
  - *Clean Paper & Surfaces* (`#f8faf8`, `#ffffff`, `#f1f5f2`) : Clarté d'un tableau de bord de trading ou d'analyse logistique.
  - *Border Subtle* (`#e6ede8`, `#d0ded4`) : Lignes fines séparatrices à 1px.

## 2. Niveaux de Confiance et Data Quality Scale

Contrairement aux solutions basées sur des étoiles ou des notes arbitraires, TRACEFAB repose sur 6 niveaux réglementaires prouvables :

1. **Complete (Niveau 6)** : 100% des données obligatoires et optionnelles sont renseignées, auditées et conformes au standard CIRPASS / ESPR.
2. **Verified (Niveau 5)** : Données et preuves documentaires inspectées et validées par un auditeur marque ou un tiers accrédité.
3. **Certified (Niveau 4)** : Certificat de conformité tiers valide rattaché (GOTS, GRS, OEKO-TEX Standard 100, Bluesign).
4. **Documented (Niveau 3)** : Justificatif ou rapport de laboratoire téléversé mais non encore audité.
5. **Declared (Niveau 2)** : Déclaration sur l'honneur issue d'un questionnaire fournisseur sans pièce jointe.
6. **Needs Review / Missing** : Donnée obligatoire manquante, certificat expiré ou anomalie de bilan massique détectée.

## 3. Typographie

**Une seule famille d'affichage sur toutes les surfaces** (landing, consoles,
portail, pages publiques) :

- **Titres & Corps de texte** : `Inter Tight` (variable `wght@400..700`, servie
  par Google Fonts avec `preconnect`). Stack : tokens `--tf-font-display` /
  `--tf-font-text`.
- **Données techniques, SKUs & Certificats** : `JetBrains Mono` — clarté pour
  les codes d'identification (GTIN, EAN, hash SHA-256 de preuve). Token
  `--tf-font-mono`.
- Plancher typographique : 11 px (token `--tf-size-3xs`) ; en dessous, le mono
  gris devient une texture illisible.
- `Plus Jakarta Sans` et `src/app/globals.css`/`tailwind.config.js` héritent de
  la même stack : aucune famille concurrente ne subsiste dans le dépôt.

## 4. Composants Principaux

- **Cartes KPI** : Données synthétiques grand format avec bordure contrastée latérale et pourcentage d'évolution.
- **Multi-Tier Supply Chain Graph** : Visualisation continue des 7 échelons de transformation textile :
  `Fiber (Tier 4) → Material (Tier 3) → Mill (Tier 3) → Dyeing (Tier 2) → Manufacturing (Tier 1) → Brand (HQ) → Product (DPP)`.
- **Cockpit DPP Readiness** : Indicateur radial de maturité avec liste de contrôle d'éligibilité pour l'émission des QR codes consommateurs.
- **Supplier Vault** : Espaces de dépôt sécurisé avec contrôle strict des accès et non-divulgation des formules propriétaires.

## 5. Feuilles de style — qui charge quoi

| Feuille | Rôle | Chargée par |
|---|---|---|
| `tracefab-core.css` | Tokens v3, reset, typographie, grille, boutons, échelle de confiance, motion, accessibilité | landing, passport, product-intelligence |
| `tracefab-site.css` | Composants éditoriaux de la landing | landing |
| `tracefab-console.css` | Re-skin de la console sur les tokens v3 | product-intelligence |
| `tracefab-portal.css` | Composants spécifiques fournisseur | (prêt pour le portail v2) |
| `tracefab-components.css` | **Chantier 02** : badges de statut, états vides/erreur, tables, KPI, liens d'action | consoles, portail, quality-center, operations, dpp, passport, product-intelligence |
| `tracefab-spa-responsive.css` | Correctif de débordement mobile des SPA (≤ 860 px) | brand-console, supplier-portal |
| `tracefab-touch.css` | **Toujours en dernier** : plancher tactile, focus clavier, mouvement réduit | toutes les pages |

Les SPA Brand Console / Supplier Portal / Quality Center / Operations portent
leur CSS inline historique ; `tracefab-components.css` n'utilise que des
classes préfixées `.tf-c-*` / `.tf-status*` et n'entre jamais en collision.

## 6. Cibles tactiles & accessibilité

- Plancher commun : **40 px** (`--tf-touch-min`, mesuré sur 33 types de
  contrôles, gardé par `scripts/test_touch_targets.mjs`).
- CTA primaires : **44 px** (`--tf-touch-target`, WCAG 2.5.5).
- Les liens au fil d'un texte sont exemptés (WCAG 2.5.8).
- Focus clavier : contour émeraude `:focus-visible` (2 px, offset 2 px),
  clair sur fonds sombres.
- `prefers-reduced-motion: reduce` coupe toute animation/transition sur toutes
  les pages (garde globale dans `tracefab-touch.css`, garde locale dans core).

## 7. Mouvement

Le mouvement **explique une relation** (connexion, séquence, quantité,
changement d'état) ; il n'est jamais décoratif. Durées et easing sont tokenisés
dans `tracefab-core.css` (`--tf-dur-*`, `--tf-ease-*`).

## 8. Statuts de la donnée (trust scale)

Sept statuts, sept badges `.tf-status--*` (couleurs tokenisées avec repli hex) :
`missing`, `needs-review`, `declared`, `documented`, `verified`,
`third-party-certified`, `expired`. Une déclaration fournisseur n'y est jamais
rendue comme une preuve, ni une preuve comme une certification tierce.

