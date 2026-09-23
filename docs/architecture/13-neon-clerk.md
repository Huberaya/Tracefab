# 13. Neon + Clerk — runtime foundation

## Décision

TRACEFAB utilise désormais PostgreSQL sur Neon et Clerk pour l'identité. Les migrations historiques sous `supabase/migrations/` restent la source de conception des chantiers précédents, mais la migration exécutable de l'environnement cible est :

```text
prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql
prisma/migrations/20260923140000_tracefab_clerk_context/migration.sql
prisma/migrations/20260923150000_fix_invitation_acceptance/migration.sql
```

Les deux migrations suivantes remplacent la lecture historique de l'email JWT dans la fonction d'acceptation d'invitation par le contexte Clerk transactionnel puis qualifient une colonne ambiguë dans cette fonction, sans réécrire le checksum de la migration initiale. Le schéma Prisma introspecté après application est `prisma/schema.prisma`.

## Identité

La table `users` est la table d'identités applicative. Elle conserve :

- un UUID interne ;
- `clerk_user_id`, sujet Clerk unique ;
- l'email et le nom synchronisés par le backend de confiance ;
- les timestamps applicatifs.

Aucun mot de passe n'est stocké dans TRACEFAB.

## Contexte RLS

Neon n'apporte pas `auth.uid()` ni les rôles Supabase `authenticated` et `service_role`. La migration remplace cette dépendance par :

```sql
tracefab_current_user_id()
```

Cette fonction lit le paramètre transactionnel `tracefab.user_id`. L'acceptation d'invitation lit aussi `tracefab_current_user_email()`, alimentée par `tracefab.user_email`, afin que l'email du JWT Clerk reste la frontière de confiance SQL. Le backend doit :

1. vérifier le JWT Clerk côté serveur ;
2. retrouver ou créer l'utilisateur local à partir de `clerk_user_id` ;
3. exécuter les requêtes protégées dans une transaction ;
4. définir `tracefab.user_id` et `tracefab.user_email` avec `set_config(..., true)` ;
5. ne jamais accepter cet UUID ou cet email depuis le navigateur ;
6. ne jamais transmettre le token brut d'invitation à SQL : seul son hash SHA-256 est persisté.

Les politiques RLS restent présentes sur les tables Tracefab. Les données ne sont pas exposées directement au navigateur : l'accès applicatif passe par l'API de confiance.

## Tables principales créées sur Neon

La base Tracefab était vide. La migration a créé le modèle complet des chantiers précédents, notamment :

- `users` ;
- `organizations` et `organization_memberships` ;
- `suppliers` et `supplier_sites` ;
- `tracefab_products`, `materials` et `product_materials` ;
- `documents`, `certifications`, `verification_records` ;
- `data_requests`, `data_responses`, `data_points` ;
- `data_quality_scores` et `data_quality_issues` ;
- `supply_chain_nodes` et `supply_chain_links` ;
- `dpp_requirement_profiles` et `dpp_records` ;
- `orders` et les tables d'audit nécessaires.

La table `orders` est un modèle opérationnel minimal lié à un utilisateur Clerk, une organisation et un produit Tracefab. Elle ne constitue pas une publication DPP.

## Documents et stockage

Neon ne possède pas l'équivalent de Supabase Storage. Les métadonnées documentaires restent dans PostgreSQL, mais l'objet lui-même devra être placé dans un stockage privé compatible avec l'API : S3, Cloudflare R2, Vercel Blob privé ou équivalent.

La migration ne crée pas de bucket public et n'introduit pas d'accès anonyme.

## Commandes

```bash
npm run db:neon:build
DATABASE_URL="..." npm run db:deploy
DATABASE_URL="..." npm run db:status
npm run db:generate
```

Les secrets ne doivent pas être commités. `DATABASE_URL` et `CLERK_SECRET_KEY` restent des variables serveur. Une branche Neon dédiée doit être utilisée pour toute future migration destructive ou évolution de schéma.

## Runtime Vercel et API Clerk

Le Chantier 9 ajoute des fonctions Vercel TypeScript :

- `GET /api/health` : vérifie la disponibilité de Neon sans authentification ;
- `GET /api/me` : vérifie le JWT Clerk, synchronise `users` et retourne les memberships actifs ;
- `GET/POST /api/organizations` : lit les organisations accessibles et crée une organisation avec son membership owner ;
- `POST /api/organizations/:organizationId/invitations` : crée une invitation fournisseur et tente sa livraison via l'adaptateur Resend ; le token brut n'est renvoyé qu'en mode manuel ou après échec ;
- `POST /api/invitations/accept` : hache le token reçu, vérifie l'utilisateur Clerk et accepte l'invitation uniquement si l'email correspond ;
- `GET/PATCH /api/suppliers/:supplierId/profile` : lit ou met à jour le profil derrière `tracefab_update_supplier_profile(...)` ;
- `POST /api/suppliers/:supplierId/profile/submit` : soumet un profil complet derrière `tracefab_submit_supplier_profile(...)` ;
- `GET/POST /api/products` et `GET/PATCH /api/products/:productId` : exposent les produits de marque ;
- `/api/products/:productId/revision`, `/materials` et `/identifiers` : exposent les révisions, la composition et les identifiants via les fonctions SQL de confiance ;
- `/api/materials` : gère les matériaux possédés ou partagés dans les organisations accessibles.

`api/_lib/context.ts` encapsule les requêtes tenant dans une transaction et initialise `tracefab.user_id` et `tracefab.user_email` avant les lectures/écritures protégées. `api/_lib/sql-errors.ts` centralise la traduction des exceptions métier PostgreSQL en réponses API sans réimprimer les détails SQL.

Les clés Clerk doivent être définies dans l'environnement Vercel :

```text
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
DATABASE_URL=postgresql://...
```

La clé secrète n'est jamais utilisée dans le navigateur.

## État de cette étape

- URL Neon Tracefab vérifiée ;
- base initialement vide confirmée ;
- migration Neon/Clerk appliquée ;
- Prisma introspecté sur le schéma créé ;
- aucune donnée métier initiale créée ;
- runtime Vercel, API multi-tenant et onboarding fournisseur Clerk/Prisma ajoutés ;
- tests Neon d'isolation RLS/refus des rôles insuffisants (`npm run test:neon:security`) et du parcours invitation/profil (`npm run test:neon:supplier`) ;
- email transactionnel d'invitation et contrat Resend ajoutés dans le Chantier 11 (`npm run test:email`) ;
- API Product Data, matériaux, composition et révisions ajoutées dans le Chantier 12 (`npm run test:neon:product`) ;
- pages Clerk et interfaces métier restent à construire dans un frontend dédié.
