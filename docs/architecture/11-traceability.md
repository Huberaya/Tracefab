# 11. Traceability — Chantier 7

## Objectif

Représenter une chaîne d'approvisionnement produit sous forme de graphe PostgreSQL transactionnel, en conservant la provenance et le niveau de confiance de chaque nœud et lien.

```text
Produit
  → matière
  → site fournisseur
  → organisation
  → processus
```

Le graphe décrit des relations déclarées ou documentées. Il ne constitue pas à lui seul une preuve de traçabilité physique vérifiée.

## Modèle livré

La migration `20260922060000_tracefab_traceability.sql` complète `supply_chain_nodes` et `supply_chain_links` avec :

- statut de donnée (`declared`, `documented`, etc.) ;
- document source ou preuve de lien ;
- déclarant ;
- date d'observation ;
- dates de mise à jour.

Le graphe reste dans PostgreSQL : les jointures, la transactionnalité et les policies RLS sont suffisantes pour le premier périmètre.

## Intégrité

- un nœud possède exactement une référence de type : produit, matière, site, organisation ou processus ;
- un nœud produit correspond au produit du graphe ;
- un matériau ou site fournisseur doit être accessible localement ou partagé explicitement ;
- une organisation externe doit appartenir à une relation marque-fournisseur active ;
- un lien ne peut pas s'auto-référencer ;
- un lien ne peut pas déplacer son produit de rattachement ;
- un document source doit être accessible au déclarant ;
- la version et le statut ne sont pas une certification.

## Fonctions sécurisées

- `tracefab_create_supply_chain_node(...)` ;
- `tracefab_update_supply_chain_node(...)` ;
- `tracefab_add_supply_chain_link(...)` ;
- `tracefab_update_supply_chain_link(...)` ;
- `tracefab_get_product_traceability(...)`.

Les insertions et mises à jour directes des nœuds et liens sont retirées des policies client. Les fonctions vérifient l'appartenance de la marque au produit et les partages nécessaires.

## Lecture

Une marque membre du produit peut lire le graphe produit. Un fournisseur peut lire ses propres nœuds ou les références qui lui sont partagées, mais ne reçoit pas automatiquement le graphe d'une marque. La projection JSON redonne uniquement les identifiants de documents encore accessibles.

## Reste à faire

- interface de visualisation graphe dans Brand Console ;
- import de chaînes existantes ;
- détection de cycles et chemins incomplets ;
- événements de transformation détaillés ;
- validation terrain et rapprochement avec lots/batches ;
- vérification humaine des étapes critiques ;
- export DPP versionné fondé sur ce graphe.
