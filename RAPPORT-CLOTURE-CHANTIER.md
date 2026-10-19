# TRACEFAB — Rapport de clôture du chantier de validation technique

**Branche** `arena/ba652133-tracefab` · **HEAD** `20087f0b2f82a8288eebf78692a298147a408ba1`
**Aucun push, aucune fusion, aucun déploiement, aucune opération distante effectués.**

Ce rapport ne déclare le chantier ni terminé ni fusionnable. Il sépare ce qui est
démontré de ce qui reste bloqué, et nomme l'action minimale manquante.

---

## 1. Tableau de clôture

| Domaine | Contrôle | Résultat | Preuve | Risque restant |
|---|---|---|---|---|
| Git | HEAD et branche | `92401cf…` au début de la passe du 19 octobre (suite), sur `arena/ba652133-tracefab` ; cette passe est commitée par-dessus, voir §8 | `git rev-parse HEAD` | — |
| Git | correctif `f078550` inclus dans HEAD | **OUI** | `git merge-base --is-ancestor f078550 HEAD` → 0 | — |
| Git | graphe, fusions | linéaire, 8 commits à 1 parent avant cette passe, aucune fusion | `git rev-list --parents` sur chaque commit | — |
| Git | worktree (fichiers suivis) | propre | `git status --porcelain -uno` → vide | 21 fichiers non suivis, restes de phases antérieures, non commités |
| Git | positions distantes | branche `bb1213c`, `main` `31ce446` — **inchangées** | `git ls-remote origin` | — |
| Git | secrets / temporaires commités | **aucun** | balayage du diff `main..HEAD` | — |
| Migrations | application séquentielle sur base vierge | **52/52 appliquées, 0 échec** | §8.6, rôle provisionné avant les migrations | — |
| Migrations | idempotence des 5 du chantier | **5/5 rejouées sans erreur**, 0 duplication | politiques 131→131, fonctions 165→165, déclencheurs 47→47 | — |
| Migrations | cohérence SQL ↔ provisioning ↔ état réel | **21 = 21 = 21** tables en écriture, 29 en lecture seule | extraction depuis `api/` = liste exportée = mesure `aclexplode` | la valeur précédente, **4**, était fausse — voir §8.1 |
| Migrations | collisions d'horodatage | 4, toutes sur liste d'exceptions nominative | 3 anciennes (identiques sur `main`), 1 introduite par `b9e2525` déjà sur `bb1213c` | dette : 4 horodatages ambigus |
| Migrations | **rollback** | **aucun mécanisme** | 0 down migration, 0 procédure documentée | **réel** : un retour arrière exige une nouvelle migration avant |
| Migrations | `schema.prisma` | inchangé par la branche | `git diff --stat 31ce446 HEAD -- prisma/schema.prisma` → vide | — |
| Tests | 101 entrées auto-collectées | **75 vertes, 26 rouges, 0 défaut de code** | §8.6 — filtre extrait du workflow puis exécuté | 20 navigateur absent, 6 client Prisma absent |
| Tests | `test:chantiers` | **6/6, sortie 0** | sur HEAD exact | — |
| Tests | suites de sécurité | 39/39 · 30/30 · **19/19** · **33/33** · 14/14 · 8/8 + garde propriétaire PASS | sortie 0 chacune, §8.6 | — |
| Tests | contrôles négatifs | RLS retirée → 1 ; migration retirée → 1 | empreinte restaurée `1120041bd9f6aa69`, git propre | — |
| **Privilèges** | **défaut introduit par le chantier** | **trouvé et corrigé** | §8.1–8.4 : 21 tables écrites, pas 4 ; `users` inclus | corrigé par `20261019160000` + garde `test:tables-ecriture-directe` |
| Prisma | `prisma generate` | **échec, sortie 1** | `binaries.prisma.sh` injoignable | **bloquant pour le build local** |
| Prisma | `prisma validate` | **échec, sortie 1** | même cause | idem |
| Typage | `api:typecheck` | sortie 2, **89 erreurs**, 0 dans les fichiers du chantier | `/tmp/tsc.log` | non représentatif de la CI |
| Routes | `test:router-load` | sortie 1 — `@prisma/client` n'exporte pas `PrismaClient` | client non généré | idem ; **réussi en CI** sur `bb1213c` |
| Build | `npm run build` | **non validé** | s'arrête sur `db:generate` | **condition 2 non remplie** |
| Chromium | `npx playwright install chromium` | **échec** | `cdn.playwright.dev` → `ECONNRESET` | 20 tests non exécutables ici |
| Objets SQL | référence régénérée | **245 objets** = 131 politiques + 114 `SECDEF`, inchangés à 52 migrations | `lire-objets-sql.sql` sur base vierge | — |
| Objets SQL | outil de comparaison | **épreuve réussie** | 245 vs 248 synthétique → nomme les 3, sortie 1 ; entrée manquante → sortie 2 | — |
| Objets SQL | **identité des objets divergents** | **NON IDENTIFIÉS** | aucune connexion autorisée | **bloquant** |
| CI distante | les 4 jobs requis sur **ce** HEAD | **non exécutés** | aucun push | **condition 1 non remplie** |
| CI distante | les 4 jobs requis sur `bb1213c` | **success** — preuve que l'environnement distant génère Prisma, installe Chromium, compile et teste | run `39209559163`, étapes 5/6/7/10 | `ci.yml` a +71 lignes depuis : les 4 nouvelles étapes n'ont jamais tourné |
| Production | identité effective du runtime | **non mesurée** | sonde prête, jamais exécutée sur un runtime | **bloquant pour la sécurité** |

