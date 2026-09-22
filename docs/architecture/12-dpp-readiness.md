# 12. DPP Readiness — Chantier 8

## Objectif

Transformer les données produit, qualité et traçabilité en une projection de préparation versionnée, sans la présenter comme une conformité réglementaire définitive ni comme un DPP public.

```text
requirement profile versionné
  → évaluation des sources
  → dpp_record
  → data_ready / review_required
  → revue marque
  → ready_to_publish
```

La publication publique et le rendu final DPP restent hors de ce chantier.

## Profils de readiness

La table `dpp_requirement_profiles` contient des profils versionnés. Le profil initial est :

- clé : `textile_readiness_mvp` ;
- version : `1.0` ;
- statut : `active` ;
- périmètre : préparation opérationnelle produit.

Ses exigences MVP portent sur la référence, le nom, la description, la catégorie, le pays de fabrication, la préparation des données produit, la composition, le graphe de traçabilité et l'absence de blocage qualité dans le dernier snapshot.

Ces exigences sont des critères TRACEFAB internes. Elles ne sont pas une transcription définitive d'un acte réglementaire futur.

## `dpp_records`

Chaque record conserve :

- le produit et sa version ;
- le profil et sa version ;
- les éléments manquants ;
- les blocages ;
- un fingerprint des entrées ;
- un snapshot des sources utilisé pour le calcul ;
- le statut de readiness ;
- la revue interne éventuelle.

`public_projection` reste vide dans ce chantier. Aucun accès public ou policy anonyme n'est créé.

## Fonctions sécurisées

### `tracefab_compute_dpp_readiness(...)`

Accessible aux rôles brand de revue. La fonction évalue le profil actif contre les sources produit, qualité et traçabilité. Elle produit :

- `in_progress` lorsque des exigences bloquantes manquent ;
- `review_required` lorsqu'une donnée ou qualité nécessite une revue ;
- `data_ready` lorsque les exigences du profil sont présentes et qu'aucun blocage n'est détecté.

`data_ready` signifie que les critères opérationnels du profil sont remplis. Cela ne signifie pas « vérifié », « certifié » ou « conforme ».

### `tracefab_mark_dpp_ready_to_publish(...)`

Une marque owner/admin peut faire passer un record `data_ready` à `ready_to_publish` après revue. Cette fonction ne publie rien, ne crée pas de lien public et ne renseigne pas `public_projection`.

## RLS

- les profils actifs sont lisibles par les utilisateurs authentifiés ;
- les records DPP sont lisibles par les membres de l'organisation brand ;
- les records ne sont pas insérables ou modifiables directement par le client ;
- les calculs et transitions passent par des fonctions contrôlées ;
- aucune donnée fournisseur privée n'est copiée dans le snapshot au-delà des indicateurs nécessaires à la readiness.

## Reste à faire

- revue réglementaire des profils par version ;
- configuration de profils par marché et client ;
- historique complet des runs de calcul ;
- public projection et contrôle d'accès consommateur ;
- carrier/QR/Data Matrix ;
- signature, publication et révocation d'un DPP ;
- tests Supabase réels et validation métier textile.
