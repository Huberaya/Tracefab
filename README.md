# Tracefab

Infrastructure de données fournisseurs pour la traçabilité textile, la qualité des données et la préparation au Digital Product Passport.

## Statut

**P2 en cours — Référentiel des certifications / readiness infrastructure staging / E2E Playwright non mocké — sur la base du Chantier 23 et de Neon + Clerk**

Le repository contient les fondations d'architecture, l'onboarding fournisseur, le parcours produit, la collecte, la chaîne privée de documents/certifications, le moteur de qualité, le graphe de traçabilité et la première projection versionnée de préparation DPP. Le P2 ajoute le catalogue versionné des standards de certification sous `/api/catalog/certification-standards`, la readiness protégée des intégrations réelles sous `/api/internal/p2/readiness` et un test Playwright staging strictement non mocké ; sa validation finale attend encore les credentials réels S3/antivirus/Resend/webhook d'alerte. Le schéma Neon est appliqué via Prisma avec une identité Clerk côté serveur. Le Chantier 18 ajoute une Brand Console statique sous `/brand-console/` avec produits, révisions, composition, identifiants, fournisseurs, demandes, revue et qualité. Le Chantier 19 ajoute un Supplier Portal approfondi sous `/supplier-portal/` pour le profil, les sites, les matériaux, les certificats déclarés, la qualité fournisseur, les demandes de données, les réponses versionnées et la soumission. Le Chantier 20 ajoute le stockage privé des preuves avec URLs présignées, contrôle serveur, hash SHA-256, antivirus contractuel et téléchargements temporaires. Le Chantier 21 ajoute la planification Vercel Cron des relances et l'enchaînement sécurisé de l'outbox. Le Chantier 22 ajoute les logs corrélés, l'état protégé de l'outbox et les alertes webhook timeout-safe pour les échecs de notification. Le Chantier 23 ajoute les data points structurés, la gestion d'équipe et le contexte multi-organisation du Supplier Portal, avec acceptation Clerk des invitations, renvoi/révocation et durcissement RLS Neon. Le bucket, le scanner antivirus, la configuration Cron, le webhook d'alerte et les memberships réels restent des dépendances d'infrastructure à activer sur staging/production.

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
  14-transactional-email.md
  15-product-api.md
  16-data-collection-api.md
  17-data-collection-productization.md
  18-notification-outbox.md
  19-collection-reminders.md
  20-quality-center-api.md
  21-brand-console.md
  22-supplier-portal.md
  23-private-evidence-storage.md
  24-notification-scheduler.md
  25-notification-observability.md
  26-supplier-portal-advanced.md

brand-console/
  index.html

supplier-portal/
  index.html

api/
  config.ts
  health.ts
  me.ts
  supplier/profile.ts
  supplier/profile/submit.ts
  supplier/sites.ts
  supplier/sites/[siteId].ts
  supplier/certifications.ts
  supplier/certifications/[certificationId].ts
  supplier/quality.ts
  supplier/documents.ts
  supplier/documents/upload-intent.ts
  supplier/documents/[documentId]/scan.ts
  supplier/documents/[documentId]/download.ts
  supplier/organizations.ts
  supplier/members.ts
  supplier/member-invitations/[invitationId].ts
  supplier/data-points.ts
  supplier/data-points/[dataPointId].ts
  documents/[documentId]/download.ts
  organizations.ts
  organizations/[organizationId]/invitations.ts
  suppliers.ts
  invitations/accept.ts
  suppliers/[supplierId]/profile.ts
  suppliers/[supplierId]/profile/submit.ts
  products.ts
  products/[productId].ts
  products/[productId]/revision.ts
  products/[productId]/materials.ts
  products/[productId]/identifiers.ts
  materials.ts
  materials/[materialId].ts
  data-requests.ts
  data-requests/[requestId].ts
  data-requests/[requestId]/items.ts
  data-requests/[requestId]/items/from-template.ts
  data-requests/[requestId]/send.ts
  data-requests/[requestId]/submit.ts
  data-request-items/[itemId]/response.ts
  data-responses/[responseId]/review.ts
  internal/notification-outbox/process.ts
  internal/notification-outbox/reminders.ts
  internal/notification-outbox/schedule.ts
  internal/notification-outbox/health.ts
  quality/suppliers/[supplierId].ts
  quality/products/[productId].ts
  quality-issues/[issueId]/acknowledge.ts
  quality-issues/[issueId]/waive.ts
  questionnaires.ts
  questionnaires/[questionnaireKey].ts

api/_lib/
  auth.ts
  context.ts
  http.ts
  prisma.ts
  sql-errors.ts
  email.ts
  products.ts
  data-requests.ts
  questionnaires.ts
  notifications.ts
  notification-outbox.ts
  notification-reminders.ts
  notification-observability.ts
  data-points.ts
  worker-auth.ts
  quality.ts

auth and database:
  prisma/schema.prisma
  prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql
  prisma/migrations/20260923160000_tracefab_product_api_functions/migration.sql
  prisma/migrations/20260923170000_fix_data_collection_workflow_context/migration.sql
  prisma/migrations/20260923180000_fix_data_response_progress_guard/migration.sql
  prisma/migrations/20260923190000_tracefab_notification_outbox/migration.sql
  prisma/migrations/20260923200000_tracefab_collection_reminders/migration.sql
  .env.example

scripts/
  validate_schema.py
  build_neon_migration.py
  test_neon_security.mjs
  test_neon_supplier_flow.mjs
  test_neon_supplier_advanced.mjs
  test_neon_product_flow.mjs
  test_neon_quality_flow.mjs
  test_neon_data_collection_flow.mjs
  test_brand_console.mjs
  test_brand_console_browser.mjs
  test_supplier_portal.mjs
  test_supplier_portal_browser.mjs
  test_private_storage.mjs
  test_notification_scheduler.mjs
  test_notification_observability.mjs
  test_supplier_advanced.mjs
  test_questionnaires.mjs
  test_email_delivery.mjs

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

