# 13. Neon + Clerk — runtime foundation

## Décision

TRACEFAB utilise désormais PostgreSQL sur Neon et Clerk pour l'identité. Les migrations historiques sous `supabase/migrations/` restent la source de conception des chantiers précédents, mais la migration exécutable de l'environnement cible est :

```text
prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql
```

Le schéma Prisma introspecté après application est `prisma/schema.prisma`.

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

Cette fonction lit le paramètre transactionnel `tracefab.user_id`. Le backend doit :

1. vérifier le JWT Clerk côté serveur ;
2. retrouver ou créer l'utilisateur local à partir de `clerk_user_id` ;
3. exécuter les requêtes protégées dans une transaction ;
4. définir `tracefab.user_id` avec `set_config(..., true)` ;
5. ne jamais accepter cet UUID depuis le navigateur.

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

## État de cette étape

- URL Neon Tracefab vérifiée ;
- base initialement vide confirmée ;
- migration Neon/Clerk appliquée ;
- Prisma introspecté sur le schéma créé ;
- aucune donnée métier initiale créée ;
- endpoints applicatifs, pages Clerk et synchronisation serveur restent à construire dans la couche application, absente du repository actuel.
