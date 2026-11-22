-- TRACEFAB — privilèges EFFECTIFS du rôle applicatif, en production.
-- LECTURE SEULE. Catalogue système uniquement, aucun SELECT métier.
--
-- POURQUOI CE SCRIPT EXISTE
--
-- `tracefab_app` a `rolbypassrls = false`. Cela ne dit rien de ce qu'il peut
-- FAIRE. Trois échappées restent possibles, et aucune ne se lit sur la ligne
-- `pg_roles` du rôle :
--
--   1. il peut endosser, par `SET ROLE`, un rôle qui porte BYPASSRLS
--      (mesuré : l'appartenance seule ne transmet PAS l'attribut, mais
--      `SET ROLE` le donne — scripts/test_appartenances_roles.mjs) ;
--   2. il peut recevoir, par appartenance, des privilèges d'écriture sur une
--      table que le dépôt lui refuse (l'héritage des PRIVILÈGES, lui, marche) ;
--   3. il peut exécuter une fonction SECURITY DEFINER qui écrit à sa place.
--
-- `has_table_privilege` couvre le point 2 (il inclut les privilèges hérités)
-- mais PAS ceux qu'on n'obtient qu'en endossant un rôle. D'où deux mesures
-- distinctes, jamais fusionnées.
--
-- MODE D'EMPLOI (éditeur SQL Neon, branche Primary = production)
--   exécuter les requêtes une par une, coller chaque sortie.
--   Vérifier le NOMBRE DE LIGNES avant de conclure :
--     Q1 : 6 lignes (une par table ; une table absente sort en « absente »)
--     Q2 : 1 ligne  (bilan des fonctions)
--     Q3 : 1 à N lignes (une par rôle BYPASSRLS atteignable ; 1 ligne
--          « aucun » s'il n'y en a pas — ce n'est PAS une lecture vide)
--     Q4 : 0 à N lignes (privilèges par défaut : 0 ligne est normal)
--   Moins de lignes que l'attendu sur Q1/Q2 = lecture partielle, pas un PASS.

-- =====================================================================
-- Q1 — Droits de table EFFECTIFS (héritage compris) sur les six tables
--      que le mandat nomme. « aucun » = ni direct ni hérité.
--      ATTENDU : 6 lignes.
-- =====================================================================
WITH cibles(nom) AS (VALUES
  ('documents'), ('tracefab_products'), ('organization_invitations'),
  ('brand_supplier_relationships'), ('plm_erp_integrations'), ('plm_erp_sync_jobs')
)
SELECT format('table|%s|%s|droits=%s|public=%s|proprietaire=%s',
         c.nom,
         CASE WHEN cl.oid IS NULL THEN 'ABSENTE' ELSE 'presente' END,
         coalesce((
           SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY[
             'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
            WHERE cl.oid IS NOT NULL AND pg_catalog.has_table_privilege('tracefab_app', cl.oid, p)
         ), 'aucun'),
         coalesce((
           SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY[
             'SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
            WHERE cl.oid IS NOT NULL AND pg_catalog.has_table_privilege('public', cl.oid, p)
         ), 'aucun'),
         coalesce(pg_get_userbyid(cl.relowner), '-')
       ) AS ligne
  FROM cibles c
  LEFT JOIN pg_catalog.pg_class cl
         ON cl.relname = c.nom AND cl.relnamespace = 'public'::regnamespace
 ORDER BY 1;

-- =====================================================================
-- Q2 — L'application peut-elle OBTENIR BYPASSRLS indirectement ?
--      Un rôle est « atteignable » si l'application en est membre directe
--      (`pg_auth_members`, quel que soit le sens des options) ET que
--      l'octroi autorise `SET ROLE` (`set_option`) ou l'administration
--      (`admin_option`).
--
--      ATTENDU : au moins 1 ligne. La ligne `aucun` signifie « aucun rôle
--      BYPASSRLS atteignable » et c'est le SEUL résultat rassurant.
--      Toute autre ligne est un constat grave : la RLS est neutralisable.
-- =====================================================================
SELECT format('bypass-atteignable|%s|par|%s|setrole=%s|admin=%s|attribut_direct=%s',
         r.rolname,
         pg_get_userbyid(am.grantor),
         CASE WHEN am.set_option THEN 'true' ELSE 'false' END,
         CASE WHEN am.admin_option THEN 'true' ELSE 'false' END,
         CASE WHEN (SELECT rolbypassrls FROM pg_catalog.pg_roles x
                     WHERE x.rolname = 'tracefab_app') THEN 'true' ELSE 'false' END
       ) AS ligne
  FROM pg_catalog.pg_roles r
  JOIN pg_catalog.pg_auth_members am
    ON am.roleid = r.oid
  JOIN pg_catalog.pg_roles m
    ON m.oid = am.member
 WHERE r.rolbypassrls
   AND m.rolname = 'tracefab_app'
UNION ALL
SELECT 'bypass-atteignable|aucun|par|-|setrole=false|admin=false|attribut_direct=' ||
       CASE WHEN (SELECT rolbypassrls FROM pg_catalog.pg_roles x
                   WHERE x.rolname = 'tracefab_app') THEN 'true' ELSE 'false' END
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_roles r2
     JOIN pg_catalog.pg_auth_members am2 ON am2.roleid = r2.oid
     JOIN pg_catalog.pg_roles m2 ON m2.oid = am2.member
    WHERE r2.rolbypassrls AND m2.rolname = 'tracefab_app')
 ORDER BY 1;

-- =====================================================================
-- Q3 — Les fonctions SECURITY DEFINER : qui peut les exécuter ?
--      `EXECUTE` accordé à PUBLIC est le cas à surveiller : il rend la
--      fonction appelable par n'importe quel rôle, y compris hors RLS quand
--      la fonction est SECURITY DEFINER.
--      ATTENDU : 1 ligne.
-- =====================================================================
SELECT format('fonctions|total=%s|secdef=%s|exec_app=%s|exec_public=%s|secdef_exec_public=%s',
         count(*),
         count(*) FILTER (WHERE p.prosecdef),
         count(*) FILTER (WHERE pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')),
         count(*) FILTER (WHERE pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')),
         coalesce((
           SELECT string_agg(p2.proname, ',' ORDER BY p2.proname)
             FROM pg_catalog.pg_proc p2
            WHERE p2.pronamespace = 'public'::regnamespace
              AND p2.prosecdef
              AND pg_catalog.has_function_privilege('public', p2.oid, 'EXECUTE')
         ), 'aucune')
       ) AS ligne
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace;

-- =====================================================================
-- Q4 — Privilèges PAR DÉFAUT : ce que le prochain objet recevra sans GRANT.
--      Un ALTER DEFAULT PRIVILEGES oublié peut rouvrir une écriture qu'une
--      migration venait de fermer, sur toute table créée ensuite.
--      ATTENDU : 0 à N lignes (0 est normal). La lecture vide n'est PAS un
--      échec, mais elle doit être notée « 0 ligne ».
-- =====================================================================
SELECT format('defaut|%s|par|%s|objet=%s|%s|%s=%s%s',
         coalesce(n.nspname, '(tous schemas)'),
         pg_get_userbyid(d.defaclrole),
         CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
              WHEN 'f' THEN 'fonctions' WHEN 'T' THEN 'types' ELSE d.defaclobjtype::text END,
         CASE WHEN d.defaclacl IS NULL THEN 'aucun' ELSE 'acl-presente' END,
         'grantee',
         coalesce((
           SELECT string_agg(DISTINCT a.grantee::regrole::text, ',' ORDER BY a.grantee::regrole::text)
             FROM aclexplode(d.defaclacl) a WHERE a.grantee <> 0
         ), 'aucun'),
         ''
       ) AS ligne
  FROM pg_catalog.pg_default_acl d
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
 ORDER BY 1;

-- =====================================================================
-- CE QUE CHAQUE ISSUE AUTORISE À CONCLURE
--
-- Q2 « aucun »                 -> l'application ne peut pas endosser de rôle
--                                 BYPASSRLS. C'est la seule ligne rassurante.
-- Q2 une ligne nommée          -> la RLS est neutralisable par SET ROLE.
--                                 Constat grave, à documenter tel quel.
--                                 Remédiation à PRÉPARER, pas à exécuter :
--                                 `REVOKE <role> FROM tracefab_app GRANTED BY
--                                 <grantor>` — ET VÉRIFIER QU'IL N'EN RESTE
--                                 PAS UN SECOND (voir Q1 du script
--                                 appartenances : deux lignes pour la même
--                                 paire sont possibles, et une révocation
--                                 partielle ne retire rien).
-- Q1 droits=... sur documents/tracefab_products
--                              -> comparer à la matrice minimale. Toute
--                                 écriture doit être justifiée par une
--                                 fonction SECURITY DEFINER qui la remplace.
-- Q3 secdef_exec_public non vide -> fonctions sensibles ouvertes à PUBLIC.
-- Q4 une ligne                 -> un défaut rouvrira l'écriture sur les
--                                 objets FUTURS.
-- =====================================================================
