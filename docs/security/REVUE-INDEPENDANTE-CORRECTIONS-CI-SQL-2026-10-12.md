# Revue indépendante — corrections CI et privilèges SQL (12 octobre 2026)

## Portée et sécurité

Corrections apportées directement à la branche `arena/879cd8db-tracefab` de la PR #36.
Aucune modification de `main`, aucune fusion, aucun déploiement de production,
aucune connexion ou migration Neon n'a été effectuée.

**Important :** les preuves obtenues avant cette révision ne valident pas
automatiquement le SQL ni les scripts modifiés ici. Les changements ci-dessous
sont des corrections de code ; ils restent à exécuter sur une base jetable avant
qu'une décision de fusion soit possible.

## Corrections appliquées

### 1. Migration `20261012120000_close_public_execute_gap`

- Transaction explicite `BEGIN/COMMIT` afin qu'un contrôle final en échec annule
  les changements précédents de la migration.
- Précontrôle fail-closed : les six fonctions attendues doivent exister dans
  `public`, être `SECURITY DEFINER` et appartenir au rôle migrateur.
- Références SQL qualifiées par `public`.
- Suppression des branches qui ignoraient silencieusement une fonction absente.
- Vérification des droits de `PUBLIC` par le catalogue PostgreSQL
  (`aclexplode`, grantee OID 0), au lieu de traiter `PUBLIC` comme un rôle nommé
  avec `has_function_privilege('public', ...)`.
- Vérification des six fonctions et des droits `EXECUTE` de `tracefab_app`
  lorsque ce rôle existe.
- Le commentaire de retour arrière ne propose plus de réaccorder
  `EXECUTE` à `PUBLIC` ; il demande une restauration ciblée des rôles nommés.

### 2. Test `scripts/test_neon_privileges.mjs`

- Remplacement des contrôles ACL de `PUBLIC` par une inspection du catalogue.
- Ajout de `tracefab_public_context()` à la liste des six fonctions testées.
- Conservation du contrôle négatif et des sondes transactionnelles existants.

### 3. Garde-fous CI

- `.github/workflows/ci.yml` déclare maintenant explicitement
  `permissions: contents: read`.
- Les quatre étapes `actions/checkout` désactivent
  `persist-credentials`.
- Le workflow de diagnostic Vercel n'est plus déclenché sur un `push` ;
  il est manuel uniquement et désactive aussi les identifiants persistants.
- Le registre de workflows privilégiés a été aligné sur ce déclenchement manuel.

## Vérifications réellement effectuées après modification

| Contrôle | Résultat | Limite |
|---|---|---|
| Lecture des fichiers depuis la branche | RÉUSSI | Confirme le contenu distant, pas son exécution |
| Vérification statique des six signatures SQL | RÉUSSI | N'établit pas que la migration s'exécute correctement |
| Vérification statique des références qualifiées et de l'absence de saut silencieux | RÉUSSI | Pas un test PostgreSQL |
| Vérification statique des ACL `PUBLIC` dans le test | RÉUSSI | Le script modifié n'a pas été exécuté après modification |
| Vérification statique des permissions CI et des quatre checkouts | RÉUSSI | Aucun run GitHub Actions pour le commit courant |
| Déclencheur du diagnostic Vercel | RÉUSSI : manuel uniquement | Les protections de l'environnement GitHub ne sont pas vérifiées ; ne pas exécuter le workflow |
| Déploiement Vercel Preview du commit courant au moment du contrôle | EN COURS : `INITIALIZING` | Aucun résultat de build confirmé à ce stade |
| Exécution de la migration corrigée sur une base jetable | NON EXÉCUTÉ | Bloquant avant fusion |
| Exécution de `npm run test:neon:privileges` sur base jetable | NON EXÉCUTÉ après modification | Bloquant avant fusion |
| État réel des privilèges, du rôle de connexion et de la RLS dans Neon | BLOQUÉ / INCONNU | Aucun accès ni changement de production |
| Fusion, déploiement production, réactivation de CI | NON EFFECTUÉ | Exige une décision distincte |

## Conditions minimales avant de reconsidérer la fusion

1. Exécuter la migration corrigée sur une base PostgreSQL jetable reconstruite
   avec la chaîne de migrations complète.
2. Prouver le cas positif et le cas négatif : les six fonctions sont fermées à
   `PUBLIC`, le rôle applicatif nécessaire peut les exécuter, et une fonction
   créée ensuite par le rôle migrateur n'est pas exécutable par `PUBLIC`.
3. Simuler un échec volontaire dans la migration sur la base jetable et prouver
   que l'état antérieur est restauré intégralement par rollback.
4. Exécuter les contrôles de privilèges et de politique de workflows après les
   modifications, en enregistrant le SHA exact et les sorties complètes.
5. Obtenir un état de build Preview final `READY` pour le commit exact, puis
   contrôler les changements de la PR entière.
6. Vérifier dans les paramètres GitHub que l'environnement
   `vercel-log-search` impose réellement des relecteurs obligatoires avant toute
   exécution de son workflow manuel.

**Décision actuelle : NON FUSIONNABLE.** Les garde-fous statiques ont été
renforcés, mais les tests d'exécution correspondant à cette révision ne sont pas
encore prouvés. Ne pas réactiver GitHub Actions, ne pas exécuter de migration
Neon et ne pas fusionner dans l'intervalle.
