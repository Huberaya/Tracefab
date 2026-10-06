-- Versioned external schema registry and tenant-safe bindings.
-- JSON files remain the presentation/source catalogue; the registry is the
-- database allow-list used by SECURITY DEFINER binding functions.

CREATE TABLE IF NOT EXISTS tracefab_schema_catalog (
  schema_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  subject_types TEXT[] NOT NULL,
  title TEXT NOT NULL,
  checksum TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_key, schema_version),
  CHECK (cardinality(subject_types) > 0)
);

CREATE TABLE IF NOT EXISTS tracefab_schema_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  material_id UUID REFERENCES materials(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  data_request_id UUID REFERENCES data_requests(id) ON DELETE CASCADE,
  bound_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracefab_schema_binding_catalog_fk FOREIGN KEY (schema_key, schema_version)
    REFERENCES tracefab_schema_catalog(schema_key, schema_version),
  CONSTRAINT tracefab_schema_binding_one_subject CHECK (
    ((product_id IS NOT NULL)::int + (material_id IS NOT NULL)::int +
     (supplier_id IS NOT NULL)::int + (data_request_id IS NOT NULL)::int) = 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_binding_product
  ON tracefab_schema_bindings(schema_key, schema_version, product_id)
  WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_binding_material
  ON tracefab_schema_bindings(schema_key, schema_version, material_id)
  WHERE material_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_binding_supplier
  ON tracefab_schema_bindings(schema_key, schema_version, supplier_id)
  WHERE supplier_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_binding_request
  ON tracefab_schema_bindings(schema_key, schema_version, data_request_id)
  WHERE data_request_id IS NOT NULL;

INSERT INTO tracefab_schema_catalog(schema_key, schema_version, subject_types, title)
VALUES
  ('product-data-core', '1.0', ARRAY['product', 'data_request'], 'Product data core'),
  ('material-data-core', '1.0', ARRAY['material'], 'Material data core'),
  ('supplier-profile-core', '1.0', ARRAY['supplier'], 'Supplier profile core')
ON CONFLICT (schema_key, schema_version) DO UPDATE
SET subject_types = EXCLUDED.subject_types,
    title = EXCLUDED.title,
    active = true;

ALTER TABLE tracefab_schema_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracefab_schema_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY schema_catalog_select_public ON tracefab_schema_catalog
  FOR SELECT TO PUBLIC USING (active = true);

CREATE POLICY schema_bindings_select_authorized ON tracefab_schema_bindings
  FOR SELECT TO PUBLIC USING (
    (product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = tracefab_schema_bindings.product_id
        AND tracefab_can_access_org(p.brand_organization_id)
    ))
    OR (material_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM materials m
      WHERE m.id = tracefab_schema_bindings.material_id
        AND (tracefab_can_access_org(m.owner_organization_id)
          OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id))
    ))
    OR (supplier_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = tracefab_schema_bindings.supplier_id
        AND (tracefab_can_access_org(s.organization_id)
          OR tracefab_can_access_shared_subject(s.organization_id, 'supplier', s.id))
    ))
    OR (data_request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = tracefab_schema_bindings.data_request_id
        AND (tracefab_can_access_org(r.brand_organization_id)
          OR tracefab_can_access_org(r.supplier_organization_id))
    ))
  );

CREATE OR REPLACE FUNCTION tracefab_bind_schema(
  p_schema_key TEXT,
  p_schema_version TEXT,
  p_subject_type TEXT,
  p_subject_id UUID
)
RETURNS tracefab_schema_bindings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_binding tracefab_schema_bindings;
  v_catalog tracefab_schema_catalog;
  v_org_id UUID;
  v_supplier_id UUID;
  v_actor UUID := tracefab_current_user_id();
