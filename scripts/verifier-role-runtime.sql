-- Identifier le role PostgreSQL reellement utilise par le runtime.
--
-- PORTEE : ce fichier est le chemin MANUEL (editeur SQL, psql). Il ne remplace
-- pas la sonde runtime : colle dans un editeur, il mesure la connexion de
-- l'editeur, PAS celle de l'application. La seule mesure qui prouve l'identite
-- du runtime est `GET /api/internal/p2/readiness?identity=1`, qui lit
-- `current_user` sur la connexion du client Prisma des routes
-- (`scripts/probe_preview_runtime_identity.mjs`).
--
-- STRICTEMENT EN LECTURE SEULE : aucune ecriture, aucune creation, aucun
-- privilege modifie, aucune migration. A coller sur la branche pointee par la
-- Preview (pas sur la branche de production).
--
-- Aucune chaine de connexion n'est affichee : seuls des noms de role, des
-- booleens, des compteurs et des noms de privilege remontent.

-- 1. Le role de connexion, le role effectif, et les proprietes decisives.
--    `session_user` n'est pas un doublon : si un SET ROLE existe en amont, les
--    deux divergent et la lecture de l'identite change de sens.
SELECT current_user                                                          AS role_de_connexion,
       session_user                                                          AS role_de_session,
       (current_user = session_user)                                         AS aucun_set_role,
       (SELECT rolsuper      FROM pg_roles WHERE rolname = current_user)     AS est_superuser,
       (SELECT rolbypassrls  FROM pg_roles WHERE rolname = current_user)     AS contourne_rls,
       (SELECT rolcreatedb   FROM pg_roles WHERE rolname = current_user)     AS peut_creer_base,
       (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user)     AS peut_creer_role,
       (SELECT rolreplication FROM pg_roles WHERE rolname = current_user)    AS peut_repliquer;

-- 2. L'adhesion — directe ou heritee — a un role qui contourne la RLS.
--    Un role sans BYPASSRLS peut tout de meme voir toutes les lignes s'il est
--    MEMBER d'un role qui le porte : les attributs seuls ne suffisent pas.
SELECT r.rolname, r.rolsuper, r.rolbypassrls
FROM pg_roles r
WHERE r.rolname <> current_user
  AND pg_has_role(current_user, r.oid, 'MEMBER')
  AND (r.rolsuper OR r.rolbypassrls);

-- 3. La mesure qui tranche, sans se fier aux proprietes ci-dessus.
--    Un role qui contourne la RLS voit des lignes ; un role soumis a la RLS,
--    sans contexte arme, n'en voit aucune. `LIMIT 1` : la question n'est pas
--    « combien », c'est « en voit-il au moins une ».
SELECT count(*) AS lignes_visibles_sans_contexte
FROM (SELECT 1 FROM public.tracefab_products LIMIT 1) AS visible_rows;

-- 4. La RLS est-elle activee (et forcee) sur la table porteuse du locataire ?
--    `relforcerowsecurity = false` signifie que le PROPRIETAIRE de la table
--    echappe aux politiques : c'est pourquoi l'identite du runtime compte.
SELECT relname, relrowsecurity AS rls_activee, relforcerowsecurity AS rls_forcee
FROM pg_class
WHERE oid = to_regclass('public.tracefab_products');

-- 5. Privileges du role sur cette table : lecture oui, ecriture directe non.
SELECT current_user                                                        AS role,
       has_table_privilege(current_user, 'public.tracefab_products', 'SELECT') AS lecture,
       (has_table_privilege(current_user, 'public.tracefab_products', 'INSERT')
        OR has_table_privilege(current_user, 'public.tracefab_products', 'UPDATE')
        OR has_table_privilege(current_user, 'public.tracefab_products', 'DELETE')) AS ecriture_directe,
       has_database_privilege(current_user, current_database(), 'CREATE')  AS creation_base,
       has_schema_privilege(current_user, 'public', 'CREATE')               AS creation_schema;

-- 6. Les deux roles candidats et leur posture, pour separer le role du runtime
--    de celui des migrations.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('neondb_owner', 'tracefab_app')
ORDER BY rolname;
