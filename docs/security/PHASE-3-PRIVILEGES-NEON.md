# Phase 3 — Privilèges PostgreSQL et isolation multi-locataire

**Date :** 2026-10-12
**Branche de travail :** `arena/879cd8db-tracefab`
**Autorisation :** niveau B. Tout a été mesuré sur une base **jetable locale**.
Aucune base de production n'a été contactée, lue ni modifiée.

> **Avertissement de périmètre.** Ce document ne décrit pas l'état de la
> production. Il décrit (a) des mécanismes du moteur PostgreSQL, mesurés par
> exécution sur une base vierge, et (b) l'effet de ces mécanismes sur la chaîne
> de migrations du dépôt, rejouée à l'identique. L'état réel de Neon reste
> **inconnu** : l'accès n'est pas disponible dans cet environnement.

---

## 1. Comment une base réelle a pu être utilisée sans accès à Neon

Aucune base de données n'était disponible dans l'environnement d'exécution
(ni `psql`, ni `initdb`, ni `docker`). Le registre npm, lui, est accessible : un
PostgreSQL 18.4 complet y est distribué sous forme de paquet
(`@embedded-postgres/linux-x64`), binaire inclus.

Une base jetable a donc été montée localement, les **35 migrations** du dépôt
lui ont été appliquées, puis le rôle `tracefab_app` et deux locataires ont été
créés par le script du dépôt (`scripts/seed_rls_fixture.mjs`).

Ce montage est une **réplique de la chaîne de migrations**, pas de la
production : même SQL, mêmes rôles, même ordre. Il établit ce que les
migrations font ; il n'établit pas ce que Neon contient.

Commande reproductible par le propriétaire :

```bash
mkdir -p /tmp/embpg && cd /tmp/embpg
npm install embedded-postgres@18.4.0-beta.17
# initdb --encoding=UTF8 --locale=C.UTF-8, port 55432, base tracefab_test
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/tracefab_test" \
  node scripts/seed_rls_fixture.mjs
```

## 2. Ce que la RLS fait réellement — prouvé par différence, pas par inventaire

`scripts/test_rls_isolation.mjs` a été exécuté pour la première fois dans des
conditions où il **mesure** quelque chose : connecté avec `tracefab_app`, qui ne
porte pas `BYPASSRLS`.

```
ok    role de test « tracefab_app », BYPASSRLS=false
ok    47 tables inventoriees, toutes les tables de locataire portent la RLS
ok    47 tables interrogees, aucune erreur de politique
ok    sans contexte arme, aucune table de locataire ne laisse voir une ligne
ok    tables de reference lisibles sans contexte (routes publiques preservees)
      locataire 1 : beta@rls.fixture.test  — 6 ligne(s) visibles
      locataire 2 : alpha@rls.fixture.test — 6 ligne(s) visibles
ok    les deux locataires voient des lignes differentes sur 5 table(s) :
      organization_memberships · organizations · suppliers · tracefab_products · users
      lignes visibles des deux cotes : 0
ok    en contexte public, exactement les 2 produit(s) publie(s) sont lisibles
ok    un brouillon interroge par son id reste invisible (2 brouillon(s))
ok    organizations reste totalement fermee meme en contexte public
ok    le contexte public ne survit pas a la transaction (connexion poolee sure)
```

Ce que cela établit : **les politiques filtrent**. Deux locataires voient des
ensembles différents, l'intersection est vide, et le contexte public ne laisse
passer que les produits publiés.

Ce que cela n'établit pas : que la production se connecte avec un rôle soumis à
la RLS. Elle se connecte avec `neondb_owner`, qui porte `BYPASSRLS` — pour ce
rôle, les politiques ne sont **jamais** évaluées. C'est le constat de
`p0-neon-reconciliation.md`, et il n'est pas levé.

## 3. Le défaut de fond : `ALTER DEFAULT PRIVILEGES` ne fait pas ce que la migration croyait

### 3.1 Le constat

`prisma/migrations/20261007100000_security_definer_execute_hardening` retire
`EXECUTE` à `PUBLIC` sur les fonctions existantes, puis pose, pour les
suivantes :

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

**Cette instruction ne fait rien.** Mesuré sur PostgreSQL 18.4, base vierge :