---

## 2. Phase 1 — État Git et confirmation du correctif

Les cinq vérifications demandées :

1. **`f078550` existe dans le graphe** — `git cat-file -t f078550` → `commit`,
   hash complet `f07855040b744871958f7a1d2c421022872d5201`, et
   `git merge-base --is-ancestor f078550 HEAD` → **0**.
2. **Le correctif est inclus dans le HEAD annoncé** — `20087f0` a pour parent
   `f078550`.
3. **Le document annonce le bon compte** — `git show HEAD:docs/experience/CHANTIERS-RESTANTS.md`
   → « Dépôt : 51 migrations » ; réel : **51** dossiers.
4. **`test:chantiers` réussit sur le HEAD exact** — 6/6 affirmations, **sortie 0**,
   exécuté sur `20087f0` et non sur une révision antérieure.
5. **74/100 et les 26 échecs sont reproduits** — balayage complet réexécuté sur
   `20087f0` : **74 vertes, 26 échecs** (20 Chromium, 6 client Prisma),
   **0 échec inexpliqué**.

---

## 3. Phase 2 — Migrations

### 3.1 Les cinq migrations du chantier

| migration | objectif | objets affectés | test | résultat |
|---|---|---|---|---|
| `20261017100000_fix_document_lifecycle_access` | le propriétaire relit ses documents ; la finalisation exige un rôle écrivain | 1 politique `documents_select_authorized`, 1 fonction `tracefab_finalize_document_upload` | `test:neon:isolation-lignes` | 18/18 |
| `20261017120000_harden_dpp_table_privileges` | PUBLIC perd tout privilège sur les 4 tables DPP | 1 GRANT, 5 REVOKE, 1 bloc `DO` | `test:neon:privileges-role-app` | 16/16 |
| `20261017150000_harden_finalize_ops_gate` | garde d'exploitation par privilège réel | 1 fonction `tracefab_finalize_document_upload` (recréée) | `test:neon:privileges-role-app` | 16/16 |
| `20261019120000_restreindre_dml_role_applicatif` | le rôle applicatif perd l'écriture directe hors 4 tables | 2 GRANT, 2 REVOKE, 2 blocs `DO` | `test:neon:privileges-role-app` | 16/16 |
| `20261019140000_restreindre_suppression_compteurs_debit` | la suppression de compteurs est bornée aux fenêtres expirées | 4 politiques créées, 5 supprimées, 1 fonction, 1 déclencheur | `test:neon:compteurs-debit` | 39/39 |

### 3.2 Application séquentielle sur base vierge

Base créée, rôle applicatif créé **avant** les migrations (ordre réel de
déploiement), puis les 51 migrations appliquées dans l'ordre lexicographique :

```
appliquees : 51     vides : 0     EN ECHEC : 0
```

État final mesuré : 51 tables/vues · 165 fonctions · 114 `SECURITY DEFINER` ·
**0 `SECDEF` sans `search_path` fixé** · 131 politiques · RLS active et forcée sur
**50 tables sur 51** (seule `_prisma_migrations` exemptée) · 47 déclencheurs.

Aucune dépendance à un état local préexistant : la base est créée vide.

### 3.3 Idempotence

Les 5 migrations rejouées sur la base déjà provisionnée : **5/5 sans erreur**,
et aucune duplication — politiques 131→131, fonctions 165→165, déclencheurs
47→47.

### 3.4 Cohérence SQL ↔ provisioning ↔ état réel

| source | tables en écriture directe |
|---|---|
| `scripts/lib/tracefab_app_role.mjs` (`TABLES_ECRITURE_DIRECTE`) | `audit_logs`, `documents`, `rate_limit_counters`, `tracefab_catalog_import_jobs` |
| migration `20261019120000` (re-grant) | les mêmes 4 |
| mesure réelle (`aclexplode` sur rôle `tracefab_app`) | les mêmes 4 — **47 tables en lecture seule** |

### 3.5 Collisions d'horodatage

