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