| Instruction | `pg_default_acl` après | Fonction créée ensuite |
|---|---|---|
| *(aucune)* | vide | `proacl = NULL` → **PUBLIC peut exécuter** |
| `IN SCHEMA public REVOKE … FROM PUBLIC` | **vide** | `proacl = NULL` → **PUBLIC peut exécuter** |
| `IN SCHEMA public GRANT … TO <role>` puis `REVOKE … FROM PUBLIC` | `{<role>=X/…}` | **PUBLIC peut exécuter** |
| `FOR ROLE <role> REVOKE … FROM PUBLIC` *(forme globale, sans `IN SCHEMA`)* | `{<role>=X/…}` | `proacl = {<role>=X/…}` → **PUBLIC ne peut plus** |

La raison : les défauts par schéma ne font qu'**ajouter** au défaut global, et
l'`EXECUTE` de `PUBLIC` sur les fonctions est un **défaut intégré du moteur**.
`REVOKE` ne retire que ce qui a été accordé ; un droit intégré n'a jamais été
accordé par cette instruction, donc il ne peut pas être retiré. La forme
globale fonctionne parce qu'elle écrit une entrée `pg_default_acl` non vide,
qui se substitue alors au défaut.

Ce comportement est documenté de longue date par la communauté PostgreSQL
(*BUG #8685*, « alter default privileges cannot revoke default execute
privilege on functions ») et confirmé par la documentation : `REVOKE` ne
retire qu'un `GRANT` antérieur.

### 3.2 La conséquence dans le dépôt

Le durcissement étant sans effet, **toute fonction créée après lui est née
exécutable par `PUBLIC`**. Sur la réplique de la chaîne de migrations :

```
107 fonctions SECURITY DEFINER · 5 executables par PUBLIC

  tracefab_material_is_public(uuid)          — proprietaire postgres
  tracefab_material_visible_via_product(uuid) — proprietaire postgres
  tracefab_product_is_public(uuid)           — proprietaire postgres
  tracefab_public_brand(uuid)                — proprietaire postgres
  tracefab_supplier_site_is_public(uuid)     — proprietaire postgres
```

Les quatre premières viennent de `20261009180000_public_read_context`. La
cinquième vient de `20261009120000_fix_materials_policy_recursion`, qui lui
accorde **en plus explicitement** `GRANT EXECUTE … TO PUBLIC` (ligne 75).

Par ailleurs, `docs/operations/p0-neon-reconciliation.md` affirme qu'« aucune
fonction n'est exécutable par PUBLIC ». Cette affirmation était vraie le jour
où elle a été écrite, à propos des 67 fonctions d'alors ; elle est contredite
par les 5 fonctions créées depuis.

### 3.3 Pourquoi ce n'est pas « 5 fonctions = catastrophe »

Toutes sont `SECURITY DEFINER` : elles s'exécutent avec les droits de leur
propriétaire. L'exposition réelle dépend de ce que chacune fait et vérifie, et
cette analyse n'a pas été faite ici. Ce qui est établi, c'est que le droit est
**plus large que nécessaire**, et que la documentation affirme le contraire.
C'est un écart entre le droit accordé et le droit voulu — pas une faille
démontrée.

## 4. La migration corrective

`prisma/migrations/20261012120000_close_public_execute_gap/migration.sql`

Trois opérations, aucune sur les données ni sur les politiques :

1. **fermer le défaut pour les fonctions à venir** — forme globale, sans
   `IN SCHEMA`, pour le rôle qui exécute la migration ;
2. **retirer `EXECUTE` à `PUBLIC`** sur les six fonctions concernées, chacune
   conditionnée à `to_regprocedure(...) IS NOT NULL` pour rester rejouable sur
   une base dont la chaîne diffère ;
3. **rendre `EXECUTE` au rôle applicatif** — convention identique à
   `20261009180000` (`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname =
   'tracefab_app')`), parce que le rôle est une donnée d'infrastructure, absent
   d'une base vierge.

Le **rollback est écrit dans la migration** : un droit retiré sans sa réciproque
documentée est un droit qu'on ne saura pas rendre.

### 4.1 Le retrait est-il sûr ? Preuve par la nécessité

