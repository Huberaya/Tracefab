-- ============================================================================
-- TRACEFAB — P10.5 — SONDE DE LECTURE SEULE
--
-- A EXECUTER TEL QUEL, PAR UN OPERATEUR AUTORISE, SUR LA BASE A MESURER.
--
-- Cette sonde N'ECRIT RIEN. Elle ne modifie ni role, ni privilege, ni
-- politique, ni donnee. Elle ne lit aucun secret : elle interroge des
-- catalogues (`pg_catalog`, `information_schema`) et des compteurs.
--
-- ELLE REPOND AUX QUESTIONS QUE LE DEPOT NE PEUT PAS TRANCHER :
--
--   B1  quel role le runtime utilise-t-il REELLEMENT ? (`DATABASE_URL` cote
--       Vercel n'est pas lisible depuis le depot ; seul `current_user` le dit,
--       et il faut le lire DEPUIS le runtime — voir § 1 et le mode d'emploi)
--   B2  l'historique des migrations est-il complet, et sain ?
--   B4  la hierarchie des roles permet-elle une elevation ?
--   E   la cle HMAC est-elle hors de portee de `tracefab_app` ?
--
-- MODE D'EMPLOI
--   Executer chaque bloc separement, dans l'ordre, et conserver les sorties.
--   Un resultat se lit avec sa date. Sans date, ce n'est pas une mesure.
--
-- CE QUE CETTE SONDE NE PROUVE PAS
--   Elle lit le catalogue avec le role de l'OPERATEUR. Elle ne dit donc rien
--   de l'identite du runtime : cela se mesure avec
--   `GET /api/internal/p2-readiness?identity=1` (voir § 1).
-- ============================================================================


-- ============================================================================
-- 1. CONTEXTE DE LA MESURE
--    Le role qui execute ces requetes n'est PAS celui du runtime. Ce bloc sert
--    a qualifier la mesure, pas a conclure.
-- ============================================================================
SELECT current_user                AS role_executant,
       current_database()          AS base,
       inet_server_addr()          AS adresse_serveur,
       pg_catalog.version()        AS version_postgresql,
       current_setting('server_version_num')::int AS version_num,
       now()                       AS mesuree_le;


-- ============================================================================
-- 2. LES ROLES EN PRESENCE (B4 — attributs)
--
--    ATTENDU : `tracefab_app` avec rolsuper = false et rolbypassrls = false.
--    Un `rolbypassrls = true` sur le role du runtime rend TOUTE la RLS
--    decorative : les politiques existent mais ne sont jamais evaluees.
-- ============================================================================
SELECT r.rolname,
       r.rolsuper,
       r.rolbypassrls,
       r.rolcanlogin,
       r.rolcreaterole,
       r.rolcreatedb,
       r.rolinherit,
       r.rolreplication
  FROM pg_catalog.pg_roles r
 WHERE r.rolname NOT LIKE 'pg\_%'
   AND r.rolname NOT LIKE 'azure\_%'
 ORDER BY r.rolname;


-- ============================================================================
-- 3. APPARTENANCES DIRECTES, AVEC LEURS OPTIONS (B4)
--
--    ATTENDU : aucune ligne dont `membre = 'tracefab_app'`.
--
--    POURQUOI LES OPTIONS COMPTENT : en PostgreSQL 16+, une appartenance
--    porte trois options independantes — ADMIN, INHERIT, SET. `INHERIT false`
--    n'empeche QUE l'heritage des privileges : `SET ROLE` reste possible si
--    SET est vrai, et c'est exactement le chemin d'elevation mesure en P10.4
--    (0 -> 4 produits visibles). Ne regarder que l'existence de la ligne ne
--    suffit pas.
-- ============================================================================
SELECT m.rolname                       AS membre,
       g.rolname                       AS role_accorde,
       am.admin_option,
       (to_jsonb(am) ->> 'inherit_option')::boolean AS inherit_option,
       (to_jsonb(am) ->> 'set_option')::boolean     AS set_option,
       pg_catalog.pg_get_userbyid(am.grantor)       AS accorde_par
  FROM pg_catalog.pg_auth_members am
  JOIN pg_catalog.pg_roles m ON m.oid = am.member
  JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
 WHERE m.rolname NOT LIKE 'pg\_%'
 ORDER BY 1, 2;


-- ============================================================================
-- 4. FERMETURE TRANSITIVE DEPUIS `tracefab_app` (B4)
--
--    Une appartenance DIRECTE a un role inoffensif qui est lui-meme membre du
--    proprietaire est une elevation. On developpe donc le graphe.
--
--    ATTENDU : aucune ligne.
-- ============================================================================
WITH RECURSIVE parcours AS (
  SELECT d.oid AS origine, d.oid AS courant, d.rolname AS role_atteint, 0 AS profondeur,
         ARRAY[d.rolname] AS chemin
    FROM pg_catalog.pg_roles d
   WHERE d.rolname = 'tracefab_app'
  UNION ALL
  SELECT p.origine, g.oid, g.rolname, p.profondeur + 1, p.chemin || g.rolname
    FROM parcours p
    JOIN pg_catalog.pg_auth_members am ON am.member = p.courant
    JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
   WHERE p.profondeur < 10
     AND NOT g.rolname = ANY (p.chemin)
)
SELECT role_atteint, profondeur, chemin
  FROM parcours
 WHERE profondeur > 0
 ORDER BY profondeur, role_atteint;


-- ============================================================================
-- 5. CE QUE `tracefab_app` PEUT PRENDRE, MESURE PAR LE MOTEUR (B4)
--
--    `pg_has_role(x, 'MEMBER')` est la fonction que PostgreSQL utilise
--    lui-meme pour decider d'un `SET ROLE`. C'est donc une mesure, pas une
--    lecture d'intention.
--
--    ATTENDU : false pour TRACE et pour tout role privilegie.
-- ============================================================================
SELECT cible,
       pg_catalog.pg_has_role('tracefab_app', cible, 'MEMBER')   AS peut_devenir_membre,
       pg_catalog.pg_has_role('tracefab_app', cible, 'USAGE')    AS peut_utiliser,
       pg_catalog.pg_has_role('tracefab_app', cible, 'SET')      AS peut_set_role
  FROM (VALUES ('tracefab_migrator'), ('tracefab_worker'), ('postgres'),
               ('neondb_owner'), ('cloud_admin'), ('rdsadmin'),
               ('pg_write_all_data'), ('pg_read_all_data')) AS t(cible)
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = t.cible)
 ORDER BY cible;


