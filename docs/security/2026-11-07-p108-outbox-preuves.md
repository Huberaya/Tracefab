# P10.8 — Preuves outbox sur PostgreSQL 17.11 réel

**Date** : 2026-11-07 · **Branche** : `arena/0f697b3e-tracefab`
**Artefacts** : `docs/security/2026-11-07-p108-outbox-scenarios.json` (41 scénarios, 41 PASS / 0 FAIL), `docs/security/2026-11-07-p108-ci-mesures.json` (harnais CI autonome, 8 PASS / 1 NOT APPLICABLE).
**Commandes** : `bash scripts/p108_pg17_demarrer.sh` puis `npm run p108:outbox` et `npm run p108:ci`.
**Moteur** : `PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit`. La CI utilise le build **Debian** `17.11-1.pgdg13+2` du service `postgres:17` ; les deux sont **PostgreSQL 17.11**, PGlite local (18.6) ne satisfait pas la Phase C.

---

## 1. Méthode — pourquoi ces preuves ne sont pas des simulations

* Chaque scénario part d'une **base vierge** créée par `DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE`, sur le cluster jetable local.
* La chaîne de migrations est appliquée par une connexion d'administration du cluster **jetable** ; les fixtures (organisations, relation, demande, trois événements, clé HMAC en mémoire, utilisateur) sont insérées avant la modélisation des propriétaires.
* **Toutes les opérations métier** (`claim`, `complete`, `health`, `SELECT` sur l'outbox, tentatives d'élévation, vérificateurs HMAC) sont exécutées par de **véritables connexions** `tracefab_app` : `session_user = current_user = tracefab_app`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`. `SET ROLE` n'est **jamais** utilisé pour simuler une session applicative ; le scénario `C20` mesure explicitement que `SET ROLE tracefab_app` laisse `session_user=postgres` et ne prouve donc rien.
* Le superutilisateur du cluster jetable sert **uniquement** à : créer/détruire la base, appliquer les migrations, insérer les fixtures, modeler les propriétaires non superutilisés et simuler un crash (`UPDATE … SET locked_at = now() - interval '16 minutes'`). Aucune opération métier ne passe par lui. `preuve_superutilisateur_jamais_metier = true` dans le JSON.
* Deux **modèles de propriétaire** complémentaires, tous deux explicitement documentés dans `scripts/lib/p108_pg17.mjs` :
  * `MODELISATION_PROPRIETAIRE` (ACL cible) : tables + 13 opérations système → `tracefab_migrator` (`NOSUPERUSER/NOBYPASSRLS`) ; le prédicat, le vérificateur HMAC et pgcrypto restent à l'administrateur, avec l'ACL exacte déclarée par #114 (`REVOKE … FROM PUBLIC`, `GRANT EXECUTE … TO tracefab_worker`). C'est la configuration qui reproduit le `42501`.
  * `MODELISATION_PROPRIETE_PLEINE` (forme d'une base managée) : **tous** les objets de `public` → `tracefab_migrator`, y compris les types enum et `hmac()`. Le prédicat devient exécutable (propriétaire commun) : le `42501` disparaît, mais la politique RLS bloque toujours — c'est la **seconde cause racine**, un défaut **silencieux**.
* Pour chaque scénario, le JSON consigne : SQL exact, rôle actif, `session_user`/`current_user`/`rolsuper`/`rolbypassrls`, état RLS (`relrowsecurity`, `relforcerowsecurity`, nombre de politiques) **lu depuis la connexion métier**, SQLSTATE, obtenu, attendu, statut.

---

## 2. Reproduction AVANT correction, et passage APRÈS

| Scénario | Refs | Correctif | Migrations | SQLSTATE | Obtenu | statut du scénario |
|---|---|---|---|---|---|---|
| `S1_114_seule` | `main, #114` | non | 70 | 42501 | 42501 permission denied for function tracefab_identite_systeme | PASS |
| `S2_111_et_114` | `#111, #114` | non | 87 | aucun | 1 ligne(s), status=processing | PASS |
| `S3_canonique_sans_correctif` | `main, #113, #114` | non | 72 | 42501 | 42501 permission denied for function tracefab_identite_systeme | PASS |
| `S3b_canonique_avec_correctif` | `main, #113, #114` | oui | 73 | aucun | 1 ligne(s), status=processing | PASS |

