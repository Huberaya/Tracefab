# P10.7 / P12 · Plan de réconciliation et d'activation stricte (chaîne de 100 migrations)

Ce plan décrit **ce qu'un opérateur doit faire**, dans quel ordre, avec quel
rôle, et ce qui l'arrête. Il ne décrit aucune action qui aurait déjà été
exécutée sur la Production : **aucune migration distante ni aucune bascule
`strict` / `systeme_strict` n'a été appliquée sur Neon Production** dans ce
chantier.

Rappel des contraintes permanentes :

- la chaîne du dépôt compte **100 migrations** dans `prisma/migrations`, appliquées
  dans l'ordre lexicographique strict des noms de dossier ;
- **deux modes stricts indépendants** vivent dans `public.tracefab_identity_politique` :
  - `strict` (identité **utilisateur**, jeton `tracefab_identity`) — installé à
    `false` par `20261031120000` / `20261102120000` ;
  - `systeme_strict` (identité **système**, jeton `tracefab_system` pour les 13
    opérations Clerk/outbox) — installé à `false` par `20261106130000_identite_systeme_signee` ;
- **aucun basculement n'est dans une migration** : une chaîne de migrations ne
  peut pas exiger un secret CSPRNG sans casser toute base neuve ou éphémère ;
- le préflight de propriété **D6** (`scripts/lib/preflight_proprietaires.mjs`) et
  le préflight d'isolation worker Neon (`scripts/provisionner_worker_neon.mjs --etat`) ne
  sont **jamais** contournés.

---

## 1 · État mesuré de la chaîne (100 migrations)

Sur `main`, le décompte vérifié par `node scripts/matrice_migrations.mjs --verifier`
et `node scripts/plan_reconciliation_migrations.mjs` s'établit ainsi par rapport
au relevé en lecture seule de Neon Production :

| Catégorie | Nombre | Détail |
|---|---|---|
| **Migrations du dépôt (`prisma/migrations`)** | **100** | ordre lexicographique strict, 4 paires historiques sans dépendance croisée |
| **Déjà attestées sur Neon Production** | **56** | 49 standard + 2 reprises réussies (`20261010120000`, `20261017120000`) + 5 hors bande |
| **Historiques absentes du journal Production** | **10** | de `20261021170000_dpp_readiness_truthful_gates` à `20261028150000_reconcile_plm_erp_sync_job_policies` |
| **Nouvelles (postérieures au relevé)** | **34** | de `20261029180000_plm_erp_sync_jobs_policy_dedup` à `20261112120000_grants_helpers_entre_fonctions_definer` |
| **Total restant à réconcilier sur Production** | **44** | `10 + 34 = 44` (`56 + 44 = 100`) |

### Jalons critiques parmi les 44 migrations en attente

