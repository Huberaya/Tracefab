# PHASE 8 — Evidence Center + Quality Center

**Date :** 7 octobre 2026
**Périmètre :** `/brand-console/` vues *Evidence* et *Quality & Compliance*
**Statut :** terminé, l'ensemble des contrôles passe. **En attente de votre validation avant la PHASE 9.**

---

## 0. D'abord : je dois corriger un chiffre que je vous ai donné

En PHASE 7 j'ai annoncé « 40 chaînes de copie d'interface restantes ». **C'était faux, et
largement.** Mon détecteur ne lisait que les chaînes entre guillemets — or la quasi-totalité
de la copie de cette application vit comme **texte à l'intérieur de littéraux de gabarit**,
qu'il ne voyait pas.

Mesure refaite correctement (texte des nœuds HTML + attributs lisibles + chaînes citées) :

| | annoncé en PHASE 7 | réel |
|---|---|---|
| Chaînes françaises visibles | 40 | **438** |

Le chiffre est aujourd'hui à **411** après cette phase. Je donne le détail en §4 et je m'en
tiens désormais à cette mesure.

---

## 1. Evidence Center

### 1.1 Les sept types du brief

| Documents | Certificats | Rapports d'essai | Déclarations | Audits | Factures | Relevés de production |
|---|---|---|---|---|---|---|
| 1 | 2 | 2 | 2 | 1 | 1 | 1 |

Chaque bandeau filtre le registre au clic.

### 1.2 Les huit attributs, sur chaque pièce

Le brief exigeait Source / Date / Émetteur / Produit / Fournisseur / Statut / Vérification /
Expiration. Le registre porte les dix colonnes :

`Preuve · Type · Émetteur · Source · Produit · Fournisseur · Émise le · Expire le · Confiance · Vérification`

### 1.3 Le système de confiance visuel

Les pastilles réutilisent l'échelle du design system, déjà employée sur la landing et sur
Product Intelligence : **Manquante → À revoir → Déclarée → Documentée → Vérifiée → Certifiée**.
La couleur ne porte jamais seule l'information : le libellé est écrit.

### 1.4 L'expiration est traitée comme ce qu'elle est

C'est la première chose que regarde un auditeur. Une barre d'alerte compte ce qui est
périmé et ce qui expire sous 90 jours :

> **1** expirée et encore référencée  **3** expirent sous 90 jours

Dans le tableau, une date expirée est **barrée en rouge**, une échéance proche passe en ambre.

---

## 2. Quality Center

### 2.1 La question du brief, posée telle quelle

Le titre de l'écran est **« Pouvez-vous faire confiance à vos données ? »** et les cinq
mesures demandées y répondent :

| 92,4 % | 84 % | 78 % | 87 % | 91 % |
|---|---|---|---|---|
| Complétude des données | Couverture des preuves | Taux de vérification | Qualité fournisseur | Qualité produit |

### 2.2 Chaque anomalie porte le bouton qui la règle

| Critique | Avertissement | À revoir | Résolue |
|---|---|---|---|
| 2 | 2 | 1 | 1 |

Chaque ligne embarque un bouton qui **route vers l'écran qui corrige** — certificat expiré →
Certifications, preuve manquante → Evidence, données fournisseur périmées → Fournisseurs.
C'est le `qcFixView()` : si la règle ne porte pas de cible explicite, elle est déduite de la
clé de règle. Les anomalies résolues affichent « Voir », pas « Corriger ».

Les quatre bandes sont **dérivées** des sévérités et statuts que l'API produit déjà
(`blocking`/`warning` × `open`/`acknowledged`/`waived`/`resolved`), pas d'un nouveau champ.

### 2.3 Ce qui a été préservé

Le score par produit adossé à `/api/quality/products/`, les panneaux PEF /
anti-greenwashing et les CAP (8D) restent en place, **sous** la réponse d'ensemble. La
mention « le score décrit l'état de préparation des données, il ne constitue pas une
certification » est conservée, conformément à votre consigne.

---

