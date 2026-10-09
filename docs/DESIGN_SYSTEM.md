# TRACEFAB Design System Specification (v2.4)

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

- **Titres & Corps de texte** : `Plus Jakarta Sans` — géométrique, lisible, résolument SaaS moderne.
- **Données techniques, SKUs & Certificats** : `JetBrains Mono` — clarté pour les codes d'identification (GTIN, EAN, hash SHA-256 de preuve).

## 4. Composants Principaux

- **Cartes KPI** : Données synthétiques grand format avec bordure contrastée latérale et pourcentage d'évolution.
- **Multi-Tier Supply Chain Graph** : Visualisation continue des 7 échelons de transformation textile :
  `Fiber (Tier 4) → Material (Tier 3) → Mill (Tier 3) → Dyeing (Tier 2) → Manufacturing (Tier 1) → Brand (HQ) → Product (DPP)`.
- **Cockpit DPP Readiness** : Indicateur radial de maturité avec liste de contrôle d'éligibilité pour l'émission des QR codes consommateurs.
- **Supplier Vault** : Espaces de dépôt sécurisé avec contrôle strict des accès et non-divulgation des formules propriétaires.