BEGIN
  SELECT * INTO v_catalog
  FROM tracefab_schema_catalog
  WHERE schema_key = p_schema_key AND schema_version = p_schema_version AND active = true;
  IF NOT FOUND OR NOT (p_subject_type = ANY(v_catalog.subject_types)) THEN
    RAISE EXCEPTION 'tracefab_schema_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  IF p_subject_type = 'product' THEN
    SELECT brand_organization_id INTO v_org_id FROM tracefab_products WHERE id = p_subject_id;
    IF v_org_id IS NULL OR NOT tracefab_has_org_role(v_org_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]) THEN
      RAISE EXCEPTION 'tracefab_schema_binding_forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_binding FROM tracefab_schema_bindings WHERE schema_key = p_schema_key AND schema_version = p_schema_version AND product_id = p_subject_id;
    IF FOUND THEN RETURN v_binding; END IF;
    INSERT INTO tracefab_schema_bindings(schema_key, schema_version, product_id, bound_by)
    VALUES (p_schema_key, p_schema_version, p_subject_id, v_actor)
    RETURNING * INTO v_binding;
  ELSIF p_subject_type = 'material' THEN
    SELECT owner_organization_id INTO v_org_id FROM materials WHERE id = p_subject_id;
    IF v_org_id IS NULL OR NOT tracefab_has_org_role(v_org_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]) THEN
      RAISE EXCEPTION 'tracefab_schema_binding_forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_binding FROM tracefab_schema_bindings WHERE schema_key = p_schema_key AND schema_version = p_schema_version AND material_id = p_subject_id;
    IF FOUND THEN RETURN v_binding; END IF;
    INSERT INTO tracefab_schema_bindings(schema_key, schema_version, material_id, bound_by)
    VALUES (p_schema_key, p_schema_version, p_subject_id, v_actor)
    RETURNING * INTO v_binding;
  ELSIF p_subject_type = 'supplier' THEN
    SELECT organization_id INTO v_org_id FROM suppliers WHERE id = p_subject_id;
    IF v_org_id IS NULL OR NOT tracefab_has_org_role(v_org_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]) THEN
      RAISE EXCEPTION 'tracefab_schema_binding_forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_binding FROM tracefab_schema_bindings WHERE schema_key = p_schema_key AND schema_version = p_schema_version AND supplier_id = p_subject_id;
    IF FOUND THEN RETURN v_binding; END IF;
    INSERT INTO tracefab_schema_bindings(schema_key, schema_version, supplier_id, bound_by)
    VALUES (p_schema_key, p_schema_version, p_subject_id, v_actor)
    RETURNING * INTO v_binding;
  ELSIF p_subject_type = 'data_request' THEN
    SELECT brand_organization_id, supplier_organization_id INTO v_org_id, v_supplier_id FROM data_requests WHERE id = p_subject_id;
    IF v_org_id IS NULL OR NOT (tracefab_has_org_role(v_org_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]) OR tracefab_is_org_member(v_supplier_id)) THEN
      RAISE EXCEPTION 'tracefab_schema_binding_forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_binding FROM tracefab_schema_bindings WHERE schema_key = p_schema_key AND schema_version = p_schema_version AND data_request_id = p_subject_id;
    IF FOUND THEN RETURN v_binding; END IF;
    INSERT INTO tracefab_schema_bindings(schema_key, schema_version, data_request_id, bound_by)
    VALUES (p_schema_key, p_schema_version, p_subject_id, v_actor)
    RETURNING * INTO v_binding;
  ELSE
    RAISE EXCEPTION 'tracefab_schema_subject_type_invalid' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    COALESCE(v_org_id, v_supplier_id), v_actor, 'schema.bound', 'tracefab_schema_binding', v_binding.id,
    jsonb_build_object('schemaKey', p_schema_key, 'schemaVersion', p_schema_version, 'subjectType', p_subject_type, 'subjectId', p_subject_id)
  );
  RETURN v_binding;
END;
$$;

REVOKE ALL ON FUNCTION tracefab_bind_schema(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_bind_schema(TEXT, TEXT, TEXT, UUID) TO PUBLIC;
GRANT SELECT ON tracefab_schema_catalog, tracefab_schema_bindings TO PUBLIC;
COMMENT ON TABLE tracefab_schema_bindings IS 'Tenant-scoped bindings from versioned external JSON schemas to products, materials, suppliers and data requests.';
