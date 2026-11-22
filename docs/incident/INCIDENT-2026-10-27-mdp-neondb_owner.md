# Incident — mot de passe de production exposé (27/10/2026)

**Statut : ouvert. Action de rotation à décider par le propriétaire.**

## Ce qui s'est passé

Le 27/10/2026, lors de la configuration du `.env` de validation, la chaîne de
connexion complète de la branche de validation
(`tracefab-dpp-readiness-validation-current-20261027`, hôte
`ep-morning-grass-b1pq7stz…`) a été collée en clair dans une conversation. Le
mot de passe du rôle `neondb_owner` a donc été exposé.

La chaîne a ensuite été recollée une seconde fois, par erreur, comme *valeur*
de `TF_ATTENDU_HOTE` — même secret, même exposition.

## Ce qui a été mesuré, et non supposé

| Contrôle | Résultat |
|---|---|
| Rotation sur la branche de **validation** | faite : `Reset password` dans la console Neon |
| Nouvelle chaîne opérationnelle | oui — `verifier:identite-cible` code 0, registre à 59 |
| Empreinte du nouveau secret | `8ee77c5a76`, différente de l'ancienne (`ac9ff1c44d`) |
| Ancien mot de passe sur la **validation** | **refusé** — `28P01 password authentication failed` |
| Ancien mot de passe sur la **production** | ⚠️ **ACCEPTÉ** — la connexion a réussi (aucune requête exécutée) |
| Secret dans les fichiers versionnés | aucun (seuls des `localhost` de CI et des valeurs factices) |
| `.env` suivi par git | non |

## Pourquoi la production accepte encore l'ancien mot de passe

Dans Neon, les rôles sont **rattachés à une branche**, et une réinitialisation
ne vaut que pour la branche où elle est faite. Mais une branche enfant créée
depuis une branche parente **hérite des mêmes rôles et des mêmes mots de
passe**. La branche de validation étant issue de la production, les deux
branches partageaient le mot de passe à leur création : révoquer sur l'une ne
révoque pas l'autre.

Conséquence : **le secret exposé ouvre encore la production.** C'est un incident
de sécurité réel, quelle que soit la probabilité d'exploitation.

## Ce qui reste à faire (décision du propriétaire, écriture en production)

1. **Inventaire avant rotation** — savoir qui utilise `neondb_owner` en
   production : variables d'environnement du projet Vercel (nom de la variable,
   jamais sa valeur), jobs planifiés, scripts locaux, intégrations Neon.
   *(Le connecteur Vercel de cette session répond `Access denied` : cet
   inventaire doit être fait dans la console Vercel.)*
2. **Rotation sur la branche de production** : Neon → branche de production →
   Roles → `neondb_owner` → Reset password.
3. **Mise à jour des variables dans la même fenêtre** : remplacer la valeur
   dans Vercel, puis **redéployer** (une variable modifiée n'est prise en compte
   qu'au déploiement suivant).
4. **Propagation aux autres branches** : Neon recommande de réinitialiser le
   rôle sur *chaque* branche où il peut se connecter. Les branches enfants
   gardent l'ancien mot de passe jusqu'à leur propre rotation.
5. **Preuve de révocation** : rejouer le test d'authentification sur la
   production et exiger `28P01`.
6. **Surveillance** : chercher `password authentication failed` dans les logs
   applicatifs après la rotation — c'est le signal d'un emplacement de secret
   oublié.

## Ce que cet incident enseigne sur la procédure

- Ne jamais coller une chaîne de connexion dans une conversation, même pour
  « vérifier un hôte » : `TF_ATTENDU_HOTE` attend **un nom d'hôte**, pas une URL.
- Une branche enfant n'est pas une frontière de sécurité pour les identifiants :
  hériter du schéma, c'est hériter des secrets.
- `Reset password` se prouve par un refus d'authentification (`28P01`), pas par
  le fait qu'une nouvelle chaîne fonctionne.

## Inventaire préalable (lecture seule)

Objectif : savoir **qui** présente l'ancien mot de passe, avant de le révoquer.
Seuls les **noms** de variables sont relevés — jamais les valeurs.

### 1. Vercel

Pour **chaque** projet du compte (ne pas supposer qu'il n'y en a qu'un) :
Settings → Environment Variables. Relever, pour chaque variable dont le nom
évoque une base (`DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`,
`TF_RLS_APP_URL`, `NEON_*`…) :

- le **nom** exact ;
- les **environnements** visés (Production / Preview / Development) ;
- le type (plain / encrypted / sensitive).

Relever aussi, dans le projet : les **Cron Jobs** et les fonctions qui ouvrent
une connexion directe à Postgres.

### 2. Neon

Project → Branches : liste des branches, et **quelle branche est la branche par
défaut (production)**. Puis, pour chaque branche : Roles → qui a `LOGIN`, et
qui est `neondb_owner` par défaut.

### 3. Consommateurs hors Vercel

- GitHub → Settings → Secrets and variables → Actions : **noms** des secrets
  contenant une URL de base (repo `Huberaya/Tracefab`).
- Tout script ou poste local dont le `.env` contient l'ancienne valeur.
- Intégrations tierces éventuelles (outils de BI, sauvegardes, monitoring).

### 4. Décision

Une fois l'inventaire connu, la rotation se fait **en une seule fenêtre** :
rotation Neon → mise à jour de chaque emplacement → redéploiement → preuve
`28P01` → surveillance des journaux. Le détail est dans la section suivante.

## Séquence de rotation (à exécuter seulement après inventaire)

1. **Fenêtre annoncée** : prévenir que l'application peut renvoyer des erreurs
   d'authentification pendant la manœuvre.
2. **Rotation Neon** : branche de production → Roles → `neondb_owner` →
   Reset password. Copier la nouvelle chaîne depuis `Connect` (Direct
   connection). Ne la coller que dans le gestionnaire de secrets.
3. **Mise à jour Vercel** : remplacer la valeur de chaque variable relevée à
   l'inventaire, dans **tous** les environnements concernés.
4. **Redéploiement** : une variable modifiée n'est prise en compte qu'au
   déploiement suivant — redéployer, puis vérifier que le déploiement est
   `Ready`.
5. **Preuve de révocation** : tenter une authentification avec l'ancien mot de
   passe sur la production ; exiger `28P01`. Un succès interdit de clore
   l'incident.
6. **Branches enfants** : appliquer la rotation sur chaque branche où le rôle
   peut se connecter ; une branche enfant conserve l'ancien mot de passe
   jusqu'à sa propre rotation.
7. **Surveillance 24 h** : rechercher `password authentication failed` dans les
   journaux applicatifs ; chaque occurrence désigne un emplacement de secret
   oublié.
8. **Clôture** : l'incident ne se clôt que lorsque l'étape 5 rend `28P01` et
   que l'étape 7 est vide.
