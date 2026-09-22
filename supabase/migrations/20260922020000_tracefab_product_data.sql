-- Tracefab Chantier 3 — Product Data
--
-- Adds structured product information, identifiers, material composition and a
-- transparent data-readiness computation. Data ready is not equivalent to
-- verified, certified or compliant with a final regulatory act.

-- -----------------------------------------------------------------------------
-- 1. Product data fields
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE product_data_readiness AS ENUM ('not_started', 'in_progress', 'data_ready', 'needs_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tracefab_products
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS product_family TEXT,
  ADD COLUMN IF NOT EXISTS color_name TEXT,
  ADD COLUMN IF NOT EXISTS size_range TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS country_of_design VARCHAR(2),
  ADD COLUMN IF NOT EXISTS country_of_manufacture VARCHAR(2),
  ADD COLUMN IF NOT EXISTS weight_grams NUMERIC(10,2)
    CHECK (weight_grams IS NULL OR weight_grams >= 0),
  ADD COLUMN IF NOT EXISTS care_instructions JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS data_readiness product_data_readiness NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS data_completion NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (data_completion BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS data_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_data_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS product_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('gtin', 'ean', 'upc', 'internal')),
  identifier_value TEXT NOT NULL CHECK (length(trim(identifier_value)) > 0),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, identifier_type, identifier_value)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_primary
  ON product_identifiers(product_id, identifier_type)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_product_identifiers_product
  ON product_identifiers(product_id, identifier_type);

CREATE INDEX IF NOT EXISTS idx_products_data_readiness
  ON tracefab_products(brand_organization_id, data_readiness, data_completion);

