# Chantier 20 — Cohérence

## Ce que le chantier a corrigé

Deux défauts que j'avais relevés sans les traiter, sur quatre chantiers.
Les corriger a pris une heure. Comprendre pourquoi personne ne les avait vus
a pris le reste, et c'est la partie qui a de la valeur.

### Défaut 1 — une même métrique, deux valeurs

| Indicateur | Accueil | Console | Cahier des charges |
|---|---|---|---|
| Qualité des données | 92,4 % | **91,4 %** | 92,4 % |
| Couverture de preuves | 84 % | **85,3 %** | 84 % |
| Données vérifiées | 78 % | **77,9 %** | 78 % |
| Produits traçables | 91 % | **91,8 %** | 91 % |

Ce n'était pas un désaccord à arbitrer. L'accueil respectait déjà la
spécification ; la console avait dérivé. Les effectifs, eux, étaient justes
partout.

L'asymétrie venait du code lui-même. Les effectifs étaient **construits**
pour tomber juste — le commentaire d'origine dit « somme exactement égale à
la cible ». Les taux étaient **échantillonnés** : `r() < 0.84` produit par
produit. Sur 1 248 produits, cela donne 85,3 %.

C'était du bruit d'échantillonnage affiché comme une mesure. Pour une
plateforme dont l'argument est « pouvez-vous faire confiance à vos
données ? », c'est le défaut le plus cher du catalogue : il se voit en
trente secondes et il discrédite tout le reste.

**Correction.** `assets/js/tf-demo-figures.js` devient la source unique.
La console lit ses cibles dedans et calibre ses taux après tirage
(`calibrerTaux()`), en préservant la dispersion et en ne déplaçant que la
moyenne. L'imbrication `vérifiés ⊆ couverts` est conservée, pour que la
démonstration obéisse au validateur du semeur pilote.

### Défaut 2 — sept libellés français sur une page anglaise

`01. FIBRE`, `02. FILATURE`, `03. TRICOTAGE`, `04. TEINTURE`,
`05. CONFECTION`, `06. PRODUIT`, `ACTIF` — dans la lignée produit.

Passés en clés `console.*`, sept langues.

## Ce que le chantier a réellement trouvé

Les deux correctifs étaient faciles. La question qui comptait était :
**pourquoi la garde anti-copie-en-dur, verte depuis quinze chantiers, ne
les voyait-elle pas ?**

Trois causes, découvertes l'une après l'autre.

### a. La garde n'entrait pas dans les vues de détail

Elle parcourait les `[data-view]` — la navigation. Or une fiche produit ou
fournisseur s'ouvre en cliquant une **ligne**, pas un bouton de navigation.
La partie la plus dense de l'application n'était jamais visitée.

Corrigé : la garde descend maintenant dans la fiche produit, ses onze
onglets et la fiche fournisseur. La console passe de 17 à **19 vues**
balayées.

Premier balayage : **9 chaînes** que mon inventaire manuel avait ratées,
dont `Poids unitaire (g)`, `Nomenclature & Bilan Massique (BOM)`,
`identifiant(s) actif(s)`.

### b. La garde était aveugle aux capitales et aux mots isolés

```js
.filter((t) => /\s/.test(t) && /[a-z]{3}/.test(t));
```

Deux conditions, deux angles morts. `/[a-z]{3}/` exige trois **minuscules**
consécutives : toute étiquette capitalisée était invisible. `/\s/` exige un
espace : tout mot isolé était invisible.

C'est-à-dire la majeure partie du vocabulaire d'une interface dense — et
précisément la forme de mes sept libellés (`ACTIF` est capitalisé **et**
isolé).

Je ne l'ai pas déduit : je l'ai trouvé en **mordant la garde**. J'ai remis
`04. TEINTURE` dans le code après l'avoir corrigé ; la garde est restée
verte. Un correctif que sa garde ne protège pas n'est pas un correctif.

Filtre levé : **39 chaînes** apparaissent, dont `COMPLET`, `Profil`,
`Couleur`, `Origine`, `Fichier`, `Valeur`, `Objet`,
`🛡️ GARDE-FOU CONTRACTUEL :` — du français que personne n'avait jamais pu
voir, sur les deux surfaces.

### c. La source unique ne couvrait qu'un tiers des chiffres

