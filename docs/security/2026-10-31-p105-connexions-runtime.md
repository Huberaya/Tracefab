# P10.5 — Chantier A : cartographie des connexions PostgreSQL

Date : 2026-10-31 · Branche : `arena/96848462-tracefab`

Objectif : savoir **qui** ouvre une connexion PostgreSQL, **avec quel rôle
effectif**, et par **quelle configuration** — puis rendre cette mesure
reproductible en production par un opérateur autorisé, sans secret.

Le point qui compte : « rôle configuré » et « rôle effectif » ne sont pas la
même chose. Une URL peut nommer un rôle, une politique de pooling peut en
servir un autre, une branche Neon peut régénérer des mots de passe, et une
appartenance peut changer le rôle par `SET ROLE`. Seul `current_user` lu **sur
la connexion réellement utilisée** tranche.

---

## 1. Matrice des connexions

| # | Composant | Où | Rôle visé | Rôle effectif | Origine de la configuration | Chemins de secours | Privilèges attendus |
|---|---|---|---|---|---|---|---|
| 1 | Routes API (Vercel serverless) | `api/index.ts` → `api/_lib/prisma.ts` | `tracefab_app` | **à mesurer** | `DATABASE_URL` (Prisma `env("DATABASE_URL")`) | aucun : pas de second client | SELECT/INSERT/UPDATE/DELETE sous RLS ; EXECUTE sur l'allowlist ; **pas** de SUPERUSER, **pas** de BYPASSRLS, **0** appartenance |
| 2 | Cron notification-outbox | `vercel.json` → `/api/internal/notification-outbox/schedule` (quotidien 07:00) | idem #1 | idem #1 | même client Prisma | — | idem #1 |
| 3 | Worker notification-outbox (process / reminders / health) | `api/_routes/internal/notification-outbox/*` | idem #1 | idem #1 | même client Prisma | — | idem #1 ; protégé par `workerAuthorized` |
| 4 | Ingestion PLM/ERP | `api/_routes/integrations/ingest.ts` → `api/_lib/plm-erp/ingestor.ts` → `tracefab_ingest_plm_erp_payload` | idem #1 | idem #1 | même client Prisma | — | EXECUTE sur la fonction `SECURITY DEFINER` ; identité **signée** (`tracefab.identity`) |
| 5 | Sonde de readiness | `api/_routes/internal/p2-readiness.ts` → `api/_lib/readiness-probes.ts` | idem #1 | idem #1 | même client Prisma | — | lecture catalogue (`pg_roles`) via `current_user` |
| 6 | Limitation de débit | `api/_lib/rate-limit.ts` | idem #1 | idem #1 | `DATABASE_URL` (et `CLERK_SECRET_KEY` comme sel de dérivation) | dégradation mémoire si `DATABASE_URL` absente | écriture `rate_limit_counters` |
| 7 | Migrations | `scripts/migrer_fidelement.mjs` | `tracefab_migrator` | `tracefab_migrator` | `DATABASE_URL` **du migrator** ; `TF_ADMIN_URL` pour la seule migration assistée | aucune | DDL ; BYPASSRLS (justifié) ; CREATEROLE ; membre de `tracefab_worker` |
| 8 | Élévation bornée (1 migration) | `scripts/lib/migrations_assistees.mjs` | propriétaire de branche | propriétaire | `TF_ADMIN_URL` + `TF_ALLOW_ELEVATION=oui` | refus (sortie 3) | SUPERUSER **temporaire**, refermé et relu |
| 9 | Provisionnement des rôles | `scripts/provisionner_roles_db.mjs` | propriétaire de branche | propriétaire | `DATABASE_URL` + `TF_ALLOW_PROVISIONING=oui` | refus | CREATEROLE, ALTER ROLE contrôlé |
| 10 | Provisionnement de la clé | `scripts/provisionner_cle_identite.mjs` | propriétaire / migrator | idem | `DATABASE_URL` + `TF_ALLOW_PROVISIONING=oui` + `TF_IDENTITY_KEY_HEX` | `--verifier` en lecture seule | INSERT/UPDATE sur `tracefab_identity_cles` |
| 11 | Suites de sécurité (hors production) | `scripts/test_p105_*.mjs`, `test_rls_*.mjs` | `tracefab_app` + un rôle jetable | — | `TF_RLS_APP_URL` | sortie 2 si absente | aucun privilège large : la sonde BYPASSRLS est **créée puis détruite** |
| 12 | Outils de lecture (diagnostic) | `scripts/lire-*.mjs`, `scripts/audit_neon_readonly.mjs` | rôle de lecture | idem | `DATABASE_URL` | lecture seule | SELECT catalogue |

Deux constats de cette cartographie :

- **il n'existe qu'un seul client Prisma** (`api/_lib/prisma.ts`, singleton).
  Tout le runtime — routes, cron, workers, ingestion — passe par le même
  `DATABASE_URL`. Il n'y a donc **aucun chemin de secours applicatif** : soit ce
  rôle est `tracefab_app`, soit c'est un rôle privilégié, et dans ce cas c'est
  *tout* le runtime qui l'est ;
