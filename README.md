# Tracefab

Infrastructure de données fournisseurs pour la traçabilité textile, la qualité des données et la préparation au Digital Product Passport.

## Statut

**Chantier 8 — DPP Readiness / Neon + Clerk foundation**

Le repository contient les fondations d'architecture, l'onboarding fournisseur, le parcours produit, la collecte, la chaîne privée de documents/certifications, le moteur de qualité, le graphe de traçabilité et la première projection versionnée de préparation DPP. Le schéma Neon est appliqué via Prisma avec une identité Clerk côté serveur. Les interfaces Brand Console, Supplier Portal et Quality Center restent à construire.

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
  06-supplier-profile.md
  07-product-data.md
  08-data-collection.md
  09-documents-and-certifications.md
  10-data-quality.md
  11-traceability.md
  12-dpp-readiness.md
  13-neon-clerk.md

api/
  health.ts
  me.ts
  organizations.ts

api/_lib/
  auth.ts
  context.ts
  http.ts
  prisma.ts

auth and database:
  prisma/schema.prisma
  prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql
  .env.example

scripts/
  validate_schema.py
  build_neon_migration.py

src/domain/tracefab/
  types.ts
  index.ts

supabase/migrations/
  20260922000000_tracefab_core.sql
  20260922010000_tracefab_supplier_profile.sql
  20260922020000_tracefab_product_data.sql
  20260922030000_tracefab_data_collection.sql
  20260922040000_tracefab_documents_certifications.sql
  20260922050000_tracefab_data_quality.sql
  20260922060000_tracefab_traceability.sql
  20260922070000_tracefab_dpp_readiness.sql
```

## Appliquer la migration Neon

La migration Prisma/Neon a été appliquée au projet Tracefab vide après revue :

```bash
npm install
npm run db:generate
DATABASE_URL="..." npm run db:status
DATABASE_URL="..." npm run db:deploy
```

Avant toute évolution en production :

1. utiliser une branche Neon dédiée ;
2. sauvegarder ou vérifier le point de restauration ;
3. générer une migration Prisma après revue ;
4. exécuter les tests RLS avec un contexte Clerk simulé ;
5. configurer un stockage objet privé séparé pour les documents.

Les fichiers sous `supabase/migrations/` sont conservés comme historique de conception des chantiers. Ils ne doivent pas être appliqués directement à Neon : la migration canonique est sous `prisma/migrations/`.

La création initiale d'une organisation et de son membership owner passe par `tracefab_create_organization(...)` ou `POST /api/organizations`. Le runtime Vercel expose aussi `GET /api/health` et `GET /api/me` pour la vérification Clerk et la synchronisation de `users`. Pour le parcours fournisseur, `tracefab_invite_supplier(...)`, `tracefab_accept_organization_invitation(...)` et `tracefab_submit_supplier_profile(...)` sont les fonctions de transition sécurisées. Pour les produits, `tracefab_create_product(...)`, `tracefab_update_product_data(...)` et `tracefab_start_product_revision(...)` centralisent les mutations sensibles. Pour la collecte, `tracefab_create_data_request(...)`, `tracefab_send_data_request(...)`, `tracefab_submit_data_response(...)`, `tracefab_submit_data_request(...)` et `tracefab_review_data_response(...)` pilotent le workflow. Pour les documents et certifications, `tracefab_register_document(...)`, `tracefab_finalize_document_upload(...)`, `tracefab_register_certification(...)` et `tracefab_review_certification(...)` encadrent les transitions. Pour la qualité, `tracefab_compute_supplier_quality(...)`, `tracefab_compute_product_quality(...)`, `tracefab_acknowledge_quality_issue(...)` et `tracefab_waive_quality_issue(...)` produisent et traitent les findings. Pour la traçabilité, `tracefab_create_supply_chain_node(...)`, `tracefab_add_supply_chain_link(...)` et `tracefab_get_product_traceability(...)` encadrent le graphe produit. Pour la préparation DPP, `tracefab_compute_dpp_readiness(...)` et `tracefab_mark_dpp_ready_to_publish(...)` produisent une projection interne, sans publication publique. La génération du token brut, l'envoi email, les notifications, le scan antivirus, les recalculs asynchrones et les imports catalogue restent à implémenter dans des fonctions ou services de confiance.

## Ce qui n'est pas encore implémenté

- invitations et emails transactionnels ;
- interface Brand Console ;
- Supplier Portal ;
- moteur de questionnaires ;
- OCR/Document Intelligence ;
- score de qualité calculé ;
- rendu public DPP ;
- API publique et connecteurs ERP/PLM/PIM.

Voir `docs/architecture/` pour les décisions et contrats versionnés des chantiers 1 à 8 et de l'intégration Neon/Clerk.
