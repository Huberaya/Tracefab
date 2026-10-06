-- Tracefab Chantier 6 (Passeport Fournisseur Universel « 1-Clic » / Write Once, Share Everywhere)
-- Moat Produit : Transformer la corvée fournisseur en moteur viral et protéger les secrets d'affaires

-- 1. Table des Passeports Universels Fournisseurs
CREATE TABLE IF NOT EXISTS supplier_universal_passports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  slug TEXT UNIQUE,
  share_token TEXT NOT NULL UNIQUE,
  is_public BOOLEAN NOT NULL DEFAULT true,
  headline TEXT,
  trade_secret_mode TEXT NOT NULL DEFAULT 'redacted' CHECK (trade_secret_mode IN ('full_disclosure', 'redacted', 'strict_nda')),
  disclosed_sections JSONB NOT NULL DEFAULT '{"sites": true, "certifications": true, "materials": true, "quality_score": true, "contact": true, "exact_addresses": false}'::jsonb,
  nda_terms TEXT,
  views_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_universal_passports_org ON supplier_universal_passports(supplier_organization_id);
CREATE INDEX IF NOT EXISTS idx_universal_passports_slug ON supplier_universal_passports(slug);
CREATE INDEX IF NOT EXISTS idx_universal_passports_token ON supplier_universal_passports(share_token);

