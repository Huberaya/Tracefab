# PHASE 3 — Header, Hero, visuel Supply Chain et première section

Landing `index.html` — 39 813 o, 641 lignes.

---

## 1. Le header

Navigation exigée par le cahier des charges, livrée telle quelle :

> TRACEFAB · Why TRACEFAB · Platform · Supply Chain · Product Intelligence ·
> DPP · Resources · Langue · Sign in · Request a demo

Le lockup porte l'identité : **TRACEFAB** surmontant
`DATA × TEXTILE × TRUST` en mono espacé.

Le sélecteur de langue est ici un **menu maison** (`.tf-lang`), pas un
`<select>` comme sur les huit autres pages. C'est délibéré — le header de la
landing est la seule surface où le contrôle natif jurait — mais c'est une
divergence qu'il faut connaître : elle a produit un faux négatif dans l'audit
des phases, ma sonde ne cherchant qu'un `<select>`.

## 2. Le hero

Mot pour mot ce que demandait le brief :

| Élément | Contenu livré |
|---|---|
| Label | `European textile data infrastructure` |
| Titre | `Know your product.` / `Know your supply chain.` / `Prove it.` |
| Sous-titre | connecte données fournisseurs, preuves, qualité, traçabilité et préparation DPP |
| CTA primaire | `Explore TRACEFAB` |
| CTA secondaire | `Request a demo` |
| Invite de défilement | `Unfold the system` |

Le titre en trois lignes est posé sur l'échelle `d0`
(`clamp(3.05rem, 7.7vw, 7.6rem)`), ramenée à `clamp(2.05rem, 10.4vw, 3rem)`
sous 640 px — le hero est le seul endroit du produit où l'échelle d'affichage
a une variante mobile dédiée, parce que trois lignes de titre géant ne tiennent
pas autrement.

## 3. Le visuel : TRACEFAB au centre, dix nœuds autour

Les dix nœuds exigés sont tous présents, chacun avec sa couche d'appartenance
et trois mesures au survol :

| Nœud | Couche | Valeur |
|---|---|---|
| Suppliers | Supply chain · 01 | 86 |
| Products | Product data · 02 | 1 248 |
| Materials | Product data · 02 | 3 106 |
| Facilities | Supply chain · 01 | 214 |
| Documents | Evidence · 03 | 9 847 |
| Certifications | Evidence · 03 | 612 |
| Evidence | Evidence · 03 | 84 % |
| Quality | Data quality · 04 | 92,4 % |
| Traceability | Traceability · 05 | 91 % |
| DPP | DPP · 07 | 88 % |

Chaque nœud ouvre trois lignes de détail — par exemple Traceability :
*Products traceable 91 %*, *Chains to Tier 4 63 %*, *Avg. chain depth 7 steps*.
C'est l'application du principe **Overview → Explore → Inspect** dès le
premier écran : on peut comprendre sans cliquer, et creuser sans changer de
page.

Toutes ces valeurs sont des **données de démonstration**, identifiées comme
telles dans le produit.

## 4. L'ossature en sept couches

La colonne vertébrale conceptuelle est rendue littéralement, chaque couche
portant la question à laquelle elle répond :

| | Couche | Question |
|---|---|---|
| 01 | Supply Chain | *Who makes what?* |
| 02 | Product Data | *What is the product?* |
| 03 | Evidence | *Can we prove it?* |
| 04 | Data Quality | *Can we trust it?* |
| 05 | Traceability | *Where did it come from?* |
| 06 | Intelligence | *What does the data tell us?* |
| 07 | DPP | *What can we publish?* |

Formuler chaque couche en question plutôt qu'en nom de fonctionnalité est ce
qui fait tenir la promesse « simple à comprendre, profond à explorer » : un
dirigeant lit sept questions, un responsable conformité lit sept modules.

## 5. La section « WOW »

Chaîne **Fibre → Matière → Filature → Tissage → Teinture → Coupe → Assemblage
→ Produit → DPP**, avec sept dimensions simultanées :

> Supplier · Country · Facility · Certificate · Document · Quality · Status

Au survol, chaque étape ouvre sa fiche — par exemple la fibre : *Algodão Vivo
Cooperative, Portugal, Baixo Alentejo farm cluster, GOTS 6.0 scope*, avec son
niveau de rang et son état de preuve.

## 6. Vérification

- Navigation, hero et chaîne rendus dans les 7 langues.
- 0 débordement horizontal de 390 à 1 600 px.
- 0 cible tactile sous 40 px depuis la tranche 13 — la navigation principale
  était à 39 px, les liens du pied de page à 32 px.
- 0 erreur JS, 0 ressource en échec.
- Persona CEO : **6/6**. Le brief demandait qu'un dirigeant saisisse la valeur
  en moins de 30 secondes ; c'est ce que mesure ce volet de
  `scripts/persona_audit.mjs`.

## 7. Une dette connue

`#platform` déborde en hauteur : 1 888 px à 1 440 px de large, 3 093 px à
390 px. Un bloc de neutralisation en fin de `tracefab-site.css` contient le
problème sans le résoudre. Le retirer fait réapparaître le défaut — c'est
documenté à cet endroit du fichier pour que personne ne le supprime en
croyant nettoyer.
