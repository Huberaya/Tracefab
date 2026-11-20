# P10.7 — Rattachement de la base Preview : la valeur, et la preuve qu'elle désigne la bonne branche

**Date :** 2026-11-19
**Objet :** lever l'INDETERMINATE qui subsistait sur le rattachement de la base Preview
(`br-square-bread-b1gu7jk7`), sans toucher à la Production ni modifier aucune protection.

---

## 1. La valeur exacte attendue

```
TRACEFAB_PREVIEW_DB_ENDPOINT = ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech
```

**Ce que cette valeur est :** le **nom d'hôte complet** de l'endpoint Neon que la Preview joint
réellement, sans identifiants, sans mot de passe, sans port, sans nom de base, sans schéma.
Ce n'est pas un secret : un nom d'hôte public ne donne aucun accès. C'est précisément pour cela
que le champ est documenté comme **non secret** (`docs/operations/variables-environnement.md`).

**Ce que cette valeur n'est pas :** un préfixe. Le code compare l'**égalité** du nom d'hôte après
normalisation (casse, espaces, point final) — `api/_routes/internal/p2-readiness.ts`, `hote_conforme`.
La documentation décrivait un « préfixe … par ex. `ep-xxxx` » : c'était faux, et une valeur saisie
selon cette phrase (`ep-lively-field-b1wicg4v`) aurait produit un `FAIL` de conformité qui aurait
ressemblé à « mauvaise base ». La phrase est corrigée dans le même lot.

**Le suffixe `-pooler` fait partie de la valeur.** L'hôte direct et l'hôte pooler sont deux hôtes
distincts : leur empreinte diffère (voir § 3), et le runtime publie `hote_est_pooler` séparément
au lieu de les confondre.

---

## 2. La preuve que cette valeur identifie `br-square-bread-b1gu7jk7`

La chaîne est établie par **trois maillons indépendants**, chacun vérifiable séparément.

### Maillon A — le runtime réel a joint un hôte dont l'empreinte est `55c809d501c6`

Mesuré sur le processus déployé (preuve runtime `p107-runtime-preuves.json`, run `44640585130`) :

```
base_oid       : 16396
base_nom       : neondb
hote_empreinte : 55c809d501c6
```

L'empreinte est calculée par le code du runtime lui-même :

```ts
const u = new URL(process.env.DATABASE_URL ?? '');
hote = u.hostname;
const empreinte = crypto.createHash('sha256').update(hote).digest('hex').slice(0, 12);
```

C'est donc `sha256(hôte réellement injecté)[0:12]` — un fait mesuré sur la connexion réellement
utilisée, pas une valeur supposée.

### Maillon B — `sha256("ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech")[0:12] = 55c809d501c6`

Reproductible en une ligne, sans secret :

```bash
node -e 'const c=require("node:crypto");console.log(c.createHash("sha256")
  .update("ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech")
  .digest("hex").slice(0,12))'
# 55c809d501c6
```

La correspondance est **exacte** et **discriminante**. Les variantes voisines ne collent pas —
ce qui exclut une coïncidence de dérivation :

| Hôte testé | Empreinte | Correspond ? |
|---|---|---|
| `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech` | `55c809d501c6` | **OUI** |
| `ep-lively-field-b1wicg4v.c-5.eu-central-1.aws.neon.tech` (direct) | `ed3e6b055bd9` | non |
| `ep-lively-field-b1wicg4v-pooler.eu-central-1.aws.neon.tech` (sans zone) | `8c1b8f8a3587` | non |
| `ep-lively-field-b1wicg4v` (endpoint seul) | `252462783bc8` | non |

Sur 20 000 hôtes synthétiques distincts, la fonction `sha256[0:12]` n'a produit aucune collision :
la troncature à 12 caractères ne fabrique pas de fausses égalités à cette échelle.

### Maillon C — cet endpoint appartient à `br-square-bread-b1gu7jk7`

Registre d'exceptions de migration du dépôt
(`docs/security/workflow-privileged-allowlist.json`, `previewMigrationWorkflows`) :

```
"target": "Neon project autumn-breeze-47342493, branch br-square-bread-b1gu7jk7,
           endpoint ep-lively-field-b1wicg4v, database neondb"
```

Ce registre nomme la cible **exacte** sur laquelle les deux seules migrations distantes de Preview
ont été autorisées, avec préflight et postflight bornés. L'endpoint `ep-lively-field-b1wicg4v`
et la branche `br-square-bread-b1gu7jk7` y sont liés dans la même déclaration, sur deux
workflows distincts (`p11-preview-p107-migration.yml`, `p11-preview-p107-worker-rls.yml`).

### Conclusion sur les maillons

A donne l'empreinte de l'hôte réellement joint. B montre qu'un seul hôte de cette forme produit
cette empreinte, et que c'est `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech`.
C rattache `ep-lively-field-b1wicg4v` à `br-square-bread-b1gu7jk7`.

