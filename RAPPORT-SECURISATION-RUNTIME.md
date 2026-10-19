# Sécurisation du runtime Production — préparation de la bascule

**Date :** 2026-10-19
**Statut du document : PLAN POUR APPROBATION. Aucune bascule exécutée.**

Aucune fusion. Aucun push. `main` non modifié. SHA candidat non déplacé.
Aucune variable, rôle, privilège, politique ou fonction modifié. Aucune
migration distante. Aucune opération sur Production ni sur la Preview.
Toutes les mesures de ce document ont eu lieu sur des bases PostgreSQL
locales jetables, créées puis détruites.

Légende : **[M]** mesuré pendant ce chantier · **[M-LOC]** mesuré localement sur
base jetable, ne vaut pas pour Production · **[ANT]** preuve antérieure
rapportée, non reproduite · **[DED]** déduction statique depuis le code ·
**[INACC]** inaccessible · **[NV]** non vérifié.

---

## 1. État actuel des preuves et leurs limites

### 1.1 Identifiants revérifiés

| Élément | Valeur | Statut |
|---|---|---|
| PR #58 | `OPEN`, brouillon `false`, `MERGEABLE / UNSTABLE` | **[M]** |
| Head candidat | `bb1213c00f109e250634fce006f4198ea99bf7e4` | **[M]** |
| `main` | `31ce4466b7d3d7129dec5609604eb37fdc5d5b21` | **[M]** |
| Ruleset `25012843` | `protection-main`, actif, cible `refs/heads/main`, `bypass_actors` = 0 | **[M]** |
| Contextes requis | `Socle`, `Verification`, `Parcours`, `Base — isolation RLS` | **[M]** |

Contrôles sur le SHA candidat — les quatre requis verts, chacun sur deux runs,
`head_sha` vérifié individuellement : **[M]**

| Contexte | Run | Fin (UTC) | Conclusion |
|---|---|---|---|
| Socle | `39209559163` / `39209564037` | 06:23:19 / 06:23:32 | `success` |
| Base — isolation RLS | `39209559163` / `39209564037` | 06:24:20 / 06:24:30 | `success` |
| Verification | `39209559163` / `39209564037` | 06:30:01 / 06:30:16 | `success` |
| Parcours — navigateur | `39209559163` / `39209564037` | 06:25:08 / 06:25:19 | `success` |
| Sonder les routes réelles *(non requis)* | `39209559127` | 06:22:49 | `failure` |

### 1.2 Limites de ces preuves

- **Le texte des journaux CI est inaccessible.** Il est servi par
  `productionresultssa9.blob.core.windows.net`, hors des hôtes joignables.
  **[INACC]** Les conclusions sont lues via l'API, pas les lignes `ok …`.
- **Le 10/10 sous rôle restreint est rapporté, non reproduit.** Il a été observé
  dans le Codespace de l'opérateur. Cet environnement ne peut générer aucun
  client Prisma (`binaries.prisma.sh` injoignable). **[ANT]**
- **Le 8/8 en CI repose sur une inférence vérifiée**, pas sur une lecture :
  `run-db-suite.mjs:74-77` propage le code de sortie, et la ligne 216 du script
  est la seule voie vers `0`. **[M pour la chaîne · INACC pour le texte]**
- **Aucune mesure de Production n'a été possible.** L'hôte Neon résout en DNS,
  mais cette observation ne vaut rien : le proxy de sortie répond pour des hôtes
  inexistants, mesuré sur un nom inventé. **[INACC]**

---

## 2. Sources capables de mesurer l'identité réelle du runtime

Question distincte de « quel rôle existe » : il faut le rôle **que le processus
applicatif emploie**.

| Source | Ce qu'elle prouve | Limite | Verdict |
|---|---|---|---|
| L'application elle-même, en journalisant `current_user` | Le rôle du processus, sans ambiguïté | Exige un changement de code | **La seule source décisive** |
| `pg_stat_activity` depuis une connexion d'administration | Le `usename` des backends actifs | Exige un accès admin et des connexions actives au moment de la mesure | Bonne, ponctuelle |
| `npm run db:role-runtime` | Le rôle de **la connexion que vous ouvrez** | Ne vaut pour le runtime que si la chaîne employée est exactement la sienne | **À ne pas confondre** |
| Variable Vercel `DATABASE_URL` | L'utilisateur **prévu** | Une intention, pas une mesure | Indicatif |
| Journaux d'exécution Vercel | Ce que l'application a journalisé | L'application ne journalise pas l'identité aujourd'hui | **[NV]** — rien à lire |

`api/` ne contient **aucune** occurrence de `current_user` ni `session_user`.
**[M]** La sonde `probeDatabase()` (`api/_lib/readiness-probes.ts:63-70`) exécute
`SELECT 1` et ne remonte pas l'identité.

**Conclusion : le rôle réel du runtime de Production ne peut pas être établi
depuis cet environnement.** Il exige soit un accès d'administration à
Production pour lire `pg_stat_activity`, soit le changement de code proposé au
§7.1. Jusque-là, `neondb_owner` avec `rolbypassrls = true` reste une preuve
**[ANT]**.

### 2.1 Requêtes de diagnostic préparées — lecture seule

`scripts/verifier-role-runtime.sql` existe déjà et convient : `current_user`,
`session_user`, `rolsuper`, `rolbypassrls`, un compte de lignes visibles sans
contexte, et la posture des deux rôles candidats. Aucune écriture. **[M]**

À compléter pour cet audit, en lecture seule également :

```sql
-- Backends actifs : le role reel du runtime, observe et non declare.
SELECT usename, application_name, count(*) AS connexions
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2 ORDER BY 3 DESC;

-- Privileges effectifs du role vise, sans les supposer.
SELECT table_name,
       has_table_privilege('tracefab_app', quote_ident(table_name), 'SELECT') AS s,
       has_table_privilege('tracefab_app', quote_ident(table_name), 'INSERT') AS i,
       has_table_privilege('tracefab_app', quote_ident(table_name), 'UPDATE') AS u,
       has_table_privilege('tracefab_app', quote_ident(table_name), 'DELETE') AS d
FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY 1;

-- Couverture RLS effective.
SELECT count(*) AS tables,
       count(*) FILTER (WHERE relrowsecurity) AS rls_activee,
       count(*) FILTER (WHERE relforcerowsecurity) AS rls_forcee
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';
```

