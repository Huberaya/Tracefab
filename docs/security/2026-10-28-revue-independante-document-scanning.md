# Revue indépendante — `tracefab_mark_document_scanning` et contextes internes

Date : 28/10/2026 · Branche : `arena/c27ddaa4-tracefab` · SHA examiné : `29dc215`
Base d'essai : PostgreSQL 18.4 local, **deux modèles de propriétaire** (voir §1), rôle `tracefab_app`
`NOSUPERUSER NOBYPASSRLS`, données du seed RLS (2 organisations, 2 utilisateurs, 4 produits).

Ce document ne remplace pas `2026-10-28-correction-contexte-worker.md` ; il couvre la revue
de la fonction ajoutée par `20261028120200` et l'audit des contextes internes restants.

## 1. Deux modèles de base, et pourquoi c'est déterminant

Le premier modèle, utilisé par la CI, applique les migrations avec `postgres` : ce rôle est
**superutilisateur** et porte `BYPASSRLS`. Les fonctions `SECURITY DEFINER` y sont possédées par
`postgres`, donc **contournent toutes les politiques** — y compris celles des tables qu'elles lisent.

Pour ne pas conclure depuis un modèle plus permissif que la production, un second modèle a été
construit : migrations appliquées, puis propriété transférée à un rôle `NOSUPERUSER NOBYPASSRLS`.

Ce transfert a révélé deux dépendances (§2). Les mesures de sécurité de §3 à §6 ont été rejouées
dans **les deux** modèles ; les résultats ne divergent que là où c'est signalé.

## 2. Dépendance à `BYPASSRLS` du propriétaire — mesure, non corrigée

**Constat 1 — la chaîne n'est pas rejouable par un propriétaire sans `BYPASSRLS`.**
Avec un rôle `NOSUPERUSER NOBYPASSRLS` comme propriétaire :

```
ECHEC migration 20261006160000_dpp_readiness_exposure :
new row violates row-level security policy for table "dpp_requirement_profiles"
```

Cause : `20261006100000` pose `FORCE ROW LEVEL SECURITY` sur neuf tables, puis
`20261006160000` y **insère** sans politique d'INSERT. Un propriétaire qui ne contourne pas la
RLS est donc bloqué en cours de chaîne ; un superutilisateur ne l'est pas. Le dépôt annonçait
déjà `rolbypassrls = true` sur `neondb_owner` en production, sans en mesurer la conséquence.

**Constat 2 — les fonctions `SECURITY DEFINER` deviennent récursives.**
Propriétaire sans `BYPASSRLS`, sous `tracefab_app` :

```
tracefab_mark_document_scanning(...) -> ERREUR 54001 | stack depth limit exceeded
lecture simple de documents          -> ERREUR 54001 | stack depth limit exceeded
```

Les politiques appellent des fonctions `SECURITY DEFINER` (`tracefab_has_org_role`,
`tracefab_can_access_org`, …) qui lisent à leur tour des tables à RLS forcée et rappellent les
mêmes politiques. Avec `BYPASSRLS` sur le propriétaire, la récursion n'a pas lieu et tout
fonctionne (36/36 assertions du cycle documentaire passent dans les deux modèles).

**Portée.** Ce n'est pas une vulnérabilité exploitable : `tracefab_app` ne porte pas `BYPASSRLS`,
et aucun rôle applicatif ne peut se l'octroyer. C'est une **dépendance de déploiement** : le
schéma ne fonctionne que si le rôle propriétaire contourne la RLS. Elle conditionne directement
la remédiation déjà ouverte (« retirer `BYPASSRLS` à `neondb_owner` ») : ce retrait **casserait
l'application**, et doit donc être précédé d'un correctif de la chaîne et des politiques.

**Action recommandée, non réalisée ici** : ce correctif touche 9 tables, plusieurs migrations
livrées et la conception même des politiques (les fonctions appelées par une politique ne
peuvent pas dépendre d'un privilège que le propriétaire n'a pas). Il dépasse le périmètre d'une
PR de correction de contexte. À traiter comme un chantier distinct, avant tout retrait de
`BYPASSRLS`.

