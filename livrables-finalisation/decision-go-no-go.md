# Décision GO / NO-GO — candidat d'intégration Tracefab

**Date** : 8 novembre 2026
**Périmètre** : branche `candidat-integration-tracefab` = `origin/main` (`788df220`) + 7 migrations additives
**Auteur** : agent Arena, sur mesures reproductibles
**Référence initiale** : commit `515d5abf658eccf2fbc6d49c84cd803e8a8c15db`
**Correctif séparé** : branche `fix/tracefab-worker-membership-lifecycle-20261108` (aucune PR, aucune fusion)

---

## Décision

# NO-GO — appartenance worker résiduelle du migrateur

La revue indépendante du 8 novembre 2026 a invalidé le GO initial. Le candidat `515d5ab` laisse `tracefab_migrator` membre permanent de `tracefab_worker` via le crochet `apres` de `migrations_assistees.mjs`. La capacité d'endosser le worker a été exercée et l'exposition inter-tenant mesurée (2 identités visibles contre 1 sous le runtime). La matrice initiale ne testait pas `tracefab_migrator`.

Les résultats 76/76, checksums, sondes métier et 28/28 restent des preuves valables dans leur périmètre initial, mais ne prouvent pas l'isolation du rôle migrateur. Le candidat n'est pas intégrable tant que la correction du cycle de vie, la garde terminale et les tests migrator ne sont pas exécutés sur une base PostgreSQL jetable et confirmés par CI complète.

---

## Condition 1 — Déployer les 7 migrations, pas un sous-ensemble

Quatre défauts **préexistants** de `main` sont corrigés par les migrations 2, 5, 6 et 7. Déployer un sous-ensemble laisse la base dans un état non fonctionnel :

| Si on omet… | Alors… |
|---|---|
| `120500` | **toute** lecture de `organizations`, `users` ou `supplier_passport_access_requests` échoue en `42501` |
| `120600` | `lire-disponibilite-role-app` refuse la bascule : « OBSTACLE : SELECT absent sur orders » |
| `120400` | `tracefab_add_supply_chain_link` échoue en `42804`, l'ingestion PLM est impossible |
| `120200` | la chaîne n'est pas rejouable (`2BP01 dependent privileges exist`) |

Les migrations 1, 2, 3, 4, 5, 6, 7 forment **un tout** : chacune a été nécessaire pour que la suivante ou la précédente fonctionne.

---

## Défaut P0 — cycle de vie de l'appartenance worker

Le runner doit accorder `INHERIT TRUE, SET TRUE, ADMIN FALSE` uniquement pendant les migrations qui remplacent les fonctions possédées par `tracefab_worker`, puis révoquer et vérifier l'appartenance avant `20261108120700`. La migration `120200` ne doit plus tenter de s'accorder elle-même le rôle : elle vérifie le privilège temporaire préparé par le runner. Les chemins d'échec, SIGINT/SIGTERM et la reprise après interruption doivent être testés.

La garde terminale doit refuser toute appartenance effective résiduelle. Le test doit se connecter réellement sous `tracefab_migrator` et démontrer que `SET ROLE tracefab_worker` échoue en `42501`.

---

## Conditions de passage à GO

1. Rejouer les 77 migrations sur base vierge et en reprise, sous `tracefab_migrator` non superutilisateur.
2. Prouver l'absence d'appartenance worker et le refus de `SET ROLE` après succès, après échec contrôlé et après reprise.
3. Exécuter la matrice étendue (M0–M4) sous une vraie connexion migrator.
4. Obtenir la CI complète verte sur le SHA exact de correction.
5. Conserver les interdictions : aucune modification Neon, aucune fusion, aucun déploiement Production.

## Ce qui a été prouvé avant la découverte, et comment

| Affirmation | Preuve | Fichier |
|---|---|---|
| 76/76 s'appliquent sur base vierge | replay Prisma complet, exit 0 | `preuves/replay-76.log` |
| Se rejouent sans effet | second `migrate deploy` : « no pending » | idem |
| 76/76 sous rôle **non superutilisateur** | `migrer_fidelement.mjs` avec `tracefab_migrator` | sortie console § 3 de `matrice-tests.md` |
| `42804` corrigé | 73 migrations → échec sur 4 cas ; 76 → 17/17 | `preuves/sonde-lien-graphe.log` |
| Ingestion PLM idempotente | 2 ingestions identiques → 2 nœuds, 1 lien | `preuves/sonde-ingestion-plm.log` |
| Sécurité sous rôles réels | 28/28, session authentifiée | `preuves/matrice-securite-roles.log` |
| Parcours Clerk complet | création, re-sync, révocation, garde-fou, audit | idem |
| RLS 53/53 active **et forcée** | catalogue + politique d'écriture prouvée par exécution | `preuves/inventaire.json`, `preuves/test-rls-write-policies.log` |
| Aucune régression sur les contrôles du dépôt | 24 contrôles + `typecheck`/`api:typecheck`/`schema:static` | `preuves/controles-depot.log` |

