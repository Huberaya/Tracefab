-- TraceFab — fermeture des politiques RLS résiduelles et des fonctions documentaires.
--
-- Cette migration complète les 16 politiques explicitement tenant-scopees dans
-- 72–76. Elle applique le même invariant à toutes les autres politiques qui
-- reposent sur une appartenance ou un rôle organisationnel, sans toucher aux
-- exceptions account-wide, publiques, de référence ou worker.
--
-- Les opérations de notification globales sont déplacées sous tracefab_worker,
-- non connectable et sans BYPASSRLS. Les opérations documentaires utilisateur
-- exigent le tenant actif et un rôle d'écriture.
--
-- Aucun accès public ni partage fournisseur -> marque n'est supprimé :
-- tracefab_can_access_shared_subject exige désormais que le tenant actif soit
-- précisément l'organisation grantee du partage.

BEGIN;

-- 1. Le worker ne reçoit que les droits nécessaires aux trois opérations
--    globales de notification (lecture des demandes, claim/complete outbox).
GRANT SELECT ON TABLE public.data_requests TO tracefab_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tracefab_notification_outbox TO tracefab_worker;
GRANT USAGE ON TYPE public.tracefab_notification_status TO tracefab_worker;
GRANT USAGE ON TYPE public.tracefab_notification_event TO tracefab_worker;

-- 2. Ces fonctions étaient possédées par neondb_owner (BYPASSRLS). Les faire
--    exécuter sous tracefab_worker active les politiques worker de la table
--    outbox et de data_requests. L'ACL runtime tracefab_app est conservée.
DO $worker_notification_functions$
DECLARE
  v_target record;
  v_oid oid;
  v_acl aclitem[];
  v_owner oid;
  v_after_owner oid;
  v_after_acl aclitem[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
    RAISE EXCEPTION 'tracefab_worker_role_missing';
  END IF;

  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_must_not_be_worker_member';
  END IF;

  FOR v_target IN
    SELECT * FROM (VALUES
      ('tracefab_claim_notification_outbox', 'public.tracefab_claim_notification_outbox(integer)'),
      ('tracefab_complete_notification_outbox', 'public.tracefab_complete_notification_outbox(uuid, public.tracefab_notification_status, text, text, timestamptz)'),
      ('tracefab_enqueue_due_data_request_reminders', 'public.tracefab_enqueue_due_data_request_reminders(integer)')
    ) AS t(function_name, signature)
  LOOP
    SELECT p.oid, p.proowner, p.proacl
      INTO v_oid, v_owner, v_acl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_target.function_name
       AND p.prosecdef;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'worker_notification_function_missing_or_not_definer: %',
        v_target.function_name;
    END IF;

    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO tracefab_worker',
      v_target.signature::regprocedure
    );

    SELECT p.proowner, p.proacl
      INTO v_after_owner, v_after_acl
      FROM pg_catalog.pg_proc p
     WHERE p.oid = v_oid;

    IF v_after_owner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
      RAISE EXCEPTION 'worker_notification_function_owner_not_transferred: %',
        v_target.function_name;
    END IF;

    IF pg_catalog.has_function_privilege('tracefab_app', v_oid, 'EXECUTE') IS NOT TRUE THEN
      RAISE EXCEPTION 'worker_notification_function_not_runtime_executable: %',
        v_target.function_name;
    END IF;

    IF pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE') IS TRUE THEN
      RAISE EXCEPTION 'worker_notification_function_executable_by_public: %',
        v_target.function_name;
    END IF;

    -- ALTER OWNER peut réécrire l'entrée du propriétaire ; le droit runtime
    -- reste explicitement vérifié ci-dessus et PUBLIC reste fermé.
    IF v_after_acl IS NULL THEN
      RAISE EXCEPTION 'worker_notification_function_acl_missing: %',
        v_target.function_name;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.data_requests', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.tracefab_notification_outbox', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.tracefab_notification_outbox', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.tracefab_notification_outbox', 'UPDATE') THEN
    RAISE EXCEPTION 'worker_notification_table_privileges_incomplete';
  END IF;

  IF pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_notification_outbox', 'INSERT')
     OR pg_catalog.has_table_privilege('tracefab_app', 'public.tracefab_notification_outbox', 'UPDATE') THEN
    RAISE EXCEPTION 'runtime_app_must_not_write_notification_outbox_directly';
  END IF;