---

## 3. Écarts de schéma

### 3.1 La référence embarquée est désormais validée

Jusqu'ici, la liste de 128 politiques et 114 fonctions embarquée dans
`drift.tmp.sql` était une hypothèse. Elle ne l'est plus.

Une reconstruction **textuelle** des 49 migrations donne 141 `CREATE POLICY` —
davantage que 128 — parce que des politiques sont recréées après un `DROP`. Le
compte textuel n'est donc pas l'état final. **[M]**

L'état final a été obtenu en **appliquant réellement les 49 migrations** sur une
base jetable, puis en interrogeant `pg_policies` et `pg_proc` : **[M-LOC]**

```
migrations appliquees : 49/49
ETAT FINAL REEL : politiques=128 · SECURITY DEFINER=114
```

Comparaison nom par nom avec la liste embarquée : **[M]**

```
politiques       : embarque=128  reel=128   differences : 0 dans les deux sens
SECURITY DEFINER : embarque=114  reel=114   differences : 0 dans les deux sens
```

**La liste embarquée est exacte.** L'outil `drift.tmp.sql` peut donc être
employé tel quel le jour où un accès autorisé existera.

### 3.2 Écarts signalés, toujours inexpliqués

| Écart | Production rapportée | Référence vérifiée | Écart | Statut |
|---|---|---|---|---|
| Politiques RLS | 130 | 128 | **+2** | **[ANT]** vs **[M-LOC]** |
| `SECURITY DEFINER` | 115 | 114 | **+1** | **[ANT]** vs **[M-LOC]** |
| `_prisma_migrations` | 51 lignes, 2 annulées | 49 migrations | +2 lignes | **[ANT]** |

Les deux lignes supplémentaires de `_prisma_migrations` correspondent
vraisemblablement aux deux migrations annulées — cohérent, mais non vérifié.

**Ces trois objets restent inexpliqués et constituent un bloquant.** Conformément
aux contraintes, ils ne doivent être ni modifiés ni supprimés tant que leur
provenance n'est pas établie. Une bascule qui change le rôle d'exécution peut
rendre actives des politiques jusqu'ici contournées : agir sans les comprendre,
c'est changer le comportement d'objets dont on ignore l'origine.

### 3.3 Horodatages dupliqués — mesure exacte

**Quatre** paires, et non une : **[M]**

```
20261006120000  data_collection_bridge_and_quality_automation
20261006120000  external_schema_bindings
20261006200000  catalog_import_kind
20261006200000  document_ai_automated_verification
20261006220000  esg_pef_footprint_engine
20261006220000  production_hardening
20261017120000  active_tenant_context
20261017120000  harden_dpp_table_privileges
```

49 migrations, 45 horodatages distincts. Prisma trie lexicographiquement, donc
l'ordre reste déterministe — pas d'ambiguïté d'exécution. Aucun contrôle du
dépôt ne le surveille : `check_migrations.ts` fait un `.sort()`,
`test_migration_history.mjs` ne cherche pas les doublons bien qu'il soit
collecté par le job `Verification` (vert). **[M]**