-- ============================================================================
-- 6. PROPRIETE DES OBJETS (B4)
--
--    `tracefab_app` ne doit posseder AUCUN objet. Un proprietaire contourne
--    `FORCE ROW LEVEL SECURITY` sur ce qu'il possede, et peut le modifier.
-- ============================================================================
SELECT genre, proprietaire, count(*) AS objets
  FROM (
        SELECT 'table' AS genre, pg_catalog.pg_get_userbyid(c.relowner) AS proprietaire
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
        UNION ALL
        SELECT 'sequence', pg_catalog.pg_get_userbyid(c.relowner)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'S'
        UNION ALL
        SELECT 'fonction', pg_catalog.pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
        UNION ALL
        SELECT 'schema', pg_catalog.pg_get_userbyid(n.nspowner)
          FROM pg_catalog.pg_namespace n
         WHERE n.nspname = 'public'
       ) o
 GROUP BY genre, proprietaire
 ORDER BY genre, objets DESC;


-- ============================================================================
-- 7. ROW LEVEL SECURITY : ACTIVEE **ET** FORCEE (B2)
--
--    `relrowsecurity` = la politique s'applique aux autres.
--    `relforcerowsecurity` = elle s'applique AUSSI au proprietaire.
--    Sans FORCE, un role proprietaire lit tout — c'est la situation que P10.4
--    a mesuree.
-- ============================================================================
SELECT count(*)                                                        AS tables_publiques,
       count(*) FILTER (WHERE c.relrowsecurity)                        AS rls_active,
       count(*) FILTER (WHERE c.relrowsecurity AND NOT c.relforcerowsecurity) AS rls_sans_force,
       count(*) FILTER (WHERE NOT c.relrowsecurity)                    AS sans_rls
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r';

SELECT c.relname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
 ORDER BY c.relname;


-- ============================================================================
-- 8. PRIVILEGES EFFECTIFS DU RUNTIME (B2/B4)
--
--    `has_*_privilege` tient compte des appartenances : c'est la mesure qui
--    vaut, pas la lecture de l'ACL brute.
--
--    ATTENDU : create=false sur le schema, select=false sur les tables
--    sensibles, EXECUTE sur les fonctions de l'allowlist seulement.
-- ============================================================================
SELECT pg_catalog.has_schema_privilege('tracefab_app', 'public', 'CREATE')  AS app_peut_creer_dans_public,
       pg_catalog.has_schema_privilege('tracefab_app', 'public', 'USAGE')   AS app_peut_utiliser_public,
       pg_catalog.has_table_privilege('tracefab_app', 'public._prisma_migrations', 'INSERT') AS app_ecrit_registre,
       pg_catalog.has_table_privilege('tracefab_app', 'public._prisma_migrations', 'SELECT') AS app_lit_registre;