-- 2. Table des Demandes d'Accès Entrantes de Marques (Viralité Inversée / Inbound Leads)
CREATE TABLE IF NOT EXISTS supplier_passport_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id UUID NOT NULL REFERENCES supplier_universal_passports(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requester_email TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  requester_company TEXT NOT NULL,
  requester_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  message TEXT,
  requested_scope TEXT[] NOT NULL DEFAULT ARRAY['full_evidence', 'exact_sites'],
  nda_accepted BOOLEAN NOT NULL DEFAULT true,
  nda_accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_passport_access_passport ON supplier_passport_access_requests(passport_id, status);
CREATE INDEX IF NOT EXISTS idx_passport_access_supplier ON supplier_passport_access_requests(supplier_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_passport_access_requester ON supplier_passport_access_requests(requester_email);

-- 3. Sécurité RLS Stricte
ALTER TABLE supplier_universal_passports ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_universal_passports FORCE ROW LEVEL SECURITY;

ALTER TABLE supplier_passport_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_passport_access_requests FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_universal_passports TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_passport_access_requests TO PUBLIC;

-- Politiques RLS pour supplier_universal_passports
DROP POLICY IF EXISTS universal_passports_select ON supplier_universal_passports;
CREATE POLICY universal_passports_select ON supplier_universal_passports
  FOR SELECT
  USING (
    is_public = true
    OR tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS universal_passports_modify ON supplier_universal_passports;
CREATE POLICY universal_passports_modify ON supplier_universal_passports
  FOR ALL
  USING (
    tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

-- Politiques RLS pour supplier_passport_access_requests
DROP POLICY IF EXISTS passport_access_select ON supplier_passport_access_requests;
CREATE POLICY passport_access_select ON supplier_passport_access_requests
  FOR SELECT
  USING (
    tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer']::membership_role[])
    OR (requester_organization_id IS NOT NULL AND tracefab_has_org_role(requester_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]))
    OR requester_email = NULLIF(current_setting('tracefab.user_email', true), '')
  );

DROP POLICY IF EXISTS passport_access_modify ON supplier_passport_access_requests;
CREATE POLICY passport_access_modify ON supplier_passport_access_requests
  FOR UPDATE
  USING (
    tracefab_has_org_role(supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

DROP POLICY IF EXISTS passport_access_insert ON supplier_passport_access_requests;
CREATE POLICY passport_access_insert ON supplier_passport_access_requests
  FOR INSERT
  WITH CHECK (true);

-- 4. Procédure Stockée : tracefab_get_or_create_supplier_passport
CREATE OR REPLACE FUNCTION tracefab_get_or_create_supplier_passport(
  p_supplier_organization_id UUID
)
RETURNS supplier_universal_passports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_passport supplier_universal_passports;
  v_supplier_id UUID;
  v_org_name TEXT;
  v_clean_slug TEXT;
  v_share_token TEXT;
BEGIN
  -- 1. Vérification des droits
  IF NOT tracefab_has_org_role(p_supplier_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer']::membership_role[]) THEN
    RAISE EXCEPTION 'access_denied_supplier_role_required';
  END IF;

  -- 2. Recherche du passeport existant
  SELECT * INTO v_passport
  FROM supplier_universal_passports
  WHERE supplier_organization_id = p_supplier_organization_id;

  IF FOUND THEN
    RETURN v_passport;
  END IF;

  -- 3. Récupération des informations organisation et supplier
  SELECT id INTO v_supplier_id FROM suppliers WHERE organization_id = p_supplier_organization_id;
  SELECT COALESCE(display_name, legal_name) INTO v_org_name FROM organizations WHERE id = p_supplier_organization_id;

  -- Génération d'un slug propre et lisible
  v_clean_slug := lower(regexp_replace(COALESCE(v_org_name, 'atelier'), '[^a-zA-Z0-9]+', '-', 'g'));
  v_clean_slug := trim(both '-' from v_clean_slug);
  IF length(v_clean_slug) < 3 THEN
    v_clean_slug := 'supplier';
  END IF;
  v_clean_slug := v_clean_slug || '-' || lower(substr(md5(random()::text), 1, 6));

  -- Génération d'un share_token privé
  v_share_token := 'pass_' || lower(substr(md5(random()::text || clock_timestamp()::text), 1, 20));

  -- Création du passeport
  INSERT INTO supplier_universal_passports (
    supplier_organization_id,
    supplier_id,
    slug,
    share_token,
    is_public,
    headline,
    trade_secret_mode,
    disclosed_sections,
    nda_terms
  ) VALUES (
    p_supplier_organization_id,
    v_supplier_id,
    v_clean_slug,
    v_share_token,
    true,
    'Partenaire textile engagé · Profil de conformité et traçabilité vérifié sur Tracefab',
    'redacted',
    '{"sites": true, "certifications": true, "materials": true, "quality_score": true, "contact": true, "exact_addresses": false}'::jsonb,
    'Ce profil et ses données vérifiées sont partagés sous réserve du respect du secret d''affaires (Directive UE 2016/943). Toute réutilisation commerciale non autorisée des données industrielles est interdite.'
  )
  RETURNING * INTO v_passport;

  RETURN v_passport;
END;
$$;

-- 5. Procédure Stockée : tracefab_update_supplier_passport
CREATE OR REPLACE FUNCTION tracefab_update_supplier_passport(
  p_supplier_organization_id UUID,
  p_headline TEXT DEFAULT NULL,
  p_trade_secret_mode TEXT DEFAULT NULL,
  p_disclosed_sections JSONB DEFAULT NULL,
  p_is_public BOOLEAN DEFAULT NULL
)
RETURNS supplier_universal_passports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_passport supplier_universal_passports;
BEGIN
  IF NOT tracefab_has_org_role(p_supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]) THEN
    RAISE EXCEPTION 'access_denied_supplier_admin_required';
  END IF;

  UPDATE supplier_universal_passports
  SET
    headline = COALESCE(p_headline, headline),
    trade_secret_mode = COALESCE(p_trade_secret_mode, trade_secret_mode),
    disclosed_sections = COALESCE(p_disclosed_sections, disclosed_sections),
    is_public = COALESCE(p_is_public, is_public),
    updated_at = now()
  WHERE supplier_organization_id = p_supplier_organization_id
  RETURNING * INTO v_passport;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'passport_not_found';
  END IF;

  RETURN v_passport;
END;
$$;

-- 6. Procédure Stockée : tracefab_get_public_supplier_passport (Accessible sans authentification)
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
      'shareToken', v_passport.share_token,
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

-- 7. Procédure Stockée : tracefab_request_passport_access
CREATE OR REPLACE FUNCTION tracefab_request_passport_access(
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
SET search_path = public
AS $$
DECLARE
  v_passport supplier_universal_passports;
  v_existing_org_id UUID;
  v_request supplier_passport_access_requests;
BEGIN
  -- 1. Validation email et paramètres
  IF p_requester_email IS NULL OR position('@' in p_requester_email) = 0 THEN
    RAISE EXCEPTION 'invalid_requester_email';
  END IF;
  IF trim(p_requester_name) = '' OR trim(p_requester_company) = '' THEN
    RAISE EXCEPTION 'requester_name_and_company_required';
  END IF;

  -- 2. Recherche du passeport
  SELECT * INTO v_passport
  FROM supplier_universal_passports
  WHERE (share_token = p_token_or_slug OR slug = p_token_or_slug);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'passport_not_found';
  END IF;

  -- 3. Détection de l'existence d'une marque Tracefab associée à cet email (Viralité Inversée)
  SELECT m.organization_id INTO v_existing_org_id
  FROM organization_memberships m
  JOIN users u ON u.id = m.user_id
  JOIN organizations o ON o.id = m.organization_id
  WHERE u.email = lower(trim(p_requester_email))
    AND o.type = 'brand'
    AND m.status = 'active'
  LIMIT 1;

  -- 4. Création de la demande d'accès
  INSERT INTO supplier_passport_access_requests (
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
    lower(trim(p_requester_email)),
    trim(p_requester_name),
    trim(p_requester_company),
    v_existing_org_id,
    p_message,
    COALESCE(p_nda_accepted, true),
    now(),
    'pending'
  )
  RETURNING * INTO v_request;

  -- 5. Audit log pour le fournisseur
  INSERT INTO audit_logs (
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
      'requesterName', p_requester_name,
      'requesterCompany', p_requester_company,
      'requesterEmail', p_requester_email
    )
  );

  RETURN jsonb_build_object(
    'requestId', v_request.id,
    'status', v_request.status,
    'supplierOrganizationId', v_passport.supplier_organization_id,
    'isExistingBrand', v_existing_org_id IS NOT NULL,
    'message', 'Demande d''accès transmise au fournisseur sous engagement de confidentialité NDA.'
  );
END;
$$;

-- 8. Procédure Stockée : tracefab_review_passport_access (Arbitrage fournisseur & liaison marque)
CREATE OR REPLACE FUNCTION tracefab_review_passport_access(
  p_request_id UUID,
  p_verdict TEXT
)
RETURNS supplier_passport_access_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request supplier_passport_access_requests;
  v_rel_id UUID;
BEGIN
  IF p_verdict NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_verdict_must_be_approved_or_rejected';
  END IF;

  SELECT * INTO v_request
  FROM supplier_passport_access_requests
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'access_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(v_request.supplier_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]) THEN
    RAISE EXCEPTION 'access_denied_supplier_admin_required';
  END IF;

  -- Mise à jour de la demande
  UPDATE supplier_passport_access_requests
  SET
    status = p_verdict,
    reviewed_at = now(),
    updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  -- Si approuvé et qu'une organisation marque existe déjà, créer la relation automatique
  IF p_verdict = 'approved' AND v_request.requester_organization_id IS NOT NULL THEN
    INSERT INTO brand_supplier_relationships (
      brand_organization_id,
      supplier_organization_id,
      status
    ) VALUES (
      v_request.requester_organization_id,
      v_request.supplier_organization_id,
      'active'
    )
    ON CONFLICT (brand_organization_id, supplier_organization_id)
    DO UPDATE SET status = 'active', updated_at = now()
    RETURNING id INTO v_rel_id;

    -- Activer le partage de données bilatéral
    INSERT INTO data_shares (
      relationship_id,
      supplier_organization_id,
      grantee_organization_id,
      scope,
      status
    ) VALUES (
      v_rel_id,
      v_request.supplier_organization_id,
      v_request.requester_organization_id,
      '{"certifications": true, "sites": true, "materials": true, "documents": true}'::jsonb,
      'active'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_request;
END;
$$;
