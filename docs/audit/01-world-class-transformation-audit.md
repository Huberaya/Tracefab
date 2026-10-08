# Audit de transformation — état mesuré du dépôt

**Date : 8 octobre 2026.** Chiffres relevés sur `main`, pas repris d'un
document antérieur. Chaque ligne de ce rapport est reproductible par la
commande indiquée.

Ce document existe parce que le README y renvoyait sans qu'il ait été écrit.
Le lien était mort, et les chiffres qui le citaient étaient faux. Les deux
sont corrigés ici.

---

## 1. Ce que le dépôt contient réellement

| Mesure | Valeur | Commande |
|---|---|---|
| Routes API | **125** | `grep -c 'pattern:' api/index.ts` |
| Handlers de route | 124 fichiers | `find api/_routes -name '*.ts' \| wc -l` |
| Modèles Prisma | **44** | `grep -c '^model ' prisma/schema.prisma` |
| Migrations Prisma | **32** | `ls prisma/migrations \| grep -v lock \| wc -l` |
| Migrations Supabase (historique) | 8 | `ls supabase/migrations \| wc -l` |
| Tables RLS activée | **45** | `grep -rho 'ENABLE ROW LEVEL SECURITY' prisma/migrations/ \| wc -l` |
| Tables RLS forcée | **44** | idem avec `FORCE` |
| Fonctions `SECURITY DEFINER` | 117 occurrences | `grep -rho 'SECURITY DEFINER' prisma/migrations/ \| wc -l` |
| Scripts | **107** | `ls scripts/ \| wc -l` |
| Scripts de test npm | **61** | `package.json` |
| Docs architecture | **28** | `ls docs/architecture/*.md \| wc -l` |
| Docs expérience | **26** | `ls docs/experience/*.md \| wc -l` |
| Clés de catalogue i18n | **1 626** sur 22 racines | `npm run test:phases` |
| Langues servies | **7** (`en fr de it es nl pt`) | `SUPPORTED` dans `assets/js/tf-i18n.js` |

Les fichiers `tr.json` et `zh.json` existent mais ne portent que 3 racines :
le Supplier Portal peut élargir l'ensemble via `window.TF_I18N_SUPPORTED`.
**Ce ne sont pas des locales complètes** et le README ne doit pas les compter.

### Surfaces

Les neuf surfaces répondent `200`, vérifié sur le serveur qui reproduit le
routage de `vercel.json` :

`/` · `/brand-console/` (17 vues) · `/supplier-portal/` (14 vues) ·
`/quality-center/` · `/operations/` · `/passport/` · `/dpp/` · `/p/:gtin` ·
`/product-intelligence/` (11 onglets) · `/invitations/accept`

`/passport/` n'a **pas** de route déclarée dans `vercel.json` : il est servi
par `handle: filesystem` combiné au build `**/*.html`. Cela fonctionne, mais
repose sur une règle implicite — à savoir si l'on veut le garder ainsi.

---

## 2. Le modèle de preuve — à citer exactement

L'enum `data_value_status` compte **sept** valeurs :

```
declared · documented · checked_for_consistency
verified_by_reviewer · certified_by_third_party
expired · needs_review
```

Une version antérieure du README en citait six, dont deux sous des noms
inexistants : `verified` au lieu de `verified_by_reviewer`, et
`third_party_certified` au lieu de `certified_by_third_party` — mots
inversés. La chaîne `third_party_certified` **n'apparaît nulle part dans le
dépôt** : un lecteur technique qui la cherche ne trouve rien.

C'est le principe fondateur du produit, « une donnée déclarée n'est pas une
preuve ». Il doit être cité avec les noms du code.

L'échelle d'affichage correspondante, côté design, compte six niveaux :
`missing #c0492f` · `review #b47e18` · `declared #7a8782` ·
`documented #2f6f94` · `verified #0fb97c` · `certified #07875a`.

---

## 3. Ce qui reste à faire

Douze chantiers, vérifiés un par un. Le nombre vaut ce que valent les
mesures ci-dessous ; il ne provient d'aucun décompte antérieur.

### Produit

| # | Chantier | Constat |
|---|---|---|
| 1 | **TRACEFAB Intelligence sur données réelles** | La vue existe (`intelligenceView()`), affiche `iaNoInvented` et sert des données de démonstration. Aucun moteur de question sur données réelles. |
| 2 | **DPP public dynamique** | `dpp/index.html` ne contient **aucun `fetch`** : la page est statique. La route `/api/dpp/:gtin` existe déjà et n'est pas consommée. |
| 3 | **Command palette et recherche globale** | Absentes. |
| 4 | **Centre de notifications in-app** | L'outbox serveur existe ; aucune surface de lecture pour l'utilisateur. |
| 5 | **Carte géographique** | Aucune bibliothèque cartographique dans le dépôt. |

