# Bilan des chantiers — où nous en sommes

_Mise à jour : 7 octobre 2026. Branche `merge/experience`, commit `9fba792`._

## En une phrase

Les chantiers 6 (consolidation i18n), 3 (vue Risk), 4 (vues vides en
démonstration) et 5 (portail mobile) sont **terminés**, et **les trois
personas passent le test d'acceptation** — CEO 6/6, Conformité 4/4,
Fournisseur 4/4. Le premier a révélé un quatrième moteur de
traduction caché qui corrompait le DPP public ; le deuxième, une vue entière
déclarée dans la navigation mais injoignable ; le troisième, un panneau qui
affirmait en dur un fait sur des données qu'il n'avait pas encore ; le
quatrième, un écran mobile où rien n'était actionnable. Il reste
**7 chantiers**, et **plus aucun P0**.

---

## Ce qui est fait

| # | Chantier | Résultat |
|---|---|---|
| **6** | **Catalogues i18n concurrents** · P0 | **6 des 7 pages sur le catalogue unique.** Reste `passport/` et `operations/`, toutes deux orphelines (0 lien entrant) : leur migration n'a de sens qu'une fois leur sort tranché. |
| **3** | **Vue Risk absente de la console** · P0 | **Livrée**, entre Qualité et DPP. Signaux dérivés des données déjà chargées, jamais inventés. Chaque ligne mène à sa correction. Score explicitement écarté de toute certification. A aussi révélé que la vue `intelligence` était injoignable — corrigée. Détail : `CHANTIER-3-VUE-RISK.md`. |
| **4** | **`dpp` et `certifications` vides en démonstration** · P1 | **Les deux vues se remplissent.** `dpp` : 357 → 1 745 car., jauge 88 %, 4 piliers, 1 bloquant restant. `certifications` : 5 certificats aux **échéances relatives**, donc jamais périmées. La veille des expirations **dérive des données** au lieu d'affirmer en dur qu'aucun certificat n'expire. 21 clés × 7 langues. Détail : `CHANTIER-4-DEMO-DPP-CERTIFICATIONS.md`. |
| **5** | **Portail fournisseur sans action sur mobile** · P1 | **0 action de contenu au-dessus de la ligne → 5.** Le panneau de progression dérivait de rien : trois « 100 % » en dur a cote d'un total de 72 %. Il lit désormais `state.quality.score`, désigne le point faible par calcul et porte un bouton qui y mène. Chrome mobile dégraissé de 176 px. 17 clés x 9 langues. Detail : `CHANTIER-5-PORTAIL-MOBILE.md`. |

Rappel des chantiers déjà soldés avant celui-ci : les 8 fiches de l'audit sont
toutes corrigées, les 10 routes orphelines sont enregistrées (124/124, 0
orpheline), et le `FORCE RLS` est généralisé (45 `ENABLE` / 44 `FORCE`, une
seule exemption documentée).

### Cinq défauts visibles par l'utilisateur corrigés au passage

1. La langue était **perdue entre la vitrine et l'application** — deux clés de
   stockage distinctes.
2. Le portail fournisseur repliait en **français** les clés absentes en turc,
   portugais et chinois. Il replie désormais en anglais, et les 30 clés
   manquantes sont traduites.
3. Un changement de langue venu d'un **autre onglet** ne redessinait jamais la
   page.
4. `quality-center/` n'avait **aucune traduction**, alors que trois pages y
   mènent : un visiteur allemand ou italien tombait sur une page française
   sans recours.
5. Le badge du **DPP public** ne se traduisait pas en `fr`, `it`, `es`, `pt`.

### Le quatrième moteur

Mon relevé initial annonçait trois systèmes i18n concurrents. Il y en avait
**quatre**. `public/auto-translate.js` — 25 Ko, chargé par `dpp/`,
`quality-center/` et `operations/` — ne lit aucun catalogue : il parcourt les
nœuds texte du DOM et les substitue depuis un glossaire **à source française**
de 101 entrées. Il met sa langue **en cache au chargement** et ne la
rafraîchit jamais, et il se réapplique **à chaque mutation du DOM**.

