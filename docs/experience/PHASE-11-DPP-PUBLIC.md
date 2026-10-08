# PHASE 11 — DPP public

Page `/dpp/` · l'expérience consommateur après scan du QR code.

---

## 0. Un faux diagnostic, encore

Mon premier passage a mesuré **1 479 caractères** de contenu et **6 volets sur
10**, et j'étais sur le point de conclure que la page était trop maigre.

Elle ne l'est pas. Elle rend **8 511 caractères** et couvre les **10 volets**.
J'avais mesuré `innerText`, qui ne voit que l'onglet actif : les neuf autres
volets sont masqués en CSS. `textContent` les voit.

C'est le troisième faux diagnostic du chantier. La leçon est stable : **une
mesure qui contredit l'inspection visuelle est suspecte d'abord côté mesure.**

## 1. Les dix volets exigés, tous présents

| Volet | Contenu rendu |
|---|---|
| Origin | Quinta de São Martinho, Alentejo, Portugal |
| Materials | 85 % coton bio peigné, 15 % coton recyclé pré-consommation |
| Composition | 185 g/m², 0 % substances toxiques, 0 g microfibres par lavage |
| Manufacturing | 5 maillons certifiés, du champ à la confection |
| Certifications | GOTS CU-881294, OEKO-TEX 21.HPT.94112, SMETA 4-Pillar |
| Circularity | 95 % recyclabilité, fibre mono-matière |
| Care | Lavage délicat 30 °C, séchage naturel |
| Repair | Indice 9,2/10, bonus Refashion −6 € à −15 € |
| Traceability | 5 rangs validés, certificat de transaction par étape |
| Evidence | Documents opposables en audit UE et DGCCRF |

S'y ajoute la résolution **GS1 Digital Link** (ISO/IEC 15459) qui relie le QR
physique cousu dans l'étiquette au passeport numérique, avec GTIN (AI 01) et
numéro de série (AI 21) jusqu'au lot de confection.

## 2. Conformité au cahier des charges

- **Visuellement distincte du dashboard** : registre éditorial grand public,
  pas de chrome de console.
- **Aucune revendication de conformité** : vérifié automatiquement. La garde
  repo-wide posée en tranche 10 (`test_pef_chantier3.mjs`, itération sur
  `git ls-files "*.html"`) rejette `DPP Conforme`, `certifié ESPR` et leurs
  variantes sur **tous** les fichiers HTML suivis.
- **Mobile d'abord** : un DPP se scanne au téléphone. Mesuré à 390 px —
  0 débordement, toutes les images avec `alt`, un seul `h1`.
- **Performance** : chargement complet en **116 ms**, aucune ressource en
  échec, pas de WebGL.

## 3. Résultats des contrôles

Batterie `npm run test:phases`, volet phase 11 — **10/10** :

```
✓ DPP public non squelettique                8511 car.
✓ Volets du brief couverts                   10/10
✓ Aucune revendication de conformite         aucune
✓ Selecteur de langue present                oui
✓ Chargement sous 3 s                        116 ms
✓ Aucune ressource en echec                  0 echec(s)
✓ Mobile 390px sans debordement              0px
✓ Mobile : images avec alt                   0 sans alt
✓ Exactement un h1                           1 h1
✓ Aucune erreur JS                           0 erreur(s)
```

## 4. Verdict

**Phase 11 conforme, sans modification du produit.** La page tenait déjà les
dix volets, la précaution réglementaire et la performance. Le seul défaut
était dans mon instrument de mesure.