`S1` et `S3` **échouent** avec `42501 permission denied for function tracefab_identite_systeme`, mesuré sur PostgreSQL 17.11 réel avec une session `tracefab_app` non superutilisée. `S2` (#111 présent) et `S3b` (correctif) **passent**. Le même test échoue avant la correction et passe après, sans désactivation de RLS ni élévation : c'est le test exigé par la mission.

### Seconde cause racine, mesurée séparément

| Scénario | Modèle | Correctif | Attendu | Obtenu | Statut |
|---|---|---|---|---|---|
| `R1_rls_sans_worker` | propriete_pleine_migrateur | non | 0 ligne(s), sans erreur (defaut SILENCIEUX) | 0 ligne(s) | PASS |
| `R2_rls_avec_worker` | propriete_pleine_migrateur | oui | 1 ligne(s), sans erreur | 1 ligne(s) | PASS |

`R1` : avec un propriétaire unique, le prédicat est exécutable, la garde passe, mais `notification_outbox_update_trusted` exige `current_user='tracefab_worker'` → **`claim` rend 0 ligne sans aucune erreur**. Un simple `GRANT EXECUTE` sur le prédicat n'aurait donc **pas** suffi. `R2` : avec la corrective, 1 ligne revendiquée.

### Inventaire des causes

1. **ACL du prédicat** — `tracefab_identite_systeme()` est `SECURITY INVOKER` ; #114 ferme PUBLIC et n'accorde l'`EXECUTE` qu'à `tracefab_worker`. À l'intérieur d'une fonction `SECURITY DEFINER` possédée par le rôle de migration, `current_user` vaut ce rôle → `42501`.
2. **Politique RLS forcée** — `notification_outbox_update_trusted` : `USING` et `WITH CHECK` = `(CURRENT_USER = 'tracefab_worker')`. Sans propriétaire worker, `claim` ne revendique rien, **sans erreur**.
3. **Ordre du correctif candidat** — `20261106120300` triait avant #114 `20261106130000` (voir `docs/security/2026-11-07-p108-chaine-migrations.md` §3).

Mesures catalogue : `pg_proc.proowner`, `pg_get_userbyid`, `pg_get_functiondef`, `pg_policies`, `has_function_privilege`, `has_table_privilege`, `pg_roles`. Aucune conclusion n'est tirée d'une exécution superutilisateur.

---

## 3. Correction minimale et durable

`prisma/migrations/20261107120000_p108_outbox_proprietaire_et_dependances/migration.sql` — sha256 `6bf720822f7a361bf2703a85c7583e66f056f05e5303a6c910ce783f0e7d31dc`.

* **Une seule nouvelle migration additive**, idempotente (`I1` : ré-exécution → `SQL REUSSI`, 3/3 fonctions toujours au worker). Aucune migration historique modifiée ou renommée.
* **Transfert catalogue-driven** des 13 opérations système gardées par #114 vers `tracefab_worker` : aucune liste de signatures écrite à la main, aucune fonction attendue ignorée en silence. Le nom des 13 fonctions est explicite, pas déduit de la présence de la garde : la corrective fonctionne donc **aussi sur la branche seule**, avant que #114 soit fusionnée.
* **Privilèges minimaux**, mesurés nécessaires (identiques à #111) : `SELECT` sur `data_requests`/`users`, `SELECT,INSERT,UPDATE` sur l'outbox, `USAGE` sur les types, `EXECUTE` sur les trois fonctions de locataire, `EXECUTE` du prédicat au worker et fermeture de PUBLIC si #114 est présente.
* **Préconditions** : `tracefab_worker` existe, n'est ni superutilisateur ni `BYPASSRLS` ; `tracefab_app` n'est pas membre du worker ; claim/complete existent ; le rôle de migration peut endosser le worker (condition identique à #111, **vérifiée**, jamais accordée automatiquement). Aucune appartenance de rôle n'est créée ; seul `CREATE ON SCHEMA public` est posé temporairement et **révoqué dans le même bloc**, donc la même transaction.
* **Postconditions qui font échouer la migration** : propriétaire = worker et `search_path` figé pour les 13 fonctions ; aucune exécutable par PUBLIC ; `tracefab_app` sans `INSERT`/`UPDATE` sur l'outbox ; worker avec `UPDATE` ; RLS active **et** forcée ; runtime conserve `EXECUTE` sur claim/complete ; le prédicat reste interdit au runtime.
* `I2` : la corrective est appliquée avec succès par une connexion **`tracefab_migrator` NOSUPERUSER/NOBYPASSRLS** (3/3 transferts), sans élévation permanente.

**Ce que la corrective ne fait pas** : aucun `GRANT` à `tracefab_app` ou PUBLIC sur l'outbox/le prédicat, aucune désactivation de RLS, aucune modification de politique, aucune bascule `strict`/`systeme_strict`, aucune lecture/écriture de clé HMAC, aucun secret, aucun changement de la politique anti-rejeu.

---

## 4. Les 41 scénarios (détail intégral dans le JSON)

Colonnes : SQL, rôle actif, attendu, obtenu, SQLSTATE, statut, preuve RLS active, preuve d'absence d'élévation, session mesurée. `PASS` signifie « le comportement attendu a été observé », y compris pour les **refus** attendus.

| ID | SQL | Rôle actif | Attendu | Obtenu | SQLSTATE | Statut | RLS | Non-élévation | Session mesurée |
|---|---|---|---|---|---|---|---|---|---|
| `S1_114_seule` | SELECT set_config('tracefab.identity_systeme', <jeton valide>, false); SELECT * FROM public.tracefab_claim_notification_outbox(1); | `tracefab_app` | SQLSTATE 42501 (permission denied for function tracefab_identite_systeme) | 42501 permission denied for function tracefab_identite_systeme | `42501` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `S2_111_et_114` | SELECT set_config('tracefab.identity_systeme', <jeton valide>, false); SELECT * FROM public.tracefab_claim_notification_outbox(1); | `tracefab_app` | claim >= 1 ligne, sans erreur | 1 ligne(s), status=processing | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `S3_canonique_sans_correctif` | SELECT set_config('tracefab.identity_systeme', <jeton valide>, false); SELECT * FROM public.tracefab_claim_notification_outbox(1); | `tracefab_app` | SQLSTATE 42501 (permission denied for function tracefab_identite_systeme) | 42501 permission denied for function tracefab_identite_systeme | `42501` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `S3b_canonique_avec_correctif` | SELECT set_config('tracefab.identity_systeme', <jeton valide>, false); SELECT * FROM public.tracefab_claim_notification_outbox(1); | `tracefab_app` | claim >= 1 ligne, sans erreur | 1 ligne(s), status=processing | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `R1_rls_sans_worker` | SELECT * FROM public.tracefab_claim_notification_outbox(1); -- politique: (CURRENT_USER = 'tracefab_worker') | `tracefab_app` | 0 ligne(s), sans erreur (defaut SILENCIEUX) | 0 ligne(s) | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `R2_rls_avec_worker` | SELECT * FROM public.tracefab_claim_notification_outbox(1); -- politique: (CURRENT_USER = 'tracefab_worker') | `tracefab_app` | 1 ligne(s), sans erreur | 1 ligne(s) | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C1_creation_outbox` | SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.tracefab_notification_outbox'::regclass; SELECT policyname,cmd FROM pg_poli | `tracefab_app` | rls=true, force=true, 3 politiques | {"rls":true,"force":true,"pol":3} | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C2_insertion_evennement_autorise` | SELECT * FROM public.tracefab_notification_outbox_health() | `tracefab_app` | health accessible au runtime avec jeton systeme, sans erreur | {"pending":3,"processing":0,"sent":0,"failed":0,"ready":3,"staleProcessing":0,"exhausted":0,"oldestReadyAt":"2 | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C3_claim_autorise` | SELECT * FROM public.tracefab_claim_notification_outbox(1) | `tracefab_app` | 3 lignes processing, attempts=1 | 3 lignes ; processing/1,processing/1,processing/1 | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C4_claim_concurrent_2_workers` | BEGIN; SELECT * FROM tracefab_claim_notification_outbox(1); -- T1 et T2 en parallele, FOR UPDATE SKIP LOCKED | `tracefab_app (2 connexions)` | deux transactions concurrentes : 2 lignes distinctes revendiquees (FOR UPDATE SKIP LOCKED), une seule revendic | T1=40000000-0000-4000-8000-000000000001 T2=40000000-0000-4000-8000-000000000002 | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False / tracefab_app=tracefab_app,super=False,bypass=False |
| `C5_complete_autorise` | SELECT * FROM tracefab_claim_notification_outbox(1); SELECT * FROM tracefab_complete_notification_outbox(<id>,'sent','p108-provider',NULL,now()); | `tracefab_app` | complete -> status='sent', sent_at renseigne | status=sent provider=p108-provider | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C6_complete_role_non_autorise` | SELECT * FROM public.tracefab_complete_notification_outbox($1,'sent','p108-provider',NULL,now()) | `tracefab_migrator` | SQLSTATE 42501 permission denied for function tracefab_complete_notification_outbox | 42501 permission denied for function tracefab_complete_notification_outbox | `42501` | PASS | oui | oui | tracefab_migrator=tracefab_migrator,super=False,bypass=False |
| `C7_modification_directe_interdite` | UPDATE public.tracefab_notification_outbox SET status='sent' WHERE id=<id> | `tracefab_app` | SQLSTATE 42501 permission denied for table tracefab_notification_outbox | 42501 permission denied for table tracefab_notification_outbox | `42501` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C8_acces_inter_tenant` | SELECT set_config('tracefab.user_id', <user A>, false); SELECT id FROM tracefab_notification_outbox WHERE recipient_organization_id IN (<A>,<B>); | `tracefab_app` | 1 seule ligne (organisation A), aucune ligne de B | 1 ligne(s) : a0000000-0000-4000-8000-000000000001 | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C9_sans_contexte_refuse` | SELECT set_config('tracefab.identity_systeme','',false); SELECT * FROM tracefab_claim_notification_outbox(1); | `tracefab_app` | SQLSTATE 42501 authentication_required | 42501 authentication_required | `42501` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C10_avec_contexte_passe` | SELECT * FROM public.tracefab_claim_notification_outbox(1) | `tracefab_app` | 1 ligne processing | 1 ligne(s) status=processing | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C11_complete_repete` | SELECT * FROM tracefab_complete_notification_outbox(<deja sent>,'sent','x',NULL,now()); | `tracefab_app` | SQLSTATE P0001 notification_outbox_item_not_processing | P0001 notification_outbox_item_not_processing | `P0001` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C12_rollback_apres_claim` | BEGIN; SELECT * FROM tracefab_claim_notification_outbox(1); ROLLBACK; SELECT status,attempts FROM tracefab_notification_outbox WHERE id=<id>; | `tracefab_app` | apres ROLLBACK : 3 pending, 0 processing, attempts inchange | {"pending":3,"processing":0} | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C13_crash_entre_claim_et_complete` | SELECT * FROM tracefab_claim_notification_outbox(1); COMMIT; -- puis crash, aucun complete | `tracefab_app` | 1 ligne processing, verrou horodate, aucun complete | {"status":"processing","attempts":1,"locked_at":true} | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C14_retry_apres_timeout` | ADMIN: UPDATE ... SET locked_at=now()-interval '16 minutes'; SELECT * FROM tracefab_claim_notification_outbox(1); | `tracefab_app` | ligne reclamable apres expiration, attempts >= 2 | 1 ligne(s) attempts=2 | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C15_reprise_apres_echec` | ADMIN: status='failed', attempts=2 ; SELECT * FROM tracefab_claim_notification_outbox(5); | `tracefab_app` | ligne en echec reclamable, attempts=3 | [{"id":"40000000-0000-4000-8000-000000000002","a":3},{"id":"40000000-0000-4000-8000-000000000003","a":1}] | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C16_doublon_evenement` | INSERT INTO tracefab_notification_outbox(... event_key = <deja present> ...) | `postgres` | SQLSTATE 23505 unique_violation (event_key) | 23505 duplicate key value violates unique constraint "tracefab_notification_outbox_event_key_key" | `23505` | PASS | oui | n/a | postgres=postgres,super=True,bypass=True |
| `C17_deux_organisations` | SELECT * FROM tracefab_claim_notification_outbox(5); | `tracefab_app` | au moins 2 organisations distinctes revendiquees par le worker | 3 lignes, orgs=a0000000-0000-4000-8000-000000000001,b0000000-0000-4000-8000-000000000002 | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C18_rls_active` | SELECT relrowsecurity, relforcerowsecurity FROM pg_class ...; SELECT count(*) FROM pg_policies ... | `tracefab_app` | rls=true, force=true, 3 politiques | {"rls":true,"force":true,"pol":3} | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C19_elevation_refusee` | SET ROLE tracefab_worker; | `tracefab_app` | SQLSTATE 42501 permission denied to set role | 42501 permission denied to set role "tracefab_worker" | `42501` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `C20_set_role_vs_vraie_session` | SET ROLE tracefab_app; SELECT current_user, session_user; | `postgres` | current_user=tracefab_app mais session_user=postgres (insuffisant) | {"cu":"tracefab_app","su":"postgres"} | `—` | PASS | oui | n/a | postgres=postgres,super=True,bypass=True |
| `C21_cles_illisibles_runtime` | SELECT version,secret FROM public.tracefab_identity_cles; | `tracefab_app` | aucun secret lisible (42501 ou 0 ligne RLS) | 42501 permission denied for table tracefab_identity_cles | `42501` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H1_forme_canonique_suffixe` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = false | false | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H2_majuscules_mac` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = false | false | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H3_expiration_600s` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = false | false | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H4_mac_falsifie` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = false | false | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H5_expire` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = false | false | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H6_valide` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = true | true | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H6b_borne_599s` | SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>); | `tracefab_app` | verificateur = true | true | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H7_rotation_sans_coupure` | ADMIN: INSERT cle v99002 active ; SELECT tracefab_identite_systeme_jeton_valide(<jeton ancienne cle>); | `tracefab_app` | true (ancienne cle active) | true | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H8_revocation_immediate` | ADMIN: UPDATE ... SET actif=false ; SELECT tracefab_identite_systeme_jeton_valide(<jeton revoque>); | `tracefab_app` | false | false | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H9_fail_closed_et_nouvelle_cle` | SELECT tracefab_identite_systeme_jeton_valide(<nouvelle cle>); SELECT * FROM tracefab_claim_notification_outbox(1) sans jeton; | `tracefab_app` | nouvelle cle=true ET claim sans jeton=42501 | {"valide":true,"refus":"42501"} | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H10_guc_transactionnel` | BEGIN; SELECT set_config('tracefab.identity_systeme',<jeton>,true); COMMIT; SELECT * FROM tracefab_claim_notification_outbox(1); | `tracefab_app` | apres COMMIT : 42501 authentication_required | {"refus":"42501"} | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `H11_jeton_utilisateur_lie_org` | SELECT tracefab_identity_jeton_utilisateur(<jeton org A>) avec tracefab.active_organization_id=<B>; | `tracefab_app` | NULL (jeton non lie au contexte) | null | `—` | PASS | oui | oui | tracefab_app=tracefab_app,super=False,bypass=False |
| `I1_correctif_idempotent` | RE-EXECUTION de 20261107120000_p108_outbox_proprietaire_et_dependances/migration.sql | `postgres (application de migration, cluster jetable)` | aucune erreur, 3/3 fonctions outbox toujours possedees par tracefab_worker | SQL REUSSI ; transferees=3/3 ; 1er passage=73 migrations | `—` | PASS | n/a | n/a | n/a (application de migration) |
| `I2_correctif_par_role_non_superutilisateur` | EXECUTION de la migration corrective via une connexion tracefab_migrator | `tracefab_migrator` | SQL reussi, 3/3 fonctions outbox possedees par tracefab_worker, session non superutilisee | SQL REUSSI ; 3/3 ; chaine=72 migrations | `—` | PASS | n/a | oui | tracefab_migrator=tracefab_migrator,super=False,bypass=False |

Couverture : création de l'outbox, injection autorisée, claim, **claim concurrent deux workers / deux transactions** (`FOR UPDATE SKIP LOCKED`, deux lignes distinctes), complete autorisé, complete par rôle non autorisé, modification directe refusée, accès inter-tenant refusé, sans contexte refusé, avec contexte accepté, réutilisation idempotente, reprise après échec, RLS active, superutilisateur interdit pour les opérations métier, rollback après claim, crash simulé entre claim et complete, retry après timeout, doublon d'événement (`23505`), complete répété (`P0001`), claim expiré, événements de deux organisations, tentative `SET ROLE` refusée, secret HMAC illisible.

---

## 5. HMAC — non-régression (Phase D)

* `npm run test:hmac:chaine-confiance` : **107 assertions / 0 échec** (PGlite, suite P10.7 inchangée).
* Sur PostgreSQL 17.11 réel, 12 scénarios `H1`–`H11` (dont `H6b`) tous **PASS** : forme canonique + suffixe refusé, MAC en majuscules refusé, plafond d'expiration mesuré avec **l'horloge de la base** (`now()+601` → `false`, `now()+599` → `true`), MAC falsifié refusé, jeton expiré refusé, rotation sans coupure (ancienne clé acceptée pendant le chevauchement), révocation immédiate, fail-closed (claim sans jeton → `42501`), GUC transactionnel (`SET LOCAL` ne survit pas au `COMMIT`), jeton utilisateur lié à l'organisation (jeton de A refusé avec contexte B), secret illisible par `tracefab_app` (`42501`), compatibilité RLS.
* `npm run p107:antirejeu` : **23 mesures / 0 échec**. Le risque **R1** (rejeu inter-transactions) reste **accepté et documenté**, aucune v2 livrée : la politique anti-rejeu n'a pas été modifiée dans cette mission.
* Aucun secret affiché, copié ou transmis. Les clés sont générées en mémoire (`randomBytes(32)`) et détruites avec les bases jetables.

---

## 6. Limites

* Le build PostgreSQL local est **Ubuntu 7.5.0** ; la CI est **Debian 14.2.0**. Tous deux rendent `PostgreSQL 17.11`. Le harnais CI autonome (`p108:ci`) est exécuté dans le service `postgres:17` de la CI pour couvrir le build Debian (voir `docs/security/2026-11-07-p108-ci-preuves.json`).
* `CI09_fail_closed` est **NOT APPLICABLE** sur la branche seule : la garde `authentication_required` est apportée par #114, qui n'est pas fusionnée. Le contrôle est **mesuré en `C9`** avec #114 sur le même PostgreSQL 17.11 ; il n'est pas transformé en `PASS` artificiel.
* Aucune preuve sur Neon, Preview ou Production. Voir Phase G du rapport final : `BLOCKED`, jamais `PASS`.
