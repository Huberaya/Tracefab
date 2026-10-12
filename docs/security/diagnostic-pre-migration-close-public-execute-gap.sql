-- TRACEFAB — diagnostic AVANT application de la migration
-- 20261012120000_close_public_execute_gap
--
-- CE QUE CE FICHIER EST : une lecture. Aucune instruction n'ecrit, ne cree, ne
-- supprime, ni ne modifie un privilege. Il peut donc etre lance sur un
-- environnement de preproduction ou de production sans rien y changer.
--
-- CE QU'IL SERT A MESURER — les trois hypotheses dont depend l'efficacite de la
-- migration, et qu'aucune lecture de code ne peut trancher :
--
--   H1. Le role qui jouera la migration est aussi le PROPRIETAIRE des six
--       fonctions. Sinon, l'auto-controle de la migration mesure « une fonction
--       creee par <role> » — le role executant, pas le proprietaire des objets.
--       Le controle passe alors au vert alors que les fonctions deja en place
--       restent ouvertes a PUBLIC.
--   H2. Aucun role NON-PROPRIETAIRE ne depend aujourd'hui de l'EXECUTE que
--       PUBLIC fournissait. Les politiques RLS sont evaluees avec les
--       privileges du role qui interroge : un troisieme role qui lit ces
--       tables verrait une erreur de politique apres la fermeture.
--   H3. Les privileges par defaut enregistres pour le role executant portent
--       bien l'ordre global (sans IN SCHEMA) une fois la migration appliquee.
--
-- LE LANCER AVEC LE ROLE QUI APPLIQUERA LA MIGRATION : c'est ce que mesure la
-- section 1. Une chaine de connexion ne se colle ni dans un rapport, ni dans un
-- ticket : elle se fournit par le mecanisme habituel de l'environnement.
--
-- LECTURE DU RESULTAT — les lignes qui decident :
--
--   section 6, objet « fonctions encore ouvertes a PUBLIC »
--       -> 0 est attendu APRES migration. Toute autre valeur est un echec.
--   section 2, objet « <fonction> — proprietaire »
--       -> doit valoir le role executeur de la section 1 (hypothese H1).
--   section 4, objet « role porteur d'un EXECUTE »
--       -> doit ne contenir que le proprietaire et les roles explicitement
--          autorises (hypothese H2). Tout autre role est a examiner avant.
--   section 3, objet « defauts pour fonctions »
--       -> apres migration, la ligne doit exister pour le role executeur et ne
--          plus accorder EXECUTE a PUBLIC (hypothese H3).

WITH cible(nom, args) AS (
  VALUES
    ('tracefab_public_context', '()'),
    ('tracefab_product_is_public', '(uuid)'),
    ('tracefab_material_is_public', '(uuid)'),
    ('tracefab_supplier_site_is_public', '(uuid)'),
    ('tracefab_public_brand', '(uuid)'),
    ('tracefab_material_visible_via_product', '(uuid)')
),
fonctions AS (
  SELECT c.nom, to_regprocedure(c.nom || c.args) AS oid
  FROM cible c
),
existantes AS (
  SELECT f.nom, f.oid, p.proowner, p.prosecdef, p.proacl
  FROM fonctions f
  JOIN pg_proc p ON p.oid = f.oid
),
app_existe AS (
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') AS oui
)
SELECT '1-reperes' AS section, 'role_executeur' AS objet, current_user::text AS valeur, '' AS note
UNION ALL
SELECT '1-reperes', 'base', current_database()::text, ''
UNION ALL
SELECT '1-reperes', 'version_postgresql', current_setting('server_version'), ''
UNION ALL
SELECT '1-reperes', 'role_executeur_est_superutilisateur',
       (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user), ''
