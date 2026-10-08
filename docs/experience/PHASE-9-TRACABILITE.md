# PHASE 9 — Traçabilité

Vue `supplyChain` de la Brand Console · couche 05 de l'ossature conceptuelle.

---

## 0. Ce que j'ai trouvé, et ce que j'ai dû corriger dans mon propre audit

Mon premier passage a classé cette phase à **6/9**. Trois échecs annoncés :
pas de niveaux de rang, aucun pays de production, lignage à 1 étape sur 7.

Les trois étaient **faux**. Le produit écrit `TIER 01`, ma recherche exigeait
`tier` suivi de 1, 2 ou 3 — le zéro faisait échouer la correspondance. Le
produit écrit `Türkiye` et abrège en codes ISO (`FR`, `PT`) ; ma liste ne
contenait que des noms anglais. Et je cherchais le lignage sur un détail
produit alors qu'il est rendu par la vue Supply Chain elle-même.

Je le consigne parce que c'est la deuxième fois dans ce chantier qu'une sonde
mal calibrée produit un faux diagnostic — après l'épisode du serveur statique
en tranche 9. **Un contrôle qui échoue doit être vérifié à la main avant
d'être cru.**

Après correction de la sonde : **9/9**, sans aucune modification du produit.

---

## 1. Ce que la vue rend réellement

Sept maillons, chacun avec son rang, son modèle de garde et son lieu vérifié :

| Rang | Étape | Modèle de garde | Lieu |
|---|---|---|---|
| TIER 01 | Field / Farm | Identity Preserved | İzmir, Türkiye |
| TIER 02 | Ginning | Segregated | Ege Birlik Mill |
| TIER 03 | Spinning | Mass Balance 100% | Haute-Vienne, FR |
| TIER 04 | Knitting | Identity Preserved | Barcelos, PT |
| TIER 05 | Finishing | ZDHC Level 3 | EcoDye Aquitaine |
| TIER 06 | Assembly | SMETA 4-Pillar | Atelier Braga, PT |
| TIER 07 | Distribution | DPP CIRPASS | Hub Lyon, FR |

Le lignage demandé par le cahier des charges — Fibre → Filature → Fil → Tissu
→ Teinture → Fabricant → Produit fini → DPP — est couvert à **7/7** par cette
séquence.

Au-dessus, quatre indicateurs : étapes scellées 7/7, polygones GPS vérifiés
100 %, couverture de preuves 98,4 %, modèle de garde ISO 22095. En dessous, la
réconciliation de bilan matière par jalon.

Quatre actions : export du rapport forensique, changement de produit,
génération d'une chaîne de référence, liaison de deux étapes, ajout d'un jalon
vérifié.

## 2. Conformité au cahier des charges

- **Overview → Explore → Inspect → Act** : la vue ouvre sur les quatre
  indicateurs, puis la chaîne, puis le détail par maillon, puis les actions.
- **Géographie européenne d'abord, mondiale par capacité** : Turquie, France,
  Portugal présents sur un même produit.
- **Aucune donnée inventée** : chaque maillon porte son modèle de garde et sa
  preuve ; les écarts de bilan matière sont chiffrés, pas arrondis.

## 3. Résultats des contrôles

Batterie `npm run test:phases`, volet phase 9 — **9/9** :

```
✓ Vue Supply Chain atteignable               oui
✓ Vue Supply Chain non squelettique          2322 car.
✓ Blocs de contenu rendus                    10 blocs
✓ Niveaux de rang (Tier) exposes             oui
✓ Pays de production nommes                  6 mentions
✓ Lignage multi-etapes de la chaine          7/7 etapes
✓ Aucun debordement horizontal               0px
✓ Aucune fuite de gabarit                    propre
✓ Aucune erreur JS                           0 erreur(s)
```

Barrière complète : 45 tests + `build` + `tsc --noEmit` + `e2e_audit.py` 4/4 +
personas 6/6 · 4/4 · 4/4. Tout au vert.

## 4. Verdict

**Phase 9 conforme, sans modification du produit.** La vue existait et tenait
déjà le cahier des charges ; ce qui manquait, c'était la vérification formelle
et son rapport. Les deux existent désormais, et la batterie est rejouable à
tout moment par `npm run test:phases`.
