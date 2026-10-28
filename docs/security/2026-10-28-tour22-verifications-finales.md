# Tour 22 — vérifications finales avant fusion (28/10/2026)

Branche `arena/c27ddaa4-tracefab`, PR #102. SHA de départ :
`0d22c9b6a5140c88d90195122a9b8f7705d9240d`. Les corrections de ce tour portent
`2fce6c1` (Clerk), `2634cc1` (GUC produit), `6637da0` (garde statique) et
`9d302df` (registre des chantiers).

Aucune fusion, aucun déploiement, aucune écriture distante, aucune modification
de production. Toutes les mesures ci-dessous ont été **exécutées** sur une base
jetable ; ce qui ne l'a pas été est marqué `NOT RUN` ou `BLOCKED`.

---

## 1. Le parcours d'identité Clerk : un contrôle testé statiquement, désormais éprouvé

### Ce qui existait

`api/_lib/auth.ts` exigeait `verification.status === 'verified'` sur l'adresse
primaire Clerk avant de propager `tracefab.user_email`. La règle était juste,
mais seule une **assertion statique** la vérifiait (`test:context-integrity`
lisait le source et cherchait une expression régulière). Une assertion de forme
ne prouve pas un comportement : elle passe encore si la fonction n'est jamais
appelée, si la valeur est écrasée plus loin, ou si un autre chemin la contourne.

### Ce qui a changé

La règle est sortie dans `api/_lib/clerk-identity.ts` — une fonction pure, sans
accès base ni réseau :

```ts
export function verifiedPrimaryEmail(clerkUser: ClerkUserLike): string
```

`auth.ts` n'accède plus lui-même à `emailAddresses` : il appelle cette fonction.
`scripts/test_clerk_identity.mjs` l'éprouve **cas par cas**, en l'appelant
réellement :

| Cas | Attendu | Résultat |
|---|---|---|
| adresse primaire vérifiée | rendue telle quelle | PASS |
| adresse secondaire vérifiée, primaire vérifiée | la primaire est retenue | PASS |
| statut `unverified` / `transferable` / `failed` / absent | refus `clerk_email_unverified` | PASS (4 cas) |
| aucune adresse, primaire introuvable, primaire nulle, vide, blanche | refus `clerk_email_required` | PASS (5 cas) |
| espaces de bord | retirés | PASS |
| contenu des messages de refus | aucune adresse e-mail, motifs d'une liste fermée | PASS |

Commande : `npm run test:clerk-identity` — **exit 0**, et l'épreuve est branchée
dans `npm test`.

### Le test mord vraiment

Mutation volontaire de la fonction (garde neutralisée) : **7 échecs, exit 1**.
Restauration : **exit 0**. Sans cela, le test ne serait qu'une décoration.

### Ce que la mesure en base établit (rappel du tour précédent)

Politique `passport_access_select`, rôle `tracefab_app` sans `BYPASSRLS`,
demande d'accès créée pour `victime@example.test` :

| Contexte | Lignes visibles |
|---|---|
| sans GUC | 0 |
| `tracefab.user_email` = e-mail de la victime | **1** |
| `tracefab.user_email` = un autre e-mail | 0 |

Le GUC est la seule barrière, et l'application le remplit désormais uniquement
depuis une adresse **vérifiée**. La falsification directe du GUC par un client
n'est pas possible : il n'existe aucune route qui accepte une adresse e-mail
comme entrée de contexte (101 appels inventoriés par `test:context-integrity`,
tous posés depuis la principalité authentifiée).

---

## 2. Défaut trouvé puis corrigé : un GUC falsifiable sur `tracefab_products`

### Mesure (reproductible, base jetable, rôle `tracefab_app` sans BYPASSRLS)

`tracefab_app` détient INSERT, UPDATE et DELETE sur `tracefab_products`. Le
déclencheur `products_validate_brand_ownership` protège les champs calculés
(`version`, `data_completion`, `data_readiness`, `data_ready_at`) derrière deux
GUC de session. Mesure :

| Essai | Résultat |
|---|---|
| `UPDATE … SET version = version + 1` sans GUC | REFUS `P0001 computed_product_fields_are_not_client_writable` |
| `set_config('tracefab.internal_product_revision', 'true', true)` | ACCEPTÉ |
| le même `UPDATE`, GUC posé | **ACCEPTÉ (1 ligne)** |

Le rôle runtime peut donc réécrire lui-même la version d'un produit et son état
de readiness. C'est le même défaut de conception que celui corrigé par
`20261028120100` (worker) et `20261028120200` (documents) : **une autorisation
qui repose sur un GUC est une autorisation qui repose sur l'appelant**.

