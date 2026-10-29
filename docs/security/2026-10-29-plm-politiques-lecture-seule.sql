-- TRACEFAB — releve des politiques de `plm_erp_sync_jobs`, STRICTEMENT en lecture.
--
-- A executer par l'operateur, sur `Primary`, dans une transaction en lecture
-- seule. Aucun DDL, aucun DML : uniquement des SELECT.
--
-- POURQUOI CE RELEVE EXISTE
--   Les lectures du 28/10 ont conserve les NOMS des quatre politiques, pas leurs
--   DEFINITIONS. Or la gravite du constat en depend :
--     - si `plm_erp_sync_jobs_select_brand` est un doublon du predicat canonique,
--       elle n'elargit RIEN et retirer la seule insertion suffit ;
--     - si son predicat est plus large (`true`, ou `USING` sans predicat de
--       tenant), elle ouvre la lecture inter-organisations, et retirer une seule
--       politique ne suffit pas.
--   Le commentaire de la migration `20261028150000` affirme le premier cas.
--   Ce script le VERIFIE au lieu de le supposer.
--
-- CE QU'IL NE FAIT PAS : il ne modifie rien, ne supprime rien, ne cree rien.

BEGIN READ ONLY;

-- Q0. Garde : la transaction est-elle VRAIMENT en lecture seule ?
SELECT 'Q0' AS q, current_setting('transaction_read_only') AS lecture_seule,
       current_user AS role_courant, current_database() AS base;
-- attendu : lecture_seule = on

-- Q1. Les quatre politiques, en entier — nom, commande, permissive, roles,
--     predicat USING, predicat WITH CHECK.
SELECT 'Q1' AS q,
       pol.polname                                            AS politique,
       CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                       WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                       WHEN '*' THEN 'ALL' ELSE pol.polcmd::text END  AS commande,
       pol.polpermissive                                      AS permissive,
       COALESCE((SELECT string_agg(
                   CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r) END, ', ')
                 FROM unnest(pol.polroles) AS r), '(aucun)')      AS roles,
       regexp_replace(COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
                               '(aucun)'), '\s+', ' ', 'g')       AS using_expr,
       regexp_replace(COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid),
                               '(aucun)'), '\s+', ' ', 'g')       AS with_check_expr
  FROM pg_catalog.pg_policy pol
 WHERE pol.polrelid = to_regclass('public.plm_erp_sync_jobs')
 ORDER BY pol.polname;

-- Q2. Le tableau de confrontation, calcule : chaque politique est-elle dans le
--     referentiel du depot, et son predicat porte-t-il un predicat de tenant ?
SELECT 'Q2' AS q,
       pol.polname AS politique,
       CASE
         WHEN pol.polname IN ('plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org')
           THEN 'CANONIQUE (creee par 20261006210000)'
         WHEN pol.polname IN ('plm_erp_sync_jobs_insert_brand', 'plm_erp_sync_jobs_select_brand')
           THEN 'SURNUMERAIRE (aucune migration du depot ne la cree)'
         ELSE 'INATTENDUE — a qualifier par le chef de chantier'
       END AS provenance,
       CASE
         WHEN regexp_replace(COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
                             COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
                             '\s+', ' ', 'g')
              ~ 'tracefab_is_org_member|tracefab_has_org_role'
           THEN 'predicat de tenant present'
           ELSE 'AUCUN predicat de tenant — elargit au-dela de l organisation'
       END AS portee,
       CASE
         WHEN pol.polname = 'plm_erp_sync_jobs_insert_brand'
              AND pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) ILIKE '%contributor%'
           THEN 'ELARGIT : contributor peut inserer (la canonique l interdit)'
         WHEN pol.polname = 'plm_erp_sync_jobs_select_brand'
              AND pg_catalog.pg_get_expr(pol.polqual, pol.polrelid)
                    IS DISTINCT FROM '(tracefab_is_org_member(brand_organization_id))'
           THEN 'ELARGIT ou differe : predicat different du doublon annonce'
         WHEN pol.polname LIKE 'plm_erp_sync_jobs%'
           THEN 'benin : doublon du predicat canonique, aucune portee ajoutee'
         ELSE '—'
       END AS effet
  FROM pg_catalog.pg_policy pol
 WHERE pol.polrelid = to_regclass('public.plm_erp_sync_jobs')
 ORDER BY 3, 2;

-- Q3. Le compte, et l'ecart au referentiel.
SELECT 'Q3' AS q,
       count(*) AS politiques_totales,
       count(*) FILTER (WHERE polname LIKE 'plm_erp_sync_jobs%') AS surnumeraires,
       count(*) FILTER (WHERE polname LIKE 'plm_sync_jobs%')    AS canoniques,
       CASE WHEN count(*) = 2 THEN 'conforme au referentiel'
            ELSE 'ECART : ' || count(*) || ' politiques au lieu de 2' END AS verdict
  FROM pg_catalog.pg_policy
 WHERE polrelid = to_regclass('public.plm_erp_sync_jobs');

-- Q4. Ce que la migration corrective exigera : table presente, RLS forcee,
--     et la canonique INSERT sans `contributor`. Si une de ces lignes dit
--     « NON », la migration REFUSERA — et c'est le comportement voulu.
SELECT 'Q4' AS q,
       (SELECT to_regclass('public.plm_erp_sync_jobs') IS NOT NULL)          AS table_presente,
       (SELECT relrowsecurity      FROM pg_catalog.pg_class
         WHERE oid = to_regclass('public.plm_erp_sync_jobs'))                 AS rls_activee,
       (SELECT relforcerowsecurity FROM pg_catalog.pg_class
         WHERE oid = to_regclass('public.plm_erp_sync_jobs'))                 AS rls_forcee,
       (SELECT pg_catalog.pg_get_expr(polwithcheck, polrelid) ILIKE '%contributor%'
          FROM pg_catalog.pg_policy
         WHERE polrelid = to_regclass('public.plm_erp_sync_jobs')
           AND polname = 'plm_sync_jobs_insert_brand' AND polcmd = 'a')       AS canonique_admet_contributor;

-- Q5. Les privileges effectifs du role applicatif — pour distinguer « la RLS
--     refuse » de « le privilege manque ». Les deux se ressemblent a l'usage.
SELECT 'Q5' AS q, p AS privilege,
       pg_catalog.has_table_privilege('tracefab_app', 'public.plm_erp_sync_jobs', p) AS accorde_a_tracefab_app,
       pg_catalog.has_table_privilege('public',       'public.plm_erp_sync_jobs', p) AS accorde_a_public
  FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
 -- Garde : sans la table, `has_table_privilege` leverait au milieu du script et
 -- l'operateur ne verrait plus rien. Filtre en amont, donc aucune evaluation.
 WHERE to_regclass('public.plm_erp_sync_jobs') IS NOT NULL;

COMMIT;