## 3. 16 boutons qui mentaient

En auditant ces vues j'ai trouvé **19 boutons** câblés sur `onclick="alert('…')"` affichant
un message de succès pour une action jamais exécutée :

- *« Rapport CSRD exporté avec succès. »*
- *« Paramètres sauvegardés. »*
- *« Rappel email envoyé à Rui Silva (Nhãn Textile). »*

Aucun export, aucune sauvegarde, aucun email. Sur un produit dont l'argument central est la
confiance, un bouton qui ment coûte plus cher que pas de bouton du tout.

Les 16 restants après réécriture des deux vues sont remplacés par un message honnête,
traduit dans les six langues :

> *Indisponible en mode démonstration — connectez les API TRACEFAB pour exécuter cette action.*

Les vrais boutons (`data-action="compute-quality"`, `"remind-request"`, etc.), eux, sont
intacts.

---

## 4. Dette i18n : l'état réel

| Zone | Chaînes FR | Phase |
|---|---|---|
| `modal` (formulaires de création) | 72 | PHASE 12 |
| `demoCatalogCsv` · `demoData` · `demoDpp` · `demoSupplyChain` | 41 + 32 + 25 + 11 | PHASE 12 (contenu de démo) |
| `productDetailView` | 32 | PHASE 9 |
| `supplyChainConsoleView` · `supplyChainView` | 30 + 16 | PHASE 9 |
| `dppConsoleView` · `dppView` | 16 + 9 | PHASE 10 |
| `requestDetailView` | 16 | PHASE 9 |
| `questionnairesBuilderView` | 15 | PHASE 12 |
| `reportsConsoleView` | 9 | PHASE 12 |
| reste (≈ 20 fonctions) | ~137 | PHASES 9 à 12 |
| **Total** | **411** | — |

Les vues livrées aux phases 5 à 8 — Overview, Products, Risk, Data collection, Evidence,
Quality, Certifications, Mass balance, Integrations, Materials, Reports — sont à **zéro**
chaîne codée en dur.

---

## 5. Résultats des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` (~24 suites) | **exit 0** |
| `typecheck` · `api:typecheck` · `schema:static` | ✅ |
| `test:brand-console` · `test:supplier-portal` | ✅ contrats préservés |
| `verify_locales` desktop / mobile | **6/6** · **6/6** |
| Régression visuelle vs référence PHASE 4 | **aucune** |

### Les deux vues, dans les six langues

| | Evidence | Quality |
|---|---|---|
| EN | Evidence Center | Can you trust your data? |
| FR | Centre de preuves | Pouvez-vous faire confiance à vos données ? |
| DE | Nachweiszentrum | Können Sie Ihren Daten vertrauen? |
| IT | Centro prove | Puoi fidarti dei tuoi dati? |
| ES | Centro de pruebas | ¿Puedes confiar en tus datos? |
| NL | Bewijscentrum | Kunt u uw gegevens vertrouwen? |

### Responsive (390 × 844)

| Vue | Débordement | Cibles < 44 px | Texte coupé | Erreurs JS |
|---|---|---|---|---|
| Evidence | 0 | 0 | 0 | 0 |
| Quality | 0 | 0 | 0 | 0 |

Le bandeau des types passe de 8 colonnes à 4 puis 2 ; les cinq mesures de 5 à 3 puis 2 ;
les anomalies passent en pile avec le bouton d'action sous le texte.

---

## 6. Suite proposée

**PHASE 9 — Traçabilité.** C'est la suite naturelle : le lignage cliquable
Fibre → Filateur → Fil → Tissu → Teinturerie → Fabricant → Produit fini → DPP existe déjà sur
Product Intelligence, mais `supplyChainConsoleView` et `supplyChainView` sont restées en
l'état depuis le début — 46 chaînes françaises et aucune des visualisations du brief.

C'est aussi la phase qui absorbe `productDetailView` (32) et `requestDetailView` (16), soit
**94 chaînes** au total.

**J'attends votre validation avant de démarrer.**