| horodatage | sur `main` | sur HEAD | nature |
|---|---|---|---|
| `20261006120000` | 2 | 2 | ancienne |
| `20261006200000` | 2 | 2 | ancienne |
| `20261006220000` | 2 | 2 | ancienne |
| `20261017120000` | 1 | 2 | **introduite par `b9e2525`**, déjà sur `bb1213c` |

Les quatre sont inscrites sur la liste `DETTE_ACCEPTEE` par **noms exacts**, avec
un contrôle de désynchronisation (sortie 2 si la liste n'est plus à jour).
`test:migrations:horodatages` → sortie 0, « aucune duplication nouvelle ».
`test:migrations:controle` → 8/8.

### 3.6 Risque résiduel : aucun mécanisme de rollback

**0 down migration** dans tout le dépôt, et **aucune des 5 migrations ne
documente de procédure de retour arrière**. Prisma ne gère pas les migrations
inverses ici : un retour arrière exigerait une **nouvelle migration avant**,
écrite et testée au moment du besoin. Pour `20261019140000` cela signifierait
recréer `rate_limit_counters_global` — c'est-à-dire **réouvrir la faille** que la
migration ferme. Ce point doit être connu avant toute application distante.

### 3.7 État distant

**Non vérifié.** `DATABASE_URL` et `TF_RLS_APP_URL` sont absentes de cet
environnement ; aucune connexion autorisée à une base distante. Aucune
migration n'a été appliquée, rejouée ni corrigée à distance.

---

## 4. Phase 3 — Blocage Prisma : diagnostic complet

### 4.1 Versions exactes dans le lockfile (v3)

| paquet | version |
|---|---|
| `prisma` | 6.19.3 |
| `@prisma/client` | 6.19.3 |
| `@prisma/engines` | 6.19.3 |
| `@prisma/fetch-engine` | 6.19.3 |
| `@prisma/adapter-pg` | 6.19.3 |
| `@prisma/engines-version` | `7.1.1-3.c2990dca591cba766e3b7ef5d9e8a84796e47ab7` |

Aucune divergence. La cible de plateforme détectée par
`@prisma/get-platform` est `debian-openssl-3.0.x`, **identique** à celle des URL
demandées : pas d'incohérence de plateforme.

### 4.2 Couche responsable — mesurée, pas déduite

| couche | `binaries.prisma.sh` | `registry.npmjs.org` | `api.github.com` |
|---|---|---|---|
| DNS | résout | résout | résout |
| TCP 443 | **ouvert** | ouvert | ouvert |
| certificat présenté | **aucun** | réel (Google Trust Services) | réémis par `E2B Proxy CA` |
| résultat | `SSL_ERROR_SYSCALL`, `ECONNRESET` | fonctionne | fonctionne |

Le handshake TLS est **coupé avant toute présentation de certificat**. Ce n'est
donc **pas** un problème de confiance : le magasin de certificats système
(`--cacert`, `NODE_EXTRA_CA_CERTS`) a été essayé et **n'y change rien**,
puisqu'il n'y a aucun certificat à valider.

**Conclusion** : ni réseau instable, ni proxy mal configuré, ni certificats, ni
plateforme, ni indisponibilité des artefacts. C'est une **politique de sortie
réseau** : l'hôte n'est pas sur la liste autorisée de cet environnement.

Rappel du mécanisme, lu dans le code : `@prisma/engines` exige deux binaires
natifs — `schema-engine` et `libquery-engine` — et `generate` comme `validate`
figurent dans la liste `ensureBinaries`. Le paquet npm `@prisma/engines` ne
contient **aucun** binaire, seulement le postinstall qui les télécharge.

### 4.3 Environnement de build autorisé

**La CI distante GitHub Actions est l'environnement autorisé.** Ses runners ont
une sortie réseau non filtrée. Le workflow y exécute, dans chaque job concerné :

```
[2] npm ci                -> postinstall de @prisma/engines : telecharge les binaires
[3] npm run db:generate   -> prisma generate
[5] npm run build         -> chaine complete (job verification)
```

`db:generate` précède `api:typecheck` [5], `verify:prisma-client` [17] et
`test:router-load` [18] dans `socle`, et précède l'auto-collecte des `test:*`
[8] dans `verification`. **L'ordre est vérifié dans le workflow, pas supposé.**

### 4.4 Résultats réels obtenus ici

| commande | sortie | résultat |
|---|---|---|
| `npx prisma validate` | **1** | `request to …/schema-engine.gz.sha256 failed` |
| `npx prisma generate` | **1** | `request to …/schema-engine.sha256 failed` |
| `node_modules/.prisma/client` | — | **absent** |
| `npm run api:typecheck` | **2** | 89 erreurs, **0** dans les fichiers du chantier |
| `npm run test:router-load` | **1** | 130/135, tous `@prisma/client … no exported member` |
| `npm run build` | **1** | s'arrête sur `db:generate` |

**Le build n'est pas validé.** `--no-engine`, `PRISMA_CLIENT_FORCE_WASM`,
`engineType = "client"` et l'adaptateur de migration n'ont **pas** été employés :
les deux derniers sont des changements d'architecture exigeant un audit, et les
utiliser pour obtenir un succès local produirait une validation fausse.

### 4.5 Chromium

`npx playwright install chromium` → **échec**, `cdn.playwright.dev` →
`ECONNRESET`. Même politique de sortie. Les 20 tests navigateur ne sont pas
exécutables ici ; en CI, l'étape [4] de `verification` et de `parcours` installe
Chromium.

### 4.6 Action minimale suivante

Pousser la branche pour que la CI distante exécute `npm ci` → `db:generate` →
`build`. Aucune autre action ne peut lever ce blocage depuis cet environnement.

---

## 5. Phase 4 — Objets SQL divergents

### 5.1 La référence a bougé : correction importante

Le rapport principal citait « 128 politiques et 114 fonctions, soit 242 objets ».
Ces chiffres provenaient de l'application des **49** migrations. Référence
régénérée le 19 octobre 2026 sur base vierge, avec les **51** migrations, via
`scripts/lire-objets-sql.sql` :

| | politiques | `SECURITY DEFINER` | total |
|---|---|---|---|
| référence à 49 migrations | 128 | 114 | 242 |
| **référence à 51 migrations** | **131** | **114** | **245** |

Le delta +3 s'explique entièrement par `20261019140000` :
`rate_limit_counters_global` supprimée (−1), quatre politiques par commande
créées (+4). Le compte `SECURITY DEFINER` ne bouge pas :
`tracefab_guard_rate_limit_counter` n'est **pas** `SECURITY DEFINER`, ce qui est
le comportement attendu pour une fonction de déclencheur.

### 5.2 Conséquence : l'écart « +2 / +1 » n'est plus utilisable

Le « 130 politiques / 115 fonctions » observé sur l'environnement audité est
**antérieur** à ce chantier et son **état de migration n'est pas connu**.
L'arithmétique antérieure comparait une référence à 49 migrations à une
observation d'état inconnu :

- si la cible est à 49 migrations → écart **+2** politiques ;
- si la cible est à 51 migrations → écart **−1** politique.

**Les deux inventaires doivent être régénérés à un état de migration connu et
concordant avant toute comparaison.** Aucun nom d'objet n'est avancé.

### 5.3 Lecture seule vérifiée

`scripts/lire-objets-sql.sql` : deux `SELECT` réunis par `UNION ALL`, **aucun
verbe d'écriture** hors commentaire (vérifié par grep et par
`test_comparaison_objets_sql.mjs`). La seule fonction appelée est
`pg_get_function_identity_arguments`, fonction du catalogue qui formate une
liste de paramètres, sans effet de bord. Le commentaire du fichier a été corrigé
: il annonçait « trois SELECT » et « aucune fonction appelée », deux
imprécisions.

