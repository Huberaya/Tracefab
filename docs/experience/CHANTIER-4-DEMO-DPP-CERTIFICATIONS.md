# Chantier 4 — Les vues DPP et Certifications atterrissaient à vide

**Statut : fait.** Priorité P1. Branche `merge/experience`.

---

## 1. Le défaut

En mode démonstration (`/brand-console/?demo`), seize vues sur dix-sept se
remplissaient. Deux restaient vides — et c'étaient précisément les deux qui
portent la promesse réglementaire du produit.

Mesure avant correction, en caractères de contenu réellement affichés :

| Vue | Contenu | Blocs |
|---|---:|---:|
| `supplyChain` | 2 229 | 5 |
| `quality` | 2 105 | 3 |
| `documents` | 1 636 | 2 |
| `risk` | 1 122 | 8 |
| **`certifications`** | **531** | **3** |
| **`dpp`** | **357** | **1** |

`dpp` affichait une phrase : « Sélectionnez un produit… ». `certifications`
affichait un tableau à zéro ligne surmonté d'un panneau affirmant que tout
allait bien.

Deux causes distinctes, lues dans la source :

- `dppView()` (6 439 caractères de code) commence par un retour anticipé : tant
  que `state.selectedDppProduct` est absent, elle rend un sélecteur de produit
  et s'arrête. Or `demoData()` ne posait jamais cette clé. Les 6 000 caractères
  de vue — jauge, piliers, exigences — n'étaient jamais atteints.
- `certificationsConsoleView()` mappe `state.certifications || []`. La clé
  n'était jamais semée : le tableau restait vide.

L'état vide est juste en production, sur un compte neuf. En démonstration il
retire au visiteur les deux écrans qui justifient le produit.

---

## 2. Ce qui a été fait

### 2.1 Semer les données manquantes

`demoData()` pose désormais `state.selectedDppProduct`, `state.dpp` et
`state.certifications`. Trois principes ont guidé le contenu.

**Les échéances sont relatives.** Les dates d'expiration sont calculées depuis
`Date.now()` :

```js
const dans = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
```

Cinq certificats à +412, +233, +176, +58 et +31 jours. Une date écrite en dur
aurait transformé la démonstration en vitrine de certificats périmés au bout de
quelques mois. Le test interdit explicitement le retour d'une date littérale.

**Le score DPP est imparfait, et volontairement.** 88 %, soit la valeur annoncée
par le KPI de la vue d'ensemble dans le cahier des charges — les deux écrans
devaient concorder. Mais 7 exigences satisfaites sur 9, dont une bloquante
restante : la vue montre autant ce qui manque que ce qui est acquis. Un 100 %
n'aurait rien démontré du produit.