| Migration | Ce qu'elle installe ou vérifie | Contrainte d'exécution |
|---|---|---|
| `20261028120000_runtime_function_registry` | table `tracefab_runtime_function_registry` (seed de **84** fonctions historiques) + `tracefab_apply_runtime_function_grants()` | **Non rejouable** manuellement (`CREATE TABLE` sans `IF NOT EXISTS`) : vérifier l'absence de la table et les 84 fonctions avant lancement |
| `20261028120100_worker_identity_not_forgeable` | crée `tracefab_worker` (`NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`), réindexe les politiques worker sur `current_user`, transfère 6 fonctions système | Bail worker borné requis (ou session propriétaire capable de transférer vers `tracefab_worker`) |
| `20261031120000_identite_hmac_liee_au_contexte` | tables `tracefab_identity_cles` et `tracefab_identity_politique` (`strict = false`), vérificateur `tracefab_identity_jeton_utilisateur(text)` | Bail worker temporaire requis |
| `20261102120000_identite_stricte_email_et_rotation` | `tracefab_current_user_email()` liée à l'identité signée en mode strict, attestations mass-balance sur `tracefab_current_user_id()`, rotation multi-clés actives | Exige le **propriétaire** des 6 fonctions remplacées (préflight D6) |
| `20261105120000` → `20261106000000` (série `active_tenant_*`) | fermeture RLS et gardes `SECURITY DEFINER` sur le tenant actif (`tracefab_in_active_tenant`) ; `20261105235900` transfère `tracefab_current_user_email()` à `tracefab_worker` | `20261105235900` exige le bail worker temporaire |
| `20261106130000_identite_systeme_signee` | colonne `systeme_strict = false`, `tracefab_identite_systeme_jeton_valide(text)`, `tracefab_identite_systeme()`, garde d'origine sur les **13** opérations système, sonde `tracefab_sec_probe_identite_systeme()` | Le registre runtime atteint **93** fonctions autorisées (84 + 9 ajouts) |
| `20261108119900_assert_neon_worker_preflight` | **garde fail-closed Neon** : refuse si `cloud_admin` a laissé un grant `ADMIN OPTION` direct de `tracefab_migrator` sur `tracefab_worker` non isolé sous `tracefab_worker_legacy` | Sur Neon, vérifier `--etat` puis exécuter `scripts/provisionner_worker_neon.mjs --appliquer` avant la chaîne |
| `20261108120100` & `20261108120200` | transfert de `tracefab_sync_clerk_membership` et `tracefab_revoke_clerk_membership` à `tracefab_worker` + droits minimaux `organization_memberships` + nettoyage d'appartenance | Bail worker temporaire dans la transaction |
| `20261108120700_assert_worker_membership_revoked` | **garde terminale** : échoue fermé si `tracefab_migrator` ou `tracefab_app` est encore membre de `tracefab_worker`, ou si `tracefab_migrator` est `SUPERUSER` | Toute appartenance temporaire doit être révoquée avant cette migration |
| `20261109170000_p107_expiration_floor` | borne temporelle `floor(extract(epoch FROM now()))::bigint` (plafond exact de 600 s sans arrondi) sur les vérificateurs utilisateur et système | Remplace les deux fonctions de vérification HMAC |
| `20261109190000_p107_worker_organizations_update` | politique RLS `organizations_worker_update` bornée à `CURRENT_USER = 'tracefab_worker'`, conditionnée à ce que les fonctions worker soient gardées | Permet l'archivage système d'organisation sous `FORCE ROW LEVEL SECURITY` |
| `20261112120000_grants_helpers_entre_fonctions_definer` | accorde `EXECUTE` sur `tracefab_current_user_email()` à `tracefab_migrator` sans ouvrir `PUBLIC` (requis par `tracefab_accept_organization_invitation` et `tracefab_register_supplier_organization`) | Bail worker temporaire requis (`tracefab_current_user_email` appartient à `tracefab_worker`) |

---

## 2 · Les sept migrations à bail `tracefab_worker` temporaire

La liste fermée est définie en un seul endroit (`scripts/lib/migrations_worker_temporaire.mjs`),
partagée entre `scripts/migrer_fidelement.mjs`, `scripts/lib/appliquer_chaine_comme_le_runner.mjs`
et `scripts/lib/pglite-worker-runner.mjs` :

1. `20261028120100_worker_identity_not_forgeable`
2. `20261028120200_document_reserved_fields_internal_only`
3. `20261031120000_identite_hmac_liee_au_contexte`
4. `20261105235900_active_tenant_policy_and_worker_closure`
5. `20261108120100_worker_fonctions_systeme_completes`
6. `20261108120200_corrections_p106_ownership_et_appartenance`
7. `20261112120000_grants_helpers_entre_fonctions_definer`

**Distinction impérative entre rehearsal et Production :**

- **`scripts/migrer_fidelement.mjs`** sert exclusivement au **rehearsal sur base
  de test ou branche jetable** (il refuse explicitement l'hôte de Production en
  code `3`).