En écrivant le test de cohérence, j'ai balayé le catalogue : **48 feuilles
numériques**, pas 10. Les 38 autres sont les nœuds du visuel héros, où se
lisent « 86 fournisseurs » et « 92.4% » au survol. Réécrites à la main dans
sept langues : 266 cellules que rien ne tenait.

Une liste écrite à la main mesure ce qu'on a pensé à y mettre.

## Les deux gardes livrées

### `test:coherence` — nouvelle

Règle : **aucun nombre du catalogue ne doit être inconnu de la source
unique.** Pas une liste de clés : une exhaustivité.

1. Catalogue i18n, 7 langues — **336 valeurs sur 48 clés**. Compare des
   *nombres*, pas des chaînes : « 1.248 » en allemand vaut mille deux cent
   quarante-huit, « 92.4 » en anglais vaut quatre-vingt-douze virgule
   quatre, et le même point y joue deux rôles opposés. Les séparateurs sont
   déclarés par langue, jamais devinés.
2. Accueil rendu, EN et FR — chemin catalogue → compteur animé → écran.
3. Console rendue — elle calcule à l'exécution ; c'est de là que venait la
   dérive.

Chaque étape échoue si elle ne trouve rien : un sélecteur muet ferait
passer le test pour de mauvaises raisons.

**Morsures vérifiées** (piège posé, atterrissage confirmé, puis retiré) :

| Scénario | Verdict |
|---|---|
| Un traducteur écrit 93,4 % dans `fr.json` | détecté, catalogue + rendu |
| Un nœud du héros dérive en allemand | détecté |
| Un chiffre neuf non déclaré est ajouté | détecté |
| Une clé déclarée disparaît d'un catalogue | détecté |
| Un libellé d'indicateur est renommé | détecté |
| La calibration est retirée | détecté — reproduit exactement 91,4 / 85,3 / 77,9 / 91,8 |

### `test:copy` — étendue

Vues de détail + cécité levée. **17 450 chaînes sur 9 pages, 19 vues pour
la seule console.** Morsures vérifiées : `04. TEINTURE` réintroduit dans la
lignée → détecté ; `ACTIF` réintroduit dans un badge → détecté. Les deux
passaient avant.

## Triage appliqué aux 39 chaînes

- **Copie** → clé i18n : 26 clés neuves (16 `console.*` × 7 langues,
  10 `portal.*` × 9 langues, `tr`/`zh` compris).
- **Donnée de démonstration** → anglais + `data-tf-demo`, attribut déjà
  utilisé par la page voisine. Les huit sous-libellés de lignée en
  portaient **un** sur huit ; l'intention était là, l'application non.
- **Identifiant technique** → balise `<code>` : `demo-supplier-profile`
  s'affichait comme de la copie.
- **Invariants** → trois motifs ajoutés avec justification : toponymes,
  signature de marque `DATA × TEXTILE × TRUST`, normes CIRPASS / JSON-LD.

Au passage : `fr.portal.spNavMassBalance` valait `Mass-Balance`. Ce n'est
pas une traduction française, c'est le terme anglais recopié. Corrigé en
`Bilan massique`.

## Test mis à jour, pas affaibli

`test_chantier4_demo.mjs` exigeait `CIBLE_FOURNISSEURS = 86, …` dans la
console. Les cibles ayant déménagé dans la source unique, l'assertion ne
matchait plus.

Son intention — « nommées une fois, pas dispersées » — est aujourd'hui
mieux servie : une fois **pour toutes les surfaces**, et non une fois par
surface. L'assertion vérifie donc désormais le lien plutôt que le littéral,
et passe d'une vérification à quatre, dont une interdiction explicite de
réécrire une cible en dur. Morsure vérifiée.

## Barrière

`npm run build` · `tsc --noEmit` · `api:typecheck` · **54 suites `test:*`**
· `audit:e2e` · `audit:personas` 4/4 · `test:phases` 40/40 ·
`test:journeys` 20/20 · `test:cross-tenant` 46 ENABLE · `test:coherence`.
Tout au vert.

## Ce qui reste ouvert

Rien sur ce périmètre. Les trois points non-code des chantiers précédents
sont inchangés : migration 33 à appliquer sur Neon, quatre lignes
contractuelles à remplir dans le dossier sécurité, et l'absence de hachage
de contenu sur les fichiers JS qui empêche un cache long sur `/assets/`.