**Le renommage est à exclure.** `scripts/lire-historique-migrations.mjs:67-69`
apparie `_prisma_migrations.migration_name` aux noms de dossiers : renommer un
dossier déjà appliqué le ferait voir comme « appliqué mais introuvable » sous
l'ancien nom et « jamais appliqué » sous le nouveau, donc provoquer une
réapplication. **[M pour l'appariement · DED pour la conséquence]**

---

## 4. Chemins de connexion et privilèges

### 4.1 Un seul point de connexion dans le runtime

`grep 'new PrismaClient'` sur `api/` donne **une** occurrence :
`api/_lib/prisma.ts:28`. Toutes les autres sont dans `scripts/` — outils de
migration, de test et d'amorçage, hors runtime. **[M]**

`prisma/schema.prisma` n'a qu'une source : `url = env("DATABASE_URL")`.
`TF_RLS_APP_URL` apparaît **0 fois** dans `api/` — c'est une construction propre
à la CI, codée en dur dans `ci.yml:324`, `audit-sql-privileges.yml:54` et
`migrations-34-36-41.yml:56`. **[M]**

**Conséquence : la bascule ne touche qu'une variable.** Aucun code applicatif à
modifier pour changer de rôle.

### 4.2 Privilèges actuels — mesurés, pas supposés

Après application des 49 migrations puis `bootstrap_app_role.mjs`, connexion
réelle en `tracefab_app` : **[M-LOC]**

```
fonctions appelees par le runtime : 74
EXECUTE accorde a tracefab_app    : 74
en defaut                         : 0
```

Les 74 fonctions ont été énumérées par extraction depuis `api/`, non reprises
d'une liste antérieure.

Privilèges directs sur tables clés : **[M-LOC]**

```
rate_limit_counters          SELECT=true INSERT=true UPDATE=true DELETE=true
tracefab_notification_outbox SELECT=true INSERT=true UPDATE=true DELETE=true
documents                    SELECT=true INSERT=true UPDATE=true DELETE=true
audit_logs                   SELECT=true INSERT=true UPDATE=true DELETE=true
users                        SELECT=true INSERT=true UPDATE=true DELETE=true
```

**Ce résultat contredit le message du script d'amorçage**, qui annonce « tables
DPP en lecture seule, mutations par fonctions ». Cette description n'est vraie
que pour quatre tables. La cause est `scripts/lib/tracefab_app_role.mjs:60` : **[M]**

```
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tracefab_app
```

Le seul rétrécissement porte sur `dpp_lifecycle_events`, `dpp_claims`,
`dpp_claim_evidence`, `dpp_resolvable_identifiers` (lignes 81-83).

### 4.3 Ce qui contient réellement cet octroi large

Couverture RLS mesurée après application des 49 migrations : **[M-LOC]**

```
tables ordinaires          : 50
RLS activee                : 50
RLS forcee (meme proprio)  : 50
tables SANS RLS            : 0
```

**Toutes les tables ont la RLS activée et forcée.** L'octroi large de DML est
donc entièrement contenu par la RLS — mais cela signifie aussi que **la RLS est
l'unique barrière**. C'est précisément pourquoi le `rolbypassrls = true` de
Production est le problème central : il supprime cette unique barrière.

> **Complément mesuré (§7.4).** L'octroi large ne vient pas seulement du
> provisioning : les migrations contiennent 219 `TO PUBLIC` et 37
> `TO tracefab_app`. Restreindre les `GRANT` du bootstrap ne suffit donc pas à
> réduire la surface ; la RLS reste l'unique barrière, ce qui renforce encore le
> caractère bloquant du `rolbypassrls = true` observé sur Production.

### 4.4 Chemins non HTTP

Le cron `vercel.json` — `/api/internal/notification-outbox/schedule`,
`0 7 * * *` — passe par le même `DATABASE_URL`, donc le même rôle. **[M]**

Les routes `internal/*` sont dispensées du limiteur (`rate-limit.ts:138-144`),
donc elles n'écrivent pas `rate_limit_counters`. **[M]**

Leurs écritures passent par des fonctions `SECURITY DEFINER` dans une
transaction à contexte worker — `api/_lib/context.ts:11-25` arme
`tracefab.worker_context` via `set_config(..., true)`, ce qui satisfait les
politiques `notification_outbox_*_trusted`. `tracefab_app` n'a donc pas besoin
d'un `INSERT` direct sur cette table, seulement d'`EXECUTE` — accordé, mesuré au
§4.2. **[M]**

Point notable : la migration `20261006220000_production_hardening` fait
`REVOKE INSERT, UPDATE, DELETE ON tracefab_notification_outbox FROM PUBLIC`, et
`tracefab_app` y a pourtant tous les droits — parce que l'octroi global de
`tracefab_app_role.mjs:60` prime. **[M]**

### 4.5 Privilèges minimaux proposés

À appliquer sur la **branche d'essai d'abord**, jamais directement sur
Production.

**À conserver :**

- `CONNECT` sur la base, `USAGE` sur le schéma `public` ;
- `EXECUTE` sur les 74 fonctions appelées par le runtime — mesuré complet ;
- `SELECT, INSERT, UPDATE, DELETE` sur `rate_limit_counters`, la seule table où
  le runtime écrit directement hors fonction ;
- `USAGE, SELECT` sur les séquences effectivement employées.

**À retirer :**

- l'octroi global `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` ;
- les `ALTER DEFAULT PRIVILEGES` correspondants, qui rétabliraient
  silencieusement ce qui a été retiré ;
- à remplacer par des octrois nommés, table par table, justifiés par une route.

**Interdits dans tous les cas :** `BYPASSRLS`, `SUPERUSER`, `CREATEROLE`,
`CREATEDB`, `OWNER` sur un objet du schéma.

**Séquence imposée :** ne retirer l'octroi global qu'**après** avoir vérifié,
par exécution et non par lecture, que chaque chemin applicatif passe par une
fonction ou par un octroi nommé. Retirer avant de vérifier casserait
l'application — et la RLS forcée rendrait la panne visible sur tous les
locataires à la fois.

---

## 5. Résultats des tests isolés

Tous sur base PostgreSQL locale jetable, créée puis détruite. **Aucun ne vaut
pour Production.**

| Test | Résultat | Statut |
|---|---|---|
| 49 migrations appliquées, sans erreur | `49/49` | **[M-LOC]** |
| Identité sous rôle restreint, via SQL direct | `current_user = tracefab_app`, `contourne_rls = false` | **[M-LOC]** |
| SQL exact du limiteur sous `tracefab_app` | `hits=1, 2, 3` sur 1 ligne | **[M-LOC]** |
| Contrôle négatif — rôle sans droit, même SQL | `42501 permission denied` | **[M-LOC]** |
| Limiteur via le répartiteur réel, sous rôle restreint | `10/10` | **[ANT]** |
| Limiteur via le répartiteur réel, rôle propriétaire, en CI | `8/8` par inférence vérifiée | **[M]** |
| `EXECUTE` sur les 74 fonctions du runtime | `74/74`, 0 manque | **[M-LOC]** |
| Couverture RLS | 50/50 activée et forcée | **[M-LOC]** |
| Référence des 49 migrations vs liste embarquée | 0 différence, nom par nom | **[M-LOC]** |
| Détecteur d'horodatages, état réel | 4 dettes, 0 nouvelle, sortie `0` | **[M]** |
| Détecteur — 3ᵉ migration sur horodatage endetté | détectée, sortie `1` | **[M]** |
| Détecteur — duplication inédite | détectée, sortie `1` | **[M]** |

**Contrôles négatifs inclus.** Sans eux, les résultats positifs ne vaudraient
rien : le rôle sans droit prouve que l'épreuve détecte un refus, et les deux
derniers tests du détecteur prouvent qu'il ne laisse pas passer une
duplication.

**Un défaut corrigé en cours de mesure.** La première version du détecteur ne
portait sa liste de base que sur les horodatages : une troisième migration sur
un horodatage déjà endetté passait inaperçue, sortie `0`. Le test l'a révélé ;
la liste fige désormais les noms exacts.

---

## 6. Plan de bascule et de retour arrière

### 6.1 Préconditions — toutes obligatoires

1. Le rôle réel du runtime de Production est **mesuré**, par `pg_stat_activity`
   ou par la journalisation proposée au §7.1 — pas déduit.
2. Les 2 politiques et la fonction `SECURITY DEFINER` en écart sont
   **expliquées**.
3. Une branche d'essai enfant de Production est créée, et son **hôte confirmé
   par son nom, à voix haute**, avant toute écriture.
4. Les privilèges minimaux du §4.5 sont appliqués **sur la branche d'essai** et
   vérifiés par exécution.
5. Les tests du §6.2 sont verts sur cette branche.
6. La valeur précédente de `DATABASE_URL` est conservée **avant** tout
   changement.

### 6.2 Tests sur base jetable représentative

Contrôles positifs :

- identité via le client Prisma de l'application : `current_user` et
  `session_user` à `tracefab_app`, `rolbypassrls` et `rolsuper` à `false` ;
- `scripts/test_routes_sous_role_app.mjs` — 10 assertions ;
- les 74 `EXECUTE`, mesurés et non supposés ;
- cron d'outbox : traitement complet en contexte worker.

Contrôles négatifs :

- un rôle sans droit doit être refusé — `42501` ;
- une écriture hors contexte worker sur `tracefab_notification_outbox` doit
  être refusée ;
- le limiteur doit répondre `503` si l'écriture lui est retirée — c'est le
  comportement attendu, et il faut le reconnaître plutôt que le découvrir.

Isolation entre tenants :

- `test:neon:rls`, `test:neon:write-policies`, `test:neon:bypass-control`,
  `test:neon:cross-tenant`, `test:neon:app-readiness`,
  `test:neon:dpp-provenance`, `test:neon:dpp-lifecycle`,
  `test:neon:auth-provisioning` ;
- **`test:neon:app-readiness` écrit** — `UPDATE`, `INSERT INTO users`,
  `INSERT INTO supplier_passport_access_requests`. Jamais sur Production.

### 6.3 Critères d'arrêt

Arrêter immédiatement, sans correction automatique, si :

- `current_user` n'est pas `tracefab_app`, ou `rolbypassrls` n'est pas `false` ;
- un `42501` ou `42809` frappe une opération attendue ;
- le limiteur renvoie `503 rate_limiter_unavailable` ;
- le cron d'outbox échoue ou ne traite rien ;
- un `401` provient de la couche Vercel plutôt que de l'application ;
- l'hôte de la cible ne peut pas être confirmé par son nom.

### 6.4 Surveillance après changement

- taux de `503 rate_limiter_unavailable` — premier signal d'un privilège manquant ;
- taux de `42501` dans les journaux applicatifs ;
- profondeur et ancienneté de la file `tracefab_notification_outbox` ;
- `pg_stat_activity` : `usename` réellement employé, et nombre de connexions ;
- latence des routes d'écriture, la RLS ajoutant une évaluation par requête.

### 6.5 Retour arrière — sans suppression de données

La bascule ne modifie que `DATABASE_URL`. Le retour arrière remet la valeur
précédente : changement de configuration, sans migration ni modification de
schéma, **sans supprimer aucune donnée**.

Limites à connaître avant d'agir :

- il exige que la valeur précédente ait été conservée ;
- il ne restaure pas les écritures effectuées entre-temps ;
- il ne corrige pas les requêtes déjà échouées devant les utilisateurs ;
- si le problème vient d'un privilège manquant, le retour rétablit le service
  mais **rétablit aussi le contournement de la RLS** — le retour arrière
  n'est pas une correction, c'est un repli.

---

## 7. Changements de code proposés — non déployés

Rien n'a été commité ni poussé. Le SHA candidat est inchangé.

### 7.1 Journaliser l'identité du runtime au démarrage

**Pourquoi :** c'est la seule source qui mesure le rôle du processus sans
ambiguïté (§2). Aujourd'hui `api/` ne contient aucune occurrence de
`current_user`.

**Où :** `api/_lib/prisma.ts`, après la création du client — une requête unique
au premier usage, journalisée, **jamais renvoyée dans une réponse HTTP**.

**Forme proposée :**

```ts
let identiteJournalisee = false;
async function journaliserIdentiteRuntime(client: PrismaClient) {
  if (identiteJournalisee) return;
  identiteJournalisee = true;
  try {
    const [r] = await client.$queryRaw<Array<{ u: string; bypass: boolean }>>`
      SELECT current_user AS u,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    console.info(JSON.stringify({
      schema: 'tracefab-runtime-identity-v1',
      level: r?.bypass ? 'warn' : 'info',
      role: r?.u,
      contourne_rls: r?.bypass ?? null,
      message: r?.bypass
        ? 'le role du runtime contourne la RLS'
        : 'le role du runtime est soumis a la RLS',
    }));
  } catch { /* ne jamais faire echec sur une sonde */ }
}
```

Le rôle n'est pas un secret, mais le renvoyer dans une réponse HTTP exposerait
un détail d'infrastructure à tout appelant : journal, ne pas répondre. Un
niveau `warn` quand `rolbypassrls` est vrai rend le contournement visible dans
les journaux d'exploitation au lieu de le laisser implicite.

### 7.2 Détecteur d'horodatages dupliqués — écrit et testé, non commité

`scripts/verifier-horodatages-migrations.mjs`, fichier **non suivi**, lecture
seule : aucune connexion, aucun accès base.

Les quatre paires existantes y sont figées comme dette acceptée, par **noms
exacts**. Le contrôle échoue sur toute duplication nouvelle, y compris une
troisième migration sur un horodatage déjà endetté.

**Câblage proposé**, à ne faire qu'en connaissance de cause : nommer l'entrée
`test:migrations:horodatages` la ferait collecter automatiquement par le job
`Verification`. Comme l'état actuel du dépôt passe (0 duplication nouvelle), le
contrôle serait vert dès l'ajout.

### 7.3 Rétrécissement des privilèges — appliqué, mesuré, non déployé

**Statut : code modifié dans l'arbre de travail, non poussé, non déployé.**

Dans `scripts/lib/tracefab_app_role.mjs`, l'octroi global
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` est remplacé par
`GRANT SELECT ON ALL TABLES` plus un DML conditionné, table par table, sur les
quatre seules tables que le runtime écrit en SQL brut :