### 5.4 Outil éprouvé sur la référence réelle

| cas | sortie | comportement |
|---|---|---|
| référence contre elle-même (245 objets) | **0** | inventaires identiques |
| référence 245 contre cible synthétique 248 | **1** | **nomme** les 3 objets ajoutés |
| entrée manquante | **2** | refus d'exécution |

Les trois objets de la cible synthétique étaient explicitement nommés
`synthetic_demo` / `fonction_synthetique_demo` : **aucune identité réelle n'a
été inventée**.

### 5.5 Procédure à exécuter par une personne autorisée

```
# 1. Reference : appliquer les 51 migrations a une base jetable, puis
psql "$BASE_JETABLE_LOCALE" -f scripts/lire-objets-sql.sql -At -o reference.txt

# 2. Cible : lire seulement, apres avoir NOMME et VERIFIE l hote
psql "$CIBLE_AUTORISEE" -f scripts/lire-objets-sql.sql -At -o cible.txt

# 3. Comparaison nominative
node scripts/comparer-objets-sql.mjs --reference reference.txt --cible cible.txt
```

Avant l'étape 2, **relever l'état de migration de la cible**
(`SELECT migration_name FROM _prisma_migrations ORDER BY started_at`) : sans
cette information, un écart de compte ne peut pas être interprété.

Aucun objet ne doit être supprimé avant classement. Un objet dont la
dangerosité n'est pas démontrée ne doit pas être supprimé du tout.

### 5.6 Ce qui reste à identifier

Les deux politiques et la fonction divergentes restent **sans nom, sans
propriétaire, sans définition, sans rôles bénéficiaires, sans expression
`USING`/`WITH CHECK`**. Aucun correctif minimal ni test de non-régression ne
peut être écrit avant leur identification.

---

## 6. Phase 6 — Identité d'exécution Production

### 6.1 Preuves disponibles