Un retrait de privilège n'est légitime que si l'usage subsiste. Le rôle
applicatif exécute `tracefab_material_visible_via_product` par la politique
`materials_select_authorized`, qui est déclarée `TO PUBLIC` — cela définit les
rôles auxquels la politique **s'applique**, pas qui doit **exécuter** la
fonction. Le droit a été retiré à `tracefab_app` pour mesurer :

```
droit retire a tracefab_app
lecture refusee -> permission denied for function tracefab_material_visible_via_product
droit rendu a tracefab_app
```

Puis, avec le `GRANT` de la migration corrective :

```
$ node scripts/test_rls_isolation.mjs
ok    47 tables interrogees, aucune erreur de politique
...
Isolation prouvee par execution, pas par inventaire.
```

Le `GRANT` est donc **nécessaire** (sans lui, la lecture de `materials` casse)
et **suffisant** (avec lui, l'isolation complète passe). C'est le contraire
d'un retrait aveugle.

### 4.2 Le test de non-régression

`npm run test:neon:privileges` — quatre invariants mesurés, pas lus :

| | Invariant |
|---|---|
| A | aucune fonction `SECURITY DEFINER` n'est exécutable par `PUBLIC` |
| B | le rôle applicatif peut exécuter **toutes** les fonctions appelées par les politiques (extraites de `pg_policy`) |
| C | `tracefab_material_visible_via_product` est `SECURITY DEFINER`, fermée à `PUBLIC`, ouverte à `tracefab_app` |
| D | une fonction **créée maintenant** n'est pas exécutable par `PUBLIC` — sonde créée dans une transaction annulée |

Avant la migration corrective, le test échoue sur A, C et D. Après, il passe
sur les quatre :

```
ok    A. aucune des 107 fonctions SECURITY DEFINER n est executable par PUBLIC
ok    B. tracefab_app peut executer les 12 fonction(s) appelee(s) par les politiques
ok    C. … SECURITY DEFINER, fermee a PUBLIC, ouverte a tracefab_app
ok    D. une fonction creee par postgres n est plus executable par PUBLIC
           (acl {postgres=X/postgres,tracefab_app=X/postgres})
ok    D. la fonction temoin a bien ete annulee par ROLLBACK
ok    E. le role applicatif tracefab_app est bien soumis a la RLS (BYPASSRLS=false)
```

L'invariant D est celui qui manquait au durcissement précédent : il ne lit pas
une instruction, il **crée une fonction et mesure**.

## 5. Audit en lecture seule — `scripts/audit_neon_readonly.mjs`

Outil destiné à être exécuté par le propriétaire contre Neon, quand il le
décidera. Trois garanties, chacune vérifiable :

1. **liste blanche de requêtes** — vérifiée au démarrage : chaque requête doit
   commencer par `SELECT`, `WITH`, `SHOW` ou `TABLE`. Une requête écrivante ne
   peut pas être ajoutée sans être vue.
2. **lecture seule appliquée par le serveur** —
   `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`. La garantie vient de
   PostgreSQL, pas d'une promesse du script. Le test le prouve en **tentant**
   une écriture : elle doit être refusée avec « read-only transaction ».
3. **non-divulgation** — le rapport est relu avant affichage. La chaîne de
   connexion, le schéma d'URL, `sslmode=` font échouer le script plutôt que
   d'être imprimés ; l'hôte et le mot de passe sont refusés quand ils ont la
   forme d'un identifiant réel (un mot de passe court et un nom de rôle local
   ne sont pas confondus avec un secret — un contrôle qui crie à tort finit par
   être désactivé).

Ce qu'il rapporte : rôle effectif, `rolbypassrls` de chaque rôle, RLS activée
et **forcée** par table, tables sans RLS, tables avec RLS mais sans politique,
fonctions `SECURITY DEFINER` exécutables par `PUBLIC`, entrées
`pg_default_acl`, migrations appliquées, propriétaires des tables.

Il avertit explicitement si le rôle effectif est `neondb_owner` : dans ce cas
tout constat sur la RLS mesure l'audit, pas l'application.

## 6. Ce qui reste inconnu, et ce qu'il faut pour le lever

