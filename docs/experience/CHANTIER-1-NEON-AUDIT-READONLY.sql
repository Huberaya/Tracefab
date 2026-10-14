-- TRACEFAB — audit Neon en LECTURE SEULE avant toute fusion/application.
-- Exécuter chaque SELECT séparément dans l'éditeur SQL Neon.
-- Ne contient volontairement aucun INSERT/UPDATE/DELETE/DDL/GRANT/REVOKE.
-- Ne pas partager de chaîne de connexion ni de secret.
--
-- Q1 — Identité effective, rôle runtime et propriétaire du schéma.
SELECT current_database() AS database_name,
       current_user AS current_role,
       session_user AS session_role,
       r.rolsuper,
       r.rolbypassrls,
       n.nspname AS schema_name,
       pg_get_userbyid(n.nspowner) AS schema_owner,
       has_schema_privilege(current_user, n.oid, 'CREATE') AS current_role_can_create
  FROM pg_roles r
 CROSS JOIN pg_namespace n
 WHERE r.rolname = current_user
   AND n.nspname = 'public';

-- Q2 — Historique Prisma complet, y compris migrations échouées ou annulées.
SELECT migration_name, started_at, finished_at, rolled_back_at,
       applied_steps_count, logs
  FROM public."_prisma_migrations"
 ORDER BY started_at, migration_name;

-- Q3 — Fonctions du schéma public : propriétaire, SECURITY DEFINER et EXECUTE PUBLIC effectif.
-- Le contrôle tient compte du défaut PostgreSQL lorsque proacl est NULL.
SELECT p.oid::regprocedure::text AS function_signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       p.proacl IS NULL AS uses_default_acl,
       EXISTS (
         SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       ) AS public_can_execute,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app')
            THEN has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
            ELSE NULL
       END AS tracefab_app_can_execute
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prokind = 'f'
 ORDER BY owner, function_signature;

-- Q4 — Privilèges PUBLIC sur les tables, vues et séquences du schéma public.
SELECT c.oid::regclass::text AS object_name,
       c.relkind,
       pg_get_userbyid(c.relowner) AS owner,
       acl.privilege_type,
       acl.is_grantable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(
    CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner
  ))) acl
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
   AND acl.grantee = 0
 ORDER BY object_name, acl.privilege_type;

-- Q5 — CREATE/USAGE sur le schéma public accordés à PUBLIC.
SELECT n.nspname,
       acl.privilege_type,
       acl.is_grantable
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
 WHERE n.nspname = 'public'
   AND acl.grantee = 0
 ORDER BY acl.privilege_type;

-- Q6 — Privilèges par défaut des rôles de migration (global + schéma public).
-- Sert à identifier le rôle qui doit être durci pour les futures fonctions.
SELECT pg_get_userbyid(d.defaclrole) AS owner_role,
       CASE WHEN d.defaclnamespace = 0 THEN '(global)'
            ELSE d.defaclnamespace::regnamespace::text
       END AS scope,
       d.defaclobjtype,
       acl.grantee,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(acl.grantee)
       END AS grantee_name,
       acl.privilege_type,
       acl.is_grantable
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
 WHERE d.defaclobjtype = 'f'
   AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
 ORDER BY owner_role, scope, grantee_name, acl.privilege_type;

-- Q7 — Liste compacte des fonctions de TraceFab critiques et droits runtime effectifs.
SELECT p.oid::regprocedure::text AS function_signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       EXISTS (
         SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       ) AS public_can_execute,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app')
            THEN has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
            ELSE NULL
       END AS tracefab_app_can_execute
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = ANY (ARRAY[
     'tracefab_material_visible_via_product',
     'tracefab_public_context',
     'tracefab_product_is_public',
     'tracefab_material_is_public',
     'tracefab_supplier_site_is_public',
     'tracefab_public_brand',
     'tracefab_can_access_org',
     'tracefab_is_org_member',
     'tracefab_has_org_role',
     'tracefab_can_access_shared_subject',
     'tracefab_can_access_document'
   ])
 ORDER BY function_signature;