La création initiale d'une organisation et de son membership owner passe par `tracefab_create_organization(...)` ou `POST /api/organizations`. Le runtime Vercel expose aussi `GET /api/health` et `GET /api/me` pour la vérification Clerk et la synchronisation de `users`. Le Chantier 10 ajoute `POST /api/organizations/:organizationId/invitations`, `POST /api/invitations/accept`, `GET/PATCH /api/suppliers/:supplierId/profile` et `POST /api/suppliers/:supplierId/profile/submit`. Les invitations générées par l'API renvoient le token brut une seule fois au backend appelant uniquement en mode manuel ou après échec d'envoi ; seul son hash SHA-256 entre en SQL. Le Chantier 11 ajoute l'envoi Resend lorsque `RESEND_API_KEY`, `EMAIL_FROM` et `TRACEFAB_APP_URL` sont configurés. Le Chantier 12 ajoute l'API Product Data, les matériaux, la composition versionnée, les identifiants et les révisions produit. Pour le parcours fournisseur, `tracefab_invite_supplier(...)`, `tracefab_accept_organization_invitation(...)`, `tracefab_update_supplier_profile(...)` et `tracefab_submit_supplier_profile(...)` sont les fonctions de transition sécurisées. Pour les produits, `tracefab_create_product(...)`, `tracefab_update_product_data(...)` et `tracefab_start_product_revision(...)` centralisent les mutations sensibles. Pour la collecte, `tracefab_create_data_request(...)`, `tracefab_send_data_request(...)`, `tracefab_submit_data_response(...)`, `tracefab_submit_data_request(...)` et `tracefab_review_data_response(...)` pilotent le workflow. Pour les documents et certifications, `tracefab_register_document(...)`, `tracefab_finalize_document_upload(...)`, `tracefab_register_certification(...)` et `tracefab_review_certification(...)` encadrent les transitions. Pour la qualité, `tracefab_compute_supplier_quality(...)`, `tracefab_compute_product_quality(...)`, `tracefab_acknowledge_quality_issue(...)` et `tracefab_waive_quality_issue(...)` produisent et traitent les findings. Pour la traçabilité, `tracefab_create_supply_chain_node(...)`, `tracefab_add_supply_chain_link(...)` et `tracefab_get_product_traceability(...)` encadrent le graphe produit. Pour la préparation DPP, `tracefab_compute_dpp_readiness(...)` et `tracefab_mark_dpp_ready_to_publish(...)` produisent une projection interne, sans publication publique. Le Chantier 13 expose `GET/POST /api/data-requests`, le détail et les items d'une demande, l'envoi, la réponse fournisseur versionnée, la soumission et la revue marque via les fonctions SQL de collecte. Le Chantier 14 ajoute le catalogue questionnaire versionné (`/api/questionnaires`), l'initialisation d'items depuis un template et la validation serveur des réponses. Le Chantier 15 ajoute la file durable `tracefab_notification_outbox`, les déclenchements transactionnels des notifications de collecte et le worker privé `POST /api/internal/notification-outbox/process`. Le Chantier 16 ajoute les relances dues/overdue via `POST /api/internal/notification-outbox/reminders`, avec idempotence quotidienne et fenêtre configurable. Le Chantier 17 ajoute le Quality Center API pour les scores fournisseur/produit, les issues explicables, l'acquittement et le waiver contrôlé. Le Chantier 18 ajoute une Brand Console approfondie sous `/brand-console/` pour l'authentification Clerk, le catalogue produit et ses révisions, la composition et les identifiants, les fournisseurs, les demandes de données, la revue et la qualité produit. Les contrats statiques et un parcours navigateur Playwright en mode démonstration sont disponibles via `npm run test:brand-console` et `npm run test:brand-console:browser`. Le Chantier 19 ajoute un Supplier Portal approfondi sous `/supplier-portal/` pour le profil fournisseur, les sites, les certificats, les matériaux, les demandes de données, les réponses item par item et la soumission ; les contrats et le parcours Playwright sont disponibles via `npm run test:supplier-portal` et `npm run test:supplier-portal:browser`. L'historique des réponses reste conservé et les brouillons sont masqués côté fournisseur. L'email d'invitation fournisseur est livré via l'adaptateur Resend lorsque les variables serveur sont configurées ; sinon le backend reste en mode livraison manuelle contrôlée. Le scanner antivirus est livré sous forme de contrat HTTP à connecter à un service réel ; les recalculs asynchrones et les imports catalogue restent à implémenter dans des fonctions ou services de confiance.

## Ce qui n'est pas encore implémenté

- intégration d'un webhook d'alerte réel et tableaux de bord externes ;
- gestion Supplier Portal résiduelle : synchronisation d'annuaire Clerk automatique et migration vers des schémas JSON pilotés par catalogue externe ;
- Quality Center frontend complet ;
- suppression objet interactive, rétention et nettoyage Storage ;
- OCR/Document Intelligence ;
- rendu public DPP ;
- API publique et connecteurs ERP/PLM/PIM.

Voir `docs/architecture/` pour les décisions et contrats versionnés des chantiers 1 à 23 et de l'intégration Neon/Clerk. Les contrats se vérifient avec `npm run test:private-storage`, `npm run test:notification-scheduler`, `npm run test:notification-observability` et `npm run test:supplier-advanced`. Avec une base de test configurée, `npm run test:neon:supplier:advanced` vérifie aussi l'isolation tenant, le versionnement des data points et les garde-fous RLS.