END
$worker_notification_functions$;

-- 3. Le partage documentaire n'est accessible que depuis le tenant grantee
--    actuellement armé. L'appartenance à une autre organisation du même
--    utilisateur ne suffit plus.
DO $shared_subject_guard$
DECLARE
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_oid oid;
  v_after_owner oid;
  v_after_acl aclitem[];
BEGIN
  SELECT p.oid, p.proowner, p.proacl
    INTO v_oid, v_owner, v_acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_can_access_shared_subject'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
       'p_supplier_organization_id uuid, p_subject_type text, p_subject_id uuid';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'tracefab_can_access_shared_subject_missing';
  END IF;

  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.tracefab_can_access_shared_subject(
      p_supplier_organization_id uuid,
      p_subject_type text,
      p_subject_id uuid
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT EXISTS (
        SELECT 1
          FROM public.data_shares s
          JOIN public.organization_memberships m
            ON m.organization_id = s.grantee_organization_id
           AND m.user_id = public.tracefab_current_user_id()
           AND m.status = 'active'
         WHERE s.supplier_organization_id = p_supplier_organization_id
           AND s.grantee_organization_id = public.tracefab_active_organization_id()
           AND s.status = 'active'
           AND (s.starts_at IS NULL OR s.starts_at <= now())
           AND (s.ends_at IS NULL OR s.ends_at >= now())
           AND (
             COALESCE((s.scope ->> 'all')::boolean, false)
             OR COALESCE(s.scope -> 'subject_types', '[]'::jsonb) ? p_subject_type
             OR COALESCE(s.scope -> 'subject_ids', '[]'::jsonb) ? p_subject_id::text
           )
      );
    $function$;
  $ddl$;

  SELECT p.oid, p.proowner, p.proacl
    INTO v_after_oid, v_after_owner, v_after_acl
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid;

  IF v_after_oid IS DISTINCT FROM v_oid
     OR v_after_owner IS DISTINCT FROM v_owner
     OR v_after_acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'shared_subject_guard_changed_oid_owner_or_acl';
  END IF;
END
$shared_subject_guard$;

-- 4. La lecture documentaire est limitée au tenant actif : propriétaire,
--    destinataire d'un partage, participant d'une demande, ou marque reliée à
--    la certification / au point de données. Les documents partagés doivent
--    rester disponibles aux marques autorisées.
DO $document_access_guard$
DECLARE
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_oid oid;
  v_after_owner oid;
  v_after_acl aclitem[];
BEGIN
  SELECT p.oid, p.proowner, p.proacl
    INTO v_oid, v_owner, v_acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_can_access_document'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_document_id uuid';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'tracefab_can_access_document_missing';
  END IF;

  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.tracefab_can_access_document(p_document_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      WITH active AS (
        SELECT public.tracefab_active_organization_id() AS organization_id
      )
      SELECT EXISTS (
        SELECT 1
          FROM public.documents d
          CROSS JOIN active a
         WHERE d.id = p_document_id
           AND d.status = 'available'
           AND a.organization_id IS NOT NULL
           AND public.tracefab_is_org_member(a.organization_id)
           AND (
             (
               d.owner_organization_id = a.organization_id
               AND public.tracefab_can_access_org(d.owner_organization_id)
             )
             OR public.tracefab_can_access_shared_subject(
               d.owner_organization_id, 'document', d.id
             )
             OR EXISTS (
               SELECT 1
                 FROM public.data_responses dr
                 JOIN public.data_request_items dri ON dri.id = dr.data_request_item_id
                 JOIN public.data_requests req ON req.id = dri.data_request_id
                WHERE dr.source_document_id = d.id
                  AND (
                    req.brand_organization_id = a.organization_id
                    OR req.supplier_organization_id = a.organization_id
                  )
             )
             OR EXISTS (
               SELECT 1
                 FROM public.certifications c
                WHERE c.document_id = d.id
                  AND (
                    c.owner_organization_id = a.organization_id
                    OR EXISTS (
                      SELECT 1
                        FROM public.tracefab_products p
                       WHERE p.id = c.product_id
                         AND p.brand_organization_id = a.organization_id
                    )
                    OR EXISTS (
                      SELECT 1
                        FROM public.suppliers s
                       WHERE s.id = c.supplier_id
                         AND (
                           s.organization_id = a.organization_id
                           OR EXISTS (
                             SELECT 1
                               FROM public.brand_supplier_relationships rel
                              WHERE rel.supplier_organization_id = s.organization_id
                                AND rel.brand_organization_id = a.organization_id
                                AND rel.status = 'active'
                           )
                         )
                    )
                  )
             )
             OR EXISTS (
               SELECT 1
                 FROM public.data_points dp
                 JOIN public.tracefab_products p ON p.id = dp.product_id
                WHERE dp.source_document_id = d.id
                  AND p.brand_organization_id = a.organization_id
             )
           )
      );
    $function$;
  $ddl$;

  SELECT p.oid, p.proowner, p.proacl
    INTO v_after_oid, v_after_owner, v_after_acl
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid;

  IF v_after_oid IS DISTINCT FROM v_oid
     OR v_after_owner IS DISTINCT FROM v_owner
     OR v_after_acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'document_access_guard_changed_oid_owner_or_acl';
  END IF;
END
$document_access_guard$;

-- 5. Garde métier des trois fonctions SECURITY DEFINER encore non bornées.
--    On injecte les gardes dans les définitions existantes sans changer OID,
--    propriétaire ou ACL.
DO $business_function_guards$
DECLARE
  v_target record;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_oid oid;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_definition text;
  v_marker text;
  v_injection text;
  v_count integer;
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      (
        'tracefab_apply_document_ai_verification',
        'IF NOT FOUND THEN' || E'\n' ||
        '    RAISE EXCEPTION ''document_not_found'';' || E'\n' ||
        '  END IF;',
        E'\n\n  IF public.tracefab_active_organization_id() IS NULL THEN' ||
        E'\n    RAISE EXCEPTION ''organization_id_required'';' ||
        E'\n  END IF;' ||
        E'\n  IF NOT public.tracefab_has_org_role(' ||
        E'\n    public.tracefab_active_organization_id(),' ||
        E'\n    ARRAY[''owner'', ''admin'', ''manager'', ''contributor'']::public.membership_role[]' ||
        E'\n  ) THEN' ||
        E'\n    RAISE EXCEPTION ''document_verification_role_required'';' ||
        E'\n  END IF;' ||
        E'\n  IF NOT public.tracefab_can_access_document(p_document_id) THEN' ||
        E'\n    RAISE EXCEPTION ''active_tenant_mismatch'';' ||
        E'\n  END IF;'
      ),
      (
        'tracefab_finalize_document_upload',
        'IF tracefab_current_user_id() IS NOT NULL THEN',
        E'\n    PERFORM public.tracefab_require_active_tenant_for_organization(v_document.owner_organization_id);'
      ),
      (
        'tracefab_enqueue_manual_data_request_reminder',
        'IF v_request.id IS NULL THEN' || E'\n' ||
        '    RAISE EXCEPTION ''data_request_not_remindable'';' || E'\n' ||
        '  END IF;',
        E'\n\n  PERFORM public.tracefab_require_active_tenant_for_organization(v_request.brand_organization_id);' ||
        E'\n  IF NOT public.tracefab_has_org_role(' ||
        E'\n    v_request.brand_organization_id,' ||
        E'\n    ARRAY[''owner'', ''admin'', ''manager'', ''contributor'']::public.membership_role[]' ||
        E'\n  ) THEN' ||
        E'\n    RAISE EXCEPTION ''data_request_reminder_role_required'';' ||
        E'\n  END IF;'
      )
    ) AS t(function_name, marker, injection)
  LOOP
    SELECT p.oid, p.proowner, p.proacl
      INTO v_oid, v_owner, v_acl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_target.function_name
       AND p.prosecdef;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'active_tenant_function_missing_or_not_definer: %',
        v_target.function_name;
    END IF;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);

    IF pg_catalog.strpos(v_definition, v_target.injection) > 0 THEN
      CONTINUE;
    END IF;

    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_target.marker, ''))
    ) / pg_catalog.length(v_target.marker);

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'active_tenant_function_marker_not_unique: %, found %',
        v_target.function_name, v_count;
    END IF;

    v_definition := pg_catalog.replace(
      v_definition,
      v_target.marker,
      v_target.marker || v_target.injection
    );

    -- L'IA écrit l'organisation qui a réellement effectué la vérification,
    -- pas seulement celle qui possède le document.
    IF v_target.function_name = 'tracefab_apply_document_ai_verification' THEN
      IF pg_catalog.strpos(v_definition, 'verifier_organization_id') = 0 THEN
        v_definition := pg_catalog.replace(
          v_definition,
          E'    owner_organization_id,\n    document_id,',
          E'    owner_organization_id,\n    verifier_organization_id,\n    document_id,'
        );
        v_definition := pg_catalog.replace(
          v_definition,
          E'    v_doc.owner_organization_id,\n    p_document_id,',
          E'    v_doc.owner_organization_id,\n    public.tracefab_active_organization_id(),\n    p_document_id,'
        );
      END IF;
      IF pg_catalog.strpos(v_definition, 'verifier_organization_id') = 0 THEN
        RAISE EXCEPTION 'document_ai_verifier_organization_not_recorded';
      END IF;
    END IF;

    EXECUTE v_definition;

    SELECT p.oid, p.proowner, p.proacl
      INTO v_after_oid, v_after_owner, v_after_acl
      FROM pg_catalog.pg_proc p
     WHERE p.oid = v_oid;

    IF v_after_oid IS DISTINCT FROM v_oid
       OR v_after_owner IS DISTINCT FROM v_owner
       OR v_after_acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'active_tenant_function_guard_changed_oid_owner_or_acl: %',
        v_target.function_name;
    END IF;
  END LOOP;
