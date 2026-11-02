# Runbook — déploiement de la migration corrective `20261030140000`

**Objet** : appliquer `20261030140000_ingest_payload_role_guard_and_acl` sur la
base réelle sans interrompre l'ingestion PLM/ERP, et prouver que l'exposition
est fermée **après** application.

**Portée** : une seule migration (la 67ᵉ), aucune autre. Ce runbook ne modifie
ni `main`, ni le rôle runtime, ni l'application.

**Hors de ce runbook** : la bascule du runtime vers `tracefab_app` (chantier
d'architecture, cf. rapport P10.3 § 2). Tant qu'elle n'a pas eu lieu, la RLS
reste contournée par le rôle propriétaire : la migration ferme l'exécution à des
rôles non autorisés, elle ne rend pas la RLS opposable au runtime.

---

## 0. Ce qu'il faut avoir lu avant de toucher quoi que ce soit

| Fait | Conséquence |
|---|---|
| La fonction est `SECURITY DEFINER` et s'exécute avec les droits de son propriétaire. | Son ACL **et** sa garde de rôle sont la barrière. Un `GRANT` de complaisance l'annule. |
| Le runtime actuel se connecte sous le rôle **propriétaire** de la base, qui n'est ni superutilisateur ni membre de `tracefab_app` (documenté, non mesuré). | La garde doit admettre le propriétaire. C'est le cas depuis P10.3 ; sans cette branche, le déploiement **coupe l'ingestion**. |
| `tracefab.user_id` est un GUC positionnable par le client. | Il n'est **jamais** une preuve d'identité. Ne pas construire de contrôle qui repose dessus (cf. R-A1/R-A2). |
| Aucune migration n'a été appliquée à la base réelle à ce jour. | Le déploiement est une **première** application, pas un rattrapage. |

---

## 1. Préconditions (toutes obligatoires)

1. **CI verte sur le SHA déployé.** Vérifier le run `CI` du commit exact, tous
   jobs verts, et que le SHA de la PR est bien celui qu'on déploie.
2. **Aucune dérive d'historique.** `prisma migrate status` doit lister
   uniquement `20261030140000` en attente. Toute autre migration en attente
   **arrête** la procédure : on ne déploie pas 1 migration au milieu d'une
   dérive.
3. **Point de restauration disponible.** Créer une branche Neon de sauvegarde
   (`neon branches create --name pre-20261030140000 --parent main`) **avant**
   toute écriture, et noter la fenêtre PITR du projet. Une branche enfant
   partage les rôles et mots de passe de son parent : elle sert de point de
   retour, pas de base d'essai avec d'autres identifiants.
4. **Rôle runtime identifié.** Lire le rôle réellement utilisé par le runtime
   (journaux de connexion Neon, ou `pg_stat_activity` pendant une requête
   applicative). **Ne pas le déduire de la documentation.**
5. **Sonde de lecture seule jouée et archivée** :
   `docs/security/2026-10-30-p103-sonde-lecture-seule.sql`. Archiver la sortie
   avant déploiement : c'est l'état « avant ».
6. **Aucun secret recopié** dans un ticket, un journal de CI ou un fichier du
   dépôt.

### 1 bis. Contrôle qui prédit le verdict de la garde (lecture seule)

À exécuter **connecté avec le rôle du runtime** (ou en comparant son nom à
celui du propriétaire de la fonction) :

```sql
SELECT session_user                                                        AS role_runtime,
       pg_get_userbyid(p.proowner)                                         AS proprietaire_fonction,
       (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)        AS est_superuser,
       pg_catalog.pg_has_role(session_user, 'tracefab_app', 'MEMBER')      AS est_membre_app,
       (pg_get_userbyid(p.proowner) = session_user)                        AS est_proprietaire,
       ((SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
        OR pg_catalog.pg_has_role(session_user, 'tracefab_app', 'MEMBER')
        OR pg_get_userbyid(p.proowner) = session_user)                     AS garde_laissera_passer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'tracefab_ingest_plm_erp_payload';
```

`garde_laissera_passer = false` **arrête la procédure** : appliquer la migration
couperait l'ingestion.

---

## 2. Sauvegarde

| Élément | Procédure | Vérification |
|---|---|---|
| Base | Branche Neon `pre-20261030140000` (copy-on-write, instantanée) | La branche apparaît, son rôle/mot de passe est celui du parent |
| Historique des migrations | Export de `public._prisma_migrations` (lecture seule) | Le fichier contient les 66 lignes appliquées |
| ACL de la fonction | Sortie de la sonde, § 4 et 4b | Archivée avec le SHA déployé |
| Application | Aucune sauvegarde : le déploiement Vercel reste sur le build précédent | Le build précédent est identifiable par son URL |

**Aucun `pg_dump` complet n'est nécessaire** : la migration ne touche ni
données, ni tables, ni colonnes. Elle remplace une fonction et resserre une ACL.
La restauration réellement utile est celle du **code de la fonction** (capturée
par la sonde, `pg_get_functiondef`), pas celle des données.

---

## 3. Ordre d'exécution

1. **Appliquer la migration seule**, avec le rôle de migration, sans étape
   manuelle entre les deux :

   ```bash
   npx prisma migrate deploy      # ou la commande opérationnelle équivalente
   ```

   - **Jamais** `prisma migrate dev`, **jamais** `db push`.
   - **Jamais** de `psql -c "GRANT …"` ni de correctif « à la main » : la
     migration est autocohérente et idempotente (`CREATE OR REPLACE` +
     `REVOKE`).
   - Ne pas lancer les quatre lanceurs supprimés : ils n'existent plus, et
     c'est volontaire.

2. **Vérifier immédiatement** (§ 4). Aucune autre migration, aucun autre
   changement.

3. **Déployer l'application** seulement après § 4 au vert.

---

## 4. Contrôles après application

Rejouer la sonde, puis vérifier ces six points :

| # | Contrôle | Attendu |
|---|---|---|
| 1 | `_prisma_migrations` | `20261030140000` en `APPLIQUEE` |
| 2 | `proacl` | ne contient que le propriétaire et `tracefab_app` |
| 3 | `has_function_privilege('public', …, 'EXECUTE')` | `false` |
| 4 | `pg_get_functiondef` | contient `ingest_role_not_allowed` **et** `session_user` |
| 5 | `proconfig` | `search_path=pg_catalog, public` |
| 6 | § 1 bis rejoué | `garde_laissera_passer = true` |

Puis un **essai d'exécution contrôlé**, dans une transaction toujours annulée,
avec une organisation de test identifiée comme telle :

```sql
BEGIN;
SELECT set_config('tracefab.user_id', '<uuid d un utilisateur de test>', true);
SELECT tracefab_ingest_plm_erp_payload(
  '<uuid d une organisation de test>'::uuid, 'generic_csv',
  '{"products":[{"reference":"P103-SONDE-DEPLOIEMENT","name":"sonde"}]}'::jsonb, NULL);
ROLLBACK;   -- rien ne doit subsister
```

- L'appel doit **aboutir** (rôle runtime = propriétaire) : c'est la preuve que le
  chemin légitime n'est pas cassé.
- Vérifier après le `ROLLBACK` qu'aucune ligne `P103-SONDE-DEPLOIEMENT`
  n'existe, ni dans `tracefab_products`, ni dans `plm_erp_sync_jobs`.

**Contrôle négatif obligatoire** — un rôle qui n'est ni propriétaire, ni
`tracefab_app`, ni superutilisateur doit être refusé. Il ne se teste **pas** en
production : il est prouvé sur base jetable par
`npm run test:jetables:ingest-acl` (assertions A1, A3, A10), et la sonde § 4b
montre qu'aucun autre rôle ne détient `EXECUTE`.

---

## 5. Procédure d'arrêt

Arrêter **avant** l'étape 3 (déploiement applicatif) dès qu'un des cas suivants
se produit :

| Signal | Arrêt |
|---|---|
| § 1 bis `garde_laissera_passer = false` | **immédiat**, avant migration |
| `prisma migrate status` montre une autre migration en attente | immédiat |
| § 4 points 1-6 non conformes | arrêt, aucune application de code |
| L'essai contrôlé lève `ingest_role_not_allowed` | arrêt, l'application **ne doit pas** être déployée |
| L'essai laisse une ligne après `ROLLBACK` | incident de transaction, arrêt |

Un arrêt ne demande aucune action de retour : la migration est
transactionnelle, et une migration échouée n'est pas marquée appliquée.

---

## 6. Retour arrière — ce qui est réaliste, ce qui ne l'est pas

**Ce qui n'existe pas** : un « rollback » qui annule proprement la migration.
PostgreSQL n'a pas de `DROP MIGRATION`, et réécrire la fonction telle qu'elle
était **rouvrirait la vulnérabilité P0**. Ce n'est pas un plan de retour, c'est
une régression.

**Ce qui existe, par ordre de préférence :**

1. **Retour applicatif seul** (le plus probable) : redéployer le build
   précédent sur Vercel. La migration ne change aucun schéma : l'ancien code
   continue de fonctionner (il appelle la même signature). C'est le retour à
   chaud, en minutes.
2. **Correctif en avant** : si la garde refuse un rôle légitime, la correction
   est une **nouvelle** migration qui élargit l'autorisation au rôle constaté —
   jamais un `REVOKE`/`GRANT` manuel. Le cas « runtime = propriétaire » est déjà
   couvert par la branche 3 ; tout autre rôle doit être justifié par écrit avant
   d'entrer dans la liste.
3. **Restauration de la base** : inutile ici (aucune donnée modifiée). Si elle
   était invoquée malgré tout, elle ramènerait l'ancienne fonction **et**
   l'exposition : elle exige une décision explicite et doit être suivie d'une
   réapplication de la migration.
4. **Branche Neon de sauvegarde** : sert à *enquêter* (comparer les ACL avant et
   après), pas à revenir en production.

**Décision à consigner** : si l'on choisit 6.1, noter que la base porte la
migration et que le code est en retard d'une version — état sûr, à résorber.

---

## 7. Après le déploiement — ce qu'il reste à faire

| Point | Pourquoi |
|---|---|
| Basculer le runtime vers `tracefab_app` | Sans cela, la RLS reste contournée par le rôle propriétaire, et la garde de rôle ne protège que des rôles tiers. |
| Signer le contexte d'identité (R-A1/R-A2) | Tant que `tracefab.user_id` est un GUC nu, quiconque détient les identifiants du rôle applicatif peut usurper un utilisateur. |
| Révoquer `BYPASSRLS` du rôle de runtime | Un rôle qui contourne la RLS ne peut pas servir de frontière de sécurité. |
| Vérifier la fenêtre PITR | Une fenêtre de 6 h ne couvre pas un week-end. |

Ces quatre points sont hors du périmètre de cette migration ; les traiter dans
cet ordre.
