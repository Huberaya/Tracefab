# PHASE 6 — Supplier Portal

**Date :** 7 octobre 2026
**Périmètre :** `/supplier-portal/` + clôture des écarts résiduels de la PHASE 5
**Statut :** terminé, l'ensemble des contrôles passe. **En attente de votre validation avant la PHASE 7.**

---

## 0. D'abord : la PHASE 5 n'était pas complète

Vous avez demandé si la PHASE 5 avait été faite en profondeur. Audit fait contre le brief :
**trois écarts réels**, tous fermés avant d'attaquer la PHASE 6.

| Écart | Ce que disait le brief | Correction |
|---|---|---|
| **Drill-down absent** | *« Overview → Explore → Inspect → Act »*, Supply Chain→…→Produit en quelques clics | Action **Intelligence** sur chaque ligne produit et sur la fiche produit → `/product-intelligence/?ref=…`, avec retour par le fil d'Ariane |
| **3 libellés de nav divergents** | Supply Chain · Data Collection · Evidence | Étaient *Traceability* · *Data Requests* · *Documents*. Alignés sur les 7 locales |
| **`pi.*` absent en DE/IT/ES/NL** | i18n phase 1 = EN/FR/DE/IT/ES/NL | **171 clés × 6 locales**, parité 0 manquante / 0 extra / 0 vide |

Au passage, `productsView()` — l'écran que traverse le drill-down — était à 100 % en français
codé en dur. Il passe désormais par le catalogue sur 7 locales.

> Quand le drill-down transporte une référence que la fiche de démonstration ne peut pas
> servir, la page l'écrit : *« Requested reference AT-ESS-001 — showing the demonstration
> record. »* Plutôt que d'afficher silencieusement le produit de quelqu'un d'autre.

---

## 1. Le portail fournisseur

### 1.1 L'écran d'accueil répond à trois questions, dans cet ordre

Le brief demandait *« dead-simple »* et le test persona est que le fournisseur **sache
immédiatement quoi faire**. L'écran est donc construit comme une descente :

1. **Où j'en suis** — bandeau sombre texturé, `72 %` en très grand, *Profil complété*,
   sous le titre **« Vos données. Votre profil. Réutilisables chez tous vos clients. »**
2. **Ce que je fais maintenant** — un seul bloc, une seule action :
   *« 2 demandes attendent votre réponse — dont 2 à échéance sous 7 jours »* → **Répondre maintenant**.
   La règle est dérivée de l'état réel : demandes ouvertes → sinon profil incomplet →
   sinon « Vous êtes à jour ». Le liseré passe au rouge quand une échéance est sous 7 jours.
3. **À quoi ça sert** — *Partagé avec : Atelier Demo · Maison Rivage*. La promesse de
   réutilisation n'est pas affirmée, elle est **montrée** depuis `state.shares`.

Puis seulement : les demandes à traiter, et une checklist *Ce qu'il reste à faire*
(profil, sites, matières, certificats, documents) où chaque ligne mène à l'écran qui la règle.

### 1.2 Design system

Le CSS inline (12 385 octets) est remplacé par trois `<link>` : `tracefab-core.css`,
`tracefab-console.css` et une nouvelle couche **`tracefab-portal.css`** qui ne porte que le
spécifique fournisseur (`.sp-hero`, `.sp-next`, `.sp-reuse`, `.sp-check`) plus les 22 classes
héritées du portail. Le corps `<body>` est resté **byte-identique** lors de la bascule.

Le textile apparaît comme une trame de filets dans le bandeau — texture, jamais photo.

---

## 2. Trois bugs préexistants corrigés

### 2.1 L'interface était bilingue malgré elle

| | clé localStorage | valeur par défaut |
|---|---|---|
| SPA du portail | `tracefab_lang` | **`fr`** |
| `auto-translate.js` (hérité) | `tracefab_lang` | **`en`** |

Même clé, défauts opposés. À la première visite, le SPA rendait en français et le moteur
hérité réécrivait le DOM via un `MutationObserver` — mais **uniquement les chaînes présentes
dans son glossaire**. Résultat : « Sites de production » devenait *Production Sites* tandis
que « Matières et fils » restait en français. Une interface moitié-moitié.