- **les scripts d'exploitation ne partagent pas cette URL.** Un script qui se
  connecte avec `TF_ADMIN_URL` ne dit rien du rôle du runtime. Confondre les
  deux est l'erreur qui a produit le débat de P10.4.

## 2. Procédure de vérification en production

Trois mesures, dans cet ordre. Aucune ne demande, n'affiche ni n'enregistre de
secret.

### 2.1 L'identité réelle du runtime (la seule qui compte)

```bash
TF_WORKER_SECRET=<déjà détenu par l'exploitant> \
  curl -sS -H "Authorization: Bearer $TF_WORKER_SECRET" \
  "https://<hôte>/api/internal/p2-readiness?identity=1"
```

À lire dans la réponse :

- `databaseIdentity.current_user` → le rôle réellement utilisé ;
- `databaseIdentity.bypasses_rls` / `is_superuser` → doivent être `false` ;
- `identityTokens.configured` → l'application sait-elle signer ? (booléen seul)

Un `503` avec `ready: false` sur ce mode diagnostic **est** le résultat : il dit
que l'identité effective n'est pas acceptable. Ne pas le lire comme une panne de
supervision.

Pourquoi cet endpoint et pas `psql` : la requête passe par **le même client
Prisma** que les routes. Un `psql` sur la même URL ouvre une autre connexion et
ne prouve rien sur celle que sert le runtime.

### 2.2 Le catalogue et les appartenances

`docs/security/2026-10-31-p105-sonde-connexions-lecture-seule.sql`, à exécuter
**en lecture seule**, section par section, dans l'éditeur SQL de Neon.

La sonde est elle-même testée : `scripts/test_p105_sonde_lecture_seule.mjs`
vérifie que chaque instruction commence par `SELECT`/`WITH`, que toutes
s'exécutent, que le moteur **refuse** une écriture dans la transaction
(`25006`), et que deux exécutions rendent le même résultat. Une sonde que
personne ne rejoue finit par contenir un `GRANT`.

Sections utiles : 2 (rôles et attributs), 3 (appartenances directes **avec**
ADMIN/INHERIT/SET), 4-5 (fermeture transitive, puis `pg_has_role('SET')`),
6 (propriété), 7 (RLS activée **et** forcée), 8 (privilèges effectifs),
9 (historique des migrations), 10 (registre des fonctions), 11-13 (clé HMAC,
mode d'identité, primitives de signature).

### 2.3 Ce qui invaliderait la bascule

| Constat | Conséquence |
|---|---|
| `current_user` = propriétaire de branche ou rôle `BYPASSRLS` | tout le reste est décoratif : la RLS ne s'applique pas |
| une ligne `app → X` dans `pg_auth_members` (même sans `INHERIT`) | `SET ROLE X` reste possible : escalade |
| `tracefab_app` possède une table | il contourne `FORCE RLS` sur cet objet |
| `has_table_privilege('tracefab_app','tracefab_identity_cles','SELECT')` = `true` | HMAC **abandonné** (critère d'arrêt de la mission) |
| `strict = false` alors que l'on annonce R-A1 fermé | M3 reste vrai |

## 3. Résultat mesuré sur base jetable (référence)

Cluster PostgreSQL 17.10, base `tf_p105`, 68 migrations, rôles provisionnés :

| Contrôle | Mesure |
|---|---|
| `tracefab_app` | LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, **0 appartenance** |
| `SET ROLE` depuis l'app vers migrator / worker / postgres | `42501` ×3 |
| contrôle positif `GRANT` → `SET ROLE` → 4 lignes visibles → `REVOKE` | concluant |
| tables publiques | 54 · RLS activée 53 · RLS forcée 53 |
| propriétaires | tables : `tracefab_migrator` 54 ; fonctions : `tracefab_migrator` 134, `postgres` 36, `tracefab_worker` 6 |
| politiques | 134 · encore adossées à `tracefab.public_context` : 12 · à `tracefab.user_id` : **0** |
| EXECUTE de l'allowlist par `tracefab_app` | 92/92 |
| `tracefab_app` → `tracefab_identity_cles` | `SELECT` = false, `UPDATE` = false |

Les 12 politiques encore adossées à `tracefab.public_context` sont la surface
publique (passeport, wallet) : ce GUC est posé **dans** une transaction par
`api/_lib/context.ts` pour les routes publiques, et il ne donne accès qu'à des
produits publiés. Elles ne portent pas d'identité d'utilisateur — c'est
précisément pourquoi `tracefab.user_id` n'apparaît plus dans une seule
politique.

## 4. Non vérifié en production

- `current_user` réel du runtime (mesure 2.1 non exécutée) ;
- appartenances effectives de la base Neon ;
- valeur effective de `DATABASE_URL` côté Vercel (nom du rôle) ;
- présence de `TRACEFAB_IDENTITY_KEY` sur le déploiement ;
- existence des 68 migrations dans `_prisma_migrations` de production.

**Aucune de ces cinq lignes n'est déductible du dépôt.** Le code montre ce que
le runtime *devrait* utiliser ; seule la sonde montre ce qu'il utilise.