-- -----------------------------------------------------------------------------
-- 2. Product ownership and composition integrity
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_product_brand_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_type organization_type;
BEGIN
  SELECT type INTO v_org_type
  FROM organizations
  WHERE id = NEW.brand_organization_id;

  IF v_org_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'product_requires_brand_organization';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.brand_organization_id IS DISTINCT FROM NEW.brand_organization_id THEN
    RAISE EXCEPTION 'product_brand_organization_is_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.version IS DISTINCT FROM NEW.version
       OR OLD.data_completion IS DISTINCT FROM NEW.data_completion
       OR OLD.data_readiness IS DISTINCT FROM NEW.data_readiness
       OR OLD.data_ready_at IS DISTINCT FROM NEW.data_ready_at
     )
     AND COALESCE(current_setting('tracefab.internal_product_revision', true), 'false') <> 'true'
     AND COALESCE(current_setting('tracefab.internal_product_readiness_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'computed_product_fields_are_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER products_validate_brand_ownership
    BEFORE INSERT OR UPDATE ON tracefab_products
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_product_brand_ownership();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_product_material_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_organization_id UUID;
  v_material_organization_id UUID;
BEGIN
  SELECT p.brand_organization_id
  INTO v_brand_organization_id
  FROM tracefab_products p
  WHERE p.id = NEW.product_id;

  IF v_brand_organization_id IS NULL THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  SELECT m.owner_organization_id
  INTO v_material_organization_id
  FROM materials m
  WHERE m.id = NEW.material_id;

  IF v_material_organization_id IS NULL THEN
    RAISE EXCEPTION 'material_not_found';
  END IF;

  IF v_material_organization_id <> v_brand_organization_id
     AND NOT tracefab_can_access_shared_subject(
       v_material_organization_id,
       'material',
       NEW.material_id
     ) THEN
    RAISE EXCEPTION 'material_not_shared_with_product_brand';
  END IF;

  IF NEW.product_version <> (SELECT p.version FROM tracefab_products p WHERE p.id = NEW.product_id) THEN
    RAISE EXCEPTION 'product_material_version_must_match_current_product_version';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER product_materials_validate_ownership
    BEFORE INSERT OR UPDATE ON product_materials
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_product_material_ownership();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Product data readiness computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_calculate_product_data_completion(p_product_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_count INTEGER;
  v_materials_with_percentage INTEGER;
  v_percentage_total NUMERIC;
  v_has_identifier BOOLEAN;
  v_has_product_data_point BOOLEAN;
  v_completed INTEGER := 0;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Seven deliberately explicit MVP requirements. Presence is not verification.
  IF length(trim(COALESCE(v_product.reference, ''))) > 0
     AND length(trim(COALESCE(v_product.name, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_product.category, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_product.description, ''))) >= 30 THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM product_identifiers i
    WHERE i.product_id = p_product_id
      AND (i.identifier_type = 'internal' OR i.is_primary = true)
  ) OR length(trim(COALESCE(v_product.sku, ''))) > 0
  INTO v_has_identifier;

  IF v_has_identifier THEN
    v_completed := v_completed + 1;
  END IF;

  IF v_product.country_of_manufacture IS NOT NULL
     AND length(trim(v_product.country_of_manufacture)) = 2 THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE pm.percentage IS NOT NULL),
    COALESCE(SUM(pm.percentage), 0)
  INTO v_material_count, v_materials_with_percentage, v_percentage_total
  FROM product_materials pm
  WHERE pm.product_id = p_product_id
    AND pm.product_version = v_product.version;

  IF v_material_count > 0
     AND v_materials_with_percentage = v_material_count
     AND abs(v_percentage_total - 100) < 0.01 THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM data_points dp
    WHERE dp.product_id = p_product_id
      AND dp.status NOT IN ('expired', 'needs_review')
  ) INTO v_has_product_data_point;

  IF v_has_product_data_point THEN
    v_completed := v_completed + 1;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM data_points dp
    WHERE dp.product_id = p_product_id
      AND dp.status IN ('expired', 'needs_review')
  ) INTO v_needs_review;

  RETURN round((v_completed::NUMERIC / 7) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_readiness(p_product_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completion NUMERIC(5,2);
  v_needs_review BOOLEAN;
  v_readiness product_data_readiness;
BEGIN
  v_completion := tracefab_calculate_product_data_completion(p_product_id);

  SELECT EXISTS (
    SELECT 1 FROM data_points dp
    WHERE dp.product_id = p_product_id
      AND dp.status IN ('expired', 'needs_review')
  ) INTO v_needs_review;

  v_readiness := CASE
    WHEN v_needs_review THEN 'needs_review'::product_data_readiness
    WHEN v_completion = 100 THEN 'data_ready'::product_data_readiness
    WHEN v_completion = 0 THEN 'not_started'::product_data_readiness
    ELSE 'in_progress'::product_data_readiness
  END;

  PERFORM set_config('tracefab.internal_product_readiness_update', 'true', true);

  UPDATE tracefab_products
  SET data_completion = v_completion,
      data_readiness = v_readiness,
      data_ready_at = CASE
        WHEN v_readiness = 'data_ready' AND data_ready_at IS NULL THEN now()
        WHEN v_readiness <> 'data_ready' THEN NULL
        ELSE data_ready_at
      END
  WHERE id = p_product_id;

  PERFORM set_config('tracefab.internal_product_readiness_update', 'false', true);
  RETURN v_completion;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_material()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
    RETURN OLD;
  END IF;

  PERFORM tracefab_refresh_product_data_readiness(NEW.product_id);
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_identifier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
    RETURN OLD;
  END IF;
  PERFORM tracefab_refresh_product_data_readiness(NEW.product_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_data_point()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.product_id IS NOT NULL THEN
      PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    PERFORM tracefab_refresh_product_data_readiness(NEW.product_id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id
     AND OLD.product_id IS NOT NULL THEN
    PERFORM tracefab_refresh_product_data_readiness(OLD.product_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_product_data_from_product()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM tracefab_refresh_product_data_readiness(NEW.id);
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER products_data_readiness_after_change
    AFTER INSERT OR UPDATE OF reference, sku, name, category, description,
      country_of_manufacture, version
    ON tracefab_products
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_product();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER product_materials_refresh_data_readiness
    AFTER INSERT OR UPDATE OR DELETE ON product_materials
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_material();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER product_identifiers_refresh_data_readiness
    AFTER INSERT OR UPDATE OR DELETE ON product_identifiers
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_identifier();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER data_points_refresh_product_readiness
    AFTER INSERT OR UPDATE OR DELETE ON data_points
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_product_data_from_data_point();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 4. Product mutation functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_product(
  p_brand_organization_id UUID,
  p_reference TEXT,
  p_name TEXT,
  p_category TEXT DEFAULT NULL,
  p_sku TEXT DEFAULT NULL
)
RETURNS tracefab_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_org_type organization_type;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  SELECT type INTO v_org_type
  FROM organizations
  WHERE id = p_brand_organization_id;

  IF v_org_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'brand_organization_required';
  END IF;

  INSERT INTO tracefab_products (
    brand_organization_id,
    reference,
    sku,
    name,
    category,
    created_by,
    last_data_updated_by
  )
  VALUES (
    p_brand_organization_id,
    trim(p_reference),
    NULLIF(trim(p_sku), ''),
    trim(p_name),
    NULLIF(trim(p_category), ''),
    auth.uid(),
    auth.uid()
  )
  RETURNING * INTO v_product;

  PERFORM tracefab_refresh_product_data_readiness(v_product.id);
  SELECT p.* INTO v_product
  FROM tracefab_products p
  WHERE p.id = v_product.id;

  RETURN v_product;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_product_data(
  p_product_id UUID,
  p_reference TEXT,
  p_sku TEXT,
  p_name TEXT,
  p_category TEXT,
  p_description TEXT,
  p_product_family TEXT,
  p_color_name TEXT,
  p_size_range TEXT[],
  p_country_of_design VARCHAR(2),
  p_country_of_manufacture VARCHAR(2),
  p_weight_grams NUMERIC,
  p_care_instructions JSONB
)
RETURNS tracefab_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  UPDATE tracefab_products
  SET reference = trim(p_reference),
      sku = NULLIF(trim(p_sku), ''),
      name = trim(p_name),
      category = NULLIF(trim(p_category), ''),
      description = NULLIF(trim(p_description), ''),
      product_family = NULLIF(trim(p_product_family), ''),
      color_name = NULLIF(trim(p_color_name), ''),
      size_range = COALESCE(p_size_range, '{}'::TEXT[]),
      country_of_design = upper(NULLIF(trim(p_country_of_design), '')),
      country_of_manufacture = upper(NULLIF(trim(p_country_of_manufacture), '')),
      weight_grams = p_weight_grams,
      care_instructions = COALESCE(p_care_instructions, '{}'::jsonb),
      last_data_updated_by = auth.uid()
  WHERE id = p_product_id;

  PERFORM tracefab_refresh_product_data_readiness(p_product_id);

  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  RETURN v_product;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_start_product_revision(p_product_id UUID)
RETURNS tracefab_products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_manager_role_required';
  END IF;

  PERFORM set_config('tracefab.internal_product_revision', 'true', true);

  UPDATE tracefab_products
  SET version = version + 1,
      data_completion = 0,
      data_readiness = 'in_progress',
      data_ready_at = NULL,
      last_data_updated_by = auth.uid()
  WHERE id = p_product_id
  RETURNING * INTO v_product;

  PERFORM tracefab_refresh_product_data_readiness(p_product_id);
  SELECT p.* INTO v_product
  FROM tracefab_products p
  WHERE p.id = p_product_id;

  PERFORM set_config('tracefab.internal_product_revision', 'false', true);
  RETURN v_product;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS for product identifiers
-- -----------------------------------------------------------------------------

ALTER TABLE product_identifiers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON product_identifiers TO authenticated;

CREATE POLICY product_identifiers_select_brand ON product_identifiers
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

CREATE POLICY product_identifiers_insert_brand ON product_identifiers
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

CREATE POLICY product_identifiers_update_brand ON product_identifiers
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = product_identifiers.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

-- -----------------------------------------------------------------------------
-- 6. Function privileges and documentation
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_product_brand_ownership() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_product_material_ownership() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_calculate_product_data_completion(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_readiness(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_material() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_identifier() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_data_point() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_product_data_from_product() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_create_product(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_product_data(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], VARCHAR, VARCHAR, NUMERIC, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_start_product_revision(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_create_product(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_update_product_data(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], VARCHAR, VARCHAR, NUMERIC, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_start_product_revision(UUID) TO authenticated;

COMMENT ON COLUMN tracefab_products.data_completion IS 'Computed product data completeness; it is not a verification or certification score.';
COMMENT ON COLUMN tracefab_products.data_readiness IS 'Operational readiness state for product data, distinct from product lifecycle status.';
COMMENT ON TABLE product_identifiers IS 'Product identifiers scoped to a product. External identifier uniqueness rules remain integration-specific.';
COMMENT ON FUNCTION tracefab_calculate_product_data_completion(UUID) IS 'Computes seven explicit MVP product-data requirements; data ready is not regulatory compliance.';
COMMENT ON FUNCTION tracefab_start_product_revision(UUID) IS 'Starts a new product composition/data revision; historical snapshots remain a later concern.';
