-- ============================================================================
-- 20261124120000 — durcissement des fonctions passeport fournisseur et ACL audit
--
-- LE DÉFAUT CORRIGÉ (P1), MESURÉ SUR LA CHAÎNE COMPLÈTE SOUS `tracefab_app`
--
-- La migration historique `20261006250000_universal_supplier_passport` expose
-- trois fonctions publiques/fournisseur `SECURITY DEFINER` exécutables par
-- `tracefab_app` :
--   1. `tracefab_get_public_supplier_passport(text)`
--   2. `tracefab_request_passport_access(text, text, text, text, text, boolean)`
--   3. `tracefab_review_passport_access(uuid, text)`
--
-- Lorsque `20261014140000_remove_public_supplier_passport_share_token` a fermé
-- `tracefab_get_public_supplier_passport` aux passeports privés ou non confirmés
-- (`is_public = true AND disclosure_confirmed_at IS NOT NULL`) et retiré
-- `shareToken` du JSON retourné :
--   - `tracefab_get_public_supplier_passport` acceptait encore `share_token =
--     p_token_or_slug` dans sa clause `WHERE` et gardait `search_path = public`
--     (sans `pg_catalog` en tête) ;
--   - `tracefab_request_passport_access` et `tracefab_review_passport_access`
--     n'avaient pas reçu le durcissement de visibilité publique.
--
-- Trois vecteurs réels ont été reproduits et mesurés sous `SET LOCAL ROLE tracefab_app` :
--
--   A. Contournement de confidentialité du passeport (`is_public = false`) :
--      `tracefab_request_passport_access` résolvait `(share_token = ... OR slug = ...)`
--      sans vérifier `is_public = true` ni `disclosure_confirmed_at IS NOT NULL`.
--      Un appel anonyme sur le slug d'un passeport privé réussissait et renvoyait
--      l'UUID interne `supplierOrganizationId`.
--
--   B. Oracle anonyme d'énumération d'utilisateurs de marques (`isExistingBrand`) :
--      sans aucune authentification, la fonction interrogeait `users` joint à
--      `organization_memberships` et `organizations` sur l'adresse `p_requester_email`
--      fournie en clair, renseignait `requester_organization_id` sur cette seule
--      assertion non vérifiée, et retournait `"isExistingBrand": true|false` dans
--      la réponse HTTP publique.
--
--   C. Liaison inter-organisations forcée sans consentement de la marque :
--      un fournisseur malveillant pouvait soumettre anonymement une demande sur
--      son propre passeport en usurpant l'adresse e-mail d'un membre d'une marque
--      cible `B`, puis approuver lui-même cette demande via
--      `tracefab_review_passport_access(..., 'approved')`. La fonction `SECURITY
--      DEFINER` exécutait alors :
--        - `INSERT INTO brand_supplier_relationships (brand_organization_id,
--           supplier_organization_id, status) VALUES (B, S, 'active')
--           ON CONFLICT DO UPDATE SET status = 'active'` (y compris en réactivant
--           une relation suspendue ou clôturée par `B`) ;
--        - `INSERT INTO data_shares (...) VALUES (..., 'active')`.
--      Effet mesuré sous RLS : la ligne `organizations` de `B` devenait aussitôt
--      lisible par `S` via `organizations_select_member_or_partner`, et `S`
--      apparaissait comme partenaire `active` chez `B` sans aucune action de `B`.
--
-- LA CORRECTION (ADDITIVE, SANS RÉÉCRIRE LES MIGRATIONS DÉJÀ VERSIONNÉES)
--
--   1. `tracefab_get_public_supplier_passport` :
--      - résout uniquement par `slug = p_token_or_slug` (le `share_token` privé
--        n'est plus accepté en consultation publique) ;
--      - fige `SET search_path = pg_catalog, public` et qualifie toutes les tables.
--
--   2. `tracefab_request_passport_access` :
--      - n'accepte plus `share_token` et exige `slug = p_token_or_slug`
--        `AND is_public = true AND disclosure_confirmed_at IS NOT NULL`
--        (même barrière exacte que `tracefab_get_public_supplier_passport`, et
--        même code métier `passport_not_found_or_private` mappé en 404) ;
--      - exige explicitement `p_nda_accepted IS TRUE` côté base ;
--      - ne résout plus d'organisation marque sur la foi d'un e-mail déclaratif
--        non authentifié (`requester_organization_id` reste `NULL`) ;
--      - ne renvoie ni `isExistingBrand` ni `supplierOrganizationId` dans la
--        réponse JSON publique.
--
--   3. `tracefab_review_passport_access` :
--      - conserve la garde de locataire actif (`20261105230000`) et de rôle
--        administrateur fournisseur (`owner`, `admin`, `manager`) ;
--      - met à jour le statut de la demande (`approved` / `rejected`) et trace
--        l'arbitrage dans `audit_logs`, mais ne crée ni ne réactive JAMAIS
--        unilatéralement de ligne `brand_supplier_relationships` ou `data_shares`
--        sans consentement authentifié de la marque.
--
--   4. Défense en profondeur ACL sur `public.audit_logs` (append-only) :
--      - révoque `UPDATE, DELETE, TRUNCATE` sur `public.audit_logs` pour `PUBLIC`
--        et pour `tracefab_app` tout en préservant `SELECT, INSERT` (aligné avec
--        `scripts/lib/tracefab_app_role.mjs` `TABLES_INSERT_SEUL_DIRECTE`).
--
--   5. Préservation stricte de l'OID, du propriétaire et des ACL sur les 3 fonctions.
-- ============================================================================

BEGIN;

DO $harden_passport_access_and_audit_acl$
DECLARE
  v_pub_oid oid;
  v_pub_owner oid;
  v_req_oid oid;
  v_req_owner oid;
  v_rev_oid oid;
  v_rev_owner oid;
  v_after_oid oid;
  v_after_owner oid;
  v_owner_role name;
BEGIN
  SELECT p.oid, p.proowner
    INTO v_pub_oid, v_pub_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_get_public_supplier_passport'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_token_or_slug text';

  IF v_pub_oid IS NULL THEN
    RAISE EXCEPTION 'passport_hardening_public_fn_missing';
  END IF;

  SELECT p.oid, p.proowner, r.rolname
    INTO v_req_oid, v_req_owner, v_owner_role
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_request_passport_access'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
       'p_token_or_slug text, p_requester_email text, p_requester_name text, p_requester_company text, p_message text, p_nda_accepted boolean';

  IF v_req_oid IS NULL THEN
    RAISE EXCEPTION 'passport_hardening_request_fn_missing';
  END IF;

  SELECT p.oid, p.proowner
    INTO v_rev_oid, v_rev_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_review_passport_access'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
       'p_request_id uuid, p_verdict text';

  IF v_rev_oid IS NULL THEN
    RAISE EXCEPTION 'passport_hardening_review_fn_missing';
  END IF;

  IF v_owner_role = 'tracefab_app' THEN
    RAISE EXCEPTION 'passport_hardening_runtime_owns_definer_function';
  END IF;

  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) TO %I',
    (SELECT rolname FROM pg_catalog.pg_roles WHERE oid = v_rev_owner)
  );

  -- 1. Consultation publique : slug uniquement + passeport public confirmé
  CREATE OR REPLACE FUNCTION public.tracefab_get_public_supplier_passport(
    p_token_or_slug TEXT
  )
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn_public$
  DECLARE
    v_passport public.supplier_universal_passports;
    v_org RECORD;
    v_supplier RECORD;
    v_sites JSONB;
    v_certifications JSONB;
    v_materials JSONB;
    v_score RECORD;
    v_result JSONB;
    v_exact_addresses BOOLEAN;
    v_show_sites BOOLEAN;
    v_show_certs BOOLEAN;
    v_show_materials BOOLEAN;
    v_show_score BOOLEAN;
    v_show_contact BOOLEAN;
  BEGIN
    SELECT * INTO v_passport
      FROM public.supplier_universal_passports
     WHERE slug = p_token_or_slug
       AND is_public = true
       AND disclosure_confirmed_at IS NOT NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'passport_not_found_or_private';
    END IF;

    UPDATE public.supplier_universal_passports
       SET views_count = views_count + 1,
           last_viewed_at = now()
     WHERE id = v_passport.id
     RETURNING * INTO v_passport;

    SELECT id, legal_name, display_name, country_code, website, created_at
      INTO v_org
      FROM public.organizations
     WHERE id = v_passport.supplier_organization_id;

    SELECT id, activity_types, profile_summary, contact_name, contact_email,
           employee_count_range, year_established, profile_completion
      INTO v_supplier
      FROM public.suppliers
     WHERE organization_id = v_passport.supplier_organization_id;

    v_exact_addresses := COALESCE((v_passport.disclosed_sections->>'exact_addresses')::boolean, false);
    v_show_sites := COALESCE((v_passport.disclosed_sections->>'sites')::boolean, false);
    v_show_certs := COALESCE((v_passport.disclosed_sections->>'certifications')::boolean, false);
    v_show_materials := COALESCE((v_passport.disclosed_sections->>'materials')::boolean, false);
    v_show_score := COALESCE((v_passport.disclosed_sections->>'quality_score')::boolean, false);
    v_show_contact := COALESCE((v_passport.disclosed_sections->>'contact')::boolean, false);

    IF v_show_sites AND v_supplier.id IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'countryCode', s.country_code,
        'city', s.city,
        'address', CASE WHEN v_exact_addresses THEN s.address ELSE '[Secret d''affaires masqué]' END,
        'postalCode', CASE WHEN v_exact_addresses THEN s.postal_code ELSE NULL END,
        'activityTypes', s.activity_types,
        'isActive', s.is_active
      )), '[]'::jsonb)
      INTO v_sites
      FROM public.supplier_sites s
      WHERE s.supplier_id = v_supplier.id AND s.is_active = true;
    ELSE
      v_sites := '[]'::jsonb;
    END IF;

    IF v_show_certs THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'standardName', c.standard_name,
        'standardCode', c.standard_code,
        'issuerName', c.issuer_name,
        'certificateNumber', c.certificate_number,
        'issuedAt', c.issued_at,
        'expiresAt', c.expires_at,
        'status', c.status,
        'isVerified', c.status IN ('checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party')
      )), '[]'::jsonb)
      INTO v_certifications
      FROM public.certifications c
      WHERE c.owner_organization_id = v_org.id
        AND (c.expires_at IS NULL OR c.expires_at >= current_date);
    ELSE
      v_certifications := '[]'::jsonb;
    END IF;

    IF v_show_materials THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', m.id,
        'name', m.name,
        'materialType', m.material_type,
        'originCountryCode', m.origin_country_code,
        'composition', m.composition
      )), '[]'::jsonb)
      INTO v_materials
      FROM public.materials m
      WHERE m.owner_organization_id = v_org.id;
    ELSE
      v_materials := '[]'::jsonb;
    END IF;

    IF v_show_score AND v_supplier.id IS NOT NULL THEN
      SELECT completeness, freshness, documentation_coverage, consistency, computed_at
        INTO v_score
        FROM public.data_quality_scores
       WHERE supplier_id = v_supplier.id
       ORDER BY computed_at DESC
       LIMIT 1;
    END IF;

    v_result := jsonb_build_object(
      'passport', jsonb_build_object(
        'id', v_passport.id,
        'slug', v_passport.slug,
        'headline', v_passport.headline,
        'tradeSecretMode', v_passport.trade_secret_mode,
        'ndaTerms', v_passport.nda_terms,
        'viewsCount', v_passport.views_count,
        'lastViewedAt', v_passport.last_viewed_at,
        'createdAt', v_passport.created_at,
        'publicUrl', '/passport/?ref=' || v_passport.slug
      ),
      'supplier', jsonb_build_object(
        'legalName', v_org.legal_name,
        'displayName', COALESCE(v_org.display_name, v_org.legal_name),
        'countryCode', v_org.country_code,
        'website', v_org.website,
        'activityTypes', COALESCE(v_supplier.activity_types, ARRAY[]::text[]),
        'profileSummary', v_supplier.profile_summary,
        'employeeCountRange', v_supplier.employee_count_range,
        'yearEstablished', v_supplier.year_established,
        'profileCompletion', COALESCE(v_supplier.profile_completion, 0),
        'contactName', CASE WHEN v_show_contact THEN v_supplier.contact_name ELSE NULL END,
        'contactEmail', CASE WHEN v_show_contact THEN v_supplier.contact_email ELSE NULL END
      ),
      'sites', v_sites,
      'certifications', v_certifications,
      'materials', v_materials,
      'qualityScore', CASE WHEN v_score.completeness IS NOT NULL THEN jsonb_build_object(
        'completeness', v_score.completeness,
        'freshness', v_score.freshness,
        'documentationCoverage', v_score.documentation_coverage,
        'consistency', v_score.consistency,
        'computedAt', v_score.computed_at
      ) ELSE NULL END,
      'tradeSecretProtection', jsonb_build_object(
        'exactAddressesMasked', NOT v_exact_addresses,
        'mode', v_passport.trade_secret_mode,
        'legalBasis', 'Directive (UE) 2016/943 sur la protection des secrets d''affaires'
      )
    );

    RETURN v_result;
  END;
  $fn_public$;

  -- 2. Demande publique d'accès NDA : slug public confirmé uniquement, sans oracle ni liaison d'organisation
  CREATE OR REPLACE FUNCTION public.tracefab_request_passport_access(
    p_token_or_slug TEXT,
    p_requester_email TEXT,
    p_requester_name TEXT,
    p_requester_company TEXT,
    p_message TEXT DEFAULT NULL,
    p_nda_accepted BOOLEAN DEFAULT true
  )
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn_request$
  DECLARE
    v_passport public.supplier_universal_passports;
    v_request public.supplier_passport_access_requests;
    v_email TEXT;
    v_name TEXT;
    v_company TEXT;
  BEGIN
    v_email := lower(btrim(coalesce(p_requester_email, '')));
    v_name := btrim(coalesce(p_requester_name, ''));
    v_company := btrim(coalesce(p_requester_company, ''));

    IF v_email = '' OR position('@' IN v_email) <= 1 OR position('@' IN v_email) = length(v_email) THEN
      RAISE EXCEPTION 'invalid_requester_email';
    END IF;
    IF v_name = '' OR v_company = '' THEN
      RAISE EXCEPTION 'requester_name_and_company_required';
    END IF;
    IF p_nda_accepted IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'nda_acceptance_required';
    END IF;

    SELECT * INTO v_passport
      FROM public.supplier_universal_passports
     WHERE slug = p_token_or_slug
       AND is_public = true
       AND disclosure_confirmed_at IS NOT NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'passport_not_found_or_private';
    END IF;

    INSERT INTO public.supplier_passport_access_requests (
      passport_id,
      supplier_organization_id,
      requester_email,
      requester_name,
      requester_company,
      requester_organization_id,
      message,
      nda_accepted,
      nda_accepted_at,
      status
    ) VALUES (
      v_passport.id,
      v_passport.supplier_organization_id,
      v_email,
      v_name,
      v_company,
      NULL,
      nullif(btrim(coalesce(p_message, '')), ''),
      true,
      now(),
      'pending'
    )
    RETURNING * INTO v_request;

    INSERT INTO public.audit_logs (
      organization_id,
      action,
      entity_type,
      entity_id,
      metadata
    ) VALUES (
      v_passport.supplier_organization_id,
      'passport_access_requested',
      'supplier_passport_access_requests',
      v_request.id,
      jsonb_build_object(
        'requestId', v_request.id,
        'requesterName', v_name,
        'requesterCompany', v_company,
        'requesterEmail', v_email
      )
    );

    RETURN jsonb_build_object(
      'requestId', v_request.id,
      'status', v_request.status,
      'message', 'Demande d''accès transmise au fournisseur sous engagement de confidentialité NDA.'
    );
  END;
  $fn_request$;

  -- 3. Arbitrage fournisseur : garde tenant actif + rôle admin, sans création unilatérale de relation
  CREATE OR REPLACE FUNCTION public.tracefab_review_passport_access(
    p_request_id UUID,
    p_verdict TEXT
  )
  RETURNS public.supplier_passport_access_requests
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $fn_review$
  DECLARE
    v_request public.supplier_passport_access_requests;
  BEGIN
    IF p_verdict NOT IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'invalid_verdict_must_be_approved_or_rejected';
    END IF;

    SELECT * INTO v_request
      FROM public.supplier_passport_access_requests
     WHERE id = p_request_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_request_not_found';
    END IF;

    PERFORM public.tracefab_require_active_tenant_for_organization(v_request.supplier_organization_id);
    IF NOT public.tracefab_has_org_role(
      v_request.supplier_organization_id,
      ARRAY['owner', 'admin', 'manager']::public.membership_role[]
    ) THEN
      RAISE EXCEPTION 'access_denied_supplier_admin_required';
    END IF;

    UPDATE public.supplier_passport_access_requests
       SET status = p_verdict,
           reviewed_at = now(),
           updated_at = now()
     WHERE id = p_request_id
     RETURNING * INTO v_request;

    INSERT INTO public.audit_logs (
      organization_id,
      actor_user_id,
      action,
      entity_type,
      entity_id,
      metadata
    ) VALUES (
      v_request.supplier_organization_id,
      public.tracefab_current_user_id(),
      'passport_access_reviewed',
      'supplier_passport_access_requests',
      v_request.id,
      jsonb_build_object(
        'requestId', v_request.id,
        'verdict', p_verdict
      )
    );

    RETURN v_request;
  END;
  $fn_review$;

  REVOKE EXECUTE ON FUNCTION public.tracefab_get_public_supplier_passport(text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.tracefab_request_passport_access(text, text, text, text, text, boolean) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.tracefab_review_passport_access(uuid, text) FROM PUBLIC;

  -- 4. Défense en profondeur ACL sur `public.audit_logs` (append-only)
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION public.tracefab_get_public_supplier_passport(text) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_request_passport_access(text, text, text, text, text, boolean) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_review_passport_access(uuid, text) TO tracefab_app;

    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM tracefab_app;
    GRANT SELECT, INSERT ON TABLE public.audit_logs TO tracefab_app;

    IF pg_catalog.has_table_privilege('tracefab_app', 'public.audit_logs', 'UPDATE')
       OR pg_catalog.has_table_privilege('tracefab_app', 'public.audit_logs', 'DELETE')
       OR pg_catalog.has_table_privilege('tracefab_app', 'public.audit_logs', 'TRUNCATE') THEN
      RAISE EXCEPTION 'passport_hardening_audit_logs_mutable_by_runtime';
    END IF;

    IF pg_catalog.has_function_privilege(
      'tracefab_app',
      'public.tracefab_require_active_tenant_for_organization(uuid)',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'passport_hardening_helper_executable_by_runtime';
    END IF;
  END IF;

  -- 5. Postconditions d'identité d'objet et d'hygiène PUBLIC
  SELECT p.oid, p.proowner INTO v_after_oid, v_after_owner
    FROM pg_catalog.pg_proc p WHERE p.oid = v_pub_oid;
  IF v_after_oid IS DISTINCT FROM v_pub_oid OR v_after_owner IS DISTINCT FROM v_pub_owner THEN
    RAISE EXCEPTION 'passport_hardening_public_oid_or_owner_changed';
  END IF;

  SELECT p.oid, p.proowner INTO v_after_oid, v_after_owner
    FROM pg_catalog.pg_proc p WHERE p.oid = v_req_oid;
  IF v_after_oid IS DISTINCT FROM v_req_oid OR v_after_owner IS DISTINCT FROM v_req_owner THEN
    RAISE EXCEPTION 'passport_hardening_request_oid_or_owner_changed';
  END IF;

  SELECT p.oid, p.proowner INTO v_after_oid, v_after_owner
    FROM pg_catalog.pg_proc p WHERE p.oid = v_rev_oid;
  IF v_after_oid IS DISTINCT FROM v_rev_oid OR v_after_owner IS DISTINCT FROM v_rev_owner THEN
    RAISE EXCEPTION 'passport_hardening_review_oid_or_owner_changed';
  END IF;

  IF pg_catalog.has_function_privilege('public', 'public.tracefab_get_public_supplier_passport(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'public',
       'public.tracefab_request_passport_access(text, text, text, text, text, boolean)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'public',
       'public.tracefab_review_passport_access(uuid, text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'passport_hardening_public_execute_residual';
  END IF;
END;
$harden_passport_access_and_audit_acl$;

COMMIT;