---

## Ce qui n'a PAS été prouvé

| Point | Statut | Conséquence pour la décision |
|---|---|---|
| Exécution contre Neon / Preview | **non mesurée** — aucune cible joignable | Le candidat n'a **jamais** été appliqué à une base persistante. C'est un argument pour un déploiement sur branche enfant d'abord |
| `db:generate` (moteur Prisma) | **impossible ici** — `binaries.prisma.sh` bloqué | Sans incidence sur les migrations ; à revérifier en CI |
| Tests d'interface / navigateur | non exécutés | Hors périmètre des migrations |

À la date du rapport initial (`515d5ab`), aucune migration n'avait été poussée et le candidat n'existait que dans le worktree `/home/user/wt-candidat`. La branche corrective distincte ajoute une migration terminale `120700` et modifie le runner ainsi que les tests. Elle n'a pas encore reçu de validation CI complète ; elle n'a été ni ouverte en PR, ni fusionnée, ni appliquée à Neon.

---

## Risques résiduels, par ordre de gravité

1. **`users` reste lisible en entier par `tracefab_app` en cas de RLS désactivée.** La migration `120500` vérifie que la RLS est active ET forcée avant d'accorder `SELECT`, et refuse l'état inverse (`users_rls_non_forcee`). Mais une migration *future* pourrait la désactiver. Le contrôle `test_rls_write_policies` couvre cet état — il a été exécuté, il passe.

2. **Le worker possède désormais `INSERT` sur `audit_logs`.** Nécessaire : les deux fonctions Clerk y écrivent, et sans ce droit le transfert de propriété aurait fait disparaître la trace des adhésions. Le worker n'a ni `UPDATE`, ni `DELETE`, ni `SELECT` sur cette table — vérifié par `audit_logs_worker_non_append_only` dans la migration.

3. **`GRANT CREATE ON SCHEMA public TO tracefab_worker` est posé puis retiré** dans `120100`. Le retrait est vérifié dans le même fichier (`worker_create_sur_public_non_revoque`). Une interruption entre les deux laisserait le droit en place. Probabilité faible, conséquence bornée (le worker est NOLOGIN et inatteignable), mais c'est la seule opération non atomique du lot.

---

## Recommandation opérationnelle

1. Déployer sur une **branche enfant Neon**, pas sur la production principale.
2. Y rejouer `lire-disponibilite-role-app.mjs` et `matrice-securite-roles.mjs` — les deux mesurent l'état réel, pas le catalogue.
3. Si les deux passent, promouvoir.
4. Si l'un échoue, **ne pas promouvoir** : la base porte encore un défaut préexistant que ce candidat n'a pas su voir.

---

## Ce que ce travail a coûté, en transparence

Trois défauts ont été **introduits puis corrigés** pendant ce tour, et chacun a été trouvé par une mesure, pas par une relecture :

- `120100` première version : transfert de propriété **seul** ⇒ chemin Clerk cassé (`42501` sur `organization_memberships`, puis `audit_logs`). Corrigé en déplaçant aussi les prérequis.
- `120100` deuxième version : `ALTER ... OWNER TO` échouait en `42501 permission denied for schema public` sur un exécutant non superutilisateur. Corrigé par un `CREATE` borné et révoqué.
- `120000` première version : ré-ingestion dupliquait nœuds et liens (4 au lieu de 2). Corrigé par une déduplication sur clé naturelle.

Et deux défauts de **méthode**, qui ont produit de faux échecs avant d'être compris :

- `SET ROLE tracefab_app` depuis une session `postgres` ne simule pas une session applicative — le `session_user` reste superutilisateur, donc `SET ROLE tracefab_worker` réussit à tort. Corrigé par une session réellement authentifiée.
- `RESET ROLE` exécuté sur une connexion non privilégiée échoue, ce qui faisait échouer la mesure *suivante* pour une raison sans rapport.

Ces cinq points sont consignés parce qu'ils disent quelque chose du candidat : sa solidité vient des mesures d'appel réel, pas de la relecture du SQL. Un relecteur qui n'exécute pas ne les aurait pas vus.