| table | occurrences | site |
|---|---|---|
| `audit_logs` | 2 | `api/_routes/catalog/{products,suppliers}/import.ts:189,184` |
| `documents` | 1 | `api/_lib/documents.ts:107` |
| `rate_limit_counters` | 2 | `api/_lib/rate-limit.ts:403,415` |
| `tracefab_catalog_import_jobs` | 4 | `api/_routes/catalog/{products,suppliers}/import.ts:138,140` |

`ALTER DEFAULT PRIVILEGES` est réduit à `SELECT ON TABLES`. `EXECUTE ON ALL
FUNCTIONS` est conservé. Le bloc `REVOKE` des privilèges par défaut est
conservé : il répare aussi les bases provisionnées sous l'ancienne règle. Le
message console, qui annonçait « tables DPP en lecture seule » alors que le
script accordait le DML partout, est corrigé.

### 7.4 Réfutation de la section précédente — mesure corrigée

> **Cette section remplace et annule la version antérieure du §7.4**, qui
> affirmait que les migrations laissaient à `PUBLIC` des droits
> `SELECT, INSERT, UPDATE, DELETE` et que `has_table_privilege` renvoyait vrai
> pour l'écriture sur 36 des 51 tables « quel que soit le provisioning ».
> **Les deux moitiés de cette affirmation étaient fausses**, pour des raisons
> différentes, et chacune a été mesurée.

