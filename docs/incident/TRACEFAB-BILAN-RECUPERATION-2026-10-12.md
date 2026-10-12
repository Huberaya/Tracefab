# TRACEFAB — Bilan de récupération (Chantier 1)

**Date du bilan :** 2026-10-12 (UTC)
**Auteur :** agent de remédiation
**Branche de session :** `arena/879cd8db-tracefab`
**Commit de référence (identique à `origin/main`) :** `b0c976f1307aacbcbf4e4eec06dd8d97ef06008e`
**Nature :** lecture seule. Aucune écriture distante, aucune fusion, aucune migration, aucun déploiement, aucune modification de paramètre GitHub, Vercel ou Neon.

> Toutes les valeurs de secrets sont absentes de ce document. Aucun identifiant n'a été lu, testé ni reproduit.

---

## 0. Résumé pour décideur

| # | Constat | Statut | Preuve |
|---|---|---|---|
| 1 | La production sert `b0c976f`, comme `main`. | VÉRIFIÉ | API GitHub, 28 déploiements Production, dernier `6968252029` |
| 2 | L'erreur `{"error":"internal_error","correlationId":…}` provient d'**un seul endroit du code** : `api/index.ts:199` (barrière d'erreur centrale). Les 22 autres émetteurs d'`internal_error` ne renvoient **pas** de `correlationId`. | VÉRIFIÉ | `grep -rn "internal_error" api/` |
| 3 | Cette barrière ne se déclenche que si (a) le **chargement du module de route** échoue, ou (b) le gestionnaire jette hors de son propre `try/catch`. | VÉRIFIÉ | `api/index.ts:179-200` |
| 4 | **Cause probable démontrée localement** : client Prisma non initialisé ⇒ `import()` de toute route utilisant la base échoue ⇒ réponse exactement conforme à l'incident, y compris pour `/api/health` (qui ne renvoie alors **pas** `database_unavailable`). | VÉRIFIÉ par exécution | §5.2, reproduction |
| 5 | Le client Prisma n'est **garanti généré à aucun endroit du build Vercel** : `vercel.json` contient un tableau `builds` (les réglages de build du projet sont ignorés), aucun `postinstall`, et `prisma` / `@prisma/client` sont en `devDependencies`. | VÉRIFIÉ (config) + conforme à la documentation Vercel | §5.3 |
| 6 | `main` n'est **toujours pas protégée** ; aucun ruleset ; environnements `Preview` et `Production` sans relecteur ; un seul collaborateur. | VÉRIFIÉ maintenant | §3 |
| 7 | Le pas de CI destructeur (`Scenarios croises contre la base de production`, `secrets.DATABASE_URL`) est **toujours sur `main`** ; il n'a été retiré que sur la branche de la PR #34. | VÉRIFIÉ | `git show origin/main:.github/workflows/ci.yml` |
| 8 | Le workflow `Figer la reference visuelle` (`contents: write`) est **actif** ; seul `CI` a été désactivé manuellement. La désactivation globale d'Actions annoncée par capture d'écran **n'est pas corroborée par l'API**. | VÉRIFIÉ | API `actions/workflows` |
| 9 | `EXP-01`, `EXP-02`, `EXP-03`, `CL-11` et `DEC-36` **n'existent nulle part dans le dépôt ni dans son historique**. | VÉRIFIÉ | `git log --all -S`, `git grep` sur toutes les références |
| 10 | Aucun accès réseau à Vercel, Neon ou Clerk depuis l'environnement d'exécution. Les journaux Vercel du `correlationId` sont **inaccessibles**. | VÉRIFIÉ | tests de connexion, §2 |
| 11 | Une migration de `main` **rétablit** `GRANT EXECUTE … TO PUBLIC` sur une fonction `SECURITY DEFINER`, annulant pour elle le durcissement P0. | VÉRIFIÉ | `prisma/migrations/20261009120000_…/migration.sql:75`, §5.5 |

---

## 1. Périmètre, méthode et limites

### 1.1 Méthode

Étapes suivies : état Git → branches et PR → permissions et workflows → rapports et décisions existants → audit statique du code (routeur, contexte RLS, fonctions SQL, migrations) → reproduction locale non destructive → tests hors ligne exécutables → inventaire des problèmes ouverts.

### 1.2 Limites d'environnement (démontrées, pas supposées)

| Ressource | État | Conséquence |
|---|---|---|
| `github.com`, `api.github.com` | joignables | lectures et écritures Git/Hub possibles |
| `tracefab.vercel.app` | **injoignable** (HTTP 000) | aucune sonde de production possible |
| `api.vercel.com` | **injoignable** | pas de journaux de build ou de runtime |
| `console.neon.tech` | **injoignable** | pas d'audit de base réel |
| `api.clerk.com` | **injoignable** | pas de test d'authentification réel |
| `binaries.prisma.sh` | **injoignable** | `npm run db:generate` échoue ⇒ suites Prisma/Neon non exécutables localement |

Cette limite est identique à celle déjà documentée par les chantiers 2B et 2C.3 : **elle n'est pas nouvelle et ne peut pas être contournée depuis cet environnement.**

### 1.3 Séparation des qualificatifs

Dans tout ce document : **VÉRIFIÉ** = constaté maintenant par une commande citée ; **REPRODUIT** = démontré par exécution locale ; **NON VÉRIFIABLE** = accès refusé ou inexistant ; **HISTORIQUE** = repris d'un rapport antérieur, non revérifié. Un `403` signifie « non vérifié », jamais « absent ».

---

## 2. Chantier 1 — État des lieux (EN COURS)

### 2.1 Dépôt, branches, PR

| Élément | Valeur | Statut |
|---|---|---|
| Dépôt | `Huberaya/Tracefab`, **public**, `allow_forking: true` | VÉRIFIÉ |
| Branche par défaut | `main` = `b0c976f` (2026-10-09) | VÉRIFIÉ |
| Clone local | profondeur **1** pour `main` (`.git/shallow` sur `b0c976f`) ; autres branches récupérées en profondeur (25 commits pour `arena/91844ee9`) | VÉRIFIÉ |
| Travail local historique annoncé (« nombreux fichiers modifiés, non suivis ») | **absent** : arbre propre. Ce travail n'est pas dans ce poste de travail. | VÉRIFIÉ |
| PR #34 | ouverte, non brouillon, `MERGEABLE`, `CLEAN`, tête `19a867a`, sans revue | VÉRIFIÉ |
| PR #35 | **brouillon**, tête `8fe013e`, 2 fichiers : `ci.yml` (retrait) + nouveau rapport d'incident | VÉRIFIÉ |
| PR #33 et antérieures | fusionnées | VÉRIFIÉ |
| Branches distantes | 20, dont 11 `experience/*`, 4 `arena/*`, `correctifs/chantier-1a`, `security/incident-3b-…`, `merge/experience`, `chantiers-1-to-9/10` | VÉRIFIÉ |
| Étiquettes (tags) | aucune | VÉRIFIÉ |

**Conservation :** aucun `reset`, aucun nettoyage, aucune réécriture. Les branches distantes sont les seuls lieux de sauvegarde du travail antérieur ; elles sont intactes.

### 2.2 Production

| Élément | Valeur | Statut |
|---|---|---|
| Dernier déploiement Production | `6968252029`, réf. `b0c976f`, créé 2026-10-09T18:36:13Z | VÉRIFIÉ |
| Statut de ce déploiement | `success` (« Deployment has completed »), reposé le 2026-10-12T07:37:12Z | VÉRIFIÉ |
| Nombre de déploiements Production | 28 | VÉRIFIÉ |
| Auteur des déploiements | `vercel[bot]` (intégration Vercel), **jamais un workflow GitHub** | VÉRIFIÉ |
| Vercel Preview | 72 déploiements, dont `165a313` et `8fe013e` (branche sécurité) | VÉRIFIÉ |

**Conclusion :** la production exécute exactement le code de `main`. Toute analyse du code de `main` porte donc sur le code réellement en service.

### 2.3 Workflows et permissions

| Workflow | Fichier | État API | Présent sur `main` ? |
|---|---|---|---|
| `CI` | `.github/workflows/ci.yml` | `disabled_manually` (mis à jour 2026-10-11T20:42:39Z) | oui |
| `Figer la reference visuelle` | `.github/workflows/figer-reference-visuelle.yml` | **`active`** | **non** (présent sur `arena/91844ee9-tracefab` uniquement) |

**Écart de confinement à traiter :** le workflow porteur de `contents: write` est le seul resté actif. Il se déclenche par `workflow_dispatch` **et** par `push` modifiant `tests/regression/reference/.figer`, sur toute branche où ce fichier existe. La désactivation globale d'Actions (« Disable actions ») annoncée par capture d'écran n'a pas été vérifiée indépendamment — l'API renvoie `403` sur les permissions Actions — et l'état observé (un workflow `disabled_manually`, l'autre `active`) correspond davantage à une désactivation **par workflow** qu'à une désactivation globale. **Ne pas présenter le confinement comme acquis.**

