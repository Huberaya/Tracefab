# Démonstration scriptée — 8 minutes

Chaque étape a été **jouée contre l'application réelle** et chronométrée. Les
libellés cités sont ceux qui s'affichent, pas ceux qu'on aimerait voir.

**Préparation** — ouvrir les trois onglets avant d'entrer dans la salle :

| Onglet | URL |
|---|---|
| 1 | `/` |
| 2 | `/brand-console/?demo=1` |
| 3 | `/p/3760123456789` |

Charger l'onglet 2 **à l'avance** : les compteurs s'animent au premier affichage
et l'animation dure environ une seconde. Une démonstration qui commence par
des chiffres qui défilent perd le regard.

---

## 0:00 — L'accueil : la promesse en trois lignes

**Onglet 1.** Ne rien dire pendant trois secondes. Laisser lire :

> **Know your product. / Know your supply chain. / Prove it.**

Puis une seule phrase : *« Trois questions. La troisième est celle qui coûte
cher. »*

Faire défiler jusqu'à la colonne vertébrale en sept couches. Ne pas les
commenter une à une — dire : *« Chaîne d'approvisionnement, données produit,
preuves, qualité, traçabilité, intelligence, passeport. Chaque couche s'appuie
sur la précédente. Un passeport sans preuve ne vaut rien. »*

> **Repère.** Si le dirigeant hoche la tête ici, le reste est de la
> démonstration. S'il fronce les sourcils, s'arrêter et demander ce qui manque.

## 1:00 — La console : le centre de contrôle

**Onglet 2.** Titre affiché : **Operational Control Center**.

Montrer la ligne de compteurs — produits, fournisseurs, sites, pays — puis
descendre sur le bloc **02 / DATA QUALITY**, grade et pourcentage.

Dire : *« Ce n'est pas un tableau de bord. C'est une salle de contrôle : tout
ce qui est affiché est cliquable, et tout ce qui est rouge mène à l'écran qui
le corrige. »*

Montrer la zone **ATTENTION**. C'est elle qui déclenche la question du
prospect, pas les chiffres verts.

## 2:00 — Descendre jusqu'à la matière

`Products` dans la navigation, puis **cliquer sur la première ligne**.

La fiche produit s'ouvre. Faire défiler jusqu'à la **lignée** : huit étapes,
de la fibre au passeport. Cliquer sur une étape intermédiaire.

Dire : *« Du produit fini à la ferme, en trois clics. C'est la question que
pose un auditeur, et c'est la seule réponse qui compte : montrez-moi. »*

> **Franchise.** Les libellés des étapes sont encore en français dans une
> interface anglaise. C'est une dette connue, corrigée au prochain lot. Si le
> prospect le remarque, le dire — il le verra de toute façon.

## 3:30 — Le Quality Center : la question gênante

Retour console, `Quality & Compliance`.

La page pose la question : **« Can you trust your data? »**

Dire : *« La plupart des outils vous donnent un chiffre. Celui-ci vous dit
d'où il vient, ce qui le fonde, et ce qui manque pour y croire. »*

Montrer la liste des problèmes : chaque entrée mène à sa correction.

## 4:30 — La maturité DPP : le moment décisif

`DPP` dans la navigation. Score de portefeuille : **88,0 %**, et **cinq écarts
actionnables**.

**Cliquer sur un écart.** Il ouvre directement la vue qui le corrige.

Dire : *« Un score sans action, c'est un reproche. Ici chaque point manquant
porte son écran de correction. »*

> **À dire à voix haute, toujours.** *« Ce score est un indicateur de
> préparation. Ce n'est pas une certification réglementaire, et nous ne le
> présenterons jamais comme telle. »* Un responsable conformité qui entend
> cette phrase sans l'avoir demandée vous fait crédit pour le reste de
> l'entretien.

## 5:30 — Le portail fournisseur : l'angle mort de la concurrence

Ouvrir `/supplier-portal/?demo=1`.

Montrer la barre de complétion, puis dire la phrase qui vend :

> *« Vos données. Votre profil. Réutilisables chez tous vos clients. »*

Dire : *« Un fournisseur qui remplit douze questionnaires par an n'en remplit
bien aucun. Ici il remplit une fois et partage. C'est ce qui fait qu'il
répond. »*

> **Repère.** C'est l'étape que les acheteurs sous-estiment et que les
> directions achats comprennent immédiatement. Si l'interlocuteur vient des
> achats, lui donner deux minutes de plus.

## 6:30 — Le passeport public : ce que verra le consommateur

**Onglet 3** — `/p/3760123456789`.

Laisser regarder. Origine, matières, fabrication, certifications,
circularité, entretien, réparation.

Dire : *« Même donnée, deux publics. Votre équipe voit la preuve et sa source ;
le consommateur voit l'histoire. Rien n'est ressaisi entre les deux. »*

## 7:30 — Clore sur une question, pas sur une offre

Ne pas récapituler. Demander :

> *« Sur vos produits à vous : lequel de ces sept niveaux vous manque
> aujourd'hui ? »*

Puis se taire.

---

## Les trois objections qui reviennent

**« Nos fournisseurs ne rempliront jamais ça. »**
Reprendre l'onglet du portail. Le passeport fournisseur universel se remplit
une fois et se partage. La charge diminue au lieu de s'additionner.

**« Comment savoir si la donnée est vraie ? »**
Revenir au Quality Center. Chaque valeur porte un niveau : déclarée,
documentée, vérifiée, certifiée, à revoir, manquante. Le produit ne prétend pas
que tout est vrai — il dit ce qui est prouvé et ce qui ne l'est pas.

**« Vous êtes conformes ESPR ? »**
Non, et personne ne l'est : les actes délégués ne sont pas tous publiés.
TRACEFAB mesure la **préparation**. Promettre la conformité aujourd'hui serait
une vente qu'on ne peut pas tenir.

---

## Ce qu'il ne faut pas faire

- **Ne pas présenter les chiffres de démonstration comme des chiffres
  clients.** Ils sont marqués comme données de démonstration dans l'interface ;
  le dire aussi à l'oral.
- **Ne pas promettre les intégrations PLM/ERP** comme disponibles. Le
  connecteur existe, il n'est pas déployé chez un client.
- **Ne pas improviser sur la sécurité.** Le [dossier
  sécurité](dossier-securite.md) répond, y compris sur ce qui manque.

---

## Après la démonstration : le pilote

```bash
npx tsx scripts/seed_pilot.ts --dry-run   # le plan et le rapport, sans écrire
npx tsx scripts/seed_pilot.ts             # crée le locataire pilote
```

10 fournisseurs réels en base, 3 rangs, 10 pays, 20 produits, les six états du
cycle de collecte, et le rapport qui se pose sur la table.

**Le pilote n'est pas tout vert, volontairement** : 70 % de couverture de
preuve, 25 % de vérification tiers, 4 produits sous 60 % de maturité. Un pilote
parfait ne démontre rien — c'est l'écart qui donne envie du produit.
