# 6. Supplier Profile — Chantier 2

## Objectif

Transformer la relation marque-fournisseur en parcours d'onboarding exploitable :

```text
Marque ajoute un fournisseur
  → invitation email à usage unique
  → acceptation par l'utilisateur invité
  → profil fournisseur initialisé
  → sites et activités complétés
  → soumission du profil
```

Le chantier reste centré sur la donnée structurée. Aucun profil n'est présenté comme vérifié ou certifié par le seul fait qu'il est soumis.

## Modèle livré

La migration `20260922010000_tracefab_supplier_profile.sql` complète `suppliers` avec :

- résumé d'activité ;
- contact principal ;
- fourchette d'effectif ;
- année de création ;
- score de complétude calculé ;
- utilisateur ayant modifié le profil en dernier.

Les tables déjà présentes sont réutilisées :

- `organizations` pour l'identité légale et le pays ;
- `suppliers` pour le profil principal et le statut d'onboarding ;
- `supplier_sites` pour les sites actifs et leurs activités ;
- `brand_supplier_relationships` pour la relation marque-fournisseur ;
- `organization_invitations` pour l'invitation et son hash de token.

## Fonctions sécurisées

### `tracefab_invite_supplier(...)`

Accessible uniquement à un owner, admin ou manager d'une organisation de type `brand`. La fonction :

1. crée une organisation fournisseur en statut `invited` ;
2. crée le profil fournisseur en statut `invited` ;
3. crée la relation marque-fournisseur ;
4. crée l'invitation propriétaire, valable sept jours ;
5. ne reçoit et ne stocke qu'un hash du token.

La génération du token brut, l'envoi email et le lien d'acceptation restent dans une Edge Function ou un backend de confiance.

### `tracefab_accept_organization_invitation(...)`

Accessible à un utilisateur authentifié. La fonction vérifie :

- token hash non expiré et non déjà accepté ;
- correspondance stricte avec l'email du JWT ;
- absence de membership existant ;
- création du membership owner ;
- passage de l'organisation et de la relation en statut actif ;
- passage du fournisseur en `in_progress`.

### `tracefab_update_supplier_profile(...)`

Fonction de mutation utilisée par le Supplier Portal. Elle limite l'écriture aux champs de profil, autorise les rôles opérationnels du fournisseur et recalcule la complétude. Une modification d'un profil déjà soumis ou approuvé le replace en `in_progress`.

### `tracefab_submit_supplier_profile(...)`

Accessible aux rôles opérationnels du fournisseur. La soumission est autorisée uniquement lorsque la complétude atteint 100 %. `submitted` signifie soumis pour revue, pas vérifié.

## Calcul de complétude initial

Le score porte sur sept éléments :

1. raison sociale ;
2. pays ;
3. résumé d'au moins 30 caractères ;
4. nom du contact ;
5. email du contact ;
6. au moins une activité ;
7. au moins un site actif.

Ce score mesure la présence des données attendues. Il ne mesure ni leur exactitude, ni leur fraîcheur, ni leur certification.

## Sécurité

- Le token brut n'est pas une donnée SQL Tracefab.
- Les fonctions de transition sont `SECURITY DEFINER` et leur exécution est retirée de `PUBLIC`.
- La visibilité de suivi d'invitation est limitée à la marque initiatrice et aux administrateurs du fournisseur.
- Les règles RLS existantes continuent de protéger le profil et les sites par organisation.
- Les contraintes d'ownership empêchent d'associer un site ou une entité d'un autre tenant à un profil.
- Des triggers vérifient que les relations sont bien `brand` ↔ `supplier` et que les invitations/partages référencent le bon côté fournisseur.

## Tests attendus

Les tests d'intégration Supabase doivent couvrir :

- marque autorisée à inviter ;
- fournisseur ou viewer non autorisé à inviter au nom d'une marque ;
- token invalide, expiré, réutilisé ;
- email JWT différent de l'email invité ;
- acceptation qui crée un seul owner ;
- profil incomplet refusé à la soumission ;
- profil complet passant à `submitted` ;
- marque ne pouvant pas modifier directement le profil fournisseur ;
- suivi d'invitation visible par la marque initiatrice sans exposition du token.

## Reste à faire

- Edge Function de génération et d'envoi email ;
- écran Brand Console « Ajouter un fournisseur » ;
- écran Supplier Portal du profil ;
- formulaire multi-étapes et validations UX ;
- tests RLS exécutés contre Supabase ;
- journalisation métier complète des invitations et soumissions.