`auto-translate.js` a été retiré de `brand-console` et `supplier-portal` : ces deux pages ont
leur propre catalogue complet, le réécriveur ne faisait que le corrompre. Il reste chargé sur
`dpp`, `operations` et `quality-center`, qui n'ont pas encore le leur (PHASES 8, 10, 11).

### 2.2 Le sélecteur de langue du portail n'avait aucun écouteur

Le `<select id="lang-switch">` était rendu, stylé… et **branché sur rien**. Le portail
dépendait entièrement du réécriveur hérité : il n'a jamais été réellement traduisible.
Câblé dans `bind()`. Vérifié sur les 6 locales :

| | FR | EN | DE | IT | ES | NL |
|---|---|---|---|---|---|---|
| nav | Vue d’ensemble | Overview | Übersicht | Panoramica | Resumen | Overzicht |
| checklist | Sites de production | Production sites | Produktionsstandorte | Siti produttivi | Centros de producción | Productielocaties |

### 2.3 HTML malformé en fin de fichier

`supplier-portal/index.html` contenait depuis l'origine **4 `</html>`** et des fragments
tronqués (`body>\n</html>`) après la fermeture. Sans effet sur les navigateurs, mais faux et
piégeux pour l'outillage. Nettoyé.

---

## 3. Résultats des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` (~24 suites) | **exit 0** |
| `typecheck` · `api:typecheck` · `schema:static` | ✅ |
| `test:brand-console` · `test:supplier-portal` | ✅ contrats préservés |
| `verify_locales` desktop / mobile | **6/6** · **6/6** |
| Régression visuelle vs référence PHASE 4 | **aucune** |

### Desktop

| Route | CSS inline | h1 | Débordement | Erreurs JS |
|---|---|---|---|---|
| `/` | 33 700 → **0** | 1 | non | 2 → **0** |
| `/brand-console/` | 17 621 → **0** | 1 | non | 4 → 2 ¹ |
| `/product-intelligence/` | — → **0** | 1 | non | — → **0** |
| `/supplier-portal/` | 12 370 → **0** | 1 | non | 4 → 2 ¹ |
| `/dpp/` · `/quality-center/` · `/operations/` | inchangés | 1 | non | pas de régression |

¹ Artefact de banc : le serveur de preview statique répond `501` sur `/api/*`.

### Mobile 390 × 844

| Route | Débordement | Cibles < 44 px | Texte coupé | Erreurs JS |
|---|---|---|---|---|
| `/supplier-portal/` | **0** (était 121 px) | **0** (était 17) | 0 | 0 |
| `/brand-console/` | 0 | 0 | 0 | 0 |
| `/product-intelligence/` | 0 | 0 | 0 | 0 |

---

## 4. Les trois personas

| Persona | Statut | Pourquoi |
|---|---|---|
| **CEO / Fondateur** | ✅ | Landing + Overview : l'échelle et la confiance en un écran |
| **Responsable conformité** | ✅ | Product Intelligence : 11 angles, lignage cliquable, preuves datées, manques DPP nommés |
| **Fournisseur** | ✅ **(était ⚠️)** | Un chiffre, une action, une preuve que son travail sert ailleurs. Et enfin dans sa langue |

Les trois personas du test d'acceptation sont désormais servis.

---

## 5. Dette connue, chiffrée

- **224 chaînes françaises en dur** subsistent dans les corps de vues de la console
  (majoritairement du contenu de démonstration). Rattachées aux PHASES 8 à 12, détail
  dans `PHASE-5-DASHBOARD.md` §5.
- Les vues internes du portail (profil, sites, certificats…) gardent leur copie héritée ;
  seul l'écran d'accueil a été réécrit. Le reste suit le même mécanisme `t()`, donc la
  migration est mécanique.
- `dpp`, `quality-center`, `operations` conservent leur CSS inline : PHASES 8, 10 et 11.

---

## 6. Suite proposée

**PHASE 7 — Data Collection.** Le parcours Brand → Supplier → Product → Required Data →
Evidence → Review → Verified Data, avec les états Missing / Requested / Submitted /
Under Review / Accepted / Rejected. C'est la charnière entre les deux faces que nous venons
de construire : la console demande, le portail répond.

**J'attends votre validation avant de démarrer.**