| Question | État | Ce qu'il faut |
|---|---|---|
| Les 35 migrations sont-elles appliquées en production ? | **inconnu** | `audit_neon_readonly.mjs`, ou `prisma migrate status` |
| `neondb_owner` porte-t-il toujours `BYPASSRLS` ? | **inconnu** | audit — lecture de `pg_roles` |
| Les 5 fonctions sont-elles exécutables par `PUBLIC` en production ? | **inconnu** | audit — `has_function_privilege` |
| La production a-t-elle une entrée `pg_default_acl` pour les fonctions ? | **inconnu** | audit — lecture de `pg_default_acl` |
| Combien de tables/politiques en production ? | **inconnu** | audit |
| L'application se connecte-t-elle sous `tracefab_app` ? | **inconnu** | variable d'environnement Vercel (console) |

La migration corrective **ne doit pas être appliquée en production** avant que
ces points soient connus : appliquer un retrait de privilège sur une base dont
l'état réel n'est pas constaté, c'est risquer de casser une lecture légitime
sans le savoir. La séquence est : **audit → constat → décision → autorisation →
application → preuve datée**.

## 7. Limite assumée du montage local

Le PostgreSQL local est **18.4** ; la production Neon peut être en 15, 16 ou 17.
Le comportement de `ALTER DEFAULT PRIVILEGES` décrit au §3 est stable sur toutes
ces versions (il est signalé depuis la 9.1 et documenté), mais il n'a été
**mesuré** ici que sur 18.4. L'audit en lecture seule le constatera sur la
version réelle de la base, ce qui lève la réserve.

## 8. Matrice mesurée des privilèges par défaut (2026-10-12)

La question de la mission — « déterminer précisément les privilèges par défaut
applicables aux fonctions créées par les rôles concernés, et vérifier la portée
globale et celle des schémas sans supposer que l'une remplace l'autre » — a été
tranchée par mesure, sur une base jetable, avec dix combinaisons. Pour chacune,
deux relevés indépendants : la règle écrite (`pg_default_acl`) **et** le droit
réel de la fonction créée après elle (`has_function_privilege`).

| Cas mesuré | Règle écrite dans `pg_default_acl` | `PUBLIC` peut exécuter |
|---|---|---|
| Aucune règle (témoin) | aucune | **OUI** (défaut implicite) |
| `FOR ROLE r REVOKE EXECUTE … FROM PUBLIC` (globale) | `(toutes les schémas) → {r=X/r}` | non |
| `FOR ROLE r IN SCHEMA public REVOKE …` (même schéma) | **aucune** | **OUI** |
| `FOR ROLE r IN SCHEMA public REVOKE …` (création dans un autre schéma) | **aucune** | **OUI** |
| globale puis `IN SCHEMA` | `(toutes) → {r=X/r}` | non |
| `IN SCHEMA` puis globale | `(toutes) → {r=X/r}` | non |
| `GRANT EXECUTE … TO PUBLIC` puis `REVOKE` (globale) | `(toutes) → {r=X/r}` | non |
| `IN SCHEMA` : `GRANT` puis `REVOKE` | **aucune** | **OUI** |
| globale `REVOKE` puis `IN SCHEMA … GRANT EXECUTE TO PUBLIC` | `(toutes) → {r=X/r}` **et** `public → {=X/r}` | **OUI** (porte rouverte) |
| règle écrite `FOR ROLE autre` que le créateur | aucune pour le créateur | **OUI** |

Trois enseignements qui changent le correctif :

1. **Seule la forme globale ferme le défaut.** La forme `IN SCHEMA` n'écrit
   aucune règle quand il n'y a rien à retirer : `REVOKE` ne retire que ce qui a
   été accordé, et le défaut intégré pour les fonctions n'est pas une
   attribution stockée. Le durcissement `20261007100000` a donc échoué pour
   cette raison exacte, et non par erreur de portée.
2. **La porte peut se rouvrir silencieusement.** Un
   `ALTER DEFAULT PRIVILEGES … IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO
   PUBLIC` ajoute une règle qui, fusionnée avec la règle globale, redonne le
   défaut intégré — et `proacl` redevient **NULL**, c'est-à-dire
   indistinguable d'un objet jamais touché. Une vérification qui testerait
   `proacl IS NULL` conclurait « défaut implicite » et se tromperait sur les
   deux cas à la fois.