### Cartographie — 5 déclencheurs gardés par un GUC, 1 seule table exposée

| Table | GUC | Écriture directe de `tracefab_app` |
|---|---|---|
| `certifications` | `internal_certification_update` | non (I0 U0 D0) — protégée |
| `data_request_items` | `internal_data_collection_update` | non — protégée |
| `data_requests` | `internal_data_collection_update` | non — protégée |
| `documents` | `internal_document_update` | non — protégée |
| `tracefab_products` | `internal_product_revision`, `internal_product_readiness_update` | **oui (I1 U1 D1)** — exposée |

Sur les quatre premières, la barrière réelle est l'absence de privilège, pas le
GUC. Une seule table est concernée.

### Quatre corrections écrites et mesurées — aucune retenue

| Variante | Mesure | Pourquoi écartée |
|---|---|---|
| A. Déclencheur `DEFINER`, garde `current_user = 'tracefab_app'` | n'intercepte **rien** (version acceptée avec GUC forgé) | dans un `SECURITY DEFINER`, `current_user` vaut le propriétaire |
| B. Déclencheur `INVOKER`, lecture inline de `organizations` | refuse bien, mais message `product_requires_brand_organization` pour une organisation invisible | fait tomber `test:neon:cross-tenant` (« issue inclassée ») : RLS rend `NULL` |
| C. Déclencheur `INVOKER` + garde `current_user = session_user` | refuse aussi le **seed** et les scripts d'administration | casse l'exploitation légitime |
| D. `INVOKER` + aide `SECURITY DEFINER` | fonctionnelle, mais exige `GRANT EXECUTE` dans une migration postérieure | fait tomber l'invariant « aucune `SECURITY DEFINER` exécutable par `PUBLIC` », puis `test:neon:registre-fonctions` (grant direct interdit par construction) |

### La correction retenue — périmètre colonne

C'est la voie du précédent `20261028120200` : **retirer l'écriture directe**,
les mutations passant déjà par cinq fonctions `SECURITY DEFINER` déclarées au
registre (`tracefab_create_product`, `tracefab_update_product_data`,
`tracefab_start_product_revision`, `tracefab_set_dpp_publication`,
`tracefab_ingest_plm_erp_payload`).

Un retrait **total** aurait cassé deux chemins mesurés :

1. `api/_lib/bulk-operations/bulk-importer.ts` (`tx.tracefab_products.update` /
   `.create`) écrit les champs métier — c'est l'import en masse ;
2. `api/_routes/products/[productId].ts` archive en écrivant `status` et
   `updated_at`.

La migration `20261028130000_product_computed_fields_column_scoped` retire donc
`INSERT/UPDATE/DELETE/TRUNCATE` au niveau **table** et accorde `INSERT` et
`UPDATE` **colonne par colonne** sur les vingt colonnes métier. Les quatre
colonnes calculées en sont exclues : elles ne sont plus écrites que par les
fonctions. Aucune politique RLS, aucun déclencheur, aucune fonction, aucun nom
de registre ne change.

**Le provisionnement devait changer aussi.** `scripts/lib/tracefab_app_role.mjs`
listait `tracefab_products` dans `TABLES_ECRITURE_DIRECTE` et **ré-accordait**
l'écriture table à chaque exécution — mesuré : après `REVOKE` puis relance du
seed, `has_table_privilege` rendait I/U/D = true, annulant la migration. La
table quitte cette liste ; le module accorde les mêmes vingt colonnes, source
unique reprise par la garde statique.

Mesure après correctif, même banc, même rôle :

| Essai | Résultat |
|---|---|
| `UPDATE … SET version` (sans GUC) | **REFUS 42501** |
| le même, GUC forgé posé | **REFUS 42501** |
| `UPDATE … SET name` | ACCEPTÉ |
| `INSERT` produit | ACCEPTÉ (import en masse préservé) |
| `tracefab_start_product_revision` | ACCEPTÉ |
| `DELETE` produit | REFUS 42501 (aucun appel applicatif) |

### Non-régression, éprouvée dans les deux sens

`scripts/test_produit_champs_calcules.mjs` — 11 assertions, câblé en CI
(*Base*, étape « Champs calcules produit — hors de portee du role runtime ») :
privilèges table et colonne, refus sans GUC, refus **avec** le GUC forgé, champ
métier modifiable, `INSERT` possible, révision produit fonctionnelle, état final
inchangé.

Contrôle négatif exécuté : privilège table rendu → **4 échecs, exit 1** ;
correctif réappliqué → exit 0. Le test échoue donc bien sur l'état vulnérable.

