-- TRACEFAB — confrontation du catalogue de production, LECTURE SEULE.
--
-- Aucune ecriture. Aucun appel de fonction applicative. Aucun `SELECT` sur une
-- table metier : uniquement le catalogue systeme. Le script peut donc tourner
-- avec un role en lecture seule, et ne laisse aucune trace.
--
--   psql "$DIRECT_URL" -A -t -v ON_ERROR_STOP=1 \
--        -f docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql \
--        > /tmp/etat-production.txt
--
-- La sortie est faite pour etre confrontee AUTOMATIQUEMENT au referentiel du
-- depot, pas relue a l'oeil :
--
--   node scripts/verifier_confrontation_production.mjs /tmp/etat-production.txt
--
-- 85 faits : 14 tables, 31 politiques, 14 fonctions, 7 lignes d'historique,
-- et 19 faits de roles/priviliges : 2 lignes d'attributs, 14 lignes de droits
-- par table, 2 tables hors cible, 1 ligne de schema. Les APPARTENANCES n'y
-- figurent pas en reference — le depot n'en pose aucune sur le role runtime —
-- mais la requete les lit desormais dans les DEUX sens : toute arete observee
-- chez l'operateur sortira donc en divergence, a qualifier.
--
-- Les 66 d'origine n'en comptaient que 15 : une appartenance lue dans un seul
-- sens, sans ses options. Le decompte a change parce que la lecture a change —
-- voir le commentaire de la section 5.
-- Une sortie partielle (par exemple la seule perimetre PLM) se compare avec
-- `--perimetre-plm`, qui restreint le PERIMETRE compare sans relacher aucun
-- controle sur ce qui a ete lu.
--
-- Format : une ligne par fait, champs separes par `|`, sans en-tete.
--   T|table|existe|rls|force|politiques|proprietaire   etat RLS de chaque table
--   P|table.politique|roles|cmd|using|check   toutes les politiques des tables
--   F|fonction|secdef|search_path|exec|proprietaire    fonctions des cinq
--   H|migration|present|steps|termine         historique Prisma, en lecture (7 lignes)
--   G|...                                     privileges et heritage des droits