| fait | preuve | portée |
|---|---|---|
| une seule instanciation de client | `api/_lib/prisma.ts:28`, unique `new PrismaClient()` de `api/` | code |
| une seule variable de connexion | `env("DATABASE_URL")` | code |
| `TF_RLS_APP_URL` n'est pas lu par `api/` | 0 occurrence dans `api/` | code |
| la sonde discrimine un rôle soumis d'un rôle `BYPASSRLS` | `test:neon:sonde-identite` 30/30, mesuré sur PostgreSQL | **base jetable** |
| identité effective du runtime Production | **aucune** | — |

### 6.2 Ce que les tests locaux ne prouvent pas

Les suites s'exécutent sous un rôle `tracefab_app` créé localement,
`NOSUPERUSER NOBYPASSRLS`. Elles prouvent que **la RLS fonctionne quand le rôle
y est soumis**. Elles ne prouvent **pas** que le runtime Production utilise un
tel rôle. Un `DATABASE_URL` pointant vers `neondb_owner` ou tout rôle doté de
`BYPASSRLS` contournerait **toutes** les politiques mesurées ici, sans qu'aucun
test local ne le signale.

**`neondb_owner` ou tout rôle `BYPASSRLS` ne constitue pas une preuve de
protection** — c'est l'inverse.

### 6.3 Méthode de vérification la moins intrusive

La sonde est déjà en place, en lecture seule, sans effet de bord, sur une route
interne **déjà** authentifiée (`workerSecretConfigured` puis `workerAuthorized`),
en opt-in :

```
GET /api/_routes/internal/p2-readiness?identity=1
Authorization: Bearer <jeton ouvrier deja configure>
```

Réponse : `currentUser`, `sessionUser`, `database`, `bypassesRls`, `isSuperuser`,
`measured`, `detail`. Ni URL de connexion, ni hôte, ni mot de passe ; erreurs
caviardées par `redact()`.

**Critère de conclusion** : `measured = true`, `currentUser` = rôle applicatif
attendu, `bypassesRls = false`, `isSuperuser = false`. Toute autre combinaison
interdit la bascule.

Aucun jeton n'est demandé ici. Aucun rôle, privilège, déclencheur, fonction,
politique ni paramètre Production n'a été modifié.

---

## 7. Conditions non remplies

| condition | état | action minimale |
|---|---|---|
| **1. CI distante verte** | **non exécutée** | autorisation de pousser `arena/ba652133-tracefab` (7 commits, fast-forward) |
| **2. Build complet validé** | **non validé** | idem — la CI est le seul environnement joignant `binaries.prisma.sh` |
| identité du runtime Production | non mesurée | appel de la sonde sur le runtime, par une personne autorisée |
| objets SQL divergents | non identifiés | procédure §5.5 sur cible autorisée |

### Opérations distantes réalisées

**Aucune.** Aucun push, aucune fusion, aucun déploiement, aucune modification de
`main`, de Vercel, de Preview, de Production ou d'une base distante. Les seules
bases touchées sont des bases jetables locales sur `127.0.0.1:55451`, créées et
détruites par les suites.

### Actions restantes pour une clôture réelle

1. **Autorisation de push**, puis exécution et lecture des 4 jobs requis
   (`Socle`, `Verification`, `Parcours`, `Base`) sur le commit poussé.
2. Correction sur la branche de tout échec révélé par la CI.
3. Mesure de l'identité du runtime sur un environnement autorisé.
4. Comparaison nominative des objets SQL sur cible autorisée, après relevé de
   l'état de migration de la cible.
5. Décision explicite sur le risque « aucun mécanisme de rollback » avant toute
   application des migrations à une base distante.

**Le chantier n'est pas terminé.** Les deux conditions de fusion ne sont
appuyées par aucun résultat vérifiable, et deux points de sécurité Production
restent ouverts.

---

## 8. Passe du 19 octobre (suite) — défaut majeur trouvé et corrigé

Cette passe avait trois objectifs : débloquer Prisma, valider le build, établir la
sécurité distante. Elle a surtout produit autre chose : **la découverte d'un
défaut que le chantier avait introduit et qu'aucun contrôle ne voyait.**

### 8.1 Le défaut

`scripts/lib/tracefab_app_role.mjs` restreignait le rôle applicatif à **4 tables**
d'écriture directe. Sa justification était écrite noir sur blanc dans la
migration `20261019120000`, ligne 33 : « intersection des `INSERT INTO |
UPDATE | DELETE FROM` présents dans `api/` avec les 50 noms de tables ».

Ce filtre ne retient que le **SQL écrit en clair**. Il laisse dehors toutes les
écritures faites par méthode de modèle Prisma, qui sont la forme dominante du
dépôt (`tx.user.upsert(...)`, `.data_points.create(...)`,
`.supply_chain_links.deleteMany(...)`).

**Mesure corrigée : 21 tables sont écrites directement par `api/`, pas 4.**
17 manquaient, dont `users` (5 sites : `api/_lib/auth.ts:37` et
`api/_routes/webhooks/clerk.ts:47,62,75,155`).