**Première erreur — le décompte de 219.** Il provenait d'un `grep` de la chaîne
`TO PUBLIC`, qui compte aussi les 132 `REVOKE ... FROM PUBLIC`. Le décompte
réel, analysé sur le SQL et non sur une chaîne :

| instruction | occurrences |
|---|---|
| `GRANT ... TO PUBLIC` | 86 |
| `REVOKE ... FROM PUBLIC` | 132 |

**Deuxième erreur — l'état final de `PUBLIC`.** Mesuré par `aclexplode(relacl)`
sur `grantee = 0`, seule méthode correcte : `has_table_privilege('public', ...)`
ne lit pas le pseudo-rôle `PUBLIC`, il n'existe pas dans `pg_roles`. Résultat sur
base reconstruite depuis les 50 migrations :

```
entrees ACL PUBLIC sur tables, vues et vues materialisees : 0
fonctions avec EXECUTE pour PUBLIC                        : 0 / 164
```

**`PUBLIC` est propre dans l'état final.** Les révoctions font leur travail.

**Troisième erreur — l'origine des 36 tables.** Elles existent bien, mais pas
pour la raison avancée. Le mécanisme réel est dans
`20261014130000_revoke_public_schema_privileges`, bloc `$preserve_runtime_acl$`
: avant de révoquer les privilèges relationnels de `PUBLIC`, il les recopie
explicitement sur le rôle applicatif —

```sql
IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
  ... EXECUTE format('GRANT %s ON TABLE %s TO tracefab_app', ...);
```

Ce transfert est **conditionné à l'existence du rôle au moment des
migrations**. D'où deux états mesurés, et c'est ce qui explique la contradiction
entre mes deux mesures :

| ordre de provisioning | DML explicite sur `tracefab_app` |
|---|---|
| rôle créé **après** les migrations | **4** tables |
| rôle créé **avant** les migrations — ordre réel CI et Production | **36** tables |

La CI exécute `db:prepare-ci-role` **puis** `db:deploy:throwaway` : l'ordre réel
est donc celui qui donne 36. Mon contrôle `test:neon:privileges-role-app`
mesurait l'ordre inverse et sous-estimait la surface. **Corrigé** : il
provisionne désormais avant les migrations.

Seize tables sont à l'origine du transfert, chacune ayant reçu un
`GRANT SELECT, INSERT, UPDATE[, DELETE] ... TO PUBLIC` dans une migration
antérieure : `organizations`, `organization_memberships`,
`organization_invitations`, `suppliers`, `product_identifiers`,
`plm_erp_integrations`, `plm_erp_sync_jobs`, `product_pef_assessments`,
`product_green_claims`, `green_claims_audits`,
`quality_corrective_action_plans`, `quality_cap_messages`,
`supplier_universal_passports`, `supplier_passport_access_requests`,
`transaction_certificates`, `mass_balance_allocations`,
`mass_balance_reconciliations`, `rate_limit_counters`,
`tracefab_catalog_import_jobs`.

**Ce qui confine réellement, inchangé et remesuré :** 50 tables sur 51 portent
une RLS active et forcée, la seule exception étant `_prisma_migrations`.

### 7.5 Validation du TLS — défaut corrigé, garde ajoutée

**[M]** `rejectUnauthorized` était positionné à faux en **13 endroits répartis
sur 11 fichiers**, tous sur des connexions portant un mot de passe de rôle. La
validation du certificat y était donc désactivée. Les 13 occurrences sont
passées à vrai. Un CA privé doit désormais passer par `NODE_EXTRA_CA_CERTS`, ce
qui garde la validation active au lieu de la supprimer.

Le réglage est centralisé dans `scripts/lib/pg-ssl.mjs` (`tlsDemande`,
`sslDepuisUrl`), employé par `tracefab_app_role.mjs`.

La garde `scripts/test_tls_validation_active.mjs` parcourt `scripts/` et `api/`
(404 fichiers) et refuse toute réintroduction. Elle a été éprouvée : défaut
réintroduit dans `seed_rls_fixture.mjs` → sortie 1 nommant `fichier:ligne` ;
restauré → sortie 0.

### 7.6 Couverture CI du provisioning — trou comblé

**[M]** `bootstrap_app_role.mjs` n'était exécuté par **aucune** étape de CI et
n'avait **aucune** entrée npm. `prepare_ci_db_role.mjs:34` ne fait que
`CREATE ROLE`, sans aucun `GRANT`. Les privilèges réellement reçus par
`tracefab_app` n'étaient donc mesurés nulle part, et les mesures antérieures
décrivaient une configuration que la CI ne produit jamais.

Trois entrées sont ajoutées :

| entrée npm | exécution |
|---|---|
| `test:tls:validation` | auto-collectée par le job `Verification` |
| `test:migrations:horodatages` | auto-collectée par le job `Verification` |
| `test:neon:privileges-role-app` | étape 24 du job `base-de-donnees` |

Le contrôle des privilèges crée **sa propre base éphémère** dans le cluster, y
applique les 49 migrations, exécute le provisioning réel, puis se reconnecte en
`tracefab_app`. Il ne touche pas `tracefab_test`, donc ne modifie aucun
privilège vu par les autres suites du même job. Il réutilise `TF_APP_PASSWORD`
de l'environnement plutôt qu'un mot de passe propre, pour ne pas réinitialiser
celui qu'emploie `TF_RLS_APP_URL`.

Résultat local : **14/14 assertions vertes, sortie 0**, via
`npm run test:neon:privileges-role-app`, donc via la même enveloppe que la CI.

---

### 7.7 Migration corrective — appliquée et mesurée, non déployée

`prisma/migrations/20261019120000_restreindre_dml_role_applicatif/migration.sql`

Nouvelle migration versionnée. Aucune migration historique n'est réécrite, aucun
objet n'est supprimé, aucune politique RLS ni fonction n'est modifiée : seuls des
privilèges de table sont retirés.

Effet mesuré sur base reconstruite, ordre réel de déploiement :