WITH cibles(nom) AS (
  VALUES
    ('plm_erp_integrations'), ('plm_erp_sync_jobs'),
    ('pef_emission_factors'), ('product_pef_assessments'),
    ('green_claims_rules'), ('product_green_claims'), ('green_claims_audits'),
    ('quality_corrective_action_plans'), ('quality_cap_messages'),
    ('supplier_universal_passports'), ('supplier_passport_access_requests'),
    ('transaction_certificates'), ('mass_balance_allocations'),
    ('mass_balance_reconciliations')
),
fonctions(nom) AS (
  VALUES
    ('tracefab_ingest_plm_erp_payload'),
    ('tracefab_calculate_product_pef'),
    ('tracefab_audit_product_green_claims'),
    ('tracefab_create_quality_cap'),
    ('tracefab_review_quality_remediation'),
    ('tracefab_submit_quality_remediation'),
    ('tracefab_get_or_create_supplier_passport'),
    ('tracefab_get_public_supplier_passport'),
    ('tracefab_request_passport_access'),
    ('tracefab_review_passport_access'),
    ('tracefab_update_supplier_passport'),
    ('tracefab_register_transaction_certificate'),
    ('tracefab_allocate_tc_quantity'),
    ('tracefab_reconcile_mass_balance')
),
migrations(nom) AS (
  VALUES
    ('20261006220000_esg_pef_footprint_engine'),
    ('20261006230000_green_claims_anti_greenwashing_engine'),
    ('20261006240000_quality_corrective_action_plans_cap'),
    ('20261006250000_universal_supplier_passport'),
    ('20261006260000_mass_balance_anti_fraud_engine'),
    ('20261028140000_supplier_invitation_owner_relationship_scope'),
    ('20261028150000_plm_erp_policy_convergence')
)
SELECT ligne FROM (
  -- 1. Etat RLS des quatorze tables.
  SELECT 1 AS ordre, c.nom AS tri,
         'T|' || c.nom
         || '|existe=' || CASE WHEN cl.oid IS NULL THEN '0' ELSE '1' END
         || '|rls=' || coalesce(cl.relrowsecurity::text, '-')
         || '|force=' || coalesce(cl.relforcerowsecurity::text, '-')
         || '|politiques=' || coalesce((
              SELECT count(*)::text FROM pg_catalog.pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.nom), '0')
         || '|proprietaire=' || coalesce(pg_catalog.pg_get_userbyid(cl.relowner), '-')
         AS ligne
    FROM cibles c
    LEFT JOIN pg_catalog.pg_class cl
           ON cl.relname = c.nom AND cl.relnamespace = 'public'::regnamespace

  UNION ALL
  -- 2. TOUTES les politiques des quatorze tables, en entier.
  --
  -- Ne comparer que le NOMBRE de politiques ne dit rien des regles : une
  -- politique peut etre reecrite a nombre constant. Le 28/10, le compteur a
  -- signale la derive PLM, mais il ne l'aurait pas fait si la production avait
  -- remplace une politique par une autre du meme nom. Les regles sont donc
  -- lues une par une.
  SELECT 2, tablename || '.' || policyname,
         'P|' || tablename || '.' || policyname
         || '|roles=' || array_to_string(roles, ',')
         || '|cmd=' || cmd
         || '|permissive=' || permissive
         || '|using=' || regexp_replace(coalesce(qual, '(aucun)'), '\s+', ' ', 'g')
         || '|check=' || regexp_replace(coalesce(with_check, '(aucun)'), '\s+', ' ', 'g')
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND tablename IN (SELECT nom FROM cibles)

  UNION ALL
  -- 3. Les fonctions : DEFINER, search_path, EXECUTE effectif.
  SELECT 3, p.proname,
         'F|' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
         || '|secdef=' || p.prosecdef::text
         || '|search_path=' || coalesce(array_to_string(p.proconfig, ','), '(aucun)')
         || '|exec_public=' || pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')::text
         || '|exec_app=' || pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')::text
         || '|proprietaire=' || pg_catalog.pg_get_userbyid(p.proowner)
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN (SELECT nom FROM fonctions)

  UNION ALL
  -- 4. PRIVILEGES ET HERITAGE DES DROITS.
  --
  -- Ce que la confrontation du 28/10 ne mesurait PAS, et qui manquait au
  -- mandat : les attributs du role runtime, ses appartenances, et les
  -- privileges de TABLE reels sur les quatorze cibles.
  --
  -- Pourquoi c'est necessaire, et pas decoratif :
  --   - 20261028120100 cree `tracefab_worker` et REVOQUE son appartenance a
  --     `tracefab_app` : si cette appartenance subsiste, le role runtime peut
  --     redevenir le worker (usurpation) ;
  --   - 20261028120200 retire INSERT/UPDATE/DELETE sur `documents` ;
  --   - 20261028130000 retire l'ecriture au niveau TABLE sur
  --     `tracefab_products` et accorde colonne par colonne ;
  --   - `rolbypassrls` sur le role runtime annulerait TOUTE la RLS lue par
  --     ailleurs : c'est le controle le plus important de cette section.
  --
  -- Les privileges sont rendus en liste triee et codee, pour que deux
  -- ensembles identiques se comparent a l'identique.
  SELECT 4, 'attributs.' || r.rolname,
         'G|attributs|' || r.rolname
         || '|super=' || r.rolsuper::text
         || '|bypassrls=' || r.rolbypassrls::text
         || '|inherit=' || r.rolinherit::text
         || '|createrole=' || r.rolcreaterole::text
         || '|createdb=' || r.rolcreatedb::text
         || '|login=' || r.rolcanlogin::text
    FROM pg_catalog.pg_roles r
    -- `neondb_owner` est l'infrastructure de la base, pas un objet du depot :
    -- ses attributs ne sont pas predictibles depuis la chaine, et le comparer
    -- fabriquerait une divergence qui n'en est pas une. Son PROPRIETAIRE sur
    -- les objets est deja mesure par les lignes `T` et `F`.
   WHERE r.rolname IN ('tracefab_app', 'tracefab_worker')

  UNION ALL
  -- ANOMALIE CORRIGEE ICI, et elle etait de taille.
  --
  -- La version precedente ecrivait :
  --     '|herite=' || CASE WHEN r.rolinherit THEN 'oui' ELSE 'non' END
  -- ou `r` est le role ACCORDE. Elle lisait donc l'attribut INHERIT du role
  -- accorde, et non l'option d'heritage DE L'APPARTENANCE. Les deux different :
  --     GRANT neondb_owner TO tracefab_app WITH INHERIT FALSE;
  -- laisse `neondb_owner.rolinherit = true` (il n'a pas change) et pose
  -- `am.inherit_option = false`. La ligne affichait « herite=oui » alors que
  -- l'heritage etait coupe — et l'inverse est possible aussi.
  --
  -- Les options se lisent sur la ligne d'appartenance : `admin_option`,
  -- `inherit_option`, `set_option` (PostgreSQL 16+). Pour rester lisible sur
  -- une version anterieure, on les extrait par `to_jsonb`, qui rend NULL au
  -- lieu d'echouer sur une colonne absente : la sortie dit alors `n/a`, ce qui
  -- est un etat a qualifier, jamais un « identique ».
  --
  -- Pourquoi `set_option` compte autant qu'`inherit_option` : mesure sur base
  -- jetable (scripts/test_appartenances_roles.mjs), les ATTRIBUTS de role ne
  -- s'heritent pas. L'appartenance seule ne donne donc pas BYPASSRLS — mais
  -- elle autorise `SET ROLE neondb_owner`, qui le donne. Une appartenance
  -- dangereuse peut donc afficher `herite=false` et rester une evasion.
  SELECT 5, 'membre.' || r.rolname || '.' || m.rolname,
         'G|membre|' || m.rolname || '|dans|' || r.rolname
         || '|admin=' || am.admin_option::text
         || '|herite=' || coalesce(to_jsonb(am)->>'inherit_option', 'n/a')
         || '|setrole=' || coalesce(to_jsonb(am)->>'set_option', 'n/a')
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE m.rolname IN ('tracefab_app', 'tracefab_worker')

  UNION ALL
  -- Le sens INVERSE. Le role runtime n'y est pas le membre, donc l'ancienne
  -- lecture ne le voyait pas du tout : `neondb_owner` membre de `tracefab_app`
  -- etait invisible, alors que c'est le temoin d'un fournisseur integre au
  -- role applicatif. Sur le plan des droits, ce sens est benin (le
  -- proprietaire a deja tout) ; sur le plan de la gouvernance, il dit qu'une
  -- appartenance a ete posee dans le mauvais sens — et c'est exactement le
  -- genre d'objet qu'on ne veut pas decouvrir apres coup.
  --
  -- Il est lu, donc il sera compare : toute arete de ce sens apparaitra en
  -- divergence face au referentiel du depot, qui n'en contient aucune. C'est
  -- voulu. Une divergence a qualifier vaut mieux qu'un angle mort.
  SELECT 5, 'membre-inverse.' || r.rolname || '.' || m.rolname,
         'G|membre|' || m.rolname || '|dans|' || r.rolname
         || '|admin=' || am.admin_option::text
         || '|herite=' || coalesce(to_jsonb(am)->>'inherit_option', 'n/a')
         || '|setrole=' || coalesce(to_jsonb(am)->>'set_option', 'n/a')
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE r.rolname IN ('tracefab_app', 'tracefab_worker')
     AND m.rolname NOT IN ('tracefab_app', 'tracefab_worker')

  UNION ALL
  SELECT 6, 'table.' || c.nom,
         'G|table|' || c.nom
         || '|app=' || coalesce(array_to_string(ARRAY(
              SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
               WHERE pg_catalog.has_table_privilege('tracefab_app', cl.oid, p)), ','), '(aucun)')
         || '|public=' || coalesce(array_to_string(ARRAY(
              SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
               WHERE pg_catalog.has_table_privilege('public', cl.oid, p)), ','), '(aucun)')
    FROM cibles c
    LEFT JOIN pg_catalog.pg_class cl
           ON cl.relname = c.nom AND cl.relnamespace = 'public'::regnamespace
   WHERE cl.oid IS NOT NULL

  UNION ALL
  -- Deux tables HORS des quatorze cibles, mais que deux des onze migrations
  -- en ecart depouillent explicitement :
  --   20261028120200 retire INSERT/UPDATE/DELETE a `tracefab_app` sur `documents` ;
  --   20261028130000 retire l'ecriture au niveau table sur `tracefab_products`.
  -- Sans ces deux lignes, l'effet le plus sensible de ces migrations resterait
  -- invisible a la confrontation.
  SELECT 6, 'hors-cible.' || h.nom,
         'G|hors-cible|' || h.nom
         || '|app=' || coalesce(array_to_string(ARRAY(
              SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
               WHERE pg_catalog.has_table_privilege('tracefab_app', h.nom, p)), ','), '(aucun)')
         || '|public=' || coalesce(array_to_string(ARRAY(
              SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
               WHERE pg_catalog.has_table_privilege('public', h.nom, p)), ','), '(aucun)')
    FROM (VALUES ('documents'), ('tracefab_products')) AS h(nom)
   WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_class cl
                  WHERE cl.relname = h.nom AND cl.relnamespace = 'public'::regnamespace)

  UNION ALL
  SELECT 7, 'schema.public',
         'G|schema|public'
         || '|app=' || array_to_string(ARRAY(
              SELECT p FROM unnest(ARRAY['USAGE','CREATE']) p
               WHERE pg_catalog.has_schema_privilege('tracefab_app', 'public', p)), ',')
         || '|public=' || array_to_string(ARRAY(
              SELECT p FROM unnest(ARRAY['USAGE','CREATE']) p
               WHERE pg_catalog.has_schema_privilege('public', 'public', p)), ',')

  UNION ALL
  -- 5. Historique Prisma : les cinq hors bande, et la corrective (absente
  --    aujourd'hui — c'est precisement ce que l'application changera).
  SELECT 8, m2.nom,
         'H|' || m2.nom
         || '|present=' || CASE WHEN m.migration_name IS NULL THEN '0' ELSE '1' END
         || '|steps=' || coalesce(m.applied_steps_count::text, '-')
         || '|termine=' || coalesce((m.finished_at IS NOT NULL)::text, '-')
    FROM migrations m2
    LEFT JOIN _prisma_migrations m ON m.migration_name = m2.nom
) x
ORDER BY ordre, tri, ligne;
