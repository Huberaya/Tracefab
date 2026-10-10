# Chantier 2B — levée des blocages opérationnels (sans déploiement en production)

Date : 2026-10-10. Branche : `arena/91844ee9-tracefab`. Commit de référence : `f57e0b0`. PR #34.

Ce rapport est un état des lieux en lecture seule. Aucune valeur de secret n'est affichée ni enregistrée. Aucune base de production n'a été touchée. Aucune migration n'a été lancée.

## Constat transversal

- **Réseau de l'environnement d'exécution** : seuls `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org` et `files.pythonhosted.org` sont joignables. Neon (`console.neon.tech`), Clerk (`api.clerk.com`) et Apple (`developer.apple.com`) renvoient un échec de connexion. Google Wallet n'a pas été testé, mais son hôte n'est pas non plus dans la liste autorisée. Conséquence : **aucun test d'intégration réelle n'est exécutable depuis cet environnement**, même avec des secrets.
- **Secrets** : aucune variable d'environnement d'intégration n'est présente dans l'environnement d'exécution. `gh secret list` (dépôt et environnements `Preview`/`Production`) échoue : la présence des secrets côté GitHub ne peut pas être vérifiée.
- **Droits de lecture GitHub** : la protection de branche de `main` renvoie 403 (« Resource not accessible by integration »). Aucune ruleset n'est remontée. Les permissions Actions au niveau du dépôt ne sont pas lisibles.

## Tableau par action