| étape | tables avec DML pour `tracefab_app` |
|---|---|
| après les 49 migrations historiques | **36** |
| après la migration corrective | **4** |
| après une seconde application (idempotence) | **4** |

Les quatre tables conservées sont `audit_logs`, `documents`,
`rate_limit_counters`, `tracefab_catalog_import_jobs`. La lecture reste
disponible sur les 51 tables. `PUBLIC` reste à zéro.

Deux défauts de cette migration ont été trouvés en l'exécutant, puis corrigés :

- `format('... ON %I %I ...', 'TABLE', relname)` quote le mot-clé `TABLE` en
  identifiant → `42601 syntax error at or near "users"`. Le mot-clé ne doit pas
  passer par `%I`.
- un `CASE` sans effet, vestige d'une version antérieure, a été retiré.

### 7.8 Isolation prouvée sur des lignes existantes — C3

`scripts/test_isolation_lignes_reelles.mjs` · entrée `test:neon:isolation-lignes`

`has_table_privilege`, la présence de `FORCE ROW LEVEL SECURITY` et un
`DELETE ... WHERE false` ne prouvent rien de l'isolation : avec `WHERE false`
aucune ligne n'est examinée, donc la clause `USING` n'est jamais évaluée. Ce
contrôle crée deux organisations réelles, y insère des documents et des produits
réels, puis tente depuis l'une d'agir sur les lignes de l'autre.

**Résultat : 18/18 assertions vertes, sortie 0.**

| axe | résultat |
|---|---|
| lecture inter-tenant | A ne lit ni le document de B, ni aucun document de B |
| modification inter-tenant | refusée ; le document de B reste intact |
| suppression inter-tenant | refusée ; le document de B existe toujours |
| insertion avec organisation falsifiée | refusée |
| accès sans contexte d'identité | aucun document privé visible |
| contournement par contexte `worker` | ne permet pas de modifier le document de B |
| `search_path` des 114 fonctions `SECURITY DEFINER` | fixé sur les 114 |
| parcours publics | produit publié lisible, brouillon non lisible |
| surface d'écriture directe | limitée aux 4 tables ; aucun DML pour `PUBLIC` |

Chaque refus est doublé d'un contrôle positif sur les données propres, pour
qu'une base vide ne puisse pas passer pour de l'isolation.

**Contrôle négatif embarqué.** Avec
`ISOLATION_CONTROLE_NEGATIF=desactive_rls_documents`, la RLS est retirée de
`documents` : **7 assertions passent au rouge, sortie 1.** C'est ce qui prouve
qu'elles mesurent la RLS.

Ce contrôle négatif a révélé un défaut réel du test lui-même : les assertions
d'écriture portaient d'abord sur `status` puis sur `byte_size`, et **restaient
vertes même RLS désactivée**, parce que le déclencheur de la migration initiale
lève `managed_document_fields_are_not_client_writable` sur `status`,
`byte_size`, `sha256`, `uploaded_by`, `available_at`, `deleted_at` et
`deleted_by`. Elles portent désormais sur `original_filename`, absent de cette
liste. Un test d'isolation qui ne peut pas échouer ne prouve rien.

### 7.9 Contrôle de migrations éprouvé — C4

`scripts/test_controle_migrations.mjs` · entrée `test:migrations:controle`

**8/8 assertions vertes, sortie 0.** Le détecteur accepte désormais
`TF_MIGRATIONS_DIR`, uniquement pour permettre cette épreuve sur des
arborescences synthétiques.

| cas | code attendu | obtenu |
|---|---|---|
| état réel du dépôt | 0 | 0 |
| nouvelle collision | 1 | 1 |
| troisième migration sur horodatage endetté | 1 | 1 |
| renommage d'une migration endettée | 1 ou 2 | ✓ |
| migration corrective à horodatage unique | 0 | 0 |
| dette acceptée désynchronisée du dépôt | 2 | 2 |

Le dernier cas a révélé un trou réel du détecteur : `disparues` ne voyait que
les horodatages **entièrement** absents. Si l'une des deux migrations d'un
horodatage endetté était retirée, l'horodatage subsistait avec un seul nom, ne
constituait plus une duplication, n'était plus examiné, et la liste de dette
devenait silencieusement morte. Un ensemble `desynchronisees` compare désormais
les noms attendus aux noms présents.

**Non vérifiable localement, à assumer.** Prouver qu'aucune migration déjà
appliquée n'a été renommée exige le vrai `_prisma_migrations` d'une base
déployée. Ce contrôle ne peut pas être fait depuis cet environnement. L'outil
existe — `scripts/lire-historique-migrations.mjs` — et la procédure d'exécution
contrôlée reste à dérouler sur cible autorisée.

### 7.10 Objets divergents — l'écart ne peut pas être tranché d'ici

Le schéma reconstruit depuis les 50 migrations contient **128 politiques** et
**114 fonctions `SECURITY DEFINER`**, soit 242 objets. L'environnement
précédemment audité en signalait 130 et 115 : **deux politiques et une fonction
en plus.**

**Aucun accès à cet environnement depuis ce chantier.** L'écart ne peut donc pas
être tranché ici, et conformément à la consigne **aucun objet n'est supprimé**.

Deux outils sont livrés pour le trancher sur cible autorisée :

- `scripts/lire-objets-sql.sql` — trois `SELECT` sur le catalogue, aucune
  écriture, aucune fonction appelée. Produit un objet par ligne.
- `scripts/comparer-objets-sql.mjs` — compare deux inventaires **nominativement**
  et rend la différence exacte dans les deux sens. Sortie 0 identiques,
  1 divergence, 2 entrée manquante.

Épreuve : référence de 242 objets contre elle-même → **sortie 0** ; avec
l'écart réel injecté (2 politiques + 1 fonction) → **sortie 1**, en nommant les
trois objets. Un écart de compte ne permet aucune décision ; une liste nominative
permet de classer chaque objet en légitime, obsolète ou dangereux.

### 7.11 Limitation de débit — risque reproduit puis corrigé

**Risque reproduit, pas déduit.** La politique posée par la migration
`20261008100000` est unique :

```sql
CREATE POLICY rate_limit_counters_global ON rate_limit_counters
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
```

