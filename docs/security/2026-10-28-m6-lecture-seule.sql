-- ============================================================================
-- M6 — relevé de production, LECTURE SEULE
--
-- Usage : à exécuter par un opérateur habilité, avec un rôle de diagnostic
-- dédié (ou le rôle propriétaire) sur la base de PRODUCTION.
--
-- GARANTIES DE CE SCRIPT
--   - aucune écriture : uniquement des SELECT sur le catalogue système ;
--   - aucune table temporaire, aucun CREATE ;
--   - aucun changement de rôle, de search_path ou de GUC ;
--   - aucun appel à une fonction applicative ;
--   - aucune donnée personnelle : il ne lit que des noms de rôles, des
--     propriétaires, des compteurs et des définitions de politiques.
--
-- À exécuter de préférence dans une transaction READ ONLY :
--   BEGIN READ ONLY;  ...  ROLLBACK;
-- ainsi toute écriture accidentelle serait refusée par le serveur lui-même.
--
-- Ne pas coller la chaîne de connexion ni un mot de passe dans le rapport :
-- ce relevé ne les contient pas.
--
-- Si un bloc échoue (par exemple parce qu'une table est absente), PostgreSQL
-- avorte la transaction : exécuter alors le fichier bloc par bloc plutôt qu'en
-- un seul copier-coller. Le bloc des migrations est placé en dernier pour
-- cette raison précise.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Identité réelle de la session et attributs des rôles pertinents
-- ----------------------------------------------------------------------------
SELECT current_user                        AS role_effectif,
       session_user                        AS role_de_session,
       current_setting('transaction_read_only') AS lecture_seule;

SELECT rolname,
       rolsuper,
       rolbypassrls,
       rolcreaterole,
       rolcreatedb,
       rolcanlogin,
       rolinherit,
       rolconnlimit,
       rolvaliduntil
  FROM pg_catalog.pg_roles
 WHERE rolname IN ('tracefab_app', 'tracefab_worker', 'tracefab_owner', 'neondb_owner')
    OR rolname = current_user
 ORDER BY rolname;

-- Appartenances : qui peut endosser qui (chemins d'élévation).
SELECT r.rolname  AS role_membre,
       g.rolname  AS role_groupe,
       m.admin_option,
       m.inherit_option,
       m.set_option
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles r ON r.oid = m.member
  JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
 ORDER BY 1, 2;

-- ----------------------------------------------------------------------------
-- 2. Propriétaires effectifs du schéma et des objets sensibles
-- ----------------------------------------------------------------------------
SELECT n.nspname AS schema,
       pg_catalog.pg_get_userbyid(n.nspowner) AS proprietaire
  FROM pg_catalog.pg_namespace n
 WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
 ORDER BY 1;

-- Tables, vues, séquences du schéma public : propriétaire + RLS
SELECT c.relname                                   AS objet,
       c.relkind                                   AS type,
       pg_catalog.pg_get_userbyid(c.relowner)      AS proprietaire,
       c.relrowsecurity                            AS rls_activee,
       c.relforcerowsecurity                       AS rls_forcee
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p', 'S')
 ORDER BY c.relname;

-- Fonctions SECURITY DEFINER : propriétaire et search_path figé
SELECT p.proname                                          AS fonction,
       pg_catalog.pg_get_userbyid(p.proowner)             AS proprietaire,
       p.prosecdef                                        AS security_definer,
       array_to_string(p.proconfig, ',')                  AS reglages,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
 ORDER BY p.prosecdef DESC, p.proname;

-- Types énumérés et domaine de propriété
SELECT t.typname,
       pg_catalog.pg_get_userbyid(t.typowner) AS proprietaire
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
 ORDER BY 1;

-- ----------------------------------------------------------------------------
-- 3. Politiques RLS : définition réelle, par table sensible
-- ----------------------------------------------------------------------------
SELECT c.relname                    AS table_nom,
       c.relrowsecurity             AS rls_activee,
       c.relforcerowsecurity        AS rls_forcee,
       p.polname                    AS politique,
       p.polcmd                     AS commande,        -- r=SELECT a=INSERT w=UPDATE d=DELETE *=ALL
       p.polpermissive              AS permissive,
       coalesce(array_to_string(p.polroles::regrole[], ','), '-') AS roles,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
       pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY c.relname, p.polname;

-- Tables sous RLS sans AUCUNE politique d'écriture : le propriétaire seul écrit.
SELECT c.relname,
       (SELECT count(*) FROM pg_catalog.pg_policy p
         WHERE p.polrelid = c.oid AND p.polcmd IN ('a', 'w', 'd', '*')) AS politiques_ecriture
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
 ORDER BY 2, 1;

-- ----------------------------------------------------------------------------
-- 4. Privilèges effectifs : tracefab_app, héritage, PUBLIC
-- ----------------------------------------------------------------------------
-- Privilèges de table réellement détenus par le rôle runtime
SELECT c.relname                                   AS table_nom,
       has_table_privilege('tracefab_app', c.oid, 'SELECT') AS sel,
       has_table_privilege('tracefab_app', c.oid, 'INSERT') AS ins,
       has_table_privilege('tracefab_app', c.oid, 'UPDATE') AS upd,
       has_table_privilege('tracefab_app', c.oid, 'DELETE') AS del,
       has_table_privilege('tracefab_app', c.oid, 'TRUNCATE') AS tron
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;

-- Privilèges hérités : par quel rôle ils arrivent
SELECT r.rolname AS role_accordant,
       c.relname AS table_nom,
       acl.privilege_type
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
  JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
 WHERE n.nspname = 'public'
   AND acl.grantee <> 0
   AND pg_catalog.pg_has_role('tracefab_app', r.oid, 'USAGE')
 ORDER BY 2, 3;

-- Privilèges accordés à PUBLIC : doivent être vides sur les tables métier
SELECT c.relname AS table_nom,
       acl.privilege_type
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
 WHERE n.nspname = 'public'
   AND acl.grantee = 0            -- 0 = PUBLIC
 ORDER BY 1, 2;

-- Privilèges de PUBLIC sur les fonctions (une SECURITY DEFINER exécutable par
-- PUBLIC est un chemin d'élévation) :
SELECT p.proname,
       p.prosecdef AS security_definer,
       acl.privilege_type
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
 WHERE n.nspname = 'public'
   AND acl.grantee = 0
   AND acl.privilege_type = 'EXECUTE'
 ORDER BY 1;

-- Fonctions exécutables par le rôle runtime mais absent du registre
SELECT p.proname
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM public.tracefab_runtime_function_registry r WHERE r.name = p.proname)
 ORDER BY 1;

-- Privilèges par défaut : ce qu'un futur objet recevra sans attention
SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS role_emetteur,
       coalesce(n.nspname, '*')                 AS schema,
       d.defaclobjtype                          AS type_objet,
       acl.privilege_type,
       acl.grantee
  FROM pg_catalog.pg_default_acl d
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl
 ORDER BY 1, 2;

-- ----------------------------------------------------------------------------
-- 5. Contrôles de cohérence attendu/observé (à lire, pas à croire)
-- ----------------------------------------------------------------------------
-- Le rôle runtime exécute-t-il encore les fonctions du registre ?
SELECT (SELECT count(*) FROM public.tracefab_runtime_function_registry) AS registre,
       (SELECT count(*) FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')) AS executables_par_app;

-- Rôles qui peuvent lire une table sous FORCE RLS sans passer par elle
SELECT rolname, rolbypassrls, rolsuper
  FROM pg_catalog.pg_roles
 WHERE rolbypassrls OR rolsuper
 ORDER BY rolname;

-- ----------------------------------------------------------------------------
-- 6. État des migrations appliquées — EN DERNIER, À DESSEIN
--    (lecture seule ; on ne modifie jamais cette table)
--
--    CE BLOC EST LE DERNIER, ET CE N'EST PAS UN HASARD : si la table
--    `_prisma_migrations` est absente (base reconstruite par rejeu de fichiers
--    SQL, par exemple), la requête échoue et PostgreSQL AVORTE la transaction
--    de lecture — les requêtes suivantes seraient alors toutes ignorées. Placé
--    en dernier, il ne peut donc pas masquer les relevés précédents.
-- ----------------------------------------------------------------------------
SELECT count(*)                                     AS migrations_appliquees,
       max(migration_name)                          AS derniere_par_ordre_alphabetique,
       max(finished_at)                             AS derniere_execution,
       count(*) FILTER (WHERE finished_at IS NULL)  AS terminees_sans_horodatage,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS annulees,
       count(*) FILTER (WHERE applied_steps_count = 0)    AS sans_etape
  FROM public._prisma_migrations;

SELECT migration_name,
       checksum,
       started_at,
       finished_at,
       applied_steps_count,
       rolled_back_at,
       logs
  FROM public._prisma_migrations
 ORDER BY started_at DESC
 LIMIT 15;

-- Échecs éventuels : une migration commencée et non terminée est un incident.
SELECT migration_name, started_at, finished_at, applied_steps_count, left(coalesce(logs, ''), 400) AS extrait_journal
  FROM public._prisma_migrations
 WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
 ORDER BY started_at DESC;

ROLLBACK;
-- ainsi toute écriture accidentelle serait refusée par le serveur lui-même.
--
-- Ne pas coller la chaîne de connexion ni un mot de passe dans le rapport :
-- ce relevé ne les contient pas.
-- ============================================================================

BEGIN READ ONLY;


ROLLBACK;

-- ============================================================================
-- Lecture des résultats — ce qui compte
--
--   A. Si le propriétaire des tables porte rolsuper = true ou rolbypassrls =
--      true, alors FORCE ROW LEVEL SECURITY ne protège de rien contre lui :
--      c'est le point de M3, et il se lit dans le premier SELECT.
--
--   B. Si `tracefab_app` a rolsuper ou rolbypassrls à true, l'isolation
--      multi-locataires ne repose plus sur la base : blocage immédiat.
--
--   C. Une table sous RLS avec « politiques_ecriture = 0 » ne peut être écrite
--      que par son propriétaire : toute migration qui y insère un référentiel
--      exige donc un propriétaire privilégié (cause mesurée du blocage de
--      20261006160000).
--
--   D. Toute ligne renvoyée par « Privilèges accordés à PUBLIC » sur une table
--      métier, ou toute SECURITY DEFINER exécutable par PUBLIC, est un défaut.
--
--   E. Une migration avec finished_at NULL ou rolled_back_at non NULL est un
--      incident : ne rien rejouer avant de l'avoir compris.
-- ============================================================================
