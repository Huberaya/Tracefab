# P10.4 — Bascule du runtime vers `tracefab_app` : préparation mesurée

**Statut : préparée, NON exécutée. Aucun déploiement, aucune variable modifiée,
aucune écriture sur Neon Production.**

Ce document ne conclut pas « prêt à basculer ». Il mesure ce qui peut l'être
sans accès à la production, et nomme précisément les quatre mesures qui
manquent — chacune étant un blocage, pas une formalité.

Toutes les mesures de ce document ont été faites sur un **cluster jetable**
(PostgreSQL 17.10, `127.0.0.1:55435`), avec une topologie reproduisant celle de
production :

| Rôle | Attributs | Propriété | Rôle de production analogue |
|---|---|---|---|
| `tf_p104_owner` | `NOSUPERUSER BYPASSRLS CREATEROLE`, `LOGIN` | 52 tables, 118 fonctions `SECURITY DEFINER` | `neondb_owner` |
| `tracefab_app` | `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, `LOGIN` | aucune | `tracefab_app` |
| `tracefab_worker` | `NOLOGIN NOINHERIT NOBYPASSRLS` | 6 fonctions `SECURITY DEFINER` | `tracefab_worker` |

---

## 1. Inventaire des composants et de leur rôle PostgreSQL

### 1.1 Ce que le code prouve

| Composant | Point d'entrée | Accès base | Rôle utilisé |
|---|---|---|---|
| API serverless (135 routes) | `api/index.ts` → `api/_routes/**` | client Prisma **unique** (`api/_lib/prisma.ts`, seul `new PrismaClient()` de `api/`) | `DATABASE_URL` |
| Route de readiness interne | `api/_routes/internal/p2-readiness.ts` | même client | `DATABASE_URL` |
| Tâche planifiée quotidienne | `vercel.json` → `/api/internal/notification-outbox/schedule` | même client | `DATABASE_URL` |
| Traitement différé (outbox) | `internal/notification-outbox/{process,reminders,health}` | même client | `DATABASE_URL` |
| Webhook Clerk | `api/_routes/webhooks/clerk.ts` | même client, contexte worker | `DATABASE_URL` |
| Ingestion PLM/ERP | `api/_routes/integrations/ingest.ts` → `tracefab_ingest_plm_erp_payload` | même client, dans la transaction authentifiée | `DATABASE_URL` |
| Migrations | `prisma migrate deploy` | connexion directe | rôle de migration (propriétaire) |
| Suites de test / maintenance | `scripts/*.mjs` | `DATABASE_URL` (admin) et `TF_RLS_APP_URL` (applicatif) | deux rôles distincts |

**Preuve structurelle** : `grep` sur `api/` ne rend **qu'une seule** variable de
connexion base — `DATABASE_URL` (quatre occurrences, dont trois dans
`readiness-probes.ts`). `TRACEFAB_NOTIFICATION_ALERT_URL`,
`PRIVATE_STORAGE_ANTIVIRUS_URL` et `TRACEFAB_ERROR_WEBHOOK_URL` sont des
webhooks HTTP, pas des bases. Il n'existe donc **aucun composant runtime avec un
rôle distinct** : basculer `DATABASE_URL` bascule tout, d'un seul coup. C'est
une bonne nouvelle pour l'exploitation, et une mauvaise pour le cloisonnement —
une fuite d'identifiant vaut pour les 135 routes, le cron et le webhook.

### 1.2 Ce que le code ne prouve pas

Le **nom** du rôle que contient `DATABASE_URL` n'est pas déductible du dépôt.
Trois instruments existent pour le mesurer, et aucun n'a pu être exécuté ici
(aucun identifiant de production, et la mission interdit d'en manipuler) :

| Instrument | Ce qu'il rend | Écriture |
|---|---|---|
| `GET /api/internal/p2-readiness?identity=1` (en-tête `x-tracefab-worker-secret`) | `current_user`, `session_user`, `bypassesRls`, `isSuperuser` — lus **sur la connexion Prisma des routes** | aucune |
| `npm run db:role-runtime` | même mesure depuis un poste, plus le nombre de lignes visibles sans contexte | aucune |
| `SELECT current_user, rolsuper, rolbypassrls, …` (éditeur SQL Neon) | identité de la connexion de l'éditeur, pas celle du runtime | aucune |

**Mesure de discrimination** (cluster jetable) : la sonde distingue réellement
les deux postures, ce qui prouve qu'elle n'est pas décorative.

| Connexion | `current_user` | contourne RLS | produits visibles **sans** contexte |
|---|---|---|---|
| `tracefab_app` | `tracefab_app` | `false` | **0** |
| `tf_p104_owner` | `tf_p104_owner` | `true` | **4** |

> **Blocage B1.** L'identité réelle du runtime de production n'est pas mesurée.
> Tant qu'elle ne l'est pas, aucune des affirmations de ce document ne peut être
> appliquée à la production, et la bascule ne peut pas être déclarée prête.

---

## 2. Capacité réelle de `tracefab_app` — matrice des privilèges effectifs

Mesurée sur la topologie ci-dessus, par le catalogue **et** par exécution.

| Contrôle | Résultat mesuré |
|---|---|
| `SUPERUSER` | `false` |
| `BYPASSRLS` | `false` |
| `CREATEDB`, `CREATEROLE` | `false`, `false` |
| Propriété de tables | **0** sur 52 |
| Propriété de fonctions | **0** sur 124 |
| Appartenance à un rôle | **aucune** (ni propriétaire, ni worker) |
| `CREATE` sur le schéma `public` | refusé |
| Lecture (`SELECT`) | 51 tables publiques, filtrées par RLS |
| Écriture directe (DML) | **16 tables** — exactement la liste déclarée, 19 tables en lecture seule |
| `_prisma_migrations` | ni lisible ni modifiable par le rôle applicatif |
| `EXECUTE` sur l'allowlist runtime | **91/91** |
| `SECURITY DEFINER` hors allowlist exécutables | **0** |
| RLS | 51/51 tables, **51/51 forcées**, 132 politiques |
| Séquences | 0 (aucune séquence à accorder) |

**Verdict outillé** : `npm run db:disponibilite-role-app` (lecture seule, sortie
0 = prêt, 1 = obstacle) rend « le rôle est prêt pour la bascule » sur cette
topologie, puis « 1 obstacle » dès qu'une fonction hors allowlist devient
exécutable.

### 2.1 Le contrôle qui décide de tout, et que ce verdict ne fait pas

`BYPASSRLS` ne s'hérite pas : il s'obtient par `SET ROLE`. Si `tracefab_app`
était membre du rôle propriétaire, la bascule serait **cosmétique**. Mesuré sur
le cluster jetable, appartenance accordée puis révoquée :

| État | `tracefab_app` sans contexte | après `SET ROLE tf_p104_owner` |
|---|---|---|
| sans appartenance | 0 produit | `SET ROLE` refusé |
| **avec appartenance** | 0 produit | **4 produits — les deux locataires** |

Le script de disponibilité signale bien un obstacle dans ce cas (39 fonctions
hors allowlist deviennent exécutables par héritage), mais **ce n'est qu'un
symptôme** : le danger est l'appartenance elle-même.

> **Blocage B4.** Le sens de l'appartenance `tracefab_app` ↔ propriétaire n'est
> pas mesuré en production. SQL de mesure, lecture seule et déjà éprouvé en CI :
> `docs/security/2026-10-28-appartenances-roles-production.sql`
> (`npm run test:appartenances-roles:sql` le joue avant de le livrer).

### 2.2 Migrations avec un rôle distinct

| Scénario | Résultat mesuré |
|---|---|
| Chaîne complète (67 migrations) exécutée par un **superutilisateur** | **67/67** |
| Chaîne complète exécutée par le propriétaire **non superutilisateur**, base neuve | **66/67** — `20261028120100` → `42501 must be able to SET ROLE "tracefab_worker"` |
| Même migration rejouée sur base où `tracefab_worker` existe déjà | `42501 permission denied to alter role` (`ALTER ROLE … NOSUPERUSER` exige `SUPERUSER`, mesuré attribut par attribut) |
| **Migration de cette PR** (`20261030140000`) par le propriétaire non superutilisateur | **acceptée** (jouée puis annulée) |
| Même migration par `tracefab_app` | **refusée** `42501 permission denied for schema public` |

Deux conséquences, toutes deux vérifiées :

1. **la séparation des rôles pour les migrations fonctionne** : la migration de
   cette PR s'applique sous le propriétaire et **pas** sous le rôle applicatif ;
2. **la chaîne historique n'est applicable que par un superutilisateur** sur
   PostgreSQL ≥ 16. Depuis PostgreSQL 16, un rôle créé par un `CREATEROLE`
   reçoit l'`ADMIN` mais **ni `SET` ni `INHERIT`** ; la migration
   `20261028120100` saute son `GRANT` parce que `pg_has_role(…,'MEMBER')` est
   déjà vrai, puis échoue sur `ALTER FUNCTION … OWNER TO tracefab_worker`.

> **Blocage B2.** Si `20261028120100` est **déjà appliquée** en production, la
> suite ne pose pas de problème. Si elle est **en attente**, `neondb_owner` ne
> peut pas l'appliquer sur PostgreSQL ≥ 16 : il faut un exécutant superutilisateur,
> ou traiter cette migration à part. Cette question se tranche par une lecture de
> `_prisma_migrations` (sonde `docs/security/2026-10-30-p103-sonde-lecture-seule.sql`).

> **Blocage B3.** `scripts/lib/tracefab_app_role.mjs` (`ensureAppRole`) réaffirme
> les attributs du rôle par `ALTER ROLE … NOSUPERUSER`, refusé à un exécutant non
> superutilisateur (`42501 Only roles with the SUPERUSER attribute may change the
> SUPERUSER attribute`, mesuré). En clair : **créer** `tracefab_app` est possible
> depuis un rôle `CREATEROLE`, **le durcir** ou le réparer ne l'est pas. Le
> provisioning de production doit donc être fait par un rôle superutilisateur,
> ou l'assistant adapté.

### 2.3 Pooling

Tous les contextes arment `set_config(…, true)` — portée **transactionnelle** —
à l'intérieur de `prisma.$transaction`. Vérifié par exécution avec un pool de
**une** connexion physique, réutilisée quatre fois :

```
même connexion (pid 10485) : avec contexte -> 2 produits
                            sans contexte -> 0
                            avec contexte -> 2
                            sans contexte -> 0
```

Aucun contexte ne survit à sa transaction : le pool ne peut pas servir à un
utilisateur l'identité d'un autre.

**Point d'attention (A-3)** : `prisma/schema.prisma` ne déclare **que**
`url = env("DATABASE_URL")`, sans `directUrl`. Or
`docs/operations/variables-environnement.md` décrit `DATABASE_URL` comme
« Connexion Neon, pooler inclus ». Si l'URL est effectivement celle du pooler
(hôte contenant `-pooler`), `prisma migrate deploy` passe par un pooler en mode
transaction, qui ne tient pas les verrous de session attendus par le moteur de
migration. À vérifier avant tout déploiement.

### 2.4 Clés HMAC (préparation)

L'ACL qui portera la clé a été éprouvée sur le cluster jetable : table
`tracefab_identity_keys` possédée par le propriétaire, sans aucun `GRANT` au
rôle applicatif.

| Essai, connecté en `tracefab_app` | Résultat |
|---|---|
| `SELECT count(*) FROM tracefab_identity_keys` | **42501 permission denied** |
| `has_table_privilege(…,'SELECT')` | `false` |
| appel de la fonction de vérification | accepté (`false` sur un jeton faux) |
| jeton correct (MAC calculé hors base) | `true` |
| jeton falsifié (identité changée, MAC conservé) | `false` |

---

## 3. Simulation complète de bascule — preuves

Base `tracefab` du cluster jetable, 67 migrations, fixtures `db:seed-rls`
(deux locataires, quatre produits), puis exécution **sous `tracefab_app` réel**.

| # | Étape | Résultat |
|---|---|---|
| 1 | Démarrer sous le propriétaire | produits visibles sans contexte : **4** (deux locataires) — RLS non opposable |
| 2 | Basculer vers `tracefab_app` | sans contexte : **0** |
| 3 | Parcours complets (quatre contextes) | `test_neon:app-readiness` **13/13** |
| 4 | Fonctions `SECURITY DEFINER` | allowlist 91/91 exécutables, 0 hors allowlist ; worker `test:neon:worker-non-forgeable` vert |
| 5 | Ingestion PLM/ERP | voir ci-dessous |
| 6 | Workers et traitements différés | `test:plm:rls-isolation` **43 vérifications**, contrat du planificateur de notifications vert |
| 7 | Deux organisations | `Maison Alpha` / `Maison Beta`, produits visibles 3 vs 5 selon le rôle |
| 8 | Refus inter-organisations | `test:neon:isolation` (7 tables), `test:neon:write-policies` **16/16**, `test:rls:bypass-controle-negatif` **6/6** |
| 9 | Migrations avec le rôle dédié | § 2.2 |
| 10 | Absence de `BYPASSRLS` | § 2 |
| 11 | **Retour au rôle précédent** (jetable uniquement) | propriétaire → applicatif → propriétaire → applicatif : ingestion **SUCCÈS** aux quatre tours |

### 3.1 Ingestion sous `tracefab_app`

| Scénario | Résultat mesuré |
|---|---|
| M1 — identité légitime de A, sur A | **SUCCÈS**, 1 produit écrit |
| M2 — identité de A, sur l'organisation B | **REFUS** `brand_product_role_required` |
| M3 — identité **forgée** du propriétaire de B, sur B | **SUCCÈS**, 1 produit écrit |
| M4 — aucune identité posée | **REFUS** `authentication_required` |

Les quatre transactions sont annulées : aucune ligne résiduelle.

**M3 est le résultat le plus important de la mission.** La bascule ferme
R-A3 (contournement de la RLS par le rôle propriétaire) ; elle **ne ferme pas**
R-A1 : un détenteur des identifiants `tracefab_app` forge toujours
`tracefab.user_id` et écrit chez n'importe quel locataire. C'est exactement ce
que l'architecture HMAC du § 4 doit fermer, et elle seule.

### 3.2 Suites exécutées et résultats

| Suite | Résultat |
|---|---|
| `test:neon:app-readiness` | 13/13 |
| `test:neon:write-policies` | 16/16 |
| `test:rls:bypass-controle-negatif` | 6/6 |
| `test:neon:isolation` | vert (7 tables porteuses, contexte public, contexte non persistant) |
| `test:jetables:ingest-acl` | 30/30 |
| `test:plm:rls-isolation` | 43 vérifications |
| `test:neon:privileges-role-app` | 40/40 |
| `test:neon:ecarts-privileges` | 13/13 |
| `test:neon:worker-non-forgeable` | vert |
| `test_notification_scheduler.mjs` | vert |
| `db:disponibilite-role-app` | « prêt pour la bascule », sortie 0 |
| `db:role-runtime` | distingue les deux rôles (§ 1.2) |
| `test_routes_sous_role_app` / couverture de contexte | 25/25 routes sans Clerk classées |

**Une suite n'a pas pu tourner** : `test_neon_plm_erp_gs1.mjs` échoue en
`P6001` — elle passe par le SDK Prisma, dont le client n'est pas générable hors
ligne (`binaries.prisma.sh`, TLS). Ce n'est pas une régression : c'est la limite
connue, et la CI est le premier juge du moteur natif.

---

## 4. Architecture HMAC (conçue, non implémentée)

**Non implémentée** : la mission l'interdit avant validation de la bascule, et
l'implémenter avant l'étape 1 serait un contrôle décoratif — le propriétaire
lirait la clé.

### 4.1 Le principe

L'application authentifie (Clerk), puis **signe** l'identité résolue. La base
**vérifie**. Le GUC seul cesse d'être une preuve : il ne vaut que s'il est
accompagné d'un MAC valide, calculé avec une clé que le rôle applicatif ne peut
pas lire.

```
jeton = "v1|user_id|org_id|purpose|exp" "." HMAC-SHA256(K, "v1|user_id|org_id|purpose|exp")
```

`tracefab_current_user_id()` — appelée, directement ou non, par les 72 fonctions
qui dépendent de l'identité — devient le point unique de vérification :

1. lit `tracefab.identity` (posé par `withTracefabUserContext`, portée
   transactionnelle) ;
2. recompose le corps, recalcule le MAC avec la clé active (et la précédente
   pendant une rotation) ;
3. vérifie `exp` (60 s) et le `purpose` attendu ;
4. rend `user_id` si tout est juste, **`NULL` sinon** — et toutes les fonctions
   d'autorisation répondent alors faux : échec fermé.

### 4.2 Ce que chaque exigence de la mission impose

| Exigence | Réponse |
|---|---|
| La clé ne peut pas être lue par `tracefab_app` | table `tracefab_identity_keys` sans `GRANT`, lue uniquement depuis une fonction `SECURITY DEFINER` possédée par un rôle auquel `tracefab_app` n'appartient pas (§ 2.4, mesuré) |
| Aucune fonction de signature arbitraire | la seule fonction exposée prend un jeton et rend un booléen ; **aucune** fonction ne rend un MAC. Pas d'oracle de signature |
| Jeton limité dans le temps | `exp` = maintenant + 60 s, vérifié côté base (horloge base) |
| Jeton lié au contexte | `user_id`, `org_id` et `purpose` sont dans le corps signé : un jeton d'organisation A ne vaut pas pour B |
| Le pool ne conserve pas un contexte | déjà assuré par `set_config(…, true)` (§ 2.3) ; le jeton ne change rien à cette propriété |
| Transactions | aucune connexion supplémentaire, aucun aller-retour : le jeton est posé par la **même** instruction que le contexte actuel |

### 4.3 Scénarios adverses

| Scénario | Sans HMAC (aujourd'hui) | Avec HMAC |
|---|---|---|
| Falsification du GUC seul | **écriture chez la victime** (M3, mesuré) | refus : MAC absent |
| Falsification du GUC + reprise d'un MAC observé | — | refus : le MAC couvre l'identité |
| Jeton rejoué par le même utilisateur dans les 60 s | — | accepté ; borné par `exp`. Nonce à ajouter seulement si le besoin est prouvé (coût : une écriture par requête) |
| Jeton expiré | — | refus |
| Changement d'organisation | libre | refus : `org_id` signé |
| Fuite des identifiants DB (`tracefab_app`) | usurpation totale | **aucune signature possible** : la clé n'est pas lisible par ce rôle |
| Compromission du processus serveur | totale | totale — le serveur détient la clé. Hors de portée d'une barrière base |
| Rotation de clé | — | deux clés actives pendant la fenêtre, `version` dans le corps |

### 4.4 Coût

Mesuré en P10.3 sur le même cluster : `hmac()` en base **0,05 µs**, HMAC Node
**1,98 µs**, appel d'une fonction `SECURITY DEFINER` **4,81 µs**, aller-retour
réseau **148,6 µs**. Le surcoût est de l'ordre de **2 µs par requête**, sans
aller-retour supplémentaire : négligeable devant le reste.

### 4.5 Ordre imposé

1. basculer le runtime vers `tracefab_app` (sinon le propriétaire lit la clé) ;
2. vérifier qu'`app` n'est membre d'aucun rôle privilégié (B4) ;
3. provisionner la clé **par l'opérateur**, jamais par l'application ;
4. déployer la vérification, double lecture pendant une version, puis retrait du GUC nu.

---

## 5. PITR — procédure de relevé, non exécutée

Aucune lecture de Neon n'a été faite : pas d'identifiant, et la mission
l'interdit. Ce qui suit est la procédure exacte à exécuter **en lecture seule**.

| À relever | Où | Lecture seule |
|---|---|---|
| Rétention d'historique effective | Console Neon → Project → Settings → Storage ; API `GET /api/v2/projects/{project_id}` → `history_retention_seconds` | oui |
| Fenêtre réellement restaurable | API `GET /api/v2/projects/{project_id}/branches` → `restore_until` de la branche primary | oui |
| Options offertes par l'offre | Console, même écran ; comparer au palier du compte | oui |
| Délai de restauration | **exercice** : créer une branche enfant à un horodatage donné, mesurer le temps, la supprimer | crée une ressource, ne modifie pas la production |

**Limites à documenter** : la rétention couvre la restauration *à un instant*,
pas la récupération d'une ligne supprimée sans retour arrière complet ; une
restauration remplace l'état de la branche, elle ne fusionne pas ; et un
`DROP` de branche n'est pas rattrapable au-delà de la fenêtre.

**Fenêtre cible proposée : 7 jours**, pour trois raisons : (a) une corruption
silencieuse se découvre rarement dans les 24 h — elle apparaît via un ticket
client ; (b) la bascule elle-même doit rester annulable plusieurs jours sans
perte ; (c) au-delà de 7 jours, la probabilité d'un incident non détecté
devient très faible alors que le coût de stockage croît linéairement. **Aucune
modification de rétention n'est demandée ni effectuée.**

---

## 6. Procédure de bascule et retour arrière

### 6.1 Préconditions (toutes bloquantes)

1. `npm run db:role-runtime` sur la base visée : `role_de_connexion` = rôle du
   runtime, et `contourne_rls` = `true` **avant** bascule (sinon il n'y a rien à
   basculer).
2. `docs/security/2026-10-28-appartenances-roles-production.sql` : `tracefab_app`
   **n'est pas** membre du propriétaire (B4).
3. `npm run db:disponibilite-role-app` : sortie 0.
4. `_prisma_migrations` : `20261028120100` appliquée (B2), et historique sans
   dérive.
5. Le rôle de migration est identifié, et il peut appliquer les migrations en
   attente (mesuré : oui pour celle de cette PR, non pour la chaîne historique
   sous un rôle non superutilisateur).
6. La chaîne de connexion de secours du rôle actuel est conservée **hors de tout
   fichier versionné**.

### 6.2 Bascule — Preview d'abord

1. Renseigner `DATABASE_URL` de **Preview** avec `tracefab_app` (jamais Production).
2. Déployer une Preview depuis la branche.
3. Sonder les routes sensibles à la RLS : `/api/health`,
   `/api/internal/p2-readiness?identity=1` (doit rendre `tracefab_app`,
   `bypassesRls=false`), une route publique (`/dpp?gtin=…`), une route
   authentifiée, et le provisionnement Clerk.
4. Deux comptes de deux organisations : chacun ne voit que ses données.
5. Ingestion PLM/ERP sur la Preview : succès sur sa propre organisation, refus
   sur l'autre.

### 6.3 Production

6. Même séquence, sur autorisation explicite. Surveiller une heure : `42501`,
   `row-level security`, `P2028`, et le taux de réponses vides sur les routes
   publiques.

### 6.4 Retour arrière

La bascule est un **changement de variable d'environnement** : le retour est de
même nature et de même ampleur. Rebasculer `DATABASE_URL` sur la valeur
conservée, redéployer. **Aucune migration à défaire, aucune donnée à restaurer.**

Le retour a été exercé sur la base jetable (propriétaire → applicatif →
propriétaire → applicatif, ingestion réussie aux quatre tours). Il n'a **pas**
été exercé en Preview ni en production.

---

## 7. Ce que ce document n'établit pas

- l'identité du runtime de production (B1) ;
- le sens de l'appartenance des rôles en production (B4) ;
- l'état de l'historique de migrations en production (B2) ;
- la rétention PITR effective ;
- le comportement du SDK Prisma sous `tracefab_app` : reproduit instruction pour
  instruction, jamais exécuté hors ligne ;
- le comportement du pooler Neon avec `prisma migrate deploy` (A-3).
