-- TRACEFAB — ne jamais renvoyer le jeton privé dans le passeport fournisseur public.
--
-- La fonction historique permet une consultation par slug public et incluait
-- par erreur share_token dans son JSON. Ce jeton est un identifiant privé :
-- la consultation publique conserve le slug et les données explicitement
-- divulgables, mais ne doit jamais révéler le jeton stocké.
-- Migration additive : ne pas modifier la migration historique 20261006250000.
BEGIN;

CREATE OR REPLACE FUNCTION tracefab_get_public_supplier_passport(
  p_token_or_slug TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_passport supplier_universal_passports;
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
  -- Recherche du passeport par token ou slug
  SELECT * INTO v_passport
  FROM supplier_universal_passports
  WHERE (share_token = p_token_or_slug OR slug = p_token_or_slug)
    AND is_public = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'passport_not_found_or_private';
  END IF;

  -- Incrémentation atomique des vues
  UPDATE supplier_universal_passports
  SET
    views_count = views_count + 1,
    last_viewed_at = now()
  WHERE id = v_passport.id
  RETURNING * INTO v_passport;

  -- Récupération de l'organisation
  SELECT id, legal_name, display_name, country_code, website, created_at
  INTO v_org
  FROM organizations
  WHERE id = v_passport.supplier_organization_id;

  -- Récupération du profil fournisseur
  SELECT id, activity_types, profile_summary, contact_name, contact_email, employee_count_range, year_established, profile_completion
  INTO v_supplier
  FROM suppliers
  WHERE organization_id = v_passport.supplier_organization_id;

  -- Récupération des préférences de divulgation
  v_exact_addresses := COALESCE((v_passport.disclosed_sections->>'exact_addresses')::boolean, false);
  v_show_sites := COALESCE((v_passport.disclosed_sections->>'sites')::boolean, true);
  v_show_certs := COALESCE((v_passport.disclosed_sections->>'certifications')::boolean, true);
  v_show_materials := COALESCE((v_passport.disclosed_sections->>'materials')::boolean, true);
  v_show_score := COALESCE((v_passport.disclosed_sections->>'quality_score')::boolean, true);
  v_show_contact := COALESCE((v_passport.disclosed_sections->>'contact')::boolean, true);

  -- Récupération des sites (avec masquage d'adresse si protection activée)
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
    FROM supplier_sites s
    WHERE s.supplier_id = v_supplier.id AND s.is_active = true;
  ELSE
    v_sites := '[]'::jsonb;
  END IF;

  -- Récupération des certifications actives
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
    FROM certifications c
    WHERE c.owner_organization_id = v_org.id
      AND (c.expires_at IS NULL OR c.expires_at >= current_date);
  ELSE
    v_certifications := '[]'::jsonb;
  END IF;

  -- Récupération des matières
  IF v_show_materials THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'materialType', m.material_type,
      'originCountryCode', m.origin_country_code,
      'composition', m.composition
    )), '[]'::jsonb)
    INTO v_materials
    FROM materials m
    WHERE m.owner_organization_id = v_org.id;
  ELSE
    v_materials := '[]'::jsonb;
  END IF;

  -- Récupération du score qualité
  IF v_show_score AND v_supplier.id IS NOT NULL THEN
    SELECT completeness, freshness, documentation_coverage, consistency, computed_at
    INTO v_score
    FROM data_quality_scores
    WHERE supplier_id = v_supplier.id
    ORDER BY computed_at DESC
    LIMIT 1;
  END IF;

  -- Construction du résultat JSON
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
$$;

-- La route publique appelle cette fonction via le serveur tracefab_app.
-- Le client navigateur ne doit pas disposer d'un accès SQL direct.
REVOKE EXECUTE ON FUNCTION tracefab_get_public_supplier_passport(text) FROM PUBLIC;
DO $runtime_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_get_public_supplier_passport(text) TO tracefab_app;
  END IF;
END
$runtime_grant$;

COMMIT;