Le commentaire de cette migration justifie le `USING (true)` : la table n'a pas
de locataire, elle est indexée par empreinte client et écrite sur des routes
publiques sans contexte utilisateur armé. **Cette justification est valable et
elle est conservée** pour la lecture, l'insertion et la mise à jour.

Elle ne couvre pas la suppression. Rôles effectivement concernés, mesurés :

| rôle | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `postgres` (propriétaire) | oui | oui | oui | oui |
| `tracefab_app` | oui | oui | oui | oui |
| `PUBLIC` | non | non | non | non |

Reproduction sur base jetable, sous le rôle applicatif, avec 2 compteurs actifs
(47 et 3 coups) et 1 expiré :

```
compteurs avant                          : 3
DELETE FROM rate_limit_counters          : 3 lignes supprimees
compteurs apres                          : 0
```

Un rôle applicatif compromis peut donc remettre à zéro l'état de limitation de
débit de tous les clients.

**Besoin légitime, vérifié sur tout le dépôt.** Le runtime n'écrit cette table
qu'à deux endroits, dans `api/_lib/rate-limit.ts` :

```
:403  INSERT ... ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET hits = rate_limit_counters.hits + 1 RETURNING hits
:415  DELETE FROM rate_limit_counters WHERE expires_at < NOW()
```

La suppression légitime ne porte que sur des fenêtres déjà expirées. Aucune
suppression de compteur actif n'est utile à l'application.

**Correction** — `20261019140000_restreindre_suppression_compteurs_debit` :

| commande | avant | après |
|---|---|---|
| SELECT | `USING (true)` | `USING (true)` — inchangé |
| INSERT | `WITH CHECK (true)` | `WITH CHECK (true)` — inchangé |
| UPDATE | `USING (true) WITH CHECK (true)` | inchangé, plus déclencheur |
| DELETE | `USING (true)` | **`USING (expires_at < now())`** |

Le `FOR ALL` est remplacé par quatre politiques par commande. Une clause
`WITH CHECK` ne voit que `NEW` et ne peut donc pas exprimer « `hits` ne diminue
pas » ; un déclencheur `BEFORE UPDATE` le peut, et refuse aussi le déplacement
d'un compteur sur une autre fenêtre. Les deux attaques sont refusées en
`42501`, ce que les journaux PostgreSQL confirment :

```
ERROR:  rate_limit_counter_hits_cannot_decrease (avant=3, apres=0)
ERROR:  rate_limit_counter_identity_is_immutable
```

**Résultat** — `scripts/test_compteurs_debit.mjs`, **18/18 assertions vertes,
sortie 0**. Le contrôle vérifie d'abord le chemin réel (insertion, upsert qui
incrémente à 2 puis 3, lecture, nettoyage des fenêtres expirées), puis les abus.

**Contrôle négatif** : migration retirée → **8/18, sortie 1**, avec
« 3 actifs avant, 0 après (supprimées : 4) ». C'est la preuve que la migration
est bien ce qui corrige, et que le test mesure quelque chose.

### 7.12 Outil de comparaison éprouvé sur fixtures synthétiques

`scripts/test_comparaison_objets_sql.mjs` · entrée `test:objets-sql:comparaison`
· **14/14 assertions vertes, sortie 0.**

Aucune connexion autorisée à l'environnement audité n'est disponible. Les
identifiants des deux politiques et de la fonction en écart **ne sont donc pas
produits ici et ne sont pas inventés** : l'outil est éprouvé sur des fixtures,
pour que la comparaison soit fiable du premier coup sur cible autorisée.

| cas | sortie |
|---|---|
| inventaires identiques | 0 |
| écart de la forme observée (2 politiques + 1 fonction) | 1, noms rendus |
| objet absent de la cible | 1, nom rendu |
| cible absente / référence introuvable / sortie inexploitable | 2 |

Le contrôle vérifie aussi que `lire-objets-sql.sql` ne contient **aucun verbe
d'écriture hors commentaire** (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`,
`CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`) — un outil destiné à une cible
sensible ne doit pas pouvoir écrire.

**Commande à exécuter plus tard, sur cible explicitement autorisée :**

```
psql "$CIBLE_AUTORISEE" -f scripts/lire-objets-sql.sql -At -o cible.txt
node scripts/comparer-objets-sql.mjs --reference reference.txt --cible cible.txt
```

`reference.txt` est la même requête exécutée sur une base reconstruite depuis
les migrations. Sortie 0 = identiques, 1 = divergence nominative, 2 = entrée
manquante.

### 7.13 Build et typecheck — indisponibilité réseau, pas défaut de code

**`prisma generate` et `prisma validate` échouent tous deux au même endroit :**

```
Error: request to https://binaries.prisma.sh/all_commits/c2990dca.../
debian-openssl-3.0.x/schema-engine.gz.sha256 failed,
reason: Client network socket disconnected before secure TLS connection
was established
```

`curl` sur `binaries.prisma.sh` renvoie `SSL_ERROR_SYSCALL` : la connexion est
coupée à la couche TLS. **C'est une indisponibilité réseau, pas un défaut de
code.** `npm view @prisma/engines` répond `7.10.1` depuis le registre autorisé,
donc l'accès npm fonctionne ; seul l'hôte des binaires est hors d'atteinte.

Conséquence en cascade, mesurée :

| commande | résultat | cause |
|---|---|---|
| `npm run build` | non exécutable | commence par `db:generate` |
| `npm run typecheck` | non exécutable | types Prisma absents |
| `npm run api:typecheck` | sortie 2, **89 erreurs** | voir ci-dessous |
| `npm run schema:static` | **sortie 0** | indépendant des moteurs |
| `npm run test:workflow-policy` | **sortie 0** | valide le `ci.yml` modifié |
| `npm run test:workflow-policy-temoins` | **sortie 0** | — |
| `npm run test:db-guard` | **sortie 0** | — |
| `npm run test:db-routing` | **sortie 0** | — |

Les 89 erreurs de `api:typecheck` se décomposent en **85 `TS2305` — toutes
`Module '"@prisma/client"' has no exported member`**, et 4 `TS2339` sur des
propriétés de type `unknown` issues de `$queryRaw`. `node_modules/.prisma/client`
est absent : le client n'a jamais été généré. **Les 89 erreurs remontent donc à
la même cause réseau.**

