-- TRACEFAB — P10.7/P11 — préflight du registre des fonctions Runtime.
-- Lecture seule, PostgreSQL, aucun DDL et aucune écriture dans _prisma_migrations.
-- Exécuté sur Neon Production le 11/11/2026 avant toute migration.
--
-- Cette sonde reproduit les préconditions du contrôle 3.a/3.b/3.c de
-- 20261028120000_runtime_function_registry, sans créer le registre :
--   1. les 84 fonctions inscrites existent une seule fois dans public ;
--   2. elles appartiennent au rôle courant (ou au worker s'il existe) ;
--   3. aucune fonction appelée par une politique RLS n'est hors registre ;
--   4. aucune fonction SECURITY DEFINER du propriétaire courant n'est
--      exécutable par PUBLIC.
--
-- Résultat mesuré le 11/11/2026 sur la branche Neon Production :
-- executor=neondb_owner, expected=84, missing=0, overloaded=0,
-- wrong_owner=0, unregistered_policy_functions=0,
-- security_definer_public_executor=0.
--
-- IMPORTANT : cette sonde valide les préconditions catalogues du registre.
-- Elle ne remplace pas la rehearsal complète de migrate deploy, et ne prouve
-- pas encore le chargement du secret HMAC par le Runtime Production.

WITH expected(name) AS (
VALUES
  ('tracefab_accept_organization_invitation'),
  ('tracefab_acknowledge_quality_issue'),
  ('tracefab_active_organization_id'),
  ('tracefab_add_data_request_item'),
  ('tracefab_add_dpp_claim'),
  ('tracefab_add_dpp_event'),
  ('tracefab_add_product_identifier'),
  ('tracefab_add_product_material'),
  ('tracefab_add_supply_chain_link'),
  ('tracefab_allocate_tc_quantity'),
  ('tracefab_apply_document_ai_verification'),
  ('tracefab_audit_product_green_claims'),
  ('tracefab_bind_schema'),
  ('tracefab_calculate_product_pef'),
  ('tracefab_can_access_document'),
  ('tracefab_can_access_org'),
  ('tracefab_can_access_shared_subject'),
  ('tracefab_claim_notification_outbox'),
  ('tracefab_complete_notification_outbox'),
  ('tracefab_compute_dpp_readiness'),
  ('tracefab_compute_product_quality'),
  ('tracefab_compute_supplier_quality'),
  ('tracefab_create_data_request'),
  ('tracefab_create_dpp_identity'),
  ('tracefab_create_material'),
  ('tracefab_create_organization'),
  ('tracefab_create_product'),
  ('tracefab_create_quality_cap'),
  ('tracefab_create_supply_chain_node'),
  ('tracefab_current_user_email'),
  ('tracefab_current_user_id'),
  ('tracefab_delete_supply_chain_link'),
  ('tracefab_delete_supply_chain_node'),
  ('tracefab_enqueue_due_data_request_reminders'),
  ('tracefab_enqueue_manual_data_request_reminder'),
  ('tracefab_finalize_document_upload'),
  ('tracefab_get_or_create_supplier_passport'),
  ('tracefab_get_product_traceability'),
  ('tracefab_get_public_supplier_passport'),
  ('tracefab_has_org_role'),
  ('tracefab_in_active_tenant'),
  ('tracefab_ingest_plm_erp_payload'),
  ('tracefab_invite_supplier'),
  ('tracefab_is_org_member'),
  ('tracefab_link_dpp_claim_evidence'),
  ('tracefab_mark_dpp_ready_to_publish'),
  ('tracefab_material_is_public'),
  ('tracefab_material_visible_via_product'),
  ('tracefab_product_is_public'),
  ('tracefab_public_brand'),
  ('tracefab_public_context'),
  ('tracefab_public_dpp_claims'),
  ('tracefab_reconcile_mass_balance'),
  ('tracefab_require_active_tenant'),
  ('tracefab_register_certification'),
  ('tracefab_register_document'),
  ('tracefab_register_supplier_organization'),
  ('tracefab_register_transaction_certificate'),
  ('tracefab_replace_dpp_identity'),
  ('tracefab_request_passport_access'),
  ('tracefab_review_data_response'),
  ('tracefab_review_passport_access'),
  ('tracefab_review_quality_remediation'),
  ('tracefab_revoke_clerk_membership'),
  ('tracefab_send_data_request'),
  ('tracefab_set_dpp_publication'),
  ('tracefab_start_product_revision'),
  ('tracefab_submit_data_request'),
  ('tracefab_submit_data_response'),
  ('tracefab_submit_quality_remediation'),
  ('tracefab_submit_supplier_profile'),
  ('tracefab_supplier_site_is_public'),
  ('tracefab_sync_clerk_membership'),
  ('tracefab_sync_clerk_organization'),
  ('tracefab_update_certification'),
  ('tracefab_update_material'),
  ('tracefab_update_product_data'),
  ('tracefab_update_product_identifier'),
  ('tracefab_update_product_material'),
  ('tracefab_update_supplier_passport'),
  ('tracefab_update_supplier_profile'),
  ('tracefab_update_supply_chain_link'),
  ('tracefab_update_supply_chain_node'),
  ('tracefab_waive_quality_issue')
),
fm AS (
  SELECT e.name,
         count(p.oid) FILTER (WHERE n.nspname = 'public' AND p.prokind = 'f')::int AS overloads,
         string_agg(DISTINCT pg_catalog.pg_get_userbyid(p.proowner), ','
           ORDER BY pg_catalog.pg_get_userbyid(p.proowner))
           FILTER (WHERE n.nspname = 'public' AND p.prokind = 'f') AS owners
    FROM expected e
    LEFT JOIN pg_catalog.pg_proc p ON p.proname = e.name AND p.prokind = 'f'
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   GROUP BY e.name
),
policy_bodies AS (
  SELECT coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
         coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS body
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.oid <> coalesce(to_regclass('public.tracefab_runtime_function_registry')::oid, 0)
),
policy_functions AS (
  SELECT DISTINCT (m.matches)[1] AS name
    FROM policy_bodies b
    CROSS JOIN LATERAL pg_catalog.regexp_matches(
      b.body, '(tracefab_[a-z0-9_]+)[[:space:]]*\(', 'g'
    ) AS m(matches)
)
SELECT current_user AS migration_executor,
       (SELECT count(*) FROM expected) AS registered_expected,
       (SELECT count(*) FROM fm WHERE overloads = 0) AS missing_functions,
       (SELECT string_agg(name, ',' ORDER BY name) FROM fm WHERE overloads = 0) AS missing_names,
       (SELECT count(*) FROM fm WHERE overloads > 1) AS overloaded_names,
       (SELECT string_agg(name, ',' ORDER BY name) FROM fm WHERE overloads > 1) AS overloaded_list,
       (SELECT count(*) FROM fm
         WHERE overloads = 1 AND owners NOT IN (current_user, 'tracefab_worker')) AS wrong_owner_count,
       (SELECT string_agg(name || '=' || coalesce(owners, '?'), ',' ORDER BY name)
          FROM fm WHERE overloads = 1 AND owners NOT IN (current_user, 'tracefab_worker')) AS wrong_owners,
       (SELECT count(*) FROM policy_functions pf
         WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.name = pf.name)) AS unregistered_policy_functions,
       (SELECT string_agg(pf.name, ',' ORDER BY pf.name) FROM policy_functions pf
         WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.name = pf.name)) AS unregistered_policy_names,
       (SELECT count(*)
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prokind = 'f'
           AND p.prosecdef
           AND pg_catalog.pg_get_userbyid(p.proowner) = current_user
           AND EXISTS (
             SELECT 1
               FROM pg_catalog.aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           )) AS security_definer_public_executor_count;