**Limite assumée de la mesure** : le transfert de propriété a été fait après application des
migrations ; l'échec de §2 constat 1 a été obtenu en appliquant la chaîne directement en tant que
propriétaire non superutilisateur.

## 3. Revue de `tracefab_mark_document_scanning`

| # | Point vérifié | Mesure | Verdict |
|---|---|---|---|
| 1 | propriétaire et `search_path` | propriétaire = propriétaire des migrations (`postgres` en base d'essai, comme les trois autres fonctions du cycle) ; `SET search_path = public` | conforme |
| 2 | `EXECUTE` | retiré à `PUBLIC` par la migration ; accordé à `tracefab_app` **par le registre** ; 0 fonction `SECURITY DEFINER` exécutable par `PUBLIC` | conforme |
| 3 | élévation | `SET ROLE tracefab_worker` → `42501` ; `SET SESSION AUTHORIZATION tracefab_worker` → `42501` ; 0 appartenance croisée | conforme |
| 4 | rôle dans l'organisation propriétaire | `owner/admin/manager/contributor` acceptés ; `viewer` → `document_scan_role_required` ; autre locataire → refus (libellé variable, voir §4) | conforme |
| 5 | états et rejeu | `uploaded → scanning` OK ; rejeu sur `scanning` OK (reprise) ; depuis `available` ou `rejected` → `document_not_in_scannable_state` | conforme |
| 6 | champs réservés | `UPDATE`/`INSERT`/`DELETE` directs → `42501`, **même avec `tracefab.internal_document_update = 'true'`** | conforme |
| 7 | injection | aucun SQL dynamique dans la fonction ; un seul paramètre `UUID` typé | conforme |
| 8 | erreur en cours de transaction | le drapeau interne est transactionnel : mesuré `true` → après `ROLLBACK TO SAVEPOINT` → revient à l'état antérieur ; après `ROLLBACK` → vide | conforme |
| 9 | cohérence des quatre fonctions | `register`, `finalize`, `mark` : `EXECUTE` accordé et **appelées** depuis `api/` ; `soft_delete` : `EXECUTE` **non accordé** et **appelée nulle part** | voir §5 |

Détail du point 8, mesuré :

```
avant                                 : <non posé>
après set_config(...,true)            : true
après erreur + ROLLBACK TO SAVEPOINT  : true   <- valeur antérieure au savepoint
après ROLLBACK                        : vide
```

Aucun état partiellement validé : la fonction valide avant d'écrire, et toute erreur annule
l'écriture *et* le drapeau avec la (sous-)transaction.

## 4. Un libellé d'erreur dépend du modèle de déploiement

Pour un document appartenant à un autre locataire, la fonction répond :

- `document_not_found` si le propriétaire subit la RLS (la ligne est invisible avant le contrôle) ;
- `document_scan_role_required` si le propriétaire contourne la RLS (la ligne est lue, le rôle tranche).

Les deux refusent, et l'état du document reste inchangé dans les deux cas. Le test de régression
assertit donc **la propriété** (refus + état intact), pas le libellé — sinon il serait vert ou
rouge selon le seul environnement, sans rien dire de la sécurité.

## 5. `tracefab_soft_delete_document` : capacité sans chemin

La fonction existe, est `SECURITY DEFINER`, mais :

- `EXECUTE` n'est **pas** accordé à `tracefab_app` (mesuré : `42501 permission denied for function`) ;
- elle n'est appelée **nulle part** dans `api/` (recherche sur tout le répertoire).

C'est la même catégorie que `users_update_self` après `20261028120100` : une capacité déclarée
dans le schéma, sans chemin applicatif. Rien à corriger dans cette PR — la supprimer ou l'ouvrir
serait un changement de produit, pas de sécurité. À trancher par le responsable : soit une route
de suppression logique est prévue et il faudra la déclarer au registre, soit la fonction est morte.

## 6. Contextes internes restants

### 6.1 `tracefab.internal_document_update`

Fermé par `20261028120200`. Mesuré sous `tracefab_app`, drapeau posé :

```
UPDATE documents SET status='available'            -> 42501
UPDATE documents SET sha256=repeat('c',64)         -> 42501
SELECT                                             -> OK
tracefab_mark_document_scanning (ayant-droit)      -> OK, scanning
```

### 6.2 `tracefab.internal_data_collection_update`

Inatteignable par privilège : `tracefab_app` ne détient que `SELECT` sur `data_requests`,
`data_request_items` et `data_responses`. Mesuré, drapeau posé :

```
UPDATE data_requests  -> 42501
INSERT data_requests  -> 42501
UPDATE data_responses -> 42501
```

Le déclencheur qui lit ce drapeau protège une écriture que le rôle applicatif ne peut de toute
façon pas effectuer. Aucun changement nécessaire.

### 6.3 `tracefab.user_email` dans `passport_access_select`

La politique laisse lire une demande d'accès dont `requester_email` égale
`current_setting('tracefab.user_email')`. Trois questions, trois mesures.

**a) Le courriel vient-il du client ?** Non. `api/_lib/auth.ts` vérifie le JWT Clerk
(`verifyToken`), puis lit l'adresse principale via l'API Clerk (`clerk.users.getUser`). Aucune
route ne passe un courriel de requête dans ce GUC ; les appelants de
`withTracefabUserContext` transmettent tous `user.email` issu de cette vérification.