**La chaîne est textile.** Les quatre piliers portent un contenu de métier :
identification (GTIN, référence, catégorie), composition (fibre à fibre, part
recyclée, origine), traçabilité (rangs 1 à 4 — confection, tissage, filature,
matière première), qualité (certificats fournisseurs, certificat de transaction,
rapport d'essai). Le rang 4 manquant est le bloquant : c'est le point dur réel
de la traçabilité textile.

### 2.2 Dériver la veille des expirations

Le panneau « Veille des expirations » affirmait en dur :

> Aucun certificat n'expire dans les 60 prochains jours.

Et la colonne Statut rendait une pastille figée « Valide » sur chaque ligne.

Cette prose était inoffensive tant que la vue était vide. Elle devenait fausse à
la seconde où l'on semait des données — et elle entrait en contradiction directe
avec le « 8 Certificates Expiring » du cahier des charges. Les deux dérivent
maintenant des données :

```js
const certJours = (c) => Math.ceil((Date.parse(c.expires) - Date.now()) / 86400000);
```

En dessous de 0 jour : « Expiré ». En dessous de 90 : « Expire bientôt ». Au
delà : « Valide ». Le panneau compte les certificats sous 90 jours, nomme le
prochain renouvellement et affiche son échéance — ou dit qu'il n'y en a aucun,
quand c'est vrai. Avec le jeu de démonstration : **2 certificats sous 90 jours,
prochain renouvellement OEKO-TEX STANDARD 100 dans 31 jours.**

Le seuil de 90 jours n'est pas arbitraire : c'est celui qu'annonce l'encadré
« Règle de conformité continue » de la même vue. Les deux chiffres s'accordent
désormais, là où le panneau en annonçait 60 et la règle 90.

### 2.3 Externaliser la copie de la vue

Rendre les statuts traduisibles tout en laissant les titres en français aurait
produit, en anglais, un écran mi-français mi-anglais — plus incohérent qu'avant.
Les 13 chaînes de chrome de la vue sont donc passées au catalogue en même temps :
titre, accroche, intitulés de colonnes, titres de panneaux, texte de la règle,
état vide.

**21 clés `cert*` × 7 langues**, produites par
`scripts/build_certifications_i18n.mjs`, calqué sur le générateur du chantier 3 :
région délimitée par marqueurs, retirée par recherche littérale avant réécriture,
idempotent.

### 2.4 Deux corrections de bord

**Responsive.** La vue DPP débordait de 133 px à 390 px : la ligne de jauge
(`grid-template-columns: 200px 1fr`) et la grille de piliers (2 colonnes) ne
s'effondraient pas. Une `@media (max-width: 720px)` les passe en colonne unique
et autorise la césure des codes d'exigence. Débordement ramené à 0.

**Formulation.** Le panneau des exigences restantes disait « avant de pouvoir
**certifier** le passeport ». La règle du projet est explicite : la préparation
DPP n'est jamais une certification. La phrase devient « avant de pouvoir
**passer** le passeport en statut Prêt pour validation », suivie du rappel que la
préparation est un indicateur opérationnel. Aucun test n'assertait l'ancienne
formulation.

---

## 3. Résultat mesuré

| Vue | Avant | Après | Blocs |
|---|---:|---:|---:|
| `dpp` | 357 | **1 745** | 1 → **5** |
| `certifications` | 531 | **807** | 3 → **3** (5 lignes de tableau) |

`certifications` reste compacte parce que c'est un tableau de cinq lignes : le
volume de texte y est faible par nature. Ce qui compte est qu'elle ne rend plus
un vide.

| Contrôle | Résultat |
|---|---|
| Débordement horizontal, 1440×900 et 390×844, EN/FR/DE | **0 px** |
| Erreurs console | **aucune** |
| Les 17 vues parcourues, états vides restants | **aucun** |
| Statuts traduits | `Valid` / `Gültig` / `Expire bientôt` / `Läuft bald ab` |
| `npm run build` (chaîne complète) | **vert** |
| Matrice de tests | **34 OK / 1 échec** |

L'unique échec reste `test:supplychain:chantier3`, **identique sur `origin/main`**
et antérieur à ces travaux (il attend le littéral `'Tier 4 · Matières'`).

### Test de non-régression

`npm run test:chantier4-demo` — **33 assertions**, chaîné dans `build`. Il
verrouille notamment :

- la présence des trois graines et des quatre piliers ;
- que les échéances dérivent de `Date.now()` et qu'aucune date n'est littérale ;
- la **cohérence arithmétique interne** : `totalRequirements − metRequirements`
  doit égaler le nombre de champs manquants, et `blockingCount` le nombre de
  champs `blocking: true`. Une graine incohérente échoue le test ;
- que la phrase « aucun certificat n'expire » et la pastille figée « Valide »
  ne reviennent pas ;
- que « certifier le passeport » ne réapparaisse nulle part dans la page ;
- la couverture des 21 clés dans les 7 locales, **en suivant le contrat de
  résolution** `console.*` puis repli `shared.*` ;
- qu'aucune phrase en dur ne subsiste dans la vue ;
- que les deux générateurs i18n insèrent en tête de bloc, condition de leur
  cohabitation (voir § 4).

Captures : `.visual/risk/c4-dpp-{en,fr,mobile}.png`,
`.visual/risk/c4-certifications-{en,fr,mobile}.png`. Le dossier `.visual/` est
ignoré par git.

---

## 4. Un piège rencontré, qui méritera de l'attention

Les deux générateurs i18n — celui du chantier 3 et celui-ci — écrivent chacun
une région dans le même bloc `console` de `en.js`. Ils inséraient leur région
**juste avant l'accolade fermante** du bloc, en ajoutant une virgule après
l'entrée précédente.

Quand la région de l'autre générateur était déjà en place, cette entrée
précédente était une **ligne de commentaire** (`// --- fin … ---`). La virgule
se retrouvait collée à la fin du commentaire, donc avalée par lui. `en.js`
devenait syntaxiquement invalide, et seulement au deuxième générateur exécuté —
jamais au premier.

Les deux scripts insèrent désormais **en tête de bloc**, chaque ligne portant sa
propre virgule finale. L'insertion est alors valide quel que soit le contenu
existant. Vérifié : les deux générateurs, dans les deux ordres, deux fois
chacun — 97 clés stables, les deux régions intactes.

La leçon vaut au delà de ce chantier : **un générateur de code qui insère par
rapport à un délimiteur de fin est fragile dès qu'un second générateur écrit
dans la même zone.** Insérer en tête, avec une virgule par ligne, supprime la
dépendance au voisin.

---

## 5. Ce qui n'a pas été fait

**Le jeu de démonstration reste étroit.** Il compte 1 fournisseur, 2 produits,
1 matière. Le cahier des charges affiche en vue d'ensemble 1 248 produits,
86 fournisseurs, 214 sites, 18 pays. Un responsable conformité qui passe de la
vue d'ensemble à la liste des fournisseurs verra 86 d'un côté et 1 de l'autre.
Ce chantier-ci corrigeait des **états vides** ; l'écart d'échelle est un sujet
distinct, désormais inscrit au backlog.

**Aucune route API n'a été ajoutée.** Tout est semé côté client dans `demoData()`,
donc visible uniquement en mode démonstration. Les comptes réels continuent de
lire leurs données du serveur, et l'état vide y reste le comportement correct —
il est d'ailleurs toujours rendu explicitement par la nouvelle clé `certNone`.

**Le reste de la copie en dur de la console n'a pas été traité.** Seule la vue
certifications a été externalisée, parce que la traiter à moitié l'aurait rendue
incohérente. Les autres vues relèvent du point 7 du backlog.

---

## 6. Fichiers touchés

| Fichier | Nature |
|---|---|
| `brand-console/index.html` | graines `demoData()`, `certJours`/`certStatut`, veille dérivée, 13 chaînes externalisées, media query DPP, formulation corrigée |
| `scripts/build_certifications_i18n.mjs` | **nouveau** — 21 clés × 7 langues |
| `scripts/build_risk_i18n.mjs` | insertion en tête de bloc (cohabitation) |
| `scripts/test_chantier4_demo.mjs` | **nouveau** — 33 assertions |
| `assets/i18n/en.js` + `{fr,de,it,es,nl,pt}.json` | 21 clés `cert*` |
| `package.json` | `test:chantier4-demo`, chaîné dans `build` |
