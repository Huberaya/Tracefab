# Durcissement production — sécurité, Vercel et RLS

## État

Le durcissement applicatif est versionné dans le chantier `production-hardening` :

- headers de sécurité Vercel et headers JSON API ;
- politique `no-store` par défaut pour les réponses API ;
- échec contrôlé du routeur API sans fuite d’exception ;
- allow-list `TRACEFAB_AUTHORIZED_PARTIES` pour les tokens Clerk ;
- RLS forcée sur le catalogue de schémas et les bindings ajoutés tardivement ;
- politique de lecture tenant-scoped pour l’outbox ;
- audit log explicitement append-only pour le rôle applicatif ;
- vérification de chaîne d’audit dans la transaction RLS du demandeur ;
- audit des variables de production sans jamais imprimer leurs valeurs.

La rotation effective des valeurs Vercel, Clerk, Neon, Resend, stockage privé et GitHub reste une opération d’administration externe : elle doit être exécutée par un opérateur ayant accès aux comptes concernés. Aucun secret n’est inclus dans le dépôt.

## Contrôle des dépendances

Le lockfile est la source d’installation de production et doit être régénéré avec `npm ci`. La vérification de sécurité doit couvrir les deux arbres :

```bash
npm ci
npm audit --omit=dev --audit-level=moderate
npm audit --audit-level=moderate
```

Les deux commandes `npm audit` doivent terminer avec **0 vulnérabilité**. Ne pas utiliser `npm audit fix --force` sans revue : cela pourrait changer le runtime Vercel ou le client Prisma par une montée majeure non validée.

Le projet conserve Prisma 6 pour préserver le schéma et le mode de connexion existants. Le dépôt contient désormais aussi l’application Next.js et les chantiers fonctionnels amont ; `@vercel/node`, Next.js et Tailwind doivent donc être inclus dans chaque audit. Le contrôle P0 Neon ne remplace pas le chantier séparé de mise à niveau des dépendances : aucune mise en production ne doit être autorisée tant que `npm audit --omit=dev` et l’audit complet ne retournent pas zéro vulnérabilité.

## Variables Vercel — production

Configurer les variables suivantes dans l’environnement **Production** du projet Vercel. Ne pas réutiliser les valeurs Preview/Development.

| Groupe | Variables | Contrôle attendu |
|---|---|---|
| Runtime | `NODE_ENV` | `production` ; Vercel fournit aussi `VERCEL_ENV=production` |
| Neon | `DATABASE_URL` | URL PostgreSQL TLS, rôle applicatif dédié, jamais `postgres` ou `neondb_owner` |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | clés `pk_live_` / `sk_live_` |
| Clerk webhook | `CLERK_WEBHOOK_SIGNING_SECRET` | secret `whsec_` renouvelé |
| Clerk audience | `TRACEFAB_AUTHORIZED_PARTIES` | liste d’origines HTTPS réellement servies |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `TRACEFAB_APP_URL` | clé de production, domaine expéditeur vérifié, URL HTTPS |
| Workers | `TRACEFAB_NOTIFICATION_WORKER_SECRET`, `CRON_SECRET` | deux secrets aléatoires distincts, au moins 32 caractères |
| Invitations | `TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK` | `false` en production |
| Stockage | `PRIVATE_STORAGE_ENDPOINT`, `PRIVATE_STORAGE_BUCKET`, `PRIVATE_STORAGE_REGION`, `PRIVATE_STORAGE_ACCESS_KEY_ID`, `PRIVATE_STORAGE_SECRET_ACCESS_KEY` | endpoint HTTPS, bucket privé, credentials dédiés |
| Antivirus | `PRIVATE_STORAGE_ANTIVIRUS_URL`, `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` | scanner HTTPS et bearer token dédié |
| Alerting optionnel | `TRACEFAB_NOTIFICATION_ALERT_URL`, `TRACEFAB_NOTIFICATION_ALERT_TOKEN`, `TRACEFAB_NOTIFICATION_ALERT_TIMEOUT_MS` | endpoint HTTPS et token séparé |

Audit local des noms, formats et valeurs placeholder — les valeurs ne sont jamais affichées :

```bash
npm run security:production:env
```

Pour vérifier uniquement la présence des variables Vercel sans lire leur contenu :

```bash
vercel env ls production
```

La commande `vercel env ls` peut être utilisée en lecture seule. Ne pas copier sa sortie dans un commit ou un ticket si l’outil affiche des métadonnées sensibles.

## Procédure de rotation sans exposition

Effectuer les rotations par groupe, avec un déploiement et un smoke test entre chaque groupe.