3. **La seule mesure qui tranche est `has_function_privilege('public', oid,
   'EXECUTE')`**, jamais la lecture d'une colonne. C'est ce que font
   `test_neon_privileges.mjs` (§A), l'audit en lecture seule, et le contrôle
   négatif §G du même test, qui rouvre la porte exprès dans une transaction
   annulée et exige que le détecteur la voie.

Corollaire mesuré au passage : sur PostgreSQL 15+, un rôle non propriétaire ne
peut **pas** créer de fonction dans `public` (le `CREATE` sur le schéma n'est
plus accordé à `PUBLIC`) — la sonde s'est fait refuser avec `42501` avant
d'obtenir ce droit explicitement. Le créateur est donc, en pratique, le
propriétaire de la base, et c'est lui que la règle globale doit viser.

## 9. Plan d'application et de retour arrière (préparé, non appliqué)

Aucune de ces étapes n'a été exécutée : elles exigent une autorisation
explicite. Elles sont écrites pour être suivies telles quelles.

**Avant tout** — l'audit en lecture seule, avec la cible déclarée à l'avance :

```bash
# chaîne en lecture seule, fournie par un mécanisme sécurisé (jamais dans un chat)
DATABASE_URL=... node scripts/audit_neon_readonly.mjs --expect-database=<nom exact de la base>
```

Relevé à consigner : rôle de connexion, `rolsuper`/`rolbypassrls` du rôle
applicatif, nombre de tables et de politiques, `pg_default_acl`, et pour
chacune des cinq fonctions `has_function_privilege('public', …, 'EXECUTE')`.
Le script sort en 3 si la base jointe n'est pas celle déclarée, et en 2 sans
cible : il n'existe aucun repli silencieux.

**Décision** — trois cas, trois conduites :

- `neondb_owner` (ou tout rôle `BYPASSRLS`) porte la connexion applicative :
  la migration de privilèges **ne suffit pas** ; la RLS n'est pas évaluée pour
  ce rôle. La remédiation est un changement de rôle de connexion côté Vercel,
  avec son propre plan (§5 de ce document).
- Les cinq fonctions sont déjà fermées à `PUBLIC` : la migration est un
  **no-op** vérifié ; ne pas l'appliquer pour « faire quelque chose ».
- Les cinq fonctions sont ouvertes à `PUBLIC` (l'état attendu d'après le code) :
  appliquer la migration.

**Application** — par la voie du dépôt, jamais à la main :

```bash
npx prisma migrate status      # doit lister 20261012120000 comme non appliquée
npx prisma migrate deploy      # applique, dans l'ordre, sur la base ciblée
```

La migration se vérifie elle-même : si une fonction créée à la fin n'est pas
protégée de `PUBLIC`, elle **échoue** (`insufficient_privilege`) et n'est donc
pas enregistrée comme appliquée. Empreinte du fichier appliqué, à consigner
au rapport :

```
00c11a307ca0ae0a94a1a08e7910369a65112d7931064282afd37d317f96e7f2  migration.sql
```

**Après application** — deux contrôles, dont un sur la base réelle :

```bash
npm run test:neon:privileges   # A à G ; G rouvre la porte dans une transaction annulée
```

Le contrôle D crée une fonction témoin **dans une transaction annulée** ; le
contrôle G fait de même. Aucun objet ne subsiste. À défaut d'autorisation pour
exécuter cette suite contre la production, le même constat s'obtient en lecture
pure : relancer l'audit et vérifier que le compteur « fonctions SECURITY
DEFINER exécutables par PUBLIC » est à zéro.

**Retour arrière** — le rollback est écrit dans la migration elle-même (§3,
lignes 78-84) et se limite à rendre `EXECUTE` à `PUBLIC` :

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE <créateur> GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO PUBLIC;
-- … et les quatre autres, telles quelles dans le fichier de migration
```

Il n'est volontairement pas mis dans `prisma/migrations/` : un rollback
enregistré comme migration serait rejoué comme une régression par la chaîne
suivante. Il s'exécute à la main, sous autorisation, et se termine par un
nouvel audit pour constater le retour à l'état antérieur.
