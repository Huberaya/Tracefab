-- Trusted product-data mutations for the Vercel API. Direct Prisma writes are
-- deliberately not used for composition, identifiers or materials because the
-- Neon owner connection must not be treated as an RLS boundary.

CREATE OR REPLACE FUNCTION tracefab_create_material(
  p_owner_organization_id UUID,
  p_material_type TEXT,
  p_name TEXT,
  p_composition JSONB DEFAULT '{}'::jsonb,
  p_origin_country_code VARCHAR(2) DEFAULT NULL
)
RETURNS materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_material materials;
BEGIN
  IF NOT tracefab_has_org_role(
    p_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'material_owner_role_required';
  END IF;

  IF length(trim(COALESCE(p_material_type, ''))) = 0 OR length(trim(COALESCE(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'invalid_material';
  END IF;

  INSERT INTO materials (
    owner_organization_id,
    material_type,
    name,
    normalized_name,
    composition,
    origin_country_code,
    created_by
  )
  VALUES (
    p_owner_organization_id,
    trim(p_material_type),
    trim(p_name),
    lower(regexp_replace(trim(p_name), '\\s+', ' ', 'g')),
    COALESCE(p_composition, '{}'::jsonb),
    upper(NULLIF(trim(p_origin_country_code), '')),
    tracefab_current_user_id()
  )
  RETURNING * INTO v_material;

  RETURN v_material;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_material(
  p_material_id UUID,
  p_material_type TEXT,
  p_name TEXT,
  p_composition JSONB,
  p_origin_country_code VARCHAR(2)
)
RETURNS materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_material materials;
BEGIN
  SELECT * INTO v_material FROM materials WHERE id = p_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'material_not_found'; END IF;

  IF NOT tracefab_has_org_role(
    v_material.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'material_owner_role_required';
  END IF;

  IF length(trim(COALESCE(p_material_type, ''))) = 0 OR length(trim(COALESCE(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'invalid_material';
  END IF;

  UPDATE materials
  SET material_type = trim(p_material_type),
      name = trim(p_name),
      normalized_name = lower(regexp_replace(trim(p_name), '\\s+', ' ', 'g')),
      composition = COALESCE(p_composition, '{}'::jsonb),
      origin_country_code = upper(NULLIF(trim(p_origin_country_code), ''))
  WHERE id = p_material_id
  RETURNING * INTO v_material;

  RETURN v_material;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_add_product_identifier(
  p_product_id UUID,
  p_identifier_type TEXT,
  p_identifier_value TEXT,
  p_is_primary BOOLEAN DEFAULT false
)
RETURNS product_identifiers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_identifier product_identifiers;
  v_brand_organization_id UUID;
  v_type TEXT;
  v_value TEXT;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  v_type := lower(trim(COALESCE(p_identifier_type, '')));
  v_value := trim(COALESCE(p_identifier_value, ''));
  IF v_type NOT IN ('gtin', 'ean', 'upc', 'internal') OR v_value = '' THEN
    RAISE EXCEPTION 'invalid_product_identifier';
  END IF;

  INSERT INTO product_identifiers (
    product_id,
    identifier_type,
    identifier_value,
    is_primary,
    created_by
  )
  VALUES (
    p_product_id,
    v_type,
    v_value,
    COALESCE(p_is_primary, false),
    tracefab_current_user_id()
  )
  RETURNING * INTO v_identifier;

  RETURN v_identifier;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_product_identifier(
  p_product_id UUID,
  p_identifier_id UUID,
  p_identifier_value TEXT,
  p_is_primary BOOLEAN
)
RETURNS product_identifiers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_identifier product_identifiers;
  v_brand_organization_id UUID;
  v_value TEXT;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  v_value := trim(COALESCE(p_identifier_value, ''));
  IF v_value = '' THEN
    RAISE EXCEPTION 'invalid_product_identifier';
  END IF;

  UPDATE product_identifiers
  SET identifier_value = v_value,
      is_primary = COALESCE(p_is_primary, false)
  WHERE id = p_identifier_id
    AND product_id = p_product_id
  RETURNING * INTO v_identifier;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_identifier_not_found';
  END IF;

  RETURN v_identifier;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_add_product_material(
  p_product_id UUID,
  p_material_id UUID,
  p_material_role TEXT,
  p_percentage NUMERIC,
  p_unit TEXT DEFAULT '%'
)
RETURNS product_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_exists BOOLEAN;
  v_material product_materials;
  v_role TEXT;
  v_unit TEXT;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  SELECT EXISTS (SELECT 1 FROM materials WHERE id = p_material_id)
  INTO v_material_exists;
  IF NOT v_material_exists THEN
    RAISE EXCEPTION 'material_not_found';
  END IF;

  IF p_percentage IS NOT NULL AND (p_percentage < 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'invalid_material_percentage';
  END IF;

  v_role := NULLIF(trim(COALESCE(p_material_role, '')), '');
  v_unit := NULLIF(trim(COALESCE(p_unit, '%')), '');
  IF v_role IS NULL OR v_unit IS NULL THEN
    RAISE EXCEPTION 'invalid_product_material';
  END IF;

  INSERT INTO product_materials (
    product_id,
    material_id,
    material_role,
    percentage,
    unit,
    product_version
  )
  VALUES (
    p_product_id,
    p_material_id,
    v_role,
    p_percentage,
    v_unit,
    v_product.version
  )
  RETURNING * INTO v_material;

  RETURN v_material;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_product_material(
  p_product_id UUID,
  p_material_id UUID,
  p_material_role TEXT,
  p_product_version INTEGER,
  p_percentage NUMERIC,
  p_unit TEXT
)
RETURNS product_materials
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material product_materials;
  v_unit TEXT;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  IF p_product_version <> v_product.version THEN
    RAISE EXCEPTION 'product_material_version_must_match_current_product_version';
  END IF;
  IF p_percentage IS NOT NULL AND (p_percentage < 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'invalid_material_percentage';
  END IF;

  v_unit := NULLIF(trim(COALESCE(p_unit, '%')), '');
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'invalid_product_material';
  END IF;

  UPDATE product_materials
  SET percentage = p_percentage,
      unit = v_unit
  WHERE product_id = p_product_id
    AND material_id = p_material_id
    AND material_role = p_material_role
    AND product_version = p_product_version
  RETURNING * INTO v_material;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_material_not_found';
  END IF;

  RETURN v_material;
END;
$$;

GRANT EXECUTE ON FUNCTION tracefab_create_material(UUID, TEXT, TEXT, JSONB, VARCHAR) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_material(UUID, TEXT, TEXT, JSONB, VARCHAR) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_add_product_identifier(UUID, TEXT, TEXT, BOOLEAN) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_product_identifier(UUID, UUID, TEXT, BOOLEAN) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_add_product_material(UUID, UUID, TEXT, NUMERIC, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_update_product_material(UUID, UUID, TEXT, INTEGER, NUMERIC, TEXT) TO PUBLIC;

COMMENT ON FUNCTION tracefab_add_product_identifier(UUID, TEXT, TEXT, BOOLEAN) IS 'Adds a product identifier after checking the current brand role.';
COMMENT ON FUNCTION tracefab_add_product_material(UUID, UUID, TEXT, NUMERIC, TEXT) IS 'Adds a current-version material after checking brand role and sharing integrity.';