D'où un symptôme longtemps incompréhensible : le badge se traduisait en `de`
et `nl`, mais pas en `fr`, `it`, `es`, `pt`. `tf-i18n` écrivait pourtant la
bonne valeur — mesurée à l'instant même du rendu — puis le moteur la
repeignait. Les deux langues épargnées sont exactement celles dont la valeur
(« Konform », « Conform ») n'est pas une clé du glossaire français ; les
quatre autres partagent « EU ESPR / DPP Conforme », qui en est une.

**89 valeurs françaises du catalogue partagé sont des clés de ce glossaire** :
le conflit était latent bien au-delà du badge.

Traitement différencié, selon ce dont chaque page dépend réellement :

| Page | Décision | Raison |
|---|---|---|
| `quality-center/` | **retiré** | sa copie visible passe désormais entièrement par le catalogue |
| `dpp/` | **conservé et synchronisé** | son corps est encore en français en dur : le retirer rendrait la page monolingue |
| `operations/` | inchangé | orpheline, non migrée |

### Vérifications

- `dpp/` : **14/14** — 7 langues × 2 parcours (sélecteur de la page et
  chargement direct `?lang=`), aucune erreur console.
- `quality-center/` : **6 langues** conformes sans le moteur historique.
- Matrice : **32/33**, `typecheck`, `api:typecheck`, `schema:static` au vert.
  L'unique échec, `test:supplychain:chantier3`, échoue **à l'identique sur
  `origin/main`** — c'est le chantier 1.

---

## Ce qui reste — 7 chantiers

| # | Chantier | Priorité | Nature |
|---|---|---|---|
| 1 | Arbitrer `test:supplychain:chantier3` | P1 | décision |
| 2 | Déclarer `tsx` en devDependency | P1 | 1 ligne (8 scripts passent par `npx`) |
| 7 | Copie métier en dur dans les SPA | P1 | ~754 chaînes |
| 8 | Ouvrir la PR (**push fait**) | P1 | 1 clic — jeton sans `pull_requests=write` |
| 9 | Phases 9 à 12 sans rapport formel | P2 | revue |
| 10 | Sort de l'arbre `locales/` | P2 | **décision attendue de votre part** |
| 11 | Jeu de démonstration d'une autre échelle que les KPI annoncés | P2 | **décision attendue de votre part** |

### Le chantier 7 change de nature

Je le signalais comme « externaliser la copie en dur ». La découverte du
quatrième moteur le requalifie : sur `dpp/`, cette copie en dur est
**française**, et c'est `auto-translate.js` qui la traduit à la volée. Tant
que la page n'est pas entièrement portée par le catalogue, ce moteur ne peut
pas être retiré — les deux chantiers sont donc liés, et `dpp/` doit être
traité avant de pouvoir supprimer le moteur partout.

---

## Deux points qui appellent votre arbitrage

Aucun des deux n'est de mon ressort ; je ne les ai pas touchés.

**1. Le badge du DPP public affiche une conformité, pas une disponibilité.**
Il dit « EU ESPR / DPP Compliant » (« Conforme », « Konform »). C'est une
affirmation de conformité réglementaire sur une page grand public. Votre règle
constante est que l'état de préparation ne doit jamais être présenté comme une
certification. Je ne l'ai pas reformulé de ma propre initiative, mais je pense
qu'il devrait l'être.

**2. `dpp/index.html` comporte 76 lignes orphelines après `</html>`.** Elles
contiennent l'onglet 4 — *Réparabilité / Recyclabilité / Économie circulaire* —
soit l'une des 10 sections obligatoires du DPP public. Le défaut est
**antérieur à mes modifications** : `origin/main` est identique à l'octet
près. Les navigateurs étant tolérants, la section s'affiche probablement, mais
le balisage est invalide et un lecteur strict pourrait l'ignorer.

---

## État de livraison

**Push effectué** : `df11a5d` → `c9b1afb`, 6 commits.
`origin/merge/experience` est à jour et **16 commits en avance sur `main`**.

**La PR reste à ouvrir.** Le jeton porte `admin` et `push` sur le dépôt, mais
l'API refuse la création d'une PR avec
`x-accepted-github-permissions: pull_requests=write` : le jeton *fine-grained*
n'accorde que `Pull requests: Read`.

Au choix : un clic sur
<https://github.com/Huberaya/Tracefab/pull/new/merge/experience> (le corps de
PR prêt à coller est dans `docs/experience/PR-merge-experience.md`), ou un
jeton régénéré avec *Pull requests → Read and write* puis
`bash /home/user/push_and_pr.sh <fichier-token>`.
