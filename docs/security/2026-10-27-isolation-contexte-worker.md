> **Suite du 28/10/2026 — voir `docs/security/2026-10-28-correction-contexte-worker.md`.**
> Ce document decrit le defaut et le premier correctif candidat. Le tour suivant a
> leve les deux obstacles (registre des fonctions runtime, propriete des fonctions
> par l'identite worker) et livre le correctif : la falsification ne donne plus
> aucune ligne. Les constats de ce document sur l'origine du defaut restent
> valables ; ses conclusions sur la livraison sont perimees.



# Isolation multi-organisations — le contexte worker est contournable

**Date : 27/10/2026 · Statut : DÉFAUT OUVERT, correctif candidat testé, non appliqué.**
**Environnement des mesures : PostgreSQL 18.4 jetable, 59 migrations, rôle
`tracefab_app` sans `BYPASSRLS`.** Aucune base de production n'a été touchée.

---

## 1. Le défaut, prouvé par exécution

Cinq politiques RLS sont gardées par un GUC de session :

```sql
current_setting('tracefab.worker_context', true) = 'true'
```

Tables concernées : `users`, `organizations`, `organization_memberships`,
`data_requests`, `data_request_items`, `data_responses` (11 politiques).

**Un GUC préfixé est positionnable par n'importe quel rôle.** Mesure, avec le
rôle applicatif lui-même (`BYPASSRLS = false`) :

| État de la session | `organizations` | `users` | `organization_memberships` |
|---|---|---|---|
| sans contexte armé | 0 | 0 | 0 |
| **après `SET tracefab.worker_context = 'true'`** | **2** | **2** | **2** |
| après `RESET` | 0 | 0 | 0 |

Reproductible : `TF_RLS_APP_URL=… node scripts/prouver_bypass_contexte_worker.mjs`
→ `ECHEC`, code 1.

**Ce que cela signifie exactement.** Quiconque peut ouvrir une connexion sous
`tracefab_app` — c'est-à-dire le runtime lui-même, ou quiconque obtient ce
credential — lit l'annuaire complet des organisations et des utilisateurs de la
plateforme. L'isolation de ces trois tables ne repose donc pas sur la RLS mais
sur la bonne volonté de l'appelant.

**Ce que cela ne signifie pas.** Les autres tables de locataire restent
correctement cloisonnées : `tracefab_products`, `documents`, `dpp_records` et les
autres rendent 0 ligne sans contexte armé, et l'attaque ne les ouvre pas.

## 2. Pourquoi la suite d'isolation ne le voyait pas

`npm run test:neon:rls` (50 tables, 2 locataires) teste l'isolation **en armant
les contextes prévus** : elle vérifie qu'un locataire ne voit pas l'autre. Elle
ne teste jamais qu'un appelant malveillant fabrique un contexte. Résultat :
la suite passe alors que la faille existe.

C'est le type de trou que seule une suite **négative** révèle : « je tente de me
donner des droits, et je vérifie que je n'obtiens rien ».

## 3. Correctif candidat — testé, non appliqué

Principe : remplacer la garde par un GUC par une garde par **rôle** :

```sql
-- candidat, 11 politiques
ALTER POLICY "organizations_worker_select" ON public."organizations"
  USING ((current_user = 'tracefab_worker'::name));
```

Mesure sur un clone de la base migrée :

| Rôle | GUC posé | `organizations` | Verdict |
|---|---|---|---|
| `tracefab_app` | oui | **0** | faille fermée |
| `tracefab_app` | non | 0 | comportement normal préservé |

**Mais le correctif n'est pas déployable en l'état**, et c'est important :
un rôle `tracefab_worker` fraîchement créé échoue immédiatement sur
`permission denied for function tracefab_current_user_email`. Une bascule
complète exige donc d'**approvisionner** ce rôle (EXECUTE sur les fonctions
nécessaires, GRANT sur les tables concernées), et de donner au runtime un
**second credential** pour les seuls chemins worker.

Ce sont des décisions d'infrastructure et de produit : elles ne se prennent pas
au détour d'un correctif. Elles ne sont donc **pas** appliquées.

## 4. Options, avec leur coût

| Option | Ferme la faille | Coût | Remarque |
|---|---|---|---|
| A. Rôle worker dédié + second credential | oui | approvisionnement du rôle + variable d'environnement + redéploiement | le plus conforme à l'intention d'origine |
| B. Sortir les lectures inter-locataires des politiques et les mettre dans des fonctions `SECURITY DEFINER` | oui | refonte des routes worker | la base compte déjà 117 fonctions `SECURITY DEFINER` : le modèle existe |
| C. Ne garder le GUC que pour des tables **sans** donnée de locataire | partiellement | faible | ne couvre pas `users`/`organizations`, donc insuffisant seul |
| D. Ne rien faire | non | nul | à écarter : le défaut est prouvé, pas théorique |

**Recommandation** : B, éventuellement après A en mesure transitoire. La RLS ne
peut pas dépendre d'une valeur que l'appelant contrôle.

## 5. État des autres contrôles de privilèges (mesurés, même base)

`node scripts/auditer_privileges_effectifs.mjs` :

| Contrôle | Résultat |
|---|---|
| Tables du schéma `public` | 50 |
| RLS **activée** | 49 / 50 (`_prisma_migrations` exceptée — aucun droit DML pour `tracefab_app`) |
| RLS **FORCÉE** | 49 / 49 des tables de données — **aucune exception** |
| Tables accessibles en écriture sans RLS | **0** |
| Fonctions | 168 · 117 `SECURITY DEFINER` · **toutes** figent `search_path` · **0** exécutable par `PUBLIC` |
| Séquences | 0 |
| Politiques permissives `USING (true)` | `rate_limit_counters` (par conception : compteurs), `supplier_passport_access_requests` en insertion (route publique, par conception) |
| Privilèges par défaut | un `ALTER DEFAULT PRIVILEGES` accorde des droits à `tracefab_app` sur les futurs objets `public` — à examiner, non bloquant |

Le défaut de la section 1 est donc **isolé** : le reste du dispositif est en
ordre, et notamment aucune table de données n'échappe à la RLS forcée.

## 6. Ce qui n'a pas pu être fait ici

- **Identité réelle du runtime** : non mesurée. La sonde
  `GET /api/internal/p2/readiness?identity=1` exige
  `TRACEFAB_NOTIFICATION_WORKER_SECRET`, absent de cet environnement, et le
  réseau sortant vers `tracefab.vercel.app` comme vers Neon est coupé
  (`ECONNRESET`, port 5432 intercepté). Le rôle du runtime reste donc
  **inconnu** : `tracefab_app` selon la documentation, `neondb_owner` selon un
  commentaire de la CI, « à mesurer » selon la réconciliation du 21/10.
- **Privilèges sur la production** : les mesures ci-dessus portent sur une base
  reconstruite par les 59 migrations du dépôt, pas sur Neon.
