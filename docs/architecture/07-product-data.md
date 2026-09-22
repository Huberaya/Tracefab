# 7. Product Data — Chantier 3

## Objectif

Permettre à une marque de créer une fiche produit exploitable, de structurer sa composition matière et de savoir précisément ce qui manque avant de déclarer le produit `DATA READY`.

Le chantier ne crée pas de DPP public et ne transforme pas une donnée déclarée en donnée vérifiée.

## Modèle livré

La migration `20260922020000_tracefab_product_data.sql` complète `tracefab_products` avec :

- description et famille produit ;
- couleur et tailles ;
- pays de conception et de fabrication ;
- poids et instructions d'entretien ;
- état de préparation des données (`not_started`, `in_progress`, `data_ready`, `needs_review`) ;
- score de complétude ;
- date de passage `data_ready` et dernier contributeur.

La table `product_identifiers` permet de distinguer les identifiants `gtin`, `ean`, `upc` et `internal`.

La composition réutilise `product_materials` et `materials` du modèle initial. Les relations de composition sont liées à la version courante du produit.

## Fonctions sécurisées

### `tracefab_create_product(...)`

Crée un produit uniquement pour une organisation de type `brand` et avec un rôle opérationnel autorisé. Le produit est créé en statut lifecycle `draft`, indépendamment de son état de préparation des données.

### `tracefab_update_product_data(...)`

Met à jour les champs descriptifs autorisés, normalise les chaînes et les codes pays, conserve l'utilisateur auteur et recalcule la préparation des données.

### `tracefab_start_product_revision(...)`

Incrémente la version du produit afin de créer une nouvelle composition versionnée. Les matériaux de la version précédente ne sont pas copiés automatiquement : cette décision évite de présenter une ancienne composition comme la composition actuelle.

## Calcul `DATA READY`

Le score MVP comporte sept exigences explicites :

1. référence et nom présents ;
2. catégorie présente ;
3. description d'au moins 30 caractères ;
4. SKU ou identifiant primaire/interne ;
5. pays de fabrication ;
6. composition courante avec pourcentages renseignés et total égal à 100 % ;
7. au moins un `data_point` produit non expiré et non marqué `needs_review`.

Le score est un indicateur de présence et de cohérence minimale. Une donnée `declared` peut participer au score : elle n'est pas pour autant vérifiée, documentée ou certifiée.

## Composition et sécurité

- Un produit appartient à une organisation de type `brand`.
- Une marque peut relier un matériau qu'elle possède.
- Un matériau fournisseur doit avoir été partagé explicitement avec la marque via `data_shares`.
- Un trigger empêche de rattacher un matériau d'un autre tenant sans partage autorisé.
- La version de `product_materials` doit correspondre à la version courante du produit.
- Les identifiants sont visibles et modifiables uniquement par les membres autorisés de la marque.

## RLS et provenance

Les faits complémentaires restent dans `data_points` avec `product_id`, `data_key`, une valeur JSON typée, un statut de qualité et éventuellement un document source. Le produit ne remplace donc pas le registre de provenance.

## Tests attendus

- une organisation supplier ne peut pas créer un produit de marque ;
- un viewer ne peut pas créer ou modifier un produit ;
- une marque ne peut pas rattacher un matériau privé d'un fournisseur ;
- un matériau partagé dans le bon scope peut être rattaché ;
- la composition d'une nouvelle version ne réutilise pas silencieusement l'ancienne ;
- un produit incomplet reste `in_progress` ou `not_started` ;
- un produit avec une donnée expirée ou `needs_review` devient `needs_review` ;
- les mutations de données réactualisent automatiquement la complétude ;
- les champs calculés de préparation ne sont pas directement modifiables par le client ;
- `DATA READY` ne crée aucune projection publique et ne vaut pas certification.

## Reste à faire

- interface Brand Console de création et d'édition ;
- gestion UI de la composition et des pourcentages ;
- import catalogue CSV/Excel ;
- validation spécialisée GTIN/EAN/UPC ;
- snapshots historiques complets des fiches produit ;
- moteur de qualité multi-critères et revue humaine ;
- rattachement guidé des fournisseurs aux composants.
