# Tracefab

Infrastructure de données fournisseurs pour la traçabilité textile, la qualité des données et la préparation au Digital Product Passport.

## Statut

**Chantier 1 — Architecture / Data Model**

Ce repository contient actuellement les fondations d'architecture et le modèle de données TRACEFAB. Le frontend et les parcours métier seront ajoutés dans les chantiers suivants.

## Principes

- Le produit central est la donnée fournisseur structurée, pas le QR code.
- Le système est multi-tenant dès la première migration.
- Une donnée déclarée n'est pas automatiquement vérifiée.
- Les documents sont privés par défaut.
- Les données peuvent être partagées par périmètre entre un fournisseur et ses marques clientes.
- Le domaine TRACEFAB reste séparé du domaine marketplace Ethimarket.
- Le modèle DPP est versionné et adaptable aux exigences réglementaires futures.

## Structure

```text
docs/architecture/
  01-system-context.md
  02-multi-tenancy-and-security.md
  03-data-model.md
  04-api-and-evolution.md
  05-rls-test-plan.md

scripts/
  validate_schema.py

src/domain/tracefab/
  types.ts
  index.ts

supabase/migrations/
  20260922000000_tracefab_core.sql
```

## Appliquer la migration

La migration est prévue pour un projet Supabase vierge ou dédié à Tracefab :

```bash
supabase db reset
# ou, sur un projet distant après revue :
supabase db push
```

Avant toute application en production :

1. configurer un projet Supabase dédié ;
2. sauvegarder la base ;
3. inspecter le SQL ;
4. exécuter les tests RLS d'intégration ;
5. configurer Storage privé dans un chantier dédié.

La création initiale d'une organisation et de son membership owner devra passer par la fonction SQL `tracefab_create_organization(...)`. Les invitations et leur acceptation seront ajoutées dans le chantier 2.

## Ce qui n'est pas encore implémenté

- invitations et emails transactionnels ;
- interface Brand Console ;
- Supplier Portal ;
- moteur de questionnaires ;
- OCR/Document Intelligence ;
- score de qualité calculé ;
- rendu public DPP ;
- API publique et connecteurs ERP/PLM/PIM.

Voir `docs/architecture/` pour les décisions prises au cours du chantier 1.
