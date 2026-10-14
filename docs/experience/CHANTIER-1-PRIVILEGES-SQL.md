# Chantier 1 — Durcissement exhaustif des privilèges EXECUTE SQL

**État : correctifs préparés dans la PR #41 ; non fusionnés et non appliqués à Neon production.**

## Objectif de sécurité

Aucune fonction du schéma PostgreSQL `public` ne doit être directement exécutable par le pseudo-rôle `PUBLIC`. Les appels nécessaires au serveur passent par le rôle runtime `tracefab_app`, avec les contrôles applicatifs et les politiques RLS. Les privilèges d'un rôle SQL ne remplacent jamais l'autorisation métier.

## Constat fondé sur les éléments disponibles

### Éléments de production déjà rapportés

La dernière inspection SQL fournie a identifié six fonctions avec `EXECUTE` accessible à `PUBLIC` après la migration `20261009180000_public_read_context` :

- `tracefab_public_context()` ;
- `tracefab_product_is_public(uuid)` ;
- `tracefab_material_is_public(uuid)` ;
- `tracefab_supplier_site_is_public(uuid)` ;
- `tracefab_public_brand(uuid)` ;
- `tracefab_material_visible_via_product(uuid)`.

Cinq de ces fonctions étaient `SECURITY DEFINER`. Cela établit un défaut de privilèges SQL ; cela ne suffit pas, à lui seul, à prouver qu'une donnée a été exfiltrée.

### Éléments constatés dans le dépôt

L'audit statique a trouvé des migrations historiques qui accordent explicitement `EXECUTE TO PUBLIC` à d'autres fonctions, notamment des fonctions de synchronisation Clerk, d'onboarding fournisseur, de lecture de traçabilité, de préparation DPP et de mutations produit. Certaines ont été créées après la migration de durcissement du 7 octobre, qui ne pouvait donc pas les couvrir.

Le code du dépôt ne permet pas de déduire que toutes ces autorisations sont encore présentes en production : l'historique complet de Neon doit d'abord être réconcilié.

## Correctifs préparés

### 1. Migrations 20261014100000 et 20261014110000

Elles ferment explicitement les droits sur les fonctions ciblées qui avaient été identifiées, tout en réaccordant conditionnellement `EXECUTE` à `tracefab_app` lorsque ce rôle existe.

### 2. Migration 20261014120000 — privilèges par défaut

Elle révoque `EXECUTE` à `PUBLIC` au niveau global et pour le schéma `public`, pour le rôle qui exécute la migration. Lorsque `tracefab_app` existe, elle lui accorde par défaut `EXECUTE` sur les futures fonctions créées par ce rôle.

La migration crée une fonction témoin dans sa transaction, vérifie qu'elle n'est pas exécutable par `PUBLIC`, vérifie l'accès de `tracefab_app` si le rôle existe, puis supprime la sonde. Une vérification en échec fait échouer et annule la migration.

### 3. Migration 20261014130000 — fermeture exhaustive des privilèges publics

Elle révoque `EXECUTE` sur les fonctions du schéma `public` dont le rôle de migration est propriétaire, tous les privilèges `PUBLIC` sur les tables/vues/séquences détenues par le rôle de migration, ainsi que `CREATE` sur le schéma lui-même. Le retrait de `EXECUTE` est volontairement limité aux fonctions détenues par le rôle de migration : sur Neon, certaines fonctions d'extensions (par ex. pgcrypto) appartiennent à `cloud_admin`, et `neondb_owner` ne doit pas tenter de modifier leurs ACL. Leurs droits standards `PUBLIC EXECUTE` ne sont pas assimilés à une exposition de fonction métier TraceFab.

Si `tracefab_app` existe, la migration lui accorde `EXECUTE` sur toutes les fonctions existantes. Elle ne réaccorde pas les privilèges de tables : les droits directs déjà attribués à `tracefab_app` restent inchangés, car `REVOKE FROM PUBLIC` ne les retire pas. Sur une base vierge, le seed attribue les droits applicatifs après les migrations.

Avant de valider la transaction, elle inspecte le catalogue PostgreSQL et échoue si :
- une fonction applicative de `public` détenue par le rôle de migration reste exécutable par `PUBLIC` ;
- une table, vue ou séquence applicative détenue par le rôle de migration conserve un privilège accordé à `PUBLIC` ;
- `PUBLIC` conserve le droit `CREATE` sur le schéma `public` ;
- `tracefab_app` existe mais n'a pas `EXECUTE` sur une fonction du schéma.

Cette migration est volontairement plus large qu'une liste fixe de fonctions : elle couvre aussi les fonctions créées par les anciennes migrations qui réintroduisaient explicitement les droits publics.

### 4. Test d'intégration SQL

`scripts/test_neon_privileges.mjs` contrôle maintenant :
- toutes les fonctions du schéma `public`, pas uniquement une liste connue ;
- zéro fonction applicative détenue par le rôle de migration exécutable par `PUBLIC` (les fonctions d'extensions fournisseur sont hors périmètre) ;
- `EXECUTE` effectif pour `tracefab_app` sur toutes les fonctions ;
- l'absence d'accès pour un rôle de test sans privilèges ;
- les fonctions sensibles et les gardes de déclencheurs explicitement identifiés.

La CI exécute ce test sur un PostgreSQL jetable, après les migrations et avant le seed. Le test n'utilise pas Neon production.

## Conditions de clôture

Le chantier ne sera déclaré **exécuté et validé** que lorsque toutes les conditions suivantes seront satisfaites :

1. La CI complète est verte sur le dernier commit qui contient ces correctifs.
2. Le test d'intégration prouve zéro fonction `PUBLIC EXECUTE` sur une base neuve.
3. Le test prouve que `tracefab_app` peut exécuter les fonctions nécessaires sans s'appuyer sur `PUBLIC`.
4. La migration history complète de Neon a été comparée aux migrations du dépôt, dans l'ordre, y compris les statuts et les échecs éventuels.
5. Le rôle qui appliquera les migrations en production est confirmé ; les privilèges par défaut sont configurés pour le rôle réel qui créera les fonctions.
6. Après une application contrôlée, une requête SQL en lecture seule confirme sur Neon zéro fonction de `public` exécutable par `PUBLIC`, puis confirme les droits attendus de `tracefab_app`.
7. Les tests de lecture publique, de RLS et d'isolation inter-organisations restent verts.

## Limites et précautions

- Aucun changement n'a été appliqué à Neon production par ce chantier.
- La PR #41 reste non fusionnée au dernier état connu.
- Le rôle `tracefab_app` est un rôle runtime de confiance. Son secret doit rester côté serveur ; le fait qu'il dispose d'`EXECUTE` ne doit pas être exposé à un client navigateur.
- Les droits directs de `tracefab_app` sur les tables et séquences ne sont pas réécrits par la migration de révocation. Ils doivent être vérifiés après application ; les tests RLS exécutés après le seed vérifient que les opérations légitimes continuent de fonctionner.