-- ============================================================================
-- 9. HISTORIQUE DES MIGRATIONS (B2)
--
--    ATTENDU : aucune ligne `finished_at IS NULL AND rolled_back_at IS NULL`.
--    Une ligne non terminee fait s'arreter `prisma migrate deploy` (P3009), et
--    ne doit JAMAIS etre supprimee : elle se marque `rolled_back_at`.
-- ============================================================================
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS terminees,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)     AS en_echec,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)                          AS annulees,
       max(started_at)                                                             AS derniere_tentative
  FROM public._prisma_migrations;

SELECT migration_name, started_at, finished_at, rolled_back_at
  FROM public._prisma_migrations
 WHERE finished_at IS NULL AND rolled_back_at IS NULL
 ORDER BY started_at;


-- ============================================================================
-- 10. LE REGISTRE DES FONCTIONS DU RUNTIME (B2)
--
--    Toute fonction executable par `tracefab_app` doit y figurer. Un ecart
--    signifie qu'une migration a ouvert une fonction en contournant le
--    registre.
-- ============================================================================
SELECT (SELECT count(*) FROM public.tracefab_runtime_function_registry) AS fonctions_au_registre,
       (SELECT count(DISTINCT p.proname)
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')) AS fonctions_executables_par_app;

SELECT p.proname
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
   AND p.proname NOT IN (SELECT name FROM public.tracefab_runtime_function_registry)
 ORDER BY p.proname;


-- ============================================================================
-- 11. L'IDENTITE HMAC (E)
--
--    Aucune valeur secrete n'est lue : seulement l'existence, le mode et les
--    privileges.
--
--    ATTENDU : `app_lit_les_cles` = false, `app_peut_signer` = false.
--    `hmac` est la primitive de pgcrypto : si le runtime peut l'executer, il
--    peut produire un MAC des lors qu'il connait la cle — et s'il connait la
--    cle, tout le mecanisme est mort.
-- ============================================================================
SELECT to_regclass('public.tracefab_identity_cles')                        IS NOT NULL AS table_cles_presente,
       to_regprocedure('public.tracefab_identity_jeton_utilisateur(text)') IS NOT NULL AS fonction_verification_presente,
       to_regclass('public.tracefab_identity_politique')            IS NOT NULL AS table_mode_presente;


-- ============================================================================
-- 12. LE MODE D'IDENTITE : PERMISSIF OU STRICT (E)
--
--    `strict = false`  -> un appel SANS jeton retombe sur le GUC `tracefab.user_id`
--                         (comportement historique : forgeable).
--    `strict = true`   -> sans jeton, pas d'identite.
--
--    Tant que ce booleen vaut false, le residu R-A1 reste OUVERT, meme si le
--    mecanisme HMAC est en place. C'est le point a lire avant toute annonce.
-- ============================================================================
SELECT CASE WHEN to_regclass('public.tracefab_identity_politique') IS NULL
            THEN 'ABSENTE'
            ELSE (SELECT CASE WHEN p.strict THEN 'strict' ELSE 'permissif' END
                    FROM public.tracefab_identity_politique p LIMIT 1)
       END AS mode_identite;


-- ============================================================================
-- 13. CE QUE LE RUNTIME PEUT FAIRE DE LA PRIMITIVE DE SIGNATURE (E)
-- ============================================================================
SELECT p.oid::pg_catalog.regprocedure::text                                 AS fonction,
       pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE') AS app_peut_executer,
       pg_catalog.pg_get_userbyid(p.proowner)                               AS proprietaire
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'pg_catalog')
   AND p.proname IN ('hmac', 'digest', 'crypt', 'gen_random_bytes')
 ORDER BY 1;


-- ============================================================================
-- 14. POINT DE CONTROLE : LE RUNTIME DOIT POUVOIR TRAVAILLER
--
--    Une base parfaitement verrouillee qui ne sert plus rien n'est pas un
--    succes. Ces deux mesures disent si l'allowlist est reellement ouverte.
-- ============================================================================
SELECT count(DISTINCT p.proname) AS fonctions_executables_par_app
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE');

SELECT count(*) AS politiques_rls_publiques
  FROM pg_catalog.pg_policy pol
  JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public';