**b) Que permet la falsification du GUC ?** Mesuré sous `tracefab_app`, sur une demande créée
pour un tiers, dans une organisation dont l'utilisateur test n'est pas membre :

```
courriel de l'utilisateur            -> 0 ligne visible
courriel du tiers (GUC forcé)        -> 1 ligne visible
aucun courriel                       -> 0 ligne visible
```

La falsification donne bien l'accès. Elle exige cependant de contrôler la session SQL, ce qui
suppose de détenir les identifiants du rôle applicatif — c'est-à-dire d'être l'application.

**c) Écriture possible sur cette table ?** Non : `SELECT` seul, `UPDATE` → `42501`. Un visiteur
peut déposer une demande avec n'importe quel courriel (route publique
`/api/passport/[tokenOrSlug]/request-access`, par conception, via une fonction dédiée), mais il
ne peut pas la relire sans être authentifié avec l'adresse correspondante, et n'obtient alors
que sa propre demande.

**Verdict** : pas de correction de code. Le résidu — un GUC d'identité plutôt qu'une identité
tirée de `users` — est réel mais non atteignable par un utilisateur final. Durcir cette politique
imposerait de la réécrire sur `tracefab_current_user_id()` et une jointure, donc de toucher une
migration livrée ou d'en ajouter une pour un risque non exploitable. Documenté, à trancher.

## 7. Preuves de non-régression ajoutées

`scripts/test_neon_document_lifecycle.mjs` (déjà exécuté en CI, étape « Cycle de vie
documentaire ») a été étendu d'une section « Bascule scanning : états, rejeu et rôles » :

- `uploaded → scanning` par la fonction dédiée ;
- rejeu sur `scanning` accepté ;
- refus depuis `available`, depuis `rejected` ;
- refus pour un autre locataire, **et** état du document resté `uploaded` ;
- refus pour un membre `viewer` de la bonne organisation ;
- refus sans contexte utilisateur ;
- écriture directe refusée même drapeau interne posé.

La suite passe **36/36** dans les deux modèles de propriétaire (`exit 0`).

## 8. Ce qui n'a pas pu être exécuté ici

`@prisma/client` ne peut pas être généré dans cet environnement : la CLI Prisma exige un binaire
`schema-engine` téléchargé depuis `binaries.prisma.sh`, inaccessible. `prisma validate` échoue
lui-même pour cette raison. Contourner en fabriquant un client à la main reviendrait à tester
autre chose que le code livré : ce n'est pas fait.

Conséquence : les suites qui importent `@prisma/client` ne sont pas exécutables ici. Elles sont
recensées, avec leur statut CI réel, dans le rapport de mission.