### Plateforme

| # | Chantier | Constat |
|---|---|---|
| 6 | **Pagination API** | Aucun `take`/`skip`/`cursor` sur les routes de liste. Les collections sont renvoyées entières. |
| 7 | **Rate limiting** | Aucun module de limitation dans `api/`. |
| 8 | **CI GitHub Actions** | `.github/workflows/` n'existe pas. La barrière de tests ne tourne qu'à la main et dans le build Vercel. |

### Infrastructure à raccorder

| # | Chantier | Variable |
|---|---|---|
| 9 | Bucket S3 privé | `PRIVATE_STORAGE_*` |
| 10 | Scanner antivirus | `PRIVATE_STORAGE_ANTIVIRUS_URL/TOKEN` |
| 11 | Resend production | `RESEND_API_KEY`, `EMAIL_FROM` |
| 12 | Webhook d'alerte incidents | `TRACEFAB_NOTIFICATION_ALERT_URL/TOKEN` |

État vérifiable à chaud par `GET /api/internal/p2/readiness`.

---

## 4. Ce qui n'est plus à faire

**L'externalisation des chaînes métier est terminée.** Un chiffre de
« ~466 chaînes encore en dur » a circulé ; il décrivait l'état d'avant la
phase 12. Mesure du jour, par bascule de langue sur les neuf pages :

```
612 chaines visibles analysees sur 9 pages
Copie metier : aucune chaine non traduite hors exceptions justifiees
```

Les invariants restants sont la marque, les normes (`ESPR`, `GOTS`,
`GS1 Digital Link`…), les toponymes et les données de démonstration —
tous justifiés nommément dans `scripts/test_hardcoded_copy.mjs`.

Cette mesure a elle-même révélé six défauts réels que la barrière existante
ne voyait pas, corrigés en même temps que ce rapport :

- quatre chaînes **en français** affichées sur `/brand-console/` en
  `lang="en"` (`Pays de production`, `18 pays`,
  `Renouvellement sous 90j`, `Actions d'infrastructure rapides`) ;
- `1 098 styles` écrit en dur avec une espace de milliers française sur une
  page anglaise, alors que la page dispose déjà d'un formateur localisé ;
- le texte littéral **`body> body>`** visible sur `/supplier-portal/`,
  séquelle de quatre fins de document empilées en fin de fichier.

---

## 5. Pourquoi la barrière ne les avait pas vus

Quarante-six tests, trente-six contrôles de phase et trois personas
passaient au vert avec ces six défauts à l'écran.

La cause est un contrôle mal nommé. Il s'intitulait **« Aucune copie métier
en dur hors catalogue »** et n'assertait que `totalKeys > 1400` — la taille
du catalogue. Un catalogue volumineux ne dit rien de ce qui reste en dur
dans les pages. Le nom promettait un résultat que l'assertion ne produisait
pas, et tout le monde, moi compris, a lu le nom.

Deux corrections :

- le contrôle s'appelle désormais **« Catalogue i18n au-dessus du seuil »**,
  ce qu'il mesure effectivement ;
- `npm run test:copy` fait le vrai travail : relevé du texte visible en
  anglais, bascule en français, relevé à nouveau, et toute chaîne inchangée
  doit être justifiée par un motif explicite. Contrôle négatif prouvé.

Le détecteur croise aussi le catalogue, car la bascule de langue seule ne
distingue pas « non traduit » de « traduit à l'identique » — `sites` se dit
`sites`. Un mot dont la clé existe avec la même valeur en EN et en FR est
donc accepté.

**Leçon applicable au-delà de ce cas : le nom d'un test est lu bien plus
souvent que son corps. Un nom qui promet plus que l'assertion est une
fausse garantie, pire qu'une absence de test.**

---

## 6. Barrière de non-régression

```
61 scripts test:* · npm run build · npx tsc --noEmit
python3 scripts/e2e_audit.py              4/4
node scripts/persona_audit.mjs            6/6 · 4/4 · 4/4
npm run test:phases                      36/36
npm run test:touch        9 pages x 3 largeurs, plancher 40 px
npm run test:console-css   11 onglets, echelle de confiance 6/6
npm run test:copy          9 pages, bascule EN -> FR
```