| # | Action | État | Preuve | Environnement | Accès requis | Risque résiduel | Prochaine étape |
|---|---|---|---|---|---|---|---|
| 1.1 | Permissions GitHub Actions | **Fait en partie** | `ci.yml` : `permissions: contents: read` (commit `675e5a4`). `figer-reference-visuelle.yml` : `contents: write`, nécessaire à la régénération des références. | Dépôt | Lecture (faite) | Le workflow `figer` peut écrire dans le dépôt ; il est déclenché par un marqueur `.figer`. | Le propriétaire vérifie les permissions Actions du dépôt (non lisibles par API). |
| 1.2 | Références des actions | **Non conforme** | Toutes les actions sont épinglées par tag (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`), pas par SHA de commit. | Dépôt | Aucun (modification de code possible) | Une action tierce peut changer sans révision. | Épingler chaque action sur son SHA complet, avec un commentaire de version. Changement de code, non fait ici. |
| 1.3 | Environnement `Production` : approbation humaine | **Bloqué** | API lue : `Production` existe, `protection_rules: []`. | GitHub | Administrateur du dépôt (écriture sur l'environnement) | Un déploiement peut partir sans relecteur. | Voir « Instructions au propriétaire » ci-dessous. |
| 1.4 | Protection de branche `main` et rulesets | **Non vérifiable** | 403 sur `branches/main/protection` ; aucune ruleset remontée. | GitHub | Administrateur du dépôt | Pas de preuve de protection de `main`. | Vérification manuelle dans les réglages du dépôt. |
| 1.5 | Présence des secrets requis | **Non vérifiable** | `gh secret list` en échec (dépôt et environnements). Aucune variable d'intégration dans l'environnement. | GitHub | Administrateur du dépôt | Absence de secret non détectée avant un déploiement. | Vérification manuelle des noms de secrets (valeurs jamais affichées). |
| 2.1 | Méthode de sauvegarde Neon | **Bloqué** | Aucun `pg_dump` disponible ; console Neon et API injoignables ; le registre npm ne fournit pas `pg_dump` (cf. chantier 2, phase 4). | Neon | Accès console Neon ou clé API Neon, et outil de sauvegarde | Pas de sauvegarde physique restaurable prouvée. | Lancer une sauvegarde Neon (branche ou export) depuis la console, puis la restaurer dans une base isolée. |
| 2.2 | Procédure de restauration isolée | **Partiel** | Vérification logique seulement : 46 tables et 55 lignes restaurées dans `tracefab_restore_check`. | Base de scénario | Aucun | Ne prouve ni la sauvegarde physique, ni la restauration de production. | Une fois la sauvegarde faite, la restaurer dans une base isolée et relancer les contrôles de schéma et de rôles. |
| 3.1 | `INACTIF-001` (archivé, publié, relu) | **Décision requise** | Inventaire préprod : reste public. | Préprod | Décision produit | Une fiche archivée reste accessible publiquement. | Décider : dépublier (recommandé, car archivé) ou conserver en connaissance de cause. |
| 3.2 | Autres produits | **Inventaire fait** | Préprod : reste public `[INACTIF-001, PUB-001]` ; dépubliés `[BROUILLON-001, NON-RELU-001, SANS-ETAT-001]` ; inaccessible `[PRIVE-001]`. | Préprod | Aucun | Relecture de `PUB-001` non vérifiée sur données réelles. | Confirmer `PUB-001` avant la migration. |
| 4.1 | Clerk en préprod | **Bloqué** | Hôte injoignable ; `CLERK_SECRET_KEY` et `CLERK_WEBHOOK_SIGNING_SECRET` absents. | Préprod | Clés de l'instance Clerk de préprod, dans le gestionnaire de secrets | Authentification réelle non testée. | Fournir les clés de préprod dans les secrets GitHub de l'environnement `Preview`. |
| 4.2 | Apple Wallet (signature) | **Bloqué** | Hôte Apple injoignable ; certificats `APPLE_PASS_CERTIFICATE_PEM`, `APPLE_PASS_KEY_PEM`, `APPLE_TEAM_IDENTIFIER`, `APPLE_PASS_TYPE_IDENTIFIER` absents. | Préprod | Certificat de pass et WWDR réels | Un passe non signé ne doit jamais sortir. La garde de production existe (erreur explicite), mais la signature réelle n'est pas vérifiée. | Fournir les certificats ; valider un passe signé avec un outil de contrôle de signature. |
| 4.3 | Google Wallet (signature) | **Bloqué** | `GOOGLE_WALLET_ISSUER_ID` et `GOOGLE_WALLET_PRIVATE_KEY` absents. | Préprod | Compte émetteur et clé de compte de service | Même risque que 4.2. | Fournir les identifiants ; valider la signature du jeton avec un outil dédié. |
| 5.1 | Sel du rate limiter | **Bloqué** | `TRACEFAB_RATE_LIMIT_SALT` absent. `test:rate-limit` ne passe qu'avec un sel de test. Comportement fail-closed (503) confirmé dans `api/_lib/rate-limit.ts`. | Production | Gestionnaire de secrets, sel généré hors dépôt | Sans sel de production, le limiteur n'est pas réellement protégé. | Générer le sel dans le gestionnaire de secrets, le déployer uniquement en production, ne jamais l'afficher. |
| 5.2 | Alertes sur les 503 | **Non fait** | Aucune configuration d'alerte trouvée lors de cette passe (non recherchée en profondeur). | Production | Accès à l'outil d'observabilité | Une panne du limiteur passe inaperçue. | Définir une alerte sur le taux de 503 du limiteur. |

## Instructions au propriétaire (réglages non accessibles par API)

1. **Environnement `Production`** : dans *Settings → Environments → Production*, ajouter *Required reviewers* (au moins une personne autre que l'auteur) et, si possible, restreindre les branches de déploiement à `main`.
2. **Protection de `main`** : dans *Settings → Rules → Rulesets*, exiger une PR, des vérifications `Socle`, `Parcours`, `Base`, `Vérification`, et interdire les pushs directs.
3. **Actions** : dans *Settings → Actions → General*, limiter les actions autorisées (actions GitHub et actions vérifiées par SHA).
4. **Secrets** : dans *Settings → Environments → Preview / Production*, vérifier la présence des noms de secrets listés dans `.env.example`. Ne jamais les coller dans le chat ni dans le dépôt.
5. **Sauvegarde Neon** : depuis la console Neon, créer une branche ou un export de la base de production avant toute migration, puis la restaurer dans une base isolée.

## Décision

**BLOCAGES RESTANTS.**

Aucun blocage n'est levé en préproduction. Les intégrations réelles (Clerk, Apple Wallet, Google Wallet) ne sont pas exécutables depuis cet environnement, et les secrets nécessaires ne sont pas configurés.

Autorisation explicite requise avant toute opération irréversible, notamment la migration `20261010120000_publication_explicite` en production.