- **Sur Neon (branche de répétition issue d'un fork PITR, puis Production)** :
  - les écritures de schéma passent par **`npx prisma migrate deploy`** sur
    connexion directe (sans `-pooler`) ;
  - lorsque `tracefab_worker` a été créé sous Neon avec un grant `cloud_admin`
    portant `ADMIN OPTION`, l'opérateur exécute d'abord hors `_prisma_migrations`
    le préflight `scripts/provisionner_worker_neon.mjs` (`--dry-run` / `--etat`,
    puis `--appliquer` avec confirmation explicite d'hôte et de base) afin
    d'isoler `tracefab_worker_legacy` avant `20261108119900` ;
  - entre `20261108120200` et `20261108120700`, aucune appartenance permanente
    de `tracefab_migrator` à `tracefab_worker` ne doit subsister ; pour
    `20261112120000`, le propriétaire administratif accorde le bail `SET/INHERIT`
    (`ADMIN FALSE`) le temps de l'application puis le révoque immédiatement.

---

## 3 · Préconditions (à mesurer en lecture seule avant toute action)

Aucune précondition n'est supposée : chacune a sa sonde en lecture seule.

### 3.1 Sonde de catalogue (13 requêtes `SELECT`/`WITH`, preuve SQLSTATE `25006`)

```bash
TF_P107_AUTORISER_HOTE_DISTANT=oui \
node scripts/sonde_p107_etat_cible.mjs \
  --url "$TRACEFAB_LECTURE_URL" \
  --role-runtime tracefab_app \
  --json > mesure-avant.json
```

### 3.2 Préflight du registre des fonctions (`84` seed → `93` cible)

```bash
psql "$TRACEFAB_LECTURE_URL" -X -v ON_ERROR_STOP=1 \
  -f docs/security/2026-11-11-p107-production-registry-preflight.sql
```

### 3.3 Préflight d'isolation du rôle worker Neon et de `pgcrypto` (lecture seule)

```bash
DATABASE_ADMIN_URL="$DIRECT_NEONDB_OWNER_URL" \
node scripts/provisionner_roles_db.mjs --verifier

DATABASE_URL="$DIRECT_MIGRATOR_URL" \
TF_ADMIN_URL="$DIRECT_NEONDB_OWNER_URL" \
node scripts/provisionner_worker_neon.mjs --etat
```

### 3.4 Sonde côté runtime

```bash
TF_P107_AUTORISER_HOTE_DISTANT=oui \
node scripts/sonde_p107_runtime.mjs \
  --url "$TRACEFAB_RUNTIME_URL" \
  --role-attendu tracefab_app \
  --json > runtime-avant.json
```

et sur le déploiement HTTP (avec le secret worker) :

```bash
curl -fsS -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2-readiness?identity=1"
```

### Matrice des préconditions et conditions d'arrêt

| # | Précondition | Preuve exigée | Arrêt immédiat si |
|---|---|---|---|
| **P1** | Historique `_prisma_migrations` sain | `b1_historique.en_echec = 0` et `verifier_checksums_migrations.mjs` sans écart | une migration `finished_at IS NULL AND rolled_back_at IS NULL` ou un checksum divergent subsiste |
| **P2** | Préflight du registre des fonctions | `registered_expected = 84`, `missing_functions = 0`, `overloaded_names = 0`, `wrong_owner_count = 0` | une fonction historique manque, est surchargée ou appartient à un rôle tiers |
| **P3** | Propriétaires des fonctions remplacées (D6) | `b4_proprietaires` : les 6 fonctions appartiennent au rôle de migration ou à `tracefab_worker` | propriétaire injoignable par l'exécutant (`42501 must be owner of function`) |
| **P4** | Hygiène `SECURITY DEFINER` et ACL `PUBLIC` | `b5_hygiene.definer_sans_search_path = 0`, `executables_par_public = 0` (les éventuelles fonctions membres d'extensions plateforme détenues par un superuser externe comme `cloud_admin` sur Neon sont classées séparément dans `extensions_plateforme_publiques` conformément à `#136`) | une fonction `SECURITY DEFINER` sans `search_path`, ou une fonction applicative / `SECURITY DEFINER` ouverte à `PUBLIC` |
| **P5** | Rôles et worker Neon | `b6_droits_migration.migrator_superuser = false`, `app_membre_worker = false`, `neon_worker_swap_requis = false` | `tracefab_migrator` superuser, `tracefab_app` membre du worker, ou swap `tracefab_worker_legacy` non exécuté |
| **P6** | Clés hors de portée du runtime | `b8_portee_de_la_cle.app_lit_les_cles = false`, `app_ecrit_les_cles = false` | `tracefab_app` lit ou écrit `tracefab_identity_cles` |
| **P7** | Identité réelle du runtime | `sonde_p107_runtime.mjs` → `IDENTITE_CONFORME` (`tracefab_app`, `NOSUPERUSER`, `NOBYPASSRLS`, aucune escalade `SET ROLE`) | le runtime tourne encore sous `neondb_owner` ou atteint un rôle privilégié |
| **P8** | Contexte transactionnel compatible pooler | `contexte_transactionnel.absent_apres = true` | un GUC `set_config(..., true)` survit au `ROLLBACK`/`COMMIT` |
| **P9** | Extension `pgcrypto` | `provisionner_roles_db.mjs --verifier` vert : soit ACL `PUBLIC` fermées (`modifiable`), soit ACL plateforme Neon classées `managed-external` (`cloud_admin` non endossable, aucun octroi direct à `tracefab_app`, `hmac(bytea,bytea,text)` exécutable par `tracefab_migrator` — PR `#136`) | `pgcrypto` absente sans droit `CREATE`, propriétaire externe non classé, ou octroi direct à `tracefab_app` |
| **P10** | Sauvegarde et répétition sur branche Neon | instantané PITR noté + répétition complète réussie sur une **branche Neon dédiée** créée depuis l'état courant de Production | absence d'instantané ou répétition sur branche Neon non exécutée |

---

## 4 · Séquence opérateur complète (répétition sur branche Neon puis Production)

### Phase A — Répétition obligatoire sur un fork Neon de Production

1. Créer une branche Neon éphémère à partir du point courant de Production (sans
   toucher aux variables Vercel de Production).
2. Exécuter les sondes de lecture seule (§ 3.1 à § 3.3) sur la branche éphémère.
3. Si `tracefab_app` ou `tracefab_migrator` n'existent pas encore sur la cible,
   vérifier d'abord en lecture seule (`--dry-run`) puis provisionner avec
   `scripts/provisionner_roles_db.mjs` (`TF_ALLOW_PROVISIONING=oui`).
4. Si `neon_worker_swap_requis = true` (présence d'un grant `cloud_admin` sur
   `tracefab_worker`), isoler le rôle historique avec `scripts/provisionner_worker_neon.mjs --appliquer`.
5. Appliquer la chaîne jusqu'à la 100ᵉ migration via `npx prisma migrate deploy`
   sur l'URL directe (sans `-pooler`), en respectant l'encadrement des migrations
   worker (§ 2), puis vérifier `npx prisma migrate status`.
6. Exécuter les contrôles **postflight** (§ 5) sur la branche éphémère : les
   deux drapeaux `strict` et `systeme_strict` doivent être à **`false`** à la
   sortie des migrations.

### Phase B — Application des migrations en Production (modes permissifs conservés)

Une fois la Phase A validée sans écart et l'instantané PITR consigné :

1. Rejouer les sondes P1–P9 sur Production et archiver `mesure-avant.json`.
2. Appliquer la séquence exacte validée en Phase A (`npx prisma migrate deploy`
   sur connexion directe).
3. Vérifier immédiatement les postconditions (§ 5) :
   - `b1_historique.terminees = 100`, `en_echec = 0` ;
   - les **9 migrations jalons** de `b2_migrations_p105_p106` ont `appliquee = true` ;
   - `b7_identite.mode_identite = 'permissif'` **et** `mode_identite_systeme = 'permissif'` ;
   - `b8_portee_de_la_cle.operations_systeme_gardees = 13`, `operations_systeme_non_gardees = 0`, `app_appelle_predicat_systeme = false`, `migrator_execute_email_helper = true` ;
   - `registered_final_expected = 93`, `missing_post_chain_functions = 0`.

---

## 5 · Contrôles postflight vérifiables après la 100ᵉ migration

| Contrôle | Commande | Résultat exigé |
|---|---|---|
| Catalogue & gardes P10.7/P12 | `sonde_p107_etat_cible.mjs --json` | `codeSortie = 0`, `verdict = 'AUCUN_ARRET_DETECTE'`, `b1_historique.terminees = 100`, `en_echec = 0` |
| Jalons P10.5 → P12 | `b2_migrations_p105_p106` | **9/9** migrations `appliquee = true`, `en_echec = false` |
| Modes après migration | `b7_identite` | `mode_identite = 'permissif'`, `mode_identite_systeme = 'permissif'` |
| Opérations système & prédicat | `b8_portee_de_la_cle` | `operations_systeme_gardees = 13`, `operations_systeme_non_gardees = 0`, `app_lit_les_cles = false`, `app_peut_verifier = true`, `app_peut_verifier_systeme = true`, `app_appelle_predicat_systeme = false`, `migrator_execute_email_helper = true` |
| Sonde SQL interne | `node scripts/activer_identite_systeme_stricte.mjs --verifier` | `13 gardées · 0 non gardée · worker non connectable · runtime sans lecture des clés` |
| Registre des fonctions | `2026-11-11-p107-production-registry-preflight.sql` | `registered_final_expected = 93`, `missing_post_chain_functions = 0`, `unregistered_policy_functions = 0`, `security_definer_public_executor_count = 0` |
| Isolation worker | `b6_droits_migration` | `migrator_superuser = false`, `migrator_membre_worker = false`, `app_membre_worker = false`, `neon_worker_swap_requis = false` |

---

## 6 · Provisionnement de la clé HMAC et bascule des deux modes stricts

Les deux modes (`strict` utilisateur et `systeme_strict` système) partagent la
même table de clés (`public.tracefab_identity_cles`) et la même variable Vercel
(`TRACEFAB_IDENTITY_KEY`, hexadécimal CSPRNG ≥ 32 octets / 64 caractères hex),
avec **séparation stricte d'usage dans le corps signé** (`tracefab_identity` vs
`tracefab_system`). Ils se basculent **séparément** et **uniquement après preuve
sur le runtime déployé**.

### Étape 1 — Provisionner la clé en base et dans Vercel (sans jamais l'afficher)

1. Générer une clé CSPRNG de 32 octets (64 caractères hexadécimaux) dans un
   coffre opérateur, sans jamais l'écrire dans l'historique shell ni dans un log.
2. Enregistrer la clé dans `public.tracefab_identity_cles` :
   ```bash
   DATABASE_ADMIN_URL="$DIRECT_OWNER_URL" \
   TF_ALLOW_PROVISIONING=oui \
   TF_IDENTITY_KEY_VERSION=1 \
   TF_IDENTITY_KEY_HEX="$TRACEFAB_IDENTITY_KEY" \
   node scripts/provisionner_cle_identite.mjs --provisionner
   ```
   Puis contrôler en lecture seule :
   ```bash
   DATABASE_ADMIN_URL="$DIRECT_OWNER_URL" \
   node scripts/provisionner_cle_identite.mjs --verifier
   ```
   Attendu : `cles_actives >= 1`, `tracefab_app NE PEUT PAS lire les clés`.
3. Poser la même valeur dans `TRACEFAB_IDENTITY_KEY` sur l'environnement Vercel
   ciblé et redéployer la révision applicative à jour de `main`.

### Étape 2 — Prouver l'aller-retour cryptographique sur le runtime réel (modes encore permissifs)

Interroger la sonde de readiness authentifiée :

```bash
curl -fsS -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2-readiness?identity=1" | jq '{
    identityTokens,
    identitySysteme,
    identitePg: .identitePg.conforme,
    baseIdentite: {
      hote_conforme: .baseIdentite.hote_conforme,
      hote_est_production: .baseIdentite.hote_est_production,
      sondes_p107: .baseIdentite.sondes_p107
    }
  }'
```

**Critères impératifs avant toute bascule (GO / NO-GO) :**

- `identitePg.conforme = true` (rôle `tracefab_app`, ni `SUPERUSER`, ni `BYPASSRLS`, aucune escalade `SET ROLE`) ;
- `identityTokens.configured = true`, `mode = "signe"`, `verifiee_par_la_base = true` ;
- `identitySysteme.etat_cle = "valide"`, `mode = "signe"`, `verifiee_par_la_base = true` ;
- un parcours utilisateur authentifié (lecture RLS + écriture métier) réussit ;
- un webhook Clerk et un cycle d'outbox (`/api/internal/notification-outbox/process`) réussissent (`200`).

Tant qu'un seul de ces cinq points n'est pas mesuré vert, **ne basculer ni
`strict`, ni `systeme_strict`**.

### Étape 3 — Activer d'abord `systeme_strict`, puis `strict`

Les deux drapeaux sont indépendants afin d'isoler tout impact :

1. **Bascule de l'identité système (`systeme_strict = true`)** — après vérification
   `node scripts/activer_identite_systeme_stricte.mjs --verifier` :
   ```sql
   -- Exécuté par le propriétaire sur connexion directe (acte d'exploitation tracé)
   BEGIN;
   UPDATE public.tracefab_identity_politique
      SET systeme_strict = true, modifie_le = now()
    WHERE singleton;
   SELECT * FROM public.tracefab_sec_probe_identite_systeme();
   -- Attendu : operations_systeme_gardees = 13, operations_systeme_non_gardees = 0,
   --           mode_systeme_strict = true, runtime_lit_les_cles = false
   COMMIT;
   ```
   *(Sur une base jetable locale, cette transaction est automatisée et refusée si
   un prérequis manque par `node scripts/activer_identite_systeme_stricte.mjs --activer`.)*
   Vérifier immédiatement un webhook Clerk et le traitement de l'outbox.

2. **Bascule de l'identité utilisateur (`strict = true`)** — après observation
   nominale de `systeme_strict` :
   ```sql
   BEGIN;
   UPDATE public.tracefab_identity_politique
      SET strict = true, modifie_le = now()
    WHERE singleton;
   SELECT strict, systeme_strict, modifie_le
     FROM public.tracefab_identity_politique
    WHERE singleton;
   COMMIT;
   ```
   Vérifier immédiatement `sonde_p107_etat_cible.mjs` (`mode_identite = 'strict'`,
   `mode_identite_systeme = 'strict'`) ainsi qu'un parcours authentifié et le
   portail public `/api/dpp/:gtin`.

### Étape 4 — Rotation de clé sans coupure

1. Insérer la nouvelle clé active sous `version = N + 1` via `provisionner_cle_identite.mjs --provisionner` (`cles_actives = 2` : chevauchement).
2. Mettre à jour `TRACEFAB_IDENTITY_KEY` dans Vercel et redéployer.
3. Vérifier `verifiee_par_la_base = true` sur la nouvelle révision et attendre
   l'expiration des jetons en vol (> 10 minutes, plafond TTL base = 600 s).
4. Désactiver l'ancienne clé :
   ```sql
   UPDATE public.tracefab_identity_cles SET actif = false WHERE version = <ancienne_version>;
   ```

---

## 7 · Plan de retour arrière (du plus rapide au plus lourd)

Les migrations sont **forward-only** ; la réversibilité opérationnelle repose sur
les drapeaux de politique, la révision Vercel et le PITR Neon :

| Niveau | Action | Effet | Délai |
|---|---|---|---|
| **R1a — identité système** | `UPDATE public.tracefab_identity_politique SET systeme_strict = false, modifie_le = now() WHERE singleton;` | rétablit immédiatement l'acceptation sans jeton système (Clerk / outbox) tout en continuant de vérifier les jetons présents | quelques secondes |
| **R1b — identité utilisateur** | `UPDATE public.tracefab_identity_politique SET strict = false, modifie_le = now() WHERE singleton;` | rétablit immédiatement le repli transitoire sur le GUC `tracefab.user_id` en cas d'incident de signature | quelques secondes |
| **R2 — application** | restauration de la révision Vercel précédente | annule un changement applicatif sans défaire le schéma | 1 à 2 minutes |
| **R3 — base de données** | restauration Neon PITR à l'horodatage consigné en **P10** | annule les migrations et écritures postérieures à l'instantané | selon fenêtre Neon |

---

## 8 · Preuve par exécution hors ligne de la séquence complète (banc PGlite)

Même sans identifiants Neon Production dans l'environnement de développement ou
de CI, l'intégralité de cette séquence — **état Production reconstitué (56
migrations) → application des 44 migrations restantes jusqu'à 100 → exécution de
la sonde `sonde_p107_etat_cible.mjs` → préflight/postflight du registre (93
fonctions) → provisionnement de 2 clés HMAC en chevauchement → activation de
`systeme_strict` puis `strict` → refus `42501` / `null` des appels non signés et
acceptation des appels signés → rotation et révocation de clé → retour arrière
R1a/R1b** — est prouvée par exécution réelle sur PostgreSQL WASM via :

```bash
npm run test:p107:rehearsal-100
```

Ce banc vérifie le mécanisme SQL, les gardes, la sonde et le runbook sur le vrai
schéma des 100 migrations de `main`. Il **ne remplace pas** les mesures P1–P10
sur Neon Production, qui restent un acte opérateur soumis à autorisation humaine.
