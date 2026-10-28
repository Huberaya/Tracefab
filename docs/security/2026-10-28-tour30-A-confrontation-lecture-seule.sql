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
-- 66 faits : 14 tables, 31 politiques, 14 fonctions, 7 lignes d'historique.
-- Une sortie partielle (par exemple la seule perimetre PLM) se compare avec
-- `--perimetre-plm`, qui restreint le PERIMETRE compare sans relacher aucun
-- controle sur ce qui a ete lu.
--
-- Format : une ligne par fait, champs separes par `|`, sans en-tete.
--   T|table|existe|rls|force|politiques|proprietaire   etat RLS de chaque table
--   P|table.politique|roles|cmd|using|check   toutes les politiques des tables
--   F|fonction|secdef|search_path|exec|proprietaire    fonctions des cinq
--   H|migration|present|steps|termine         historique Prisma, en lecture (7 lignes)

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
  -- 4. Historique Prisma : les cinq hors bande, et la corrective (absente
  --    aujourd'hui — c'est precisement ce que l'application changera).
  SELECT 4, m2.nom,
         'H|' || m2.nom
         || '|present=' || CASE WHEN m.migration_name IS NULL THEN '0' ELSE '1' END
         || '|steps=' || coalesce(m.applied_steps_count::text, '-')
         || '|termine=' || coalesce((m.finished_at IS NOT NULL)::text, '-')
    FROM migrations m2
    LEFT JOIN _prisma_migrations m ON m.migration_name = m2.nom
) x
ORDER BY ordre, tri, ligne;