UNION ALL
-- L'etat « migration deja appliquee » se lit sur ses EFFETS (sections 3 et 6) et
-- non sur une table de suivi : le diagnostic doit rester executable sur toute
-- base, y compris une base ou la table de suivi serait absente. Facultatif, si
-- cette table existe :
--     SELECT migration_name, finished_at FROM _prisma_migrations
--      WHERE migration_name = '20261012120000_close_public_execute_gap';
SELECT '1-reperes', 'fonctions_cibles_trouvees', count(*)::text || ' / 6', 'une fonction absente fera echouer la section 2'
FROM existantes
UNION ALL
-- H1 : le proprietaire de chaque fonction.
SELECT '2-fonctions', e.nom || ' — proprietaire', pg_get_userbyid(e.proowner), 'doit egaler le role executeur de la section 1'
FROM existantes e
UNION ALL
SELECT '2-fonctions', e.nom || ' — SECURITY DEFINER', e.prosecdef::text,
       'attendu : true, sauf tracefab_public_context (lecture du drapeau de contexte, pas d acces a une table)'
FROM existantes e
UNION ALL
-- Le point de la migration : PUBLIC peut-il encore executer ?
SELECT '2-fonctions', e.nom || ' — PUBLIC peut executer',
       has_function_privilege('public', e.oid, 'EXECUTE')::text,
       'attendu : false apres migration'
FROM existantes e
UNION ALL
SELECT '2-fonctions', e.nom || ' — tracefab_app peut executer',
       CASE WHEN (SELECT oui FROM app_existe)
            THEN has_function_privilege('tracefab_app', e.oid, 'EXECUTE')::text
            ELSE 'role absent' END,
       'si le role existe, il doit garder l EXECUTE'
FROM existantes e
UNION ALL
SELECT '2-fonctions', e.nom || ' — droits explicites',
       COALESCE((
         SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
         FROM aclexplode(COALESCE(e.proacl, '{}')) a
         WHERE a.privilege_type = 'EXECUTE'
       ), 'aucun'),
       'liste des porteurs declares dans pg_proc.proacl'
FROM existantes e
UNION ALL
-- H3 : les privileges par defaut pour les objets futurs.
SELECT '3-defauts', 'defauts pour fonctions — ' || r.rolname,
       d.defaclacl::text,
       'role destinataire des fonctions futures'
FROM pg_default_acl d
JOIN pg_roles r ON r.oid = d.defaclrole
WHERE d.defaclobjtype = 'f'
UNION ALL
SELECT '3-defauts', 'aucun defaut enregistre pour fonctions',
       CASE WHEN EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclobjtype = 'f')
            THEN 'faux' ELSE 'vrai' END,
       'apres migration, une ligne doit exister pour le role executeur'
UNION ALL
-- H2 : qui, aujourd'hui, peut executer les six fonctions.
SELECT '4-roles', 'role porteur d un EXECUTE — ' || r.rolname,
       r.rolcanlogin::text,
       'true = role de connexion ; a examiner s il n est ni proprietaire ni tracefab_app'
FROM pg_roles r
WHERE (SELECT count(*) FROM existantes e
       WHERE has_function_privilege(r.oid, e.oid, 'EXECUTE')) > 0
  AND r.rolname <> current_user
  AND NOT r.rolsuper
UNION ALL
SELECT '4-roles', 'roles de connexion de la base',
       COALESCE(string_agg(rolname, ', ' ORDER BY rolname), 'aucun'),
       'tout role de connexion non prevu doit etre connu avant la fermeture'
FROM pg_roles WHERE rolcanlogin
UNION ALL
-- Dependance des politiques : ces fonctions sont appelees par des politiques.
SELECT '5-politiques', p.schemaname || '.' || p.tablename || ' / ' || p.policyname,
       p.cmd,
       'politique dependante : une erreur d EXECUTE s y manifesterait'
FROM pg_policies p
WHERE p.qual LIKE '%tracefab_public_context%'
   OR p.qual LIKE '%tracefab_product_is_public%'
   OR p.qual LIKE '%tracefab_material_is_public%'
   OR p.qual LIKE '%tracefab_supplier_site_is_public%'
   OR p.qual LIKE '%tracefab_public_brand%'
   OR p.qual LIKE '%tracefab_material_visible_via_product%'
UNION ALL
-- Le critere de la migration, resume en une ligne.
SELECT '6-critere', 'fonctions encore ouvertes a PUBLIC', count(*)::text,
       'doit valoir 0 : la migration est fermee si et seulement si ce compte est nul'
FROM existantes e
WHERE has_function_privilege('public', e.oid, 'EXECUTE')
ORDER BY section, objet;