`withTracefabWorkerContext` ne change pas le rôle : il pose un GUC
transactionnel (`set_config('tracefab.worker_context', 'true', true)`). Un GUC
n'accorde aucun privilège relationnel. Dès que le runtime se connecte sous
`tracefab_app`, ces 17 chemins reçoivent `42501` — **à commencer par le
provisionnement Clerk, donc plus aucune session ne peut être créée.**

### 8.2 Pourquoi aucun contrôle ne l'a vu

Le contrôle de privilèges (`scripts/test_privileges_role_app.mjs`) **recopiait**
la liste au lieu de la contester. `test_isolation_lignes_reelles.mjs` la
recopiait aussi. Les deux disaient « 4 tables », donc ils validaient la liste au
lieu de la vérifier. C'est la cause racine, et elle est structurelle.

### 8.3 Preuve que le défaut était réel

Mesurée sur base jetable, à 51 migrations :

| contrôle | à 49 migrations | à 51 (défaut) | à 52 (corrigé) |
|---|---|---|---|
| `test:neon:bypass-control` | sortie 0 | **sortie 1** — `42501 permission denied for table tracefab_products` | sortie 0 |
| `test:neon:app-readiness` | sortie 1 | **sortie 1** — `42501 permission denied for table users` | **sortie 0** |
| `test:neon:cross-tenant` | sortie 1 | sortie 1 | sortie 0 |

`test:neon:bypass-control` fait partie du job CI requis
« Base — isolation RLS executee ». Le défaut l'aurait fait passer au rouge.

### 8.4 Correction appliquée

1. **`20261019160000_retablir_dml_tables_ecrites_directement`** — ré-accorde
   `INSERT, UPDATE, DELETE` sur les 17 tables manquantes. Nouvelle migration, pas
   une réécriture : valable que la 51<sup>e</sup> ait été appliquée quelque part
   ou non. Aucune table `dpp_*` n'est concernée. Idempotente. Le durcissement
   reste réel : 36 tables avaient du DML avant le chantier, **21** en ont après,
   29 restent en lecture seule.
2. **Source unique.** `TABLES_ECRITURE_DIRECTE` est désormais exportée par la
   lib ; les deux contrôles l'**importent** au lieu de la recopier.
3. **Garde manquante.** `scripts/test_tables_ecriture_directe.mjs` re-dérive la
   liste depuis `api/` (méthodes Prisma **et** SQL) et échoue si le code écrit
   une table non accordée, ou si un privilège est accordé sans chemin
   applicatif. Statique, donc exécutable dans le job `verification` qui n'a pas
   de service PostgreSQL. `npm run test:tables-ecriture-directe` → 5/5, sortie 0.
   Contrôle négatif `TABLES_ECRITURE_CONTROLE_NEGATIF=table_fantome` → 2 échecs,
   sortie 1 : la garde peut rougir.

### 8.5 Un test dont l'attente reposait sur l'octroi global supprimé

`test_neon_cross_tenant.mjs` attendait « `DELETE suppliers` chez B : 0 ligne
touchée ». Cela ne tenait que parce que la lib accordait autrefois
`GRANT … ON ALL TABLES` : la tentative était autorisée au niveau privilège et
seul le filtrage RLS l'arrêtait. Ce n'est plus vrai table par table.

Le test dérive désormais son attente de l'ACL réelle, **et distingue le
mécanisme par le message, pas par le SQLSTATE** : `42501` recouvre à la fois
« permission denied for table » (frontière de privilège) et « new row violates
row-level security policy » (RLS `WITH CHECK`). Les confondre ferait passer une
absence de privilège pour du filtrage RLS. Résultat : sortie 0 sur la base
corrigée **et** sur la base à 49 migrations, chaque mécanisme nommé
correctement.

### 8.6 État après correction

**52 migrations appliquées séquentiellement sur base vierge, 0 échec.** État
final : 50 tables · 165 fonctions · 114 `SECURITY DEFINER` dont 0 sans
`search_path` fixé · 131 politiques · RLS active **et** forcée 50/50 ·
47 déclencheurs · **21 tables en écriture directe, 29 en lecture seule**.
Rejeu : aucune duplication (131→131, 165→165, 47→47).

Suites base, toutes sortie 0 : `privileges` · `rls` · `write-policies` ·
`app-readiness` · `bypass-control` · `cross-tenant` · `active-tenant` ·
`document-lifecycle` · `privileges-role-app` **33/33** · `isolation-lignes`
**19/19** · `compteurs-debit` **39/39** · `sonde-identite` **30/30** ·
`dpp-lifecycle` · `deploiement-publication` · garde propriétaire SQL **PASS**.

