# Décision GO / NO-GO — candidat d'intégration Tracefab

**Date** : 8 novembre 2026
**Périmètre** : branche `candidat-integration-tracefab` = `origin/main` (`788df220`) + 7 migrations additives
**Auteur** : agent Arena, sur mesures reproductibles

---

## Décision

# GO — avec deux conditions explicites

Le candidat est **techniquement déployable** : 76/76 migrations s'appliquent sur base vierge, se rejouent sans effet, et se rejouent **sous un rôle de migration non superutilisateur**. Les 28 contrôles de sécurité sous rôles réels sont conformes. Les trois sondes d'appel réel passent 17/17, 17/17 et 28/28. Les 24 contrôles et suites du dépôt passent, ainsi que `typecheck`, `api:typecheck` et `schema:static`.

**Ce GO ne vaut que si les deux conditions ci-dessous sont respectées.** Elles ne sont pas des réserves de style : chacune correspond à un défaut mesuré qui a réellement cassé quelque chose pendant ce travail.

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

## Condition 2 — Migrer avec un rôle habilité à endosser `tracefab_worker`

La migration `120100` exige `SET` sur `tracefab_worker` (ou SUPERUSER). C'est le cas de la CI (`postgres`). Sur un rôle de migration non superutilisateur, elle fonctionne **à condition** que `120200` ait posé l'appartenance bornée — ce qui est vérifié sur le chemin P10.5 : **76/76 migrations appliquées**.

Ce point reste une dette du dépôt, pas du candidat : `20261028120100` est classée « assistée » et exige une élévation temporaire documentée dans `docs/security/2026-10-31-p105-provisionnement.md`.

---

## Ce qui a été prouvé, et comment

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

**Aucune migration n'a été poussée.** Aucun push n'a eu lieu. Le candidat existe uniquement dans le worktree `/home/user/wt-candidat`.

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