1. **Préparer une nouvelle valeur** dans le fournisseur concerné ; ne pas l’écrire dans `.env`, le dépôt, une issue ou une commande shell persistante.
2. **Mettre à jour la variable Vercel Production** via le Dashboard Vercel ou le prompt sécurisé de `vercel env add`.
3. **Redéployer** la production.
4. **Valider** `/api/health`, l’authentification Clerk, le webhook et les parcours concernés.
5. **Révoquer l’ancienne valeur** uniquement après validation du déploiement.
6. **Répéter** pour le groupe suivant.

Ordre recommandé :

1. `TRACEFAB_NOTIFICATION_WORKER_SECRET` et `CRON_SECRET` ; vérifier les endpoints internes et le Cron.
2. `TRACEFAB_AUTHORIZED_PARTIES`, puis `CLERK_SECRET_KEY` ; vérifier la connexion sur Brand Console, Supplier Portal et Operations.
3. `CLERK_WEBHOOK_SIGNING_SECRET` ; envoyer un événement Clerk de staging avant bascule production.
4. `DATABASE_URL` ; créer d’abord un rôle runtime Neon à privilèges minimaux, migrer, tester puis révoquer l’ancien mot de passe.
5. `PRIVATE_STORAGE_*` et le token antivirus ; tester upload-intent, scan et téléchargement signé.
6. `RESEND_API_KEY` ; vérifier le domaine et la cible de test avant tout envoi réel. Aucun email réel ne doit être envoyé sans validation explicite des credentials, du domaine et de la cible.
7. Révoquer et remplacer le token GitHub utilisé historiquement pour les pushes avant production.

## RLS et accès database

Les tables métier doivent être `ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY`. Les vérifications statiques couvrent désormais également :

- `tracefab_schema_catalog` ;
- `tracefab_schema_bindings` ;
- `tracefab_notification_outbox` ;
- `tracefab_catalog_import_jobs` ;
- les tables cœur utilisateur, organisation, produit, fournisseur, data points, documents, qualité, DPP et audit.

Le contexte utilisateur est installé dans une transaction par `withTracefabUserContext`. Les lectures internes de l’outbox passent par `withTracefabWorkerContext`, uniquement après validation du secret HTTP worker. La chaîne d’audit est vérifiée avec le même client transactionnel que celui qui porte le contexte RLS ; elle ne tombe plus sur une connexion Prisma globale dépourvue de contexte.

Contrôle direct à exécuter avec une connexion d’audit Neon, sans afficher les données métier :

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'users', 'organizations', 'organization_memberships',
    'tracefab_products', 'suppliers', 'data_points', 'documents',
    'audit_logs', 'tracefab_notification_outbox',
    'tracefab_schema_catalog', 'tracefab_schema_bindings'
  )
ORDER BY c.relname;
```

Résultat attendu : `relrowsecurity = true` et `relforcerowsecurity = true` pour chaque table.

## Endpoints internes

| Endpoint | Méthode | Protection |
|---|---:|---|
| `/api/internal/notification-outbox/health` | GET | `x-tracefab-worker-secret` constant-time |
| `/api/internal/notification-outbox/process` | POST | `x-tracefab-worker-secret` constant-time |
| `/api/internal/notification-outbox/reminders` | POST | `x-tracefab-worker-secret` constant-time |
| `/api/internal/notification-outbox/schedule` | GET | `CRON_SECRET` en Bearer ou header dédié |
| `/api/internal/p2/readiness` | GET | worker secret + réponse configuration-only |

Les endpoints internes ne disposent d’aucune route CORS wildcard. Ils renvoient `no-store` et ne renvoient pas de valeurs de secret. Les routes inconnues et les exceptions non traitées sont fermées avec une réponse générique `internal_server_error`.

Le connecteur PLM actuellement simulé est désactivé en production sauf si `TRACEFAB_PLM_ENABLED=true` est explicitement configuré après raccordement à un connecteur réel.

## Headers actifs

Vercel applique notamment :

- HSTS avec sous-domaines ;
- CSP restrictive compatible avec Clerk, les fonts existantes et l’interface inline actuelle ;
- `X-Content-Type-Options: nosniff` ;
- `X-Frame-Options: DENY` et `frame-ancestors 'none'` ;
- `Referrer-Policy: strict-origin-when-cross-origin` ;
- `Permissions-Policy` sans caméra, microphone, géolocalisation ou paiement ;
- COOP/CORP, `Origin-Agent-Cluster`, désactivation du DNS prefetch et des politiques cross-domain ;
- `Cache-Control: no-store` pour `/api/*`.

## Validation

```bash
npm run security:production:hardening
npm run security:production:env
npm run schema:static
npm run api:typecheck
npm test
```

`security:production:env` doit être exécuté dans le contexte Vercel Production ou avec un shell contenant les variables de production ; il échoue volontairement si des variables manquent ou utilisent des placeholders.
