# 10. Data Quality — Chantier 6

## Objectif

Mesurer la qualité exploitable des données et rendre les blocages explicables, sans confondre score, vérification et certification.

```text
règles versionnées
  → quality issues explicites
  → score snapshot par fournisseur ou produit
  → acknowledgement / waiver contrôlés
```

## Modèle livré

La migration `20260922050000_tracefab_data_quality.sql` ajoute `data_quality_issues` avec :

- sujet fournisseur ou produit ;
- règle et version de calcul ;
- sévérité `info`, `warning`, `blocking` ;
- état `open`, `acknowledged`, `resolved`, `waived` ;
- champ concerné, message et détails JSON ;
- dates et acteurs de détection, résolution et acquittement.

Les snapshots continuent d'être stockés dans `data_quality_scores`. Ils sont append-only fonctionnellement : chaque calcul produit un instantané versionné.

## Règles MVP

### Fournisseur

- profil fournisseur incomplet ;
- aucun site actif ;
- absence de data points structurés ;
- data points expirés ;
- data points sans document source ;
- certifications expirées.

### Produit

- fiche produit incomplète ;
- état produit `needs_review` ;
- absence de data points ;
- data points expirés ;
- data points sans preuve documentaire ;
- composition courante absente, incomplète ou différente de 100 % ;
- certification produit expirée.

Les règles sont codées dans la version initiale `supplier_quality_v1` / `product_quality_v1`. Leur version est persistée avec chaque issue et chaque score afin d'éviter de comparer silencieusement des calculs différents.

## Dimensions du score

- `completeness` : présence des champs attendus ;
- `freshness` : proportion de données non expirées ;
- `documentation_coverage` : proportion de claims avec document source ;
- `consistency` : pénalité explicable basée sur les issues ouvertes et bloquantes.

Ces dimensions ne disent pas qu'une donnée est vraie. Une donnée `declared` peut compter dans la complétude tout en restant non vérifiée.

## Fonctions sécurisées

- `tracefab_compute_supplier_quality(...)` ;
- `tracefab_compute_product_quality(...)` ;
- `tracefab_acknowledge_quality_issue(...)` ;
- `tracefab_waive_quality_issue(...)`.

Les issues ne sont pas insérables ou modifiables directement par le client. Un waiver exige un rôle owner/admin et une justification d'au moins dix caractères. Les scores fournisseur peuvent être lus par une marque uniquement lorsqu'un partage fournisseur explicite l'autorise ; le détail des issues reste dans l'organisation propriétaire.

## Politique de lecture

- propriétaire du fournisseur ou du produit : score et issues autorisés ;
- marque bénéficiaire d'un partage fournisseur : score fournisseur synthétique autorisé ;
- marque bénéficiaire : pas d'exposition automatique du détail des issues internes ;
- aucun accès anonyme ;
- aucune projection publique créée.

## Reste à faire

- écran Quality Center ;
- seuils configurables par organisation ;
- règles JSON Schema et validation sémantique ;
- recalcul asynchrone après chaque mutation importante ;
- alertes et SLA de résolution ;
- comparaison temporelle des snapshots ;
- validation RLS sur une instance Supabase réelle.