Dernier run de `CI` : 2026-10-10, quatre jobs verts, sur `arena/91844ee9-tracefab`. Aucun run depuis la désactivation.

### 2.4 Rapports et décisions retrouvés

| Document | Contenu utile | Statut |
|---|---|---|
| `docs/incident/TRACEFAB-INCIDENT-3B4-STATUS-2026-10-12.md` | incident 3B.4 **OUVERT**, 8 actions de clôture IR-01…IR-08, procédure de rotation | VÉRIFIÉ (branche sécurité) |
| `docs/experience/CHANTIER-2B-BLOCAGES.md` | blocages d'intégration réelle (Clerk, Wallet, sel du limiteur, sauvegarde Neon) | VÉRIFIÉ |
| `docs/experience/CHANTIER-2C-SECURISATION-GITHUB.md` | constats P0 CI et protection ; correctif 2C.1 ; épinglage par SHA ; 5 suites Neon retirées | VÉRIFIÉ |
| `docs/experience/CHANTIER-2C-2-PROTECTION-ET-NEON.md` | correctif **non** sur `main` ; `supplier:advanced` destructif ; repli HMAC sur `DATABASE_URL` | VÉRIFIÉ |
| `docs/experience/CHANTIER-2C-3-VALIDATION-ET-SECURISATION.md` | PR #34 **non prête à la fusion** (migration non appliquée) ; Vercel crée la production | VÉRIFIÉ |
| `docs/operations/p0-neon-reconciliation.md` | état Neon **au 7 octobre** : 31 migrations, 46 tables, 106 politiques, durcissement `SECURITY DEFINER` (« aucune fonction n'est exécutable par PUBLIC ») | HISTORIQUE — **contredit par le dépôt depuis le 2026-10-09, voir §5.5** |
| `TRACEFAB_MARKET_READINESS_AUDIT.md`, `docs/experience/CHANTIERS-RESTANTS.md`, `docs/experience/MARCHE-A-SUIVRE.md` | inventaires fonctionnels antérieurs | HISTORIQUE |

**Identifiants de décision et d'exposition :** `EXP-01`, `EXP-02`, `EXP-03`, `CL-11` et `DEC-36` **ne figurent dans aucun fichier, aucune branche, aucun commit** du dépôt. La seule occurrence est la ligne IR-01 du rapport 3B.4, qui les cite comme à qualifier. **Ces dossiers doivent venir de l'extérieur du dépôt** : je ne peux ni les lire, ni les confirmer, ni les déclarer traités.

---

## 3. Chantier 1 (suite) — Refus par défaut : état actuel, revérifié ce jour

| Contrôle | Résultat | Statut |
|---|---|---|
| `main` protégée | `protected: false` | VÉRIFIÉ |
| Rulesets du dépôt | liste **vide** | VÉRIFIÉ |
| Environnement `Production` : relecteurs | `protection_rules: []` (aucun) | VÉRIFIÉ |
| Environnement `Production` : restriction de branches | `deployment_branch_policy: null` | VÉRIFIÉ |
| Environnement `Production` : contournement admin | `can_admins_bypass: true` | VÉRIFIÉ |
| Environnement `Preview` | mêmes constats | VÉRIFIÉ |
| Collaborateurs directs | `Huberaya` seul, admin | VÉRIFIÉ |
| Secret scanning / push protection | `security_and_analysis: null` (non activé) | VÉRIFIÉ |
| Permissions Actions, secrets, protection détaillée | HTTP 403 | NON VÉRIFIABLE |

**Conséquence opérationnelle :** un contributeur disposant du droit d'écriture peut pousser directement sur `main`, donc déclencher un déploiement Production automatique, sans revue ni vérification requise. Et les protections d'environnement GitHub, même configurées, **ne bloqueraient rien** : les déploiements sont créés par l'intégration Vercel, pas par Actions. Le levier réel est côté Vercel.

---

## 4. Chantier 3 — Erreur de production : analyse et cause probable

### 4.1 Ce que la forme de la réponse démontre déjà (déduction certaine)

La réponse observée est `{"error":"internal_error","correlationId":"c3696f22-41d0-4981-8d99-4e6a177021a3"}`.

- `grep -rn "internal_error" api/` retourne **23 occurrences**. **Une seule** ajoute `correlationId` : `api/index.ts:199`. Les 22 autres (routes `dpp/[gtin]`, `passport/[tokenOrSlug]`, `quality/caps`, `catalog/import*`, etc.) renvoient `{"error":"internal_error"}` **sans** identifiant. **VÉRIFIÉ**
- Donc : la requête a **franchi** la résolution de route (sinon `route_not_found` — VÉRIFIÉ par reproduction), puis a échoué soit au `route.load()` (import dynamique du module), soit dans le gestionnaire hors de son propre `try/catch`. **VÉRIFIÉ** (`api/index.ts:181-199`).
- `correlationId()` est un `randomUUID()` neuf à chaque requête. **Aucune trace n'est conservée côté application** : l'identifiant n'existe que dans (a) le journal `stderr` JSON de Vercel et (b) le collecteur `TRACEFAB_ERROR_WEBHOOK_URL` s'il est configuré. **Il n'est pas retrouvable sans accès aux journaux Vercel.** VÉRIFIÉ.
- L'hypothèse initiale — « la route `/api/health` renverrait `database_unavailable` » — **ne décrit pas ce cas** : `health.ts` teste `SELECT 1` *dans* son `try/catch`. Une exception survenant **au chargement du module** se produit **avant** ce `try/catch`. C'est précisément ce que la reproduction ci-dessous démontre.

### 4.2 Reproduction locale du mécanisme (REPRODUIT)

Exécution du **routeur réel** (`api/index.ts`) avec le client Prisma **non généré** — état produit par une installation où `prisma generate` ne s'exécute pas :

```
--- GET /api/health
    status  : 500
    body    : {"error":"internal_error","correlationId":"633d6034-c3f3-4e87-bad2-16fb15c901a9"}
--- GET /api/catalog/schemas          (route sans dépendance Prisma)
    status  : 200
--- GET /api/does-not-exist
    status  : 404   {"error":"route_not_found"}
```

et le journal structuré correspondant :

```json
{"schema":"tracefab-error-report-v1","service":"tracefab-api","context":{"route":"^health$","method":"GET","path":"health","status":500},
 "error":{"name":"Error","message":"@prisma/client did not initialize yet. Please run \"prisma generate\" and try to import it again.",
 "stack":"… at new PrismaClient (node_modules/.prisma/client/default.js:43:11)\n at createClient (api/_lib/prisma.ts:28:10)\n at <anonymous> (api/_lib/prisma.ts:72:38)\n at async handler (api/index.ts:183:20)"}}
```

Trois enseignements : le corps est **exactement** celui de l'incident ; `/api/health` **ne** renvoie **pas** `database_unavailable` ; la cause est le **chargement du module**, à `api/_lib/prisma.ts:72`, avant tout code de route.

### 4.3 Le client Prisma est-il généré par le build Vercel ? (NON GARANTI)

| Maillon | Constat | Statut |
|---|---|---|
| `vercel.json` | contient un tableau **`builds`** ; clés présentes : `builds`, `headers`, `routes`, `crons`. Aucun `buildCommand`, `installCommand`, `functions`, `framework`. | VÉRIFIÉ |
| Effet documenté de `builds` | la documentation Vercel indique que la présence de `builds` **fait ignorer les réglages de build du projet**. Aucune entrée `@vercel/static-build` n'existe ici, donc **aucune étape de build personnalisée n'est déclenchée**. | VÉRIFIÉ (documentation) |
| Script `build` du projet | commence par `npm run db:generate` — mais il n'est **référencé nulle part** dans `vercel.json`. | VÉRIFIÉ |
| `postinstall` | **absent** de `package.json`. | VÉRIFIÉ |
| `@prisma/client` et `prisma` | tous deux en **`devDependencies`** (3 dépendances de production seulement : `@clerk/backend`, `archiver`, `jsonwebtoken`). | VÉRIFIÉ |
| Repli de `@prisma/client` | son propre `postinstall` tente `prisma generate` et **avale les erreurs** (`process.exit(0)`). Il peut donc échouer silencieusement. | VÉRIFIÉ (lecture du script installé) |
| État observé après `npm ci` | `node_modules/.prisma/client` contient l'**avertissement factice** ; `new PrismaClient()` jette. | REPRODUIT |
| Imports de routes | avec un client valide, **125/125 modules de route s'importent sans erreur** : Prisma est le **seul** danger de chargement. | REPRODUIT |

**Conclusion :** rien ne garantit la génération du client dans le déploiement Vercel, et le seul mode de défaillance *global* possible est exactement celui observé. Il reste à confirmer par une preuve côté Vercel (§4.4).

### 4.4 Test discriminant à exécuter par le propriétaire (30 secondes, lecture seule)

```bash
curl -sS -i https://tracefab.vercel.app/api/health
curl -sS -i https://tracefab.vercel.app/api/catalog/schemas
```

| Observation | Interprétation | Suite |
|---|---|---|
| `/api/health` → 500 `internal_error` **+ correlationId**, et `/api/catalog/schemas` → 200 | **Client Prisma non initialisé dans le paquet déployé** (échec au chargement du module). Cause confirmée. | Appliquer le correctif A (ci-dessous) |
| `/api/health` → 503 `database_unavailable` | La base est injoignable (chaîne, TLS, pooler, rôle) ; l'erreur observée vient alors d'une route précise. | Lire le journal Vercel par `correlationId` |
| `/api/health` → 200, mais une route précise échoue | Panne localisée. | Fournir le `correlationId` + l'URL exacte |

Le journal de build Vercel apporte la confirmation définitive : la sortie d'installation doit contenir, ou **ne pas** contenir, la génération du client Prisma.

### 4.5 Ce que la cause n'est pas (écarté par la preuve)

- **Ni un mot de passe Neon incorrect** : une chaîne de connexion invalide ne produit pas cette réponse ; `new PrismaClient()` ne se connecte pas à la construction, et `/api/health` renverrait alors `503 database_unavailable`.
- **Ni un défaut de la barrière d'erreur** : elle fonctionne exactement comme conçu — elle rattrape, journalise, corrèle et ne divulgue rien.
- **Ni un `route_not_found`** : le corps l'exclut (reproduit).

---

## 5. Chantier 4 — Base de données, rôles, RLS et fonctions privilégiées

### 5.1 Inventaire statique (dépôt)

| Élément | Constat | Statut |
|---|---|---|
| Migrations sur disque | **35 répertoires** (le rapport P0 du 7 octobre en citait 31 : trois migrations du 2026-10-09 s'y sont ajoutées) | VÉRIFIÉ |
| Migrations appliquées en production | **inconnu** — exige `npm run db:status` avec `DATABASE_URL` de production | NON VÉRIFIABLE |
| RLS déclarée dans les migrations | 46 `ENABLE` et 50 `FORCE` | VÉRIFIÉ |
| Avertissement du dépôt lui-même | « Ces drapeaux ne prouvent rien : BYPASSRLS, porté par le rôle, prime sur ENABLE comme sur FORCE. » | VÉRIFIÉ |
| Fonctions `SECURITY DEFINER` | 103 recensées au 7 octobre, toutes avec `search_path` fixé | HISTORIQUE |
| Durcissement `REVOKE EXECUTE FROM PUBLIC` | présent dans la migration `20261007100000_security_definer_execute_hardening` | VÉRIFIÉ |
| Les 5 fonctions signalées | `tracefab_product_is_public`, `tracefab_material_is_public`, `tracefab_supplier_site_is_public`, `tracefab_public_brand` : définies par `20261009180000_public_read_context`, `REVOKE … FROM PUBLIC` par le durcissement `20261007100000`, puis `GRANT` à `tracefab_app` sous condition. `tracefab_material_visible_via_product` : **créée séparément** par `20261009120000_fix_materials_policy_recursion`, avec un **`GRANT EXECUTE … TO PUBLIC` explicite** (voir §5.5). | VÉRIFIÉ |
| `20261009180000` appliquée en production ? | **inconnu** | NON VÉRIFIABLE |

### 5.2 Rôle d'exécution et effectivité de la RLS — point P0 non tranché

La migration `20261009180000` déclare noir sur blanc : « Le rôle de connexion de production, `neondb_owner`, porte **BYPASSRLS**. Aucune des 107 politiques n'a donc jamais été évaluée : la couche RLS est **inerte**. »

Et le modèle `.env.example` promeut exactement cette forme d'URL (`…?sslmode=require&channel_binding=require` avec `neondb_owner`), alors que `scripts/audit_production_env.mjs:104` **échoue** si `DATABASE_URL` utilise un rôle *owner*/postgres (« runtime must use a least-privilege application role »). **Contradiction interne au dépôt, à trancher.**

Conséquence si la production se connecte encore en `neondb_owner` : l'isolation multi-locataires repose **uniquement** sur les `WHERE` applicatifs ; les politiques RLS ne filtrent rien. Cela ne peut être tranché que par une lecture de la base réelle (rôle de connexion, `pg_roles.rolbypassrls`, `pg_proc.proowner/proacl`, `relrowsecurity`/`relforcerowsecurity`).

### 5.3 Chemins d'accès public

- Les routes anonymes (`/api/dpp/:gtin`, `/api/passport/:tokenOrSlug`, `/api/gs1/digital-link/:gtin`) enveloppent leurs lectures dans `withTracefabPublicContext`, qui arme un drapeau **transactionnel** (`set_config(..., true)`). **VÉRIFIÉ**.
- Les politiques publiques n'accordent que des lignes dont le produit porte un `public_slug` — publier est un acte explicite. **VÉRIFIÉ**.
- La marque est exposée par une fonction dédiée `tracefab_public_brand` qui ne rend que `display_name` et `country_code`. **VÉRIFIÉ**.
- Ces garanties sont **conditionnées à l'application effective** de la migration et à un rôle sans `BYPASSRLS`. Non démontré en production. **NON VÉRIFIABLE**.

### 5.4 Points d'attention relevés (à traiter, non exécutés)

1. `scripts/test_neon_supplier_advanced.mjs` : n'exige que `DATABASE_URL`, **sans aucun contrôle de cible** ; crée un rôle de niveau cluster, accorde des privilèges sur **toutes** les tables du schéma `public`, crée puis supprime des données, et son nettoyage en `finally` n'est pas garanti. Il n'est appelé par aucun workflow — donc jamais exécuté, mais prêt à l'être par erreur.
2. Repli de la clé HMAC du limiteur de débit : `TRACEFAB_RATE_LIMIT_SALT` → `CLERK_SECRET_KEY` → `DATABASE_URL` (`api/_lib/rate-limit.ts:290`). Un secret de base sert de clé cryptographique. `scripts/audit_production_env.mjs` **ne contrôle pas** `TRACEFAB_RATE_LIMIT_SALT`.
3. `.env.example` incomplet pour Apple/Google Wallet et pour le sel du limiteur (déjà signalé en 2C phase 1).

### 5.5 Régression de privilège confirmée dans la chaîne de migrations (sur `main`)

`prisma/migrations/20261007100000_security_definer_execute_hardening/migration.sql` révoque `EXECUTE` de `PUBLIC` pour **toutes** les fonctions `SECURITY DEFINER` du schéma `public` et retire ce privilège par défaut pour les fonctions futures. Le rapport `docs/operations/p0-neon-reconciliation.md` en tire la conclusion : « aucune fonction `SECURITY DEFINER` n'est exécutable par `PUBLIC` ».

**Deux jours plus tard, une migration postérieure rétablit explicitement ce privilège :**

```sql
-- prisma/migrations/20261009120000_fix_materials_policy_recursion/migration.sql:75
GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO PUBLIC;
```

Contexte : la fonction est `SECURITY DEFINER`, `STABLE`, `SET search_path = public`, et sert à casser une récursion de politiques entre `materials` et `product_materials`. Le commentaire du `GRANT` (« Le role applicatif doit pouvoir appeler la fonction ») indique l'intention ; l'effet réel dépasse l'intention, puisque le privilège est accordé à **PUBLIC** et non au seul rôle applicatif.

| Élément | Constat |
|---|---|
| Portée de l'exposition | toute rôle pouvant se connecter à la base peut appeler la fonction ; celle-ci reste bornée par `tracefab_can_access_org` (elle ne contourne pas l'isolation), mais rend un oracle booléen sur les liens matière→produit |
| Contradiction documentaire | le rapport P0 affirme l'absence de fonction `PUBLIC`-exécutable ; le dépôt le démentit depuis le 2026-10-09 |
| État en production | **inconnu** : dépend de l'application effective de `20261009120000` |
| Classement | **P1** (durcissement) — à corriger par migration de remplacement : `REVOKE … FROM PUBLIC` puis `GRANT … TO tracefab_app` (et non `PUBLIC`), avec test de non-régression |


---

## 6. Chantier 5 — Authentification, sessions et chemins d'usurpation

| Contrôle | Constat | Statut |
|---|---|---|
| Vérification du jeton | `verifyToken` Clerk + `authorizedParties` obligatoires en production (`authorized_parties_not_configured` sinon) | VÉRIFIÉ |
| Identité transmise à SQL | `tracefab.user_id` / `tracefab.user_email` posés **transactionnellement** depuis l'utilisateur Clerk résolu côté serveur ; jamais depuis le navigateur | VÉRIFIÉ |
| Contexte ouvrier | `withTracefabWorkerContext` armé par du code serveur, jamais par un en-tête client | VÉRIFIÉ |
| Secrets de service | comparaison `timingSafeEqual` pour le worker et le cron | VÉRIFIÉ |
| Route `schedule` | refuse en 503 si `CRON_SECRET` absent, en 401 si le porteur ne correspond pas | VÉRIFIÉ |
| Espaces de noms GUC | `tracefab.*` ; valeurs par défaut **fermées** (`false`) et remises à `false` en fin de transaction | VÉRIFIÉ |
| Point à instruire | `tracefab.internal_data_collection_update` est posé en portée **session** (`set_config(..., false)`) par les fonctions SQL du chantier data-collection. Un `SET` de session est annulé par le retour arrière de transaction, donc l'exposition résiduelle est faible — **à confirmer par test** sur une base réelle. | À VÉRIFIER |
| Test croisé statique | `npm run test:cross-tenant` : aucune route hors modèle déclaré | VÉRIFIÉ (exécuté) |
| Étanchéité réelle entre deux locataires | `npm run test:neon:rls` — **non exécutable ici** (pas de PostgreSQL, pas de client Prisma généré) | NON EXÉCUTÉ |

---

## 7. Chantier 6 — Tests : ce qui a réellement été exécuté ce jour

Environnement : clone local, Node 22.22.3, `npm ci` réussi (avec `PRISMA_SKIP_ENGINE_DOWNLOAD=1`).

| Suite | Résultat | Sortie notable |
|---|---|---|
| `npm run test:routes` | **PASSÉ** | « 125 routes dans la table / 125 fichiers de route, tous enregistres / aucune route ne pointe vers un fichier manquant » |
| `npm run test:cross-tenant` | **PASSÉ** | 2 scénarios croisés ; « 46 ENABLE / 50 FORCE sur 35 migrations » |
| `npm run test:production-readiness` | **PASSÉ** | 46/46 garde-fous |
| `npm run schema:static` | **PASSÉ** | 22 tables, 61 politiques historiques |
| `npm run test:assets` | **PASSÉ** | 66 références empreintées |
| `npm run test:security:chantier1` | **PASSÉ** | RLS forcée, autorisation documentaire, validation des mutations |
| `npm run test:private-storage` | **PASSÉ** | contrat de stockage privé |
| `npm run db:generate` | **ÉCHEC (environnement)** | `binaries.prisma.sh` bloqué — n'implique pas le code |
| `npm run api:typecheck` | **NON EXÉCUTÉ** | dépend du client généré |
| `npm run test:journeys`, `audit:personas`, `test:phases`, `test:*:browser`, `test:regression` | **NON EXÉCUTÉS** | exigent un navigateur et/ou un serveur |
| `npm run test:neon:*` (5 suites RLS/sécurité) | **NON EXÉCUTÉES** | exigent PostgreSQL — retirées de la CI par le correctif 2C.1 |

**Aucune preuve de non-régression fonctionnelle de bout en bout n'a donc été produite dans cette passe.** Les tests verts ci-dessus sont des garde-fous statiques, pas une démonstration de bon fonctionnement.

---

## 8. État d'avancement par chantier

| Chantier | État | Blocage principal |
|---|---|---|
| 1 — État des lieux et conservation | **EN COURS** (≈ 80 %) | 3 points non vérifiables (secrets, permissions Actions, protection détaillée) |
| 2 — Confinement et gestion des secrets | **BLOQUÉ** | journaux CI, consoles des fournisseurs, rapports EXP-/CL-/DEC- absents du dépôt |
| 3 — Erreur de production | **CORRIGÉ, TESTS EN ATTENTE** au sens : cause probable démontrée localement ; confirmation par journal Vercel requise avant tout correctif | accès Vercel |
| 4 — Base et contrôle d'accès | **EN COURS** (inventaire statique fait) | accès Neon (lecture) |
| 5 — Authentification et autorisations | **EN COURS** (lecture de code) | base réelle pour les tests croisés |
| 6 — Tests et qualité | **EN COURS** | PostgreSQL local absent, moteur Prisma intéléchargeable |
| 7 — Staging et production | **NON COMMENCÉ** | aucune autorisation de déploiement ; aucun environnement de staging isolé identifié |
| 8 — Stabilisation et marché | **NON COMMENCÉ** | dépend des chantiers 3 à 7 |

---

## 9. Problèmes restants (par gravité)

### P0

**P0-1 — Erreur de production `internal_error` (API globale).**
Cause : probablement client Prisma non initialisé dans le paquet déployé (mécanisme reproduit ; émetteur unique identifié). Impact : routes dépendant de la base inutilisables. Action : test discriminant §4.4 puis correctif A. Dépendance : accès Vercel (journaux). Autorisation : modification de configuration de déploiement (niveau C). Prochaine étape : exécuter le test discriminant.

**P0-2 — `main` non protégée, aucun ruleset.** Impact : push direct ⇒ déploiement Production automatique sans revue ni vérification. Action : ruleset transitoire (PR obligatoire, push directs bloqués, 4 checks requis, 0 approbation tant qu'un second relecteur n'existe pas). Dépendance : décision du propriétaire sur l'avertissement « 1 approbation = PR non fusionnable ». Autorisation : réglages du dépôt (propriétaire).

**P0-3 — Effectivité de la RLS en production non démontrée.** Si le rôle de connexion reste `neondb_owner` (BYPASSRLS), les 107 politiques sont inertes et l'isolation multi-locataires n'est plus assurée que par le code applicatif. Action : lecture du rôle réel, de `rolbypassrls`, des privilèges des fonctions, des `relforcerowsecurity` ; puis bascule contrôlée vers `tracefab_app` avec les `GRANT` explicites. Dépendance : accès Neon. Autorisation : lecture base (niveau A étendu) ; toute modification : niveau D.

**P0-4 — Pas destructeur encore présent sur `main`.** `TF_SECRET_PRODUCTION: ${{ secrets.DATABASE_URL }}` + étape `Scenarios croises contre la base de production` (5 suites écrivant, dont `CREATE ROLE`, `DROP ROLE`, `DELETE`). Latent : ne s'exécute que si le secret est exposé au run — ce qui n'a été le cas sur aucun des runs examinés antérieurement. Action : porter le retrait du correctif 2C.1 sur `main` (fusion de la PR #34 ou branche dédiée minimale). Autorisation : écriture sur `main` (niveau C/D).

### P1

**P1-5 — Environnements `Preview` et `Production` sans relecteur ni restriction.** Impact réel limité pour les déploiements Vercel (ils ne passent pas par Actions), mais laisse un canal de déploiement sans aucune barrière. Action : configurer côté GitHub **et** côté Vercel (branche de production, déploiement automatique, protection de déploiement).

**P1-6 — `Figer la reference visuelle` actif avec `contents: write`.** Action : désactiver ce workflow, ou le re-prendre après revue (le ramener sur `main` avec une revue explicite). Ne pas casser la fonctionnalité : elle ne sert qu'au propriétaire.

**P1-7 — Génération du client Prisma non garantie dans le build Vercel.** Correctif A (§10).

**P1-8 — Migration `20261010120000_publication_explicite` non appliquée alors que le code de la PR #34 appelle les fonctions qu'elle crée.** Fusionner la PR #34 sans appliquer la migration au préalable produirait la même classe de panne que P0-1, mais localisée aux routes DPP. Action : ordonner strictement migration → vérification → fusion.

**P1-9 — Secrets non qualifiables.** `EXP-01`, `EXP-02`, `EXP-03`, `CL-11` inconnus du dépôt ; `DEC-36` introuvable ; présence du secret de dépôt `DATABASE_URL` non lisible (403) ; rotation non justifiée en l'absence de journaux d'accès.

**P1-10 — Régression de privilège SQL dans la chaîne de migrations (sur `main`).** `GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO PUBLIC` (migration `20261009120000`) annule, pour cette fonction, le durcissement apporté par `20261007100000`. Contredit le rapport P0. Action : migration de remplacement `REVOKE … FROM PUBLIC` + `GRANT … TO tracefab_app`, avec test positif et négatif. Dépendance : accès Neon pour constater l'état réel. Autorisation : niveau D (privilèges en production).

### P2

- **P2-10** `test:neon:supplier:advanced` destructif, sans garde de cible.
- **P2-11** Clé HMAC du limiteur dérivée de `DATABASE_URL`.
- **P2-12** 13 routes sans `try/catch` : toute exception y produit un 500 opaque corrélé (pas de message exploitable côté client) et aucune classification métier.
- **P2-13** Les 5 suites Neon ne sont exécutées **nulle part** : perte de détection des régressions RLS et multi-locataires.
- **P2-14** Aucune sonde de production automatisée (pas de vérification post-déploiement).
- **P2-15** `.env.example` incomplet (Apple, Google, `TRACEFAB_RATE_LIMIT_SALT`, `TRACEFAB_ERROR_WEBHOOK_*`).

---

## 10. Plan de remédiation priorisé (proposition)

| Ordre | Action | Niveau | Preuve attendue |
|---|---|---|---|
| 1 | Test discriminant §4.4 + lecture du journal de build Vercel | A | Sortie `curl` horodatée + extrait de journal |
| 2 | **Correctif A** (préparé, non appliqué) : rendre la génération du client Prisma obligatoire dans le build de déploiement — `postinstall` explicite `prisma generate` **et** déplacement de `prisma`/`@prisma/client` en `dependencies`, le tout validé sur une préversion Vercel | B puis C | Préversion `200` sur `/api/health`, `/api/dpp/:gtin` |
| 3 | **Garde-fou B** : nouveau contrôle qui échoue si le client Prisma n'est pas initialisé, appelé depuis `npm run build` | B | Sortie de test, échec provoqué volontairement une fois |
| 4 | Ruleset de protection de `main` (transitoire) + vérification | C (propriétaire) | `gh api rules/branches/main` et `protected: true` |
| 5 | Désactivation de `Figer la reference visuelle`, consignée | C (propriétaire) | État API `disabled_manually` |
| 6 | Lecture Neon : rôle réel, `rolbypassrls`, 5 fonctions, privilèges, `db:status` | A | Tableau rôle/fonction/privilège avant/après |
| 6 bis | **Correctif C** (préparé, non appliqué) : migration réversible `REVOKE EXECUTE … FROM PUBLIC` + `GRANT … TO tracefab_app` pour `tracefab_material_visible_via_product` | B puis D | Migration rejouée sur base isolée + test négatif « PUBLIC refusé » |
| 7 | Enquête secrets : retrouver `DEC-36`, `EXP-01..03`, `CL-11` ; qualifier chaque identifiant | A | Inventaire expurgé |
| 8 | Porter le retrait du pas destructeur sur `main` | C/D | Diff + run CI vert sur base jetable |
| 9 | Réintroduire un étage de tests base **isolé** (workflow manuel, environnement dédié, garde de cible positive) | B puis C | Run réussi **et** test négatif de garde |
| 10 | Sonde post-déploiement + alerte (health, auth, DPP public) | B puis C | Historique de sondes |

**Aucune action des lignes 2 à 10 n'est exécutée à ce stade.** Chacune indique son niveau d'autorisation.

---

## 11. État de sécurité (synthèse)

- **Confinement :** partiel. `CI` désactivé manuellement (vérifié). Workflow à écriture `Figer la reference visuelle` **actif** (vérifié). Le confinement global ne peut pas être confirmé. Les déploiements Production et le cron Vercel **ne dépendent pas** d'Actions : la désactivation ne les arrête pas.
- **Secrets :** aucune valeur lue, testée, copiée ni publiée. Présence des secrets non vérifiable (403). `EXP-01`, `EXP-02`, `EXP-03`, `CL-11` non qualifiables depuis le dépôt ; `DEC-36` introuvable. Rotation **non** recommandée en l'état faute de journaux d'accès.
- **Workflows :** 12 `uses:` épinglés par SHA sur la branche de travail (vérifié) ; `main` utilise encore les tags flottants `@v4` (vérifié).
- **Accès GitHub :** jeton disposant des droits d'administration constatés (lecture des environnements et des déploiements), mais **403** sur les permissions Actions, les secrets et la protection détaillée.
- **Accès Vercel / Neon / Clerk :** **aucun** depuis cet environnement (hôtes injoignables). Toute opération sur ces plateformes devra être exécutée par le propriétaire ou relayée.
- **RLS et privilèges SQL :** durcissement présent dans les migrations, **mais annulé pour une fonction** (`tracefab_material_visible_via_product` → `GRANT … TO PUBLIC`, P1-10) ; **effectivité en production non démontrée** (P0-3).
- **Authentification :** chaîne de confiance correctement construite en lecture de code ; non testée contre une base réelle.
- **Isolation multi-locataires :** modèle déclaré complet, test croisé statique vert ; preuve par exécution **absente**.
- **Vulnérabilités restantes :** P0-1 à P0-4, P1-5 à P1-9, ainsi que les points P2 ci-dessus.

---

## 12. Résultat, limites et risques résiduels

**Ce qui est établi :** la production sert `b0c976f` ; le corps de réponse observé ne peut provenir que de `api/index.ts:199` ; le seul mode de défaillance global possible est un client Prisma non initialisé ; ce mode reproduit **exactement** la réponse observée ; rien dans le dépôt ne garantit la génération du client dans le build Vercel ; `main` n'est pas protégée ; le pas de CI destructeur y est toujours présent ; les éléments `EXP/CL/DEC` sont hors du dépôt.

**Ce qui n'est pas établi :** la confirmation par journal Vercel (accès impossible) ; l'état réel de la base Neon (rôle, migrations, privilèges, RLS) ; la présence des secrets ; l'état réel des réglages Actions ; la qualité fonctionnelle de bout en bout (aucun test navigateur exécuté).

**Aucune expression du type « tout est corrigé », « sécurisé » ou « prêt pour la production » ne doit être employée** : aucune correction n'a été appliquée, aucune fusion effectuée, aucun déploiement réalisé, aucun test de bout en bout passé.

---

## Annexe A — Commandes et sorties de référence

```bash
# État de production (preuves §2.2)
gh api "repos/Huberaya/Tracefab/deployments?per_page=100" \
  --jq '[.[]|select(.environment=="Production")]|{count:length,last:.[0]}'
gh api repos/Huberaya/Tracefab/deployments/6968252029/statuses \
  --jq '.[]|{state,created_at,environment}'

# État des workflows (§2.3)
gh api repos/Huberaya/Tracefab/actions/workflows --jq '.workflows[]|{name,state,path}'
gh api "repos/Huberaya/Tracefab/contents/.github/workflows?ref=main" --jq '.[].name'

# Refus par défaut (§3)
gh api repos/Huberaya/Tracefab/branches/main --jq .protected
gh api repos/Huberaya/Tracefab/rulesets
gh api repos/Huberaya/Tracefab/environments \
  --jq '.environments[]|{name,protection_rules,deployment_branch_policy,can_admins_bypass}'

# Émetteur unique de l'erreur (§4.1)
grep -rn "internal_error" api/ | grep correlationId

# Recherche des identifiants de dossier (§2.4)
git log --all --oneline -S "DEC-36"      # aucun résultat
git grep -l -E "EXP-0[0-9]|CL-[0-9]+" $(git for-each-ref --format='%(refname)' refs/remotes/origin)
```
