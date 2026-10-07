# P0 Neon — réconciliation des migrations et des fonctions SQL

## État de l'audit du 7 octobre 2026

Le dépôt et `origin/main` sont synchronisés sur le commit de sécurité P0 courant. Après l'arrivée des chantiers fonctionnels amont, le dépôt contient 31 migrations Prisma et `prisma migrate status` confirme qu'elles sont appliquées sur Neon.

L'audit initial avait détecté sept migrations déjà exécutées dans Neon mais absentes du checkout local :

- `20261006200000_document_ai_automated_verification`
- `20261006210000_plm_erp_gs1_interoperability`
- `20261006220000_esg_pef_footprint_engine`
- `20261006230000_green_claims_anti_greenwashing_engine`
- `20261006240000_quality_corrective_action_plans_cap`
- `20261006250000_universal_supplier_passport`
- `20261006260000_mass_balance_anti_fraud_engine`

Ces sources SQL sont désormais présentes dans le checkout amont intégré. Le contrôle direct confirme `31` migrations sur disque, `31` migrations enregistrées dans Neon, aucune migration manquante et aucune migration DB-only. Elles ne doivent plus être supprimées ou recréées artificiellement.

## Contrôles Neon observés

- 46 tables publiques ; 45 avec RLS activé et forcé ; `_prisma_migrations` est l'exception attendue.
- 106 policies sur 45 tables.
- Aucun grant de table détecté pour `public`, `anon` ou `authenticated`.
- 103 fonctions `SECURITY DEFINER`, avec `search_path=public`.
- Avant le chantier P0, 67 fonctions étaient exécutables par `PUBLIC`.

## P0 exécuté

La migration `20261007100000_security_definer_execute_hardening` :

1. révoque `EXECUTE` de `PUBLIC` pour toutes les fonctions `SECURITY DEFINER` du schéma `public` ;
2. retire le privilège `PUBLIC EXECUTE` par défaut pour les nouvelles fonctions créées par le rôle de migration.

Le rôle propriétaire de la migration conserve ses privilèges implicites. La séparation ultérieure avec un rôle runtime devra ajouter des grants explicites et limités, dans une migration séparée et revue.

## Sortie vérifiée

- `npm run db:status` retourne `Database schema is up to date!`.
- 31 migrations sur disque correspondent aux 31 migrations terminées dans Neon.
- aucune fonction `SECURITY DEFINER` n'est exécutable par `PUBLIC` ;
- les 103 fonctions `SECURITY DEFINER` ont un `search_path` fixé ;
- `npm run test:neon:security` passe et vérifie l'isolation tenant et le refus d'une mutation par rôle insuffisant.

Le script de contrôle de migrations doit rester dynamique et afficher le nombre réellement découvert ; il ne doit pas conserver un nombre codé en dur.
