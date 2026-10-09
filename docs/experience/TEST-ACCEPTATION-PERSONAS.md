# Test d'acceptation — les trois personas

Harnais : `scripts/persona_audit.mjs`
Exécution : `node scripts/persona_audit.mjs --base http://127.0.0.1:3000`
Branche : `merge/experience` · captures et JSON dans `.visual/personas/`

Le cahier des charges fixe trois juges de paix. Ce harnais mesure des
indicateurs **observables** et affiche systématiquement la valeur relevée
face au seuil, pour qu'un échec soit actionnable plutôt qu'une opinion.

| Persona | Critère du cahier des charges | Verdict |
|---|---|---|
| CEO / Fondateur | Saisit la valeur en moins de 30 s | **6/6 — validé** |
| Resp. Conformité | Perçoit la profondeur fonctionnelle | **3/5 — à reprendre** |
| Fournisseur | Sait immédiatement quoi faire | **3/4 — à reprendre** |

---

## Persona 1 — CEO / Fondateur : validé

| Critère | Relevé | Seuil |
|---|---|---|
| Titre affiché | 241 ms | ≤ 3000 ms |
| Lecture du premier écran | 20 s (72 mots) | ≤ 30 s |
| Promesse complète sans scroll | 6/6 | 6/6 |
| Le plus gros texte porte la promesse | « Know your product. » 111 px | le titre hero |
| CTA de contenu, hors en-tête | 2 | ≤ 2 |
| Chiffres signalés comme démonstration | présent | présent |

Rien à reprendre.

---

## Persona 2 — Responsable Conformité : deux écarts

Les 7 couches sont atteignables en un clic et aucune erreur JS n'apparaît
pendant la navigation. Deux problèmes réels :

### a. La vue **Risque** n'existe pas

La navigation spécifiée exige *Overview, Products, Suppliers, Materials,
Supply Chain, Data Collection, Evidence, Certifications, Quality, **Risk**,
DPP, Reports, Settings*. La console compte 16 vues, aucune ne couvre le
risque — une seule occurrence du mot « risque » dans tout le fichier.
`massBalance`, `integrations` et `intelligence` ont été ajoutées à la place.

### b. Deux vues clés arrivent en état vide

| Vue | Contenu à l'arrivée |
|---|---|
| `supplyChain` | 2391 car. · 10 blocs |
| `documents` | 1791 car. · 6 blocs |
| `quality` | 2253 car. · 3 blocs |
| **`dpp`** | 532 car. · 1 bloc — « Sélectionnez un produit… » |
| **`certifications`** | 683 car. · 3 blocs — état vide |

Ces écrans sont corrects en soi : inviter à sélectionner un élément est un
état vide légitime. Mais pour une démonstration, atterrir dessus prive le
visiteur de la profondeur qu'on cherche précisément à lui montrer. Une
présélection par défaut suffirait.

---

## Persona 3 — Fournisseur : un écart, sur mobile

Sur desktop le portail passe : progression « 72 % complété » visible sans
scroll et action dominante identifiable.

### Sur mobile, aucune action dans le premier écran

Sur 390 × 844, **les 12 éléments cliquables visibles appartiennent tous à
la navigation**. Zéro action de contenu. Le fournisseur traverse dans
l'ordre : bannière de démonstration, logo, bande de navigation, fil
d'Ariane, deux menus déroulants, puis cinq lignes de discours — avant
d'atteindre quoi que ce soit d'actionnable. Le « 72 % complété » n'apparaît
qu'en bordure basse d'écran.

C'est l'écart le plus net du test : la promesse « le fournisseur sait
immédiatement quoi faire » n'est pas tenue sur mobile.

Pistes : remonter la carte de progression au-dessus du bloc de discours sur
petit écran, réduire le fil d'Ariane et les deux sélecteurs, exposer la
première étape recommandée comme bouton dès le premier écran.

---

## Volume de lecture du portail — indicatif

| Vue | Mots au premier écran | Équivalent lecture |
|---|---|---|
| Portail desktop | 247 | ~67 s |
| Portail mobile | 101 | ~28 s |

Publié sans seuil : le cahier des charges ne chiffre pas de durée pour le
fournisseur, il exige qu'il sache *immédiatement quoi faire*. Le volume
reste un signal utile — 247 mots pour un outil de travail est beaucoup.

---

## Note de méthode

La première exécution signalait 8 échecs. Quatre étaient des défauts de
mesure, corrigés et documentés dans le harnais :

1. les CTA comptaient les boutons d'en-tête, qui sont de la navigation
   permanente et non des appels à l'action de page ;
2. la détection de progression exigeait un élément strictement égal à
   `72%`, alors que le libellé réel est « 72% complété » ;
3. les vues en état vide étaient comptées comme des vues creuses ;
4. l'« action dominante » se comparait aux boutons de la barre latérale.

Les seuils n'ont **pas** été relâchés pour faire passer un critère. Le seul
seuil retiré est celui du volume de lecture du fournisseur, qui ne figure
pas au cahier des charges et que j'avais fixé arbitrairement : il est
désormais publié comme indicateur, pas comme test.