Preuve qu'aucune régression n'est introduite : `git diff --name-only bb1213c
HEAD | grep '\.ts$'` est **vide** — aucun commit du chantier ne touche de
TypeScript.

**Le build n'est pas déclaré validé.** Il ne peut pas l'être ici.

### 7.14 Rétablissement après reclonage du dépôt

Entre deux tours, le clone local a été **recréé depuis zéro** : le reflog ne
montre qu'un `clone:` suivi d'un checkout, HEAD avait dérivé sur le SHA de
`main`, et les commits `82734f3` et `910688a` avaient disparu de l'objet-store
local.

L'arbre de travail était intact. Méthode employée, dans cet ordre :

1. sauvegarde des 13 fichiers du chantier avec empreintes `sha256`, **avant**
   toute opération Git ;
2. `git fetch origin arena/ba652133-tracefab` — ne touche pas l'arbre ;
3. `git reset --mixed origin/arena/ba652133-tracefab` — **`--mixed`, jamais
   `--hard`**, qui aurait détruit les fichiers ;
4. comparaison octet à octet des 13 fichiers contre la sauvegarde : **13/13
   identiques** ;
5. re-commit en `852076c`.

`node_modules` avait disparu avec le reclonage. Piège rencontré ensuite, à
retenir : **`npm install --no-save` élague les paquets installés en `--no-save`
au tour précédent.** Installer `prisma` a supprimé `embedded-postgres`, ce qui a
retiré les bibliothèques d'un serveur PostgreSQL **en cours d'exécution** et
produit l'erreur trompeuse `could not access file "plpgsql"` (`58P01`) sur des
requêtes qui fonctionnaient jusque-là. Tous les paquets doivent être installés
dans une seule commande.

### 7.15 Récapitulatif des entrées de test et des contrôles négatifs

| entrée npm | exécution | résultat local |
|---|---|---|
| `test:tls:validation` | auto-collectée par `Verification` | 0 |
| `test:migrations:horodatages` | auto-collectée par `Verification` | 0 |
| `test:migrations:controle` | auto-collectée par `Verification` | 8/8 · 0 |
| `test:objets-sql:comparaison` | auto-collectée par `Verification` | 14/14 · 0 |
| `test:neon:privileges-role-app` | étape du job `base-de-donnees` | 16/16 · 0 |
| `test:neon:isolation-lignes` | étape du job `base-de-donnees` | 18/18 · 0 |
| `test:neon:compteurs-debit` | étape du job `base-de-donnees` | 18/18 · 0 |

Le job `base-de-donnees` compte désormais **26 étapes**. Les quatre entrées sans
base sont découvertes automatiquement par l'étape « Suite complete des scripts
test:* » du job `Verification`, qui retient tout `test:*` hors `*neon*`,
`*staging*`, `test:p2`, `test:regression` et `test:audit-script` — vérifié par
lecture du filtre réel du workflow, pas supposé.

Contrôles négatifs, tous rejoués après les dernières modifications :

| contrôle négatif | sortie | effet |
|---|---|---|
| isolation, RLS retirée de `documents` | 1 | 7 assertions rouges |
| compteurs, migration corrective retirée | 1 | 8/18, « 3 actifs avant, 0 après » |
| TLS, défaut réintroduit | 1 | localise `seed_rls_fixture.mjs:48` |
| migrations, collision injectée | 1 | nomme `20261101090000` |

---

## 8. Critères objectifs d'autorisation et d'arrêt

### Autorisation de lancer la bascule sur la branche d'essai

Tous ces critères, sans exception :

1. Rôle réel du runtime de Production **mesuré**, source identifiable.
2. Les 3 objets en écart **expliqués** par écrit.
3. Hôte de la branche d'essai **confirmé par son nom**.
4. `74/74 EXECUTE` vérifiés **sur la branche d'essai**, pas seulement en local.
5. Les 10 assertions sous rôle restreint vertes **sur la branche d'essai**.
6. Les 8 suites d'isolement vertes **sur la branche d'essai**.
7. Cron d'outbox exercé **sur la branche d'essai**.
8. Valeur précédente de `DATABASE_URL` conservée.

### Autorisation de basculer Production

Les huit critères ci-dessus, **plus** :

9. Une fenêtre de retour arrière décidée à l'avance, avec un responsable nommé.
10. La surveillance du §6.4 en place **avant** le changement.
11. Une autorisation explicite et distincte de celle donnée pour la branche
    d'essai. L'autorisation sur la branche d'essai **ne vaut pas** pour
    Production.

### Arrêt immédiat

Les six critères du §6.3, ou tout résultat manquant, contradictoire ou non
vérifiable. Ne pas corriger automatiquement un écart de Production pendant
l'audit.

---

## 9. Verdict

**La bascule est techniquement préparée. Elle n'est pas autorisée.**

Ce qui est établi et mesuré : le runtime n'a qu'un point de connexion, donc la
bascule ne touche qu'une variable ; les 74 fonctions appelées sont exécutables
par `tracefab_app` ; le limiteur — seul point d'écriture directe, et en échec
fermé — fonctionne sous rôle restreint, avec contrôle négatif à l'appui ; les
50 tables ont la RLS activée et forcée ; la référence des 49 migrations est
exacte, donc l'outil de diagnostic est fiable.

Ce qui bloque, et qui n'est pas technique :

1. **Le rôle réel du runtime de Production n'est pas mesuré.** `neondb_owner`
   avec `rolbypassrls = true` reste une preuve antérieure, non reproduite.
   Aucune conclusion sur la sécurité de Production ne peut s'appuyer dessus —
   ni pour rassurer, ni pour alarmer.
2. **Deux politiques et une fonction `SECURITY DEFINER` restent inexpliquées.**
   Modifier le rôle d'exécution peut rendre actives des politiques jusqu'ici
   contournées. Agir sans les comprendre, c'est changer le comportement
   d'objets d'origine inconnue.
3. **Aucune mesure de Production n'est possible depuis cet environnement.**

Conformément à la contrainte : **la faisabilité de la bascule n'est pas une
preuve que la bascule est sûre.** Ce document établit la première, et identifie
précisément ce qui manque pour la seconde.

**Arrêt avant toute opération distante. Ce plan attend une approbation
explicite.**
