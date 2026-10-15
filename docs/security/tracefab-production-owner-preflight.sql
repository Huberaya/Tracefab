-- TRACEFAB — prédiagnostic lecture seule des propriétaires et ACL PUBLIC
-- À exécuter dans Neon SQL Editor sur la base de production, AVANT toute migration.
-- Ce fichier ne contient que des SELECT : aucune modification de données ou de droits.
-- Ne partagez jamais d'URL de connexion, mot de passe, jeton ou secret avec les résultats.

-- Q1 — identité exacte du rôle et capacités.
SELECT
  current_database() AS database_name,
  session_user AS session_role,
  current_user AS effective_role,
  r.rolsuper AS is_superuser,
  r.rolcreaterole AS can_create_roles,
  r.rolcreatedb AS can_create_databases,
  r.rolbypassrls AS bypasses_rls
FROM pg_roles r
WHERE r.rolname = current_user;

-- Q2 — fonctions/procédures de public avec EXECUTE PUBLIC effectif par ACL,
-- regroupées par propriétaire, en séparant les fonctions d'extensions.
-- Une ligne non-extension possédée par un rôle différent du rôle effectif
-- peut faire échouer volontairement la migration 20261014130000.
SELECT
  pg_get_userbyid(p.proowner) AS object_owner,
  p.prosecdef AS security_definer,
  CASE WHEN ext.objid IS NULL THEN false ELSE true END AS owned_by_extension,
  count(*) AS routine_count,
  string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text) AS routine_signatures
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN (
  SELECT DISTINCT d.objid
  FROM pg_depend d
  WHERE d.classid = 'pg_proc'::regclass
    AND d.refclassid = 'pg_extension'::regclass
    AND d.deptype = 'e'
) ext ON ext.objid = p.oid
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
  AND EXISTS (
    SELECT 1
    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  )
GROUP BY p.proowner, p.prosecdef, (ext.objid IS NOT NULL)
ORDER BY object_owner, security_definer DESC, owned_by_extension;

-- Q3 — inventaire détaillé des fonctions métier non-extension dont PUBLIC
-- possède EXECUTE mais dont le propriétaire diffère du rôle effectif.
SELECT
  p.oid::regprocedure::text AS routine_signature,
  pg_get_userbyid(p.proowner) AS object_owner,
  current_user AS migration_role,
  pg_has_role(current_user, p.proowner, 'MEMBER') AS migration_role_is_member_of_owner,
  p.prosecdef AS security_definer,
  p.proconfig AS function_settings
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
  AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND EXISTS (
    SELECT 1
    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid
      AND d.refclassid = 'pg_extension'::regclass
      AND d.deptype = 'e'
  )
ORDER BY object_owner, routine_signature;

-- Q4 — relations et séquences de public avec privilèges PUBLIC, hors objets
-- d'extension, détenues par un autre rôle que le rôle effectif.
SELECT
  c.oid::regclass::text AS relation_name,
  c.relkind AS relation_kind,
  pg_get_userbyid(c.relowner) AS object_owner,
  current_user AS migration_role,
  pg_has_role(current_user, c.relowner, 'MEMBER') AS migration_role_is_member_of_owner,
  string_agg(DISTINCT acl.privilege_type, ', ' ORDER BY acl.privilege_type) AS public_privileges
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) acl
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  AND acl.grantee = 0
  AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid
      AND d.refclassid = 'pg_extension'::regclass
      AND d.deptype = 'e'
  )
GROUP BY c.oid, c.relkind, c.relowner
ORDER BY object_owner, relation_name;

-- Q5 — rôle runtime et appartenance éventuelle aux rôles propriétaires.
SELECT
  app.rolname AS runtime_role,
  owner_role.rolname AS object_owner_role,
  pg_has_role(app.oid, owner_role.oid, 'MEMBER') AS runtime_is_member_of_owner
FROM pg_roles app
CROSS JOIN pg_roles owner_role
WHERE app.rolname = 'tracefab_app'
  AND owner_role.rolname IN (
    SELECT DISTINCT pg_get_userbyid(p.proowner)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')
  )
ORDER BY object_owner_role;

-- Interprétation :
-- * Q2/Q3 non vides ne prouvent pas une exploitation, mais révèlent les ACL
--   qui doivent être expliquées avant la migration.
-- * Si Q3 contient des fonctions applicatives appartenant à postgres alors
--   que current_user est neondb_owner, ne pas lancer la migration : confirmer
--   les capacités de propriété/délégation et préparer un correctif autorisé.
-- * Les fonctions d'extension sont séparées ; ne pas révoquer leurs droits
--   par lot sans analyse de compatibilité.
-- * Ces résultats ne prouvent pas la compatibilité de l'historique Prisma :
--   utiliser également le diagnostic migration-history existant.