La garde statique `test:tables-ecriture-directe` a d'abord **refusé** la
correction (une table écrite sans octroi table), ce qui a révélé le troisième
site d'écriture que je n'avais pas relevé. Elle distingue désormais les deux
périmètres et ajoute trois assertions : aucune colonne calculée dans la liste
accordée, pas de cumul avec un octroi table, liste explicite et bornée.
Éprouvée : `version` ajoutée à la liste accordée → échec nommé.

---

## 3. M6 — script de relevé livré, exécution `BLOCKED`

`docs/security/2026-10-28-m6-lecture-seule.sql` couvre les cinq points exigés :

1. `current_user`, `session_user`, `rolsuper`, `rolbypassrls`, `rolcreaterole`,
   `rolcreatedb`, et la matrice `pg_auth_members` (qui peut endosser qui) ;
2. propriétaires du schéma, des tables, des fonctions, des types ;
3. état de `_prisma_migrations` (compteurs, dernières entrées, échecs) ;
4. `relrowsecurity`, `relforcerowsecurity`, `pg_policies` (USING et WITH CHECK),
   et les tables sous RLS **sans aucune politique d'écriture** ;
5. privilèges effectifs de `tracefab_app`, privilèges hérités (`aclexplode`),
   privilèges accordés à `PUBLIC` sur tables **et fonctions**, fonctions
   exécutables hors registre, privilèges par défaut.

Garanties : `BEGIN READ ONLY` … `ROLLBACK`, aucune table temporaire, aucun
`CREATE`, aucun changement de rôle ni de GUC, aucun appel applicatif.

Éprouvé sur le banc jetable : **17 requêtes sur 20 rendent un résultat**. Les
trois restantes portent sur `_prisma_migrations`, absente d'une base reconstruite
par rejeu de fichiers SQL — d'où leur placement en **dernier bloc**, documenté :
une requête en échec avorte la transaction et masquerait les relevés suivants.

**M6 reste `BLOCKED`** : aucune connexion de production autorisée n'est
disponible ici, et aucun secret n'a été demandé ni affiché.

---

## 4. Résultats d'exécution de ce tour

Base reconstruite depuis zéro : **63/63 migrations**, puis `db:prepare-ci-role`
et `db:seed-rls` dans l'ordre du workflow.

Séquence complète du job *Base* (40 étapes) rejouée :

| État | Nombre | Détail |
|---|---|---|
| PASS | 33 | isolation RLS, inter-organisations, privilèges, registre, worker, cycle documentaire, DPP, écritures, quotas |
| BLOCKED | 2 | `db:generate` (moteurs non téléchargeables hors ligne), `db:deploy:throwaway` (moteur de migration absent) |
| NOT RUN | 1 | `npm ci` (dépendances déjà installées) |
| FAIL (instrument) | 4 | `garde-fous:neon`, `deploiement-publication`, `ecriture-non-authentifiee`, `audit-script` — artefacts du banc : client Prisma généré hors ligne (`P2038`) et base sans `_prisma_migrations` ; **verts en CI sur le même SHA** |

Après le correctif produit, la base a été reconstruite de nouveau (**63/63**) et
les seize suites ciblées rejouées, dont `produit-champs-calcules`,
`privileges-role-app`, `ecarts-privileges`, `cross-tenant`,
`registre-fonctions`, `worker-non-forgeable` : **16/16 exit 0**.

CI sur le SHA final `9d302df` : **7/7 vertes** — *Socle*, *Base*, *Parcours*,
*Verification*, *Chaîne*, *Vercel*, *Vercel Preview Comments*. L'étape
« Champs calcules produit — hors de portee du role runtime » y est `success`.

Hors séquence : `npm test` **exit 0** ; `api:typecheck`, `test:routes`,
`test:security:chantier1`, `test:production-readiness`, `test:clerk-proxy`,
`test:route-context-coverage` : exit 0.

`test:route-auth-coverage` échoue ici en `P2038` (client hors ligne) — suite non
incluse dans `npm test`, verte en CI.

---

## 5. Ce qui reste ouvert

1. **M3** — dépendance au privilège du propriétaire (`FORCE RLS` + fonctions
   `SECURITY DEFINER` + boucle `memberships_select_member`). Inchangée, décision
   suspendue à M6.
2. ~~GUC falsifiable sur `tracefab_products`~~ — **corrigé** (§2), avec test de
   non-régression câblé en CI et contrôle négatif.
3. **M6** — `BLOCKED` faute de connexion de production autorisée.
4. **Migrations** : le dépôt compte désormais 63 migrations. Le registre
   `docs/experience/CHANTIERS-RESTANTS.md` a été mis à jour en conséquence.