END
$business_function_guards$;

-- 6. Inventaire et fermeture des politiques résiduelles.
--    Les tables account-wide restent multi-organisation par conception :
--    elles alimentent le sélecteur d'organisation et l'inbox d'invitations.
--    Les tables de référence et le catalogue de schémas sont globalement lus.
--    Toutes les autres occurrences de membership/role/access doivent être
--    combinées à tracefab_in_active_tenant(org_id). Les helpers de partage
--    appliquent déjà le même contrôle sur le grantee.
DO $active_tenant_policy_inventory$
DECLARE
  v_policy record;
  v_using text;
  v_check text;
  v_sql text;
  v_before integer;
  v_after integer;
  v_changed integer := 0;
  v_predicates integer := 0;
  v_unresolved integer := 0;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND tablename NOT IN (
         'organizations',
         'organization_memberships',
         'organization_invitations',
         'rate_limit_counters',
         'tracefab_schema_catalog',
         'dpp_requirement_profiles',
         'green_claims_rules',
         'pef_emission_factors'
       )
     ORDER BY tablename, policyname
  LOOP
    v_using := v_policy.qual;
    v_check := v_policy.with_check;

    IF v_using IS NOT NULL THEN
      v_before := pg_catalog.regexp_count(
        v_using,
        'tracefab_(is_org_member|has_org_role|can_access_org)\('
      );
      v_using := pg_catalog.regexp_replace(
        v_using,
        'tracefab_(is_org_member|has_org_role|can_access_org)\(([^()]*)\)',
        '(tracefab_in_active_tenant(\2) AND tracefab_\1(\2))',
        'g'
      );
      v_after := pg_catalog.regexp_count(v_using, 'tracefab_in_active_tenant\(')
        - pg_catalog.regexp_count(v_policy.qual, 'tracefab_in_active_tenant\(');
      IF v_after < v_before THEN
        RAISE EXCEPTION 'active_tenant_policy_using_not_fully_wrapped: %.%',
          v_policy.tablename, v_policy.policyname;
      END IF;
      v_predicates := v_predicates + v_before;
    END IF;

    IF v_check IS NOT NULL THEN
      v_before := pg_catalog.regexp_count(
        v_check,
        'tracefab_(is_org_member|has_org_role|can_access_org)\('
      );
      v_check := pg_catalog.regexp_replace(
        v_check,
        'tracefab_(is_org_member|has_org_role|can_access_org)\(([^()]*)\)',
        '(tracefab_in_active_tenant(\2) AND tracefab_\1(\2))',
        'g'
      );
      v_after := pg_catalog.regexp_count(v_check, 'tracefab_in_active_tenant\(')
        - pg_catalog.regexp_count(v_policy.with_check, 'tracefab_in_active_tenant\(');
      IF v_after < v_before THEN
        RAISE EXCEPTION 'active_tenant_policy_check_not_fully_wrapped: %.%',
          v_policy.tablename, v_policy.policyname;
      END IF;
      v_predicates := v_predicates + v_before;
    END IF;

    IF v_using IS DISTINCT FROM v_policy.qual
       OR v_check IS DISTINCT FROM v_policy.with_check THEN
      v_sql := pg_catalog.format(
        'ALTER POLICY %I ON %I.%I',
        v_policy.policyname, v_policy.schemaname, v_policy.tablename
      );
      IF v_using IS NOT NULL THEN
        v_sql := v_sql || pg_catalog.format(' USING (%s)', v_using);
      END IF;
      IF v_check IS NOT NULL THEN
        v_sql := v_sql || pg_catalog.format(' WITH CHECK (%s)', v_check);
      END IF;
      EXECUTE v_sql;
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  -- Re-read the catalogue: no tenant membership predicate may remain without
  -- at least one corresponding active-tenant predicate in its policy clause.
  FOR v_policy IN
    SELECT schemaname, tablename, policyname,
           coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expression
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND tablename NOT IN (
         'organizations',
         'organization_memberships',
         'organization_invitations',
         'rate_limit_counters',
         'tracefab_schema_catalog',
         'dpp_requirement_profiles',
         'green_claims_rules',
         'pef_emission_factors'
       )
  LOOP
    v_before := pg_catalog.regexp_count(
      v_policy.expression,
      'tracefab_(is_org_member|has_org_role|can_access_org)\('
    );
    v_after := pg_catalog.regexp_count(
      v_policy.expression,
      'tracefab_in_active_tenant\('
    );
    IF v_after < v_before THEN
      v_unresolved := v_unresolved + 1;
      RAISE EXCEPTION 'active_tenant_policy_unclassified: %.% (membership predicates %, tenant predicates %)',
        v_policy.tablename, v_policy.policyname, v_before, v_after;
    END IF;
  END LOOP;

  RAISE NOTICE 'RLS active-tenant inventory: % policies réécrites, % prédicats membership/role bornés, % politiques non classifiées',
    v_changed, v_predicates, v_unresolved;
END
$active_tenant_policy_inventory$;

-- 7. Les politiques worker ne doivent plus dépendre d'un GUC falsifiable.
DO $worker_public_postconditions$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND (
         coalesce(qual, '') ILIKE '%tracefab.worker_context%'
         OR coalesce(with_check, '') ILIKE '%tracefab.worker_context%'
       )
  ) THEN
    RAISE EXCEPTION 'worker_policy_still_uses_forgeable_guc';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'tracefab_public_context'
      AND p.prosecdef = false
  ) THEN
    RAISE EXCEPTION 'public_context_helper_must_be_invoker';
  END IF;
END
$worker_public_postconditions$;

COMMIT;