Balayage des entrées auto-collectées par le job `verification` (filtre extrait
du workflow par appariement de parenthèses, puis exécuté) : **101 entrées,
75 vertes, 26 rouges, 0 défaut de code** — 20 navigateur absent, 6 client
Prisma absent.

### 8.7 Ce que la CI distante a déjà prouvé

Lecture seule sur l'historique GitHub : la CI **a tourné sur `bb1213c`**, le
HEAD distant, et les 4 contrôles requis y sont `success`. Détail des étapes du
run `39209559163` : `Generer le client Prisma` ✓, `Installer Chromium pour
Playwright` ✓, `Compilation complete` ✓, `Suite complete des scripts test:*` ✓,
`Chargement des modules de route` ✓.

**L'environnement de build autorisé sait donc télécharger les moteurs Prisma,
installer Chromium, compiler et tester.** Ce n'est plus une hypothèse. Le
blocage est strictement la sortie réseau de cet espace de travail.

Le seul échec sur `bb1213c` est `Sonder les routes reelles depuis un runner
GitHub` (workflow « Sondage HTTP de la Preview »), qui **ne fait pas partie des
contrôles requis** — vérifié dans le ruleset `25012843` : les 4 contextes requis
sont exactement les 4 jobs de `ci.yml`.

Mais `ci.yml` a **+71 lignes** entre `bb1213c` et ce HEAD : les 4 nouvelles
étapes de `base-de-donnees` (`privileges-role-app`, `isolation-lignes`,
`compteurs-debit`, `sonde-identite`) **n'ont jamais tourné en CI**. La CI verte
de `bb1213c` valide l'état précédent, pas celui-ci.

### 8.8 Recherche d'un canal officiel pour les moteurs Prisma

Épuisement des canaux joignables depuis cet espace de travail :

| canal | résultat |
|---|---|
| `binaries.prisma.sh` | TLS coupé avant tout certificat — `SSL_ERROR_SYSCALL` |
| `cdn.playwright.dev` | idem |
| `@prisma/engines` 6.19.3 | 95 324 octets, **10 fichiers**, `optionalDependencies: {}`, `postinstall` qui télécharge |
| `prisma` 6.19.3 | 52 Mo, **WASM uniquement** (`schema_engine_bg.wasm`, `query_engine_bg.*.wasm`) — aucun binaire natif |
| `@prisma/client` 6.19.3 | 76,9 Mo, **WASM uniquement** (`query_engine_bg.postgresql.wasm-base64.js`) |
| releases GitHub `prisma/prisma-engines` | **aucune release** |
| recherche npm | seulement des forks tiers (`@vertexa/*`, `@ohos-ports/*`, `@3xpo/*`) — sources non vérifiées, **exclues** |

**Aucun canal officiel joignable ne porte les binaires natifs.** Variables
officielles relevées dans `@prisma/fetch-engine` : `PRISMA_ENGINES_MIRROR`,
`PRISMA_BINARIES_MIRROR`, `PRISMA_QUERY_ENGINE_LIBRARY`,
`PRISMA_QUERY_ENGINE_BINARY`, `PRISMA_SCHEMA_ENGINE_BINARY`,
`PRISMA_MIGRATION_ENGINE_BINARY` — toutes exigent un binaire ou un miroir que
cet espace de travail ne peut pas fournir légitimement.

Erreur exacte : `request to
https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz.sha256
failed, reason: Client network socket disconnected before secure TLS connection
was established`. `prisma validate` et `prisma generate` sortent tous deux 1 ;
`node_modules/.prisma/client` reste absent.

### 8.9 Les 89 erreurs de typecheck, qualifiées

`npm run api:typecheck` → sortie 2, **89 erreurs** : 85 × `TS2305` et 4 ×
`TS2339`. **Toutes** citent `@prisma/client`. Mécanisme vérifié à la source :
`node_modules/@prisma/client/default.d.ts` tient sur une ligne,
`export * from '.prisma/client/default'`, et `node_modules/.prisma/client`
n'existe pas. Les 4 `TS2339` sont en aval (`audit-export.ts:52`, types
effondrés en `unknown`). **0 erreur dans les fichiers du chantier.** Ce ne sont
pas des défauts de code : c'est l'absence du client généré.

### 8.10 Accès distant

Aucune `DATABASE_URL`, aucune `TF_RLS_APP_URL`, aucun `.env` dans
l'environnement (seul `.env.example`, et `.gitignore` couvre `.env`).
**Aucun accès distant n'existe ici.** Les phases d'identité du runtime et
d'objets SQL divergents restent bloquées sur cet accès, et aucune chaîne de
connexion n'a été demandée.

## 9. Passe du 19 octobre (étapes 2 et 3) — trois défauts trouvés

Passe exécutée sans push, sans merge, sans déploiement, sans accès distant.
Base de travail : PostgreSQL 18.4 jetable sur `127.0.0.1:55451`, bases créées
puis détruites. Aucun secret affiché, demandé ni enregistré.