**Portée de la preuve, dite sans embellissement :** les maillons A et B sont des mesures
arithmétiques exactes, non ambiguës. Le maillon C est une déclaration de registre du dépôt —
elle documente la cible sur laquelle l'opérateur a autorisé des migrations, elle ne la
**re-mesure** pas. La certitude finale vaut donc celle du registre pour le lien
endpoint → branche, et celle d'un calcul exact pour le lien hôte → empreinte. Pour transformer C
en mesure directe, il faudrait une lecture de l'API Neon (`api.neon.tech`), qui est hors du
réseau autorisé de cet environnement, ou une confirmation console par le propriétaire
(procédure : `livrables-finalisation/prompt-assistant-vercel.md`).

---

## 3. Ce que le contrôle automatisé vérifie désormais

`TRACEFAB_PREVIEW_DB_ENDPOINT` déclaré ⇒ le runtime publie, sur la route de readiness :

| Champ | Signification |
|---|---|
| `identite_base.hote` | le nom d'hôte **réellement joint**, sans identifiants |
| `identite_base.hote_est_pooler` | l'hôte joint est-il le pooler |
| `identite_base.hote_attendu_declare` | une valeur attendue est-elle déclarée |
| `identite_base.hote_conforme` | hôte joint = valeur attendue, après normalisation |
| `identite_base.hote_empreinte` | `sha256(hôte joint)[0:12]` |

Verdicts `C5` de la preuve runtime :

- **C5.1** hôte publié non vide ⇒ PASS ; absent ⇒ INDETERMINATE
- **C5.2** valeur attendue déclarée ⇒ PASS ; non déclarée ⇒ **INDETERMINATE** (état de
  configuration, pas défaut du runtime)
- **C5.3** `hote_conforme === true` ⇒ PASS ; `false` ⇒ **FAIL** ; non déclarée ⇒ INDETERMINATE
- **C5.4** `hote_est_production === false` ⇒ PASS ; `true` ⇒ **FAIL** ; champ absent ⇒ INDETERMINATE

### Pourquoi C5.4 existe — le trou que C5.3 ne peut pas voir

C5.3 compare l'hôte joint à l'hôte **déclaré**. Cette comparaison est nécessaire et elle ne suffit
pas. Si `TRACEFAB_PREVIEW_DB_ENDPOINT` était renseigné avec l'hôte de **Production**, la Preview
joindrait la Production et `hote_conforme` vaudrait `true` : les deux côtés désignent le même hôte,
et une égalité ne peut pas savoir que la valeur est la mauvaise. Ce serait un **PASS parfait sur la
configuration la plus grave possible**.

Le garde `managed_host` de `scripts/lib/require-throwaway-db.mjs` refuse bien tout hôte Neon — mais
il protège les scripts de migration, il ne s'exécute **jamais** dans le runtime. C5.4 comble ce trou
au seul endroit où la question se pose vraiment.

Discrimination mesurée, sur la même réponse de doublure :

| Scénario | C5.3 | C5.4 |
|---|---|---|
| Preview joint sa branche | PASS | PASS |
| Preview joint une autre branche | FAIL | PASS |
| **Preview joint la Production** | **PASS** | **FAIL** |
| Déploiement antérieur au champ | INDETERMINATE | INDETERMINATE |

La ligne en gras est la raison d'être de C5.4 : elle montre un cas où C5.3 seul donnerait un feu
vert. Les assertions correspondantes sont dans `test_preuve_runtime_bout_en_bout.mjs` (7 bis) et
`test_preuve_runtime_garde_fous.mjs` (§ 12) ; les deux étages ont été vérifiés **mordants** par
mutation — adoucir le FAIL de C5.4 en INDETERMINATE fait tomber 2 garde-fous et 1 assertion.

**Aucun chemin ne rend C5 vert sans déclaration explicite.** Une fois la valeur ci-dessus posée
dans l'environnement Preview de Vercel, C5.1/C5.2/C5.3 passent : hôte joint et hôte attendu sont
la même chaîne, octet pour octet, après normalisation.

Le corps publié est **expurgé** avant tout calcul : toute chaîne de la forme `user:pass@` est
retirée, et tout hôte publié doit être un nom d'hôte nu (ni `@`, ni `/`, ni `:`, ni espace).
Le verdict ne peut donc pas republier une chaîne de connexion en la dérivant.

---

## 4. État des quatre livrables

| # | Livrable | État | Où |
|---|---|---|---|
| 1 | Valeur exacte attendue, sans secret | **FAIT** | § 1 |
| 2 | Preuve qu'elle identifie `br-square-bread-b1gu7jk7` | **FAIT**, portée de § 2 | § 2 |
| 3 | Contrôle automatisé endpoint réel vs attendu | **FAIT** | C5.1–C5.4 + anti-fuite |
| 4 | CI complète après correction | **À EXÉCUTER** sur ce commit | run de CI |

**Ce qui reste hors de ma main :** poser la valeur dans l'environnement Preview de Vercel.
Le connecteur Vercel disponible refuse la lecture et l'écriture de variables
(`list_projects` ⇒ *Access denied* sur les deux portées, `create_env_var` inaccessible), et
l'API GitHub refuse la lecture des variables du dépôt (403). La valeur est donc livrée
**documentée et vérifiée**, pas posée.
