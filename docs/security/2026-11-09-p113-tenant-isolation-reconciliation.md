# Reconciliation de l'isolation multi-tenant — 9 novembre 2026

## Base de comparaison

- Ancienne base des PR : `788df22019c0d2b39301678ecfbc43ac868561bf`
- `main` retenu pour la réconciliation : `71855014f4a4f6212b5475f4c208704c0054fb09`
- Branche : `arena/0f697b3e-tracefab`

## Correction du harnais PGlite

Le test global doit comparer deux états réellement distincts :

1. Le baseline s'arrête immédiatement avant `20261105180000_active_tenant_access_guards`.
2. Les fixtures sont insérées dans cet état historique.
3. Le correctif et toutes les migrations suivantes sont appliqués avant les contrôles après-correctif.

Exclure seulement la migration cible tout en appliquant les migrations ultérieures produisait un baseline déjà durci et ne reproduisait plus la fuite historique.

Les fixtures de partage documentaire renseignent `document_ids` et `subject_ids` pour désigner les documents précis. Elles n'ajoutent pas `subject_types`, qui aurait accordé le partage à tous les documents de ce type.

Le contrôle produit confirme que la RLS historique masque déjà le produit du tenant B au tenant A. Le contrôle sans tenant actif confirme le refus fail-closed : aucune ligne documentaire n'est visible pour `tracefab_app`.

## Preuve locale

- `npm run test:isolation:globale` : **77 contrôles, 0 échec**.
- Exécution sur PGlite jetable dans un environnement isolé.
- Aucune connexion Neon, aucune migration distante, aucune écriture dans `_prisma_migrations`.

Ce document ne constitue pas une autorisation de fusion ou de déploiement Production.