### 9.1 Le lecteur de disponibilité classait 25 tables voulues comme inexpliquées

`scripts/lire-disponibilite-role-app.mjs` — l'outil en lecture seule qu'une
personne autorisée exécute sur la cible distante — classait l'absence
d'écriture à partir de quatre noms de tables écrits en dur. Depuis que la
politique est passée de 4 à 21 tables (migration `20261019160000`), il
présentait **25 tables volontairement en lecture seule comme « autre(s) »**,
c'est-à-dire inexpliquées. Un audit distant aurait démarré sur 25 signaux à
classer alors qu'il n'y en avait aucun.

Le script compare désormais l'état **mesuré** à `TABLES_ECRITURE_DIRECTE`, la
liste unique déjà utilisée par le provisioning et par
`test:tables-ecriture-directe`, et nomme les deux sens d'écart : DML accordé
hors liste (sur-privilège) et table déclarée sans DML (sous-privilège, ou
cible en retard de migrations). Un écart est signalé sans bloquer : sur une
cible qui n'a pas reçu les migrations, il est légitime.

Mesuré sur base jetable : `29 attendue(s) en lecture seule, 0 inattendue(s)`,
`ecriture directe mesuree sur 21 table(s) — la liste declaree en compte 21`.
Avant le correctif : `4 attendue(s) append-only, 25 autre(s)`.

Deux contrôles négatifs exécutés puis restaurés : accorder du DML sur
`certifications` (hors liste) fait nommer l'écart ; en retirer sur `documents`
(dans la liste) le fait nommer aussi. L'état initial est restauré et le retour
au nominal est mesuré, pas supposé.

Non-régression : `test:disponibilite-role-app` (statique, 20 assertions) et
`test:neon:ecarts-privileges` (comportemental sur base jetable, 13 assertions,
les deux sens provoqués puis restaurés). Le test statique est éprouvé dans les
deux sens : un `GRANT` ou un `INSERT INTO` injecté dans le lecteur le fait
passer à 19/20.

### 9.2 Six contrôles de sécurité n'étaient exécutés par aucun job CI

Vérifié en extrayant les lignes `run:` actives de `ci.yml` et en les comparant
aux entrées de `package.json` : `test:chantiers`, `test:tables-ecriture-directe`,
`test:migrations:controle`, `test:migrations:horodatages`, `test:tls:validation`
et `test:objets-sql:comparaison` existaient, passaient au vert, et **n'étaient
appelés par aucun workflow**.

La conséquence est directe : le correctif central de la passe précédente — la
liste des tables en écriture directe passée de 4 à 21 — n'était protégé par
aucune étape de CI. Une route ajoutant un `INSERT` sur une table hors liste, ou
une divergence entre la liste et le provisioning, serait passée au vert.

Les six sont statiques (ni base, ni navigateur, ni client Prisma) et sont
ajoutés au job `socle`. `test:neon:ecarts-privileges` est ajouté au job
`base-de-donnees`, après `test:neon:privileges-role-app`.

### 9.3 Le 503 du limiteur était bien le client Prisma absent, pas un défaut

`test:neon:ecriture-non-authentifiee` répondait `503 rate_limiter_unavailable`
au lieu du `401` attendu. Cause établie par mesure et non par lecture :
`touchDatabase` renvoie `null` parce que `import('./api/_lib/prisma.js')` échoue
sur `The requested module '@prisma/client' does not provide an export named
'PrismaClient'`. Vérification croisée en base : `tracefab_app` **peut** écrire
dans `rate_limit_counters` (`INSERT` et `UPDATE` acceptés), et la suppression
d'une ligne non expirée reste bloquée (`0 ligne`). La politique
`rate_limit_counters_purge_expiree` fonctionne ; le blocage est Prisma.

### 9.4 Ce que cette passe ne démontre pas

`prisma validate`, `prisma generate`, `api:typecheck`, `test:router-load`, le
build et les tests Chromium restent bloqués par l'environnement, mesuré à
nouveau sur ce commit : `binaries.prisma.sh` ferme le socket avant toute
présentation de certificat (`CONNECTED` puis `no peer certificate available`,
`SSL_ERROR_SYSCALL` côté curl, `ECONNRESET` côté Node), pendant que
`registry.npmjs.org` répond `200` avec un certificat valide. Aucune validation
de certificat n'a été désactivée. Le tarball npm officiel `@prisma/engines`
6.19.3 fait 22 666 octets et ne contient **aucun binaire** : npm n'est pas une
source de moteurs.

Aucune exécution de CI n'existe sur ce commit : le push n'est pas autorisé.
L'identité du runtime distant, l'état RLS distant et les objets SQL divergents
restent **non vérifiés** — aucun accès distant n'existe dans cet environnement.
Les mesures de cette passe portent sur PostgreSQL local et ne prouvent rien
d'une base distante.
