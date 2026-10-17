# TF-02 — Revue adversariale 2C.38 — Requêtes opérateur (lecture seule)

Ces requêtes vérifient, **en lecture seule**, la finalisation documentaire et
ses gardes d'autorisation sur staging, puis en production après autorisation.
Elles sont **distinctes** de la séquence H1.4 (Q1..Q6 de
`h1-4-MODE-OPERATOIRE.md`, qui garde sa procédure et ses cardinalités) et
n'ont pas à être collées dans cette séquence.

Règles : aucune écriture, aucun `SET` persistant, transmettre les tableaux
sans chaîne de connexion ni secret. Exécuter avec le rôle de diagnostic
habitué (lecture seule).

## R1 — ACL de la finalisation (doit montrer : PUBLIC sans EXECUTE, `tracefab_app` avec EXECUTE)

```sql
-- >>>TF02:R1
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       pg_get_userbyid(p.proowner)               AS proprietaire,
       p.prosecdef                               AS security_definer,
       has_function_privilege('public', p.oid, 'EXECUTE')       AS public_execute,
       has_function_privilege('tracefab_app', p.oid, 'EXECUTE') AS app_execute,
       p.proacl::text                            AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'tracefab_finalize_document_upload';
-- <<<TF02:R1
```

Attendu : `public_execute = false`, `app_execute = true`, `security_definer = true`.

## R2 — Classe d'exploitation (doit montrer : l'applicatif SANS TRUNCATE, le propriétaire AVEC)

```sql
-- >>>TF02:R2
SELECT has_table_privilege('tracefab_app', 'documents', 'TRUNCATE')   AS app_truncate,
       has_table_privilege(current_user, 'documents', 'TRUNCATE')     AS diagnostic_truncate,
       pg_get_userbyid(c.relowner)                                    AS proprio_documents,
       c.relrowsecurity                                               AS rls,
       c.relforcerowsecurity                                          AS rls_forcee
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'documents';
-- <<<TF02:R2
```

Attendu : `app_truncate = false` (la voie exploitation est fermée au rôle
applicatif par le privilege, pas par une comparaison de noms) ;
`diagnostic_truncate` dépend du rôle de diagnostic (vrai pour un rôle
propriétaire/DBA).

## R3 — Propriétaire de la fonction vs rôle applicatif (la garde ne doit pas en dépendre)

```sql
-- >>>TF02:R3
SELECT p.proname,
       pg_get_userbyid(p.proowner) AS proprietaire_fonction,
       (pg_get_userbyid(p.proowner) = 'tracefab_app') AS proprietaire_est_app,
       pg_get_functiondef(p.oid) LIKE '%session_user = ''tracefab_app''%' AS exclusion_app_explicite,
       pg_get_functiondef(p.oid) LIKE '%has_table_privilege(session_user, ''documents'', ''TRUNCATE')%' AS preuve_privilege_reel
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'tracefab_finalize_document_upload';
-- <<<TF02:R3
```

Attendu : `exclusion_app_explicite = true`, `preuve_privilege_reel = true`.
`proprietaire_est_app = true` est une **anomalie de configuration** à signaler
(migrations exécutées avec le rôle applicatif) : la garde reste fermée, mais
corrigez le propriétaire.

## R4 — Sha256 : validation hexadécimale dans le corps de la fonction

```sql
-- >>>TF02:R4
SELECT pg_get_functiondef(p.oid) LIKE '%^[0-9a-fA-F]{64}$%' AS validation_hex
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'tracefab_finalize_document_upload';
-- <<<TF02:R4
```

Attendu : `validation_hex = true`.

## R5 — État des migrations applicatives (complément à Q1, lecture seule)

```sql
-- >>>TF02:R5
SELECT migration_name, finished_at,
       CASE WHEN finished_at IS NULL THEN false ELSE true END AS appliquee
FROM _prisma_migrations
WHERE migration_name IN (
  '20261017100000_fix_document_lifecycle_access',
  '20261017120000_harden_dpp_table_privileges',
  '20261017150000_harden_finalize_ops_gate'
)
ORDER BY started_at;
-- <<<TF02:R5
```

Attendu : 3 lignes, toutes `appliquee = true`. Une chaîne qui n'inclut pas
`20261017150000` ne porte pas la correction de la garde d'exploitation.
