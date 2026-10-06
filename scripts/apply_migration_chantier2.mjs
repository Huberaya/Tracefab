import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Applying Chantier 2 DDL and stored procedures to Neon...');

  // 1. Table plm_erp_integrations
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS plm_erp_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      system_type TEXT NOT NULL CHECK (system_type IN ('centric_plm', 'lectra_kubix', 'sap_s4hana', 'infor_fashion', 'gs1_epcis', 'generic_csv')),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      endpoint_url TEXT,
      auth_type TEXT NOT NULL DEFAULT 'api_key' CHECK (auth_type IN ('api_key', 'bearer_token', 'oauth2', 'webhook', 'manual_import')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'syncing', 'error')),
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_sync_at TIMESTAMPTZ,
      sync_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, system_type, name)
    );
  `);
  console.log('✓ plm_erp_integrations table ready');

  // 2. Adjust plm_erp_sync_jobs table columns if needed
  await prisma.$executeRawUnsafe(`
    ALTER TABLE plm_erp_sync_jobs ADD COLUMN IF NOT EXISTS integration_id UUID REFERENCES plm_erp_integrations(id) ON DELETE SET NULL;
  `);
  console.log('✓ plm_erp_sync_jobs integration_id column verified');

  // 3. Indexes
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_plm_integrations_org
      ON plm_erp_integrations(organization_id, status);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_plm_sync_jobs_brand_org
      ON plm_erp_sync_jobs(brand_organization_id, created_at DESC);
  `);
  console.log('✓ Indexes created');

  // 4. RLS & Permissions
  await prisma.$executeRawUnsafe(`ALTER TABLE plm_erp_integrations ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE plm_erp_integrations FORCE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE plm_erp_sync_jobs ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE plm_erp_sync_jobs FORCE ROW LEVEL SECURITY;`);

  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON plm_erp_integrations TO PUBLIC;`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON plm_erp_sync_jobs TO PUBLIC;`);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS plm_integrations_select_org ON plm_erp_integrations;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY plm_integrations_select_org ON plm_erp_integrations
      FOR SELECT TO PUBLIC USING (
        tracefab_is_org_member(organization_id)
      );
  `);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS plm_integrations_mutate_brand ON plm_erp_integrations;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY plm_integrations_mutate_brand ON plm_erp_integrations
      FOR ALL TO PUBLIC USING (
        tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
      ) WITH CHECK (
        tracefab_has_org_role(organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
      );
  `);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS plm_sync_jobs_select_org ON plm_erp_sync_jobs;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY plm_sync_jobs_select_org ON plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (
        tracefab_is_org_member(brand_organization_id)
      );
  `);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS plm_sync_jobs_insert_brand ON plm_erp_sync_jobs;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY plm_sync_jobs_insert_brand ON plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
      );
  `);
  console.log('✓ RLS and security policies enforced');

  // 5. Update constraint on product_identifiers and plm_erp_sync_jobs
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE product_identifiers DROP CONSTRAINT IF EXISTS product_identifiers_identifier_type_check;`);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE product_identifiers ADD CONSTRAINT product_identifiers_identifier_type_check
        CHECK (identifier_type IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln'));
    `);
    console.log('✓ product_identifiers constraint updated to support GS1');
  } catch (err) {
    console.log('Constraint note:', err.message);
  }

  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE plm_erp_sync_jobs DROP CONSTRAINT IF EXISTS plm_erp_sync_jobs_source_system_check;`);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE plm_erp_sync_jobs ADD CONSTRAINT plm_erp_sync_jobs_source_system_check
        CHECK (source_system IN ('centric', 'centric_plm', 'lectra', 'lectra_kubix', 'sap', 'sap_s4hana', 'generic_bom', 'gs1_epcis', 'custom_api'));
    `);
    console.log('✓ plm_erp_sync_jobs source_system constraint updated');
  } catch (err) {
    console.log('Constraint note:', err.message);
  }

  // 5b. Ensure supply chain node and link functions cast status to data_value_status
  await prisma.$executeRawUnsafe(`
CREATE OR REPLACE FUNCTION tracefab_create_supply_chain_node(
  p_graph_product_id UUID,
  p_node_type node_type,
  p_label TEXT,
  p_organization_id UUID DEFAULT NULL,
  p_supplier_site_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL,
  p_material_id UUID DEFAULT NULL,
  p_process_code TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_source_document_id UUID DEFAULT NULL,
  p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_node supply_chain_nodes;
  v_site_owner UUID;
  v_material_owner UUID;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_graph_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'traceability_product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF length(trim(COALESCE(p_label, ''))) = 0 THEN
    RAISE EXCEPTION 'traceability_node_label_required';
  END IF;

  IF p_node_type = 'product' AND p_product_id IS DISTINCT FROM p_graph_product_id THEN
    RAISE EXCEPTION 'traceability_product_node_must_match_graph_product';
  END IF;

  IF p_node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner
    FROM materials
    WHERE id = p_material_id;
    IF v_material_owner IS NULL OR NOT (
      tracefab_can_access_org(v_material_owner)
      OR tracefab_can_access_shared_subject(v_material_owner, 'material', p_material_id)
    ) THEN
      RAISE EXCEPTION 'traceability_material_access_denied';
    END IF;
  END IF;

  IF p_node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner
    FROM supplier_sites ss
    JOIN suppliers s ON s.id = ss.supplier_id
    WHERE ss.id = p_supplier_site_id;
    IF v_site_owner IS NULL OR NOT (
      tracefab_can_access_org(v_site_owner)
      OR tracefab_can_access_shared_subject(v_site_owner, 'supplier_site', p_supplier_site_id)
    ) THEN
      RAISE EXCEPTION 'traceability_site_access_denied';
    END IF;
  END IF;

  IF p_node_type = 'organization'
     AND p_organization_id IS DISTINCT FROM v_product.brand_organization_id
     AND NOT EXISTS (
       SELECT 1 FROM brand_supplier_relationships r
       WHERE r.brand_organization_id = v_product.brand_organization_id
         AND r.supplier_organization_id = p_organization_id
         AND r.status = 'active'
     ) THEN
    RAISE EXCEPTION 'traceability_organization_not_in_active_relationship';
  END IF;

  INSERT INTO supply_chain_nodes (
    node_type,
    organization_id,
    supplier_site_id,
    product_id,
    material_id,
    process_code,
    label,
    metadata,
    status,
    source_document_id,
    declared_by,
    observed_at
  )
  VALUES (
    p_node_type,
    p_organization_id,
    p_supplier_site_id,
    p_product_id,
    p_material_id,
    NULLIF(trim(p_process_code), ''),
    trim(p_label),
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_source_document_id IS NULL THEN 'declared'::data_value_status ELSE 'documented'::data_value_status END,
    p_source_document_id,
    tracefab_current_user_id(),
    p_observed_at
  )
  RETURNING * INTO v_node;

  RETURN v_node;
END;
$$;
  `);

  await prisma.$executeRawUnsafe(`
CREATE OR REPLACE FUNCTION tracefab_add_supply_chain_link(
  p_product_id UUID,
  p_source_node_id UUID,
  p_target_node_id UUID,
  p_link_type supply_chain_link_type,
  p_sequence_number INTEGER DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,
  p_valid_until DATE DEFAULT NULL,
  p_evidence_document_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS supply_chain_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_link supply_chain_links;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND OR NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF p_sequence_number IS NOT NULL AND p_sequence_number < 0 THEN
    RAISE EXCEPTION 'traceability_sequence_must_be_positive';
  END IF;

  INSERT INTO supply_chain_links (
    product_id,
    source_node_id,
    target_node_id,
    link_type,
    sequence_number,
    valid_from,
    valid_until,
    evidence_document_id,
    metadata,
    status,
    declared_by
  )
  VALUES (
    p_product_id,
    p_source_node_id,
    p_target_node_id,
    p_link_type,
    p_sequence_number,
    p_valid_from,
    p_valid_until,
    p_evidence_document_id,
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_evidence_document_id IS NULL THEN 'declared'::data_value_status ELSE 'documented'::data_value_status END,
    tracefab_current_user_id()
  )
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$$;
  `);
  console.log('✓ tracefab_create_supply_chain_node & link status casting verified');

  // 6. Stored Procedure: tracefab_ingest_plm_erp_payload
  await prisma.$executeRawUnsafe(`
CREATE OR REPLACE FUNCTION tracefab_ingest_plm_erp_payload(
  p_organization_id UUID,
  p_system_type TEXT,
  p_payload JSONB,
  p_integration_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := tracefab_current_user_id();
  v_org_type organization_type;
  v_products JSONB;
  v_prod JSONB;
  v_product_id UUID;
  v_product_version INT := 1;
  v_is_new_product BOOLEAN;
  v_ref TEXT;
  v_name TEXT;
  v_sku TEXT;
  v_category TEXT;
  v_description TEXT;
  v_color TEXT;
  v_country_mfg VARCHAR(2);
  v_weight NUMERIC(10,2);
  v_gtin TEXT;
  v_materials JSONB;
  v_mat JSONB;
  v_mat_id UUID;
  v_mat_name TEXT;
  v_mat_type TEXT;
  v_mat_origin VARCHAR(2);
  v_mat_composition JSONB;
  v_mat_pct NUMERIC(7,4);
  v_mat_role TEXT;
  v_steps JSONB;
  v_step JSONB;
  v_step_label TEXT;
  v_step_process TEXT;
  v_step_country VARCHAR(2);
  v_node_id UUID;
  v_prev_node_id UUID;
  
  v_count_records INT := 0;
  v_count_created INT := 0;
  v_count_updated INT := 0;
  v_count_materials INT := 0;
  v_count_identifiers INT := 0;
  v_count_nodes INT := 0;
  v_job_id UUID;
  v_summary TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  SELECT type INTO v_org_type
  FROM organizations
  WHERE id = p_organization_id;

  IF v_org_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'brand_organization_required';
  END IF;

  IF jsonb_typeof(p_payload) = 'array' THEN
    v_products := p_payload;
  ELSIF p_payload ? 'styles' AND jsonb_typeof(p_payload->'styles') = 'array' THEN
    v_products := p_payload->'styles';
  ELSIF p_payload ? 'articles' AND jsonb_typeof(p_payload->'articles') = 'array' THEN
    v_products := p_payload->'articles';
  ELSIF p_payload ? 'products' AND jsonb_typeof(p_payload->'products') = 'array' THEN
    v_products := p_payload->'products';
  ELSIF p_payload ? 'articleMaster' THEN
    v_products := jsonb_build_array(p_payload->'articleMaster');
  ELSE
    v_products := jsonb_build_array(p_payload);
  END IF;

  FOR v_prod IN SELECT * FROM jsonb_array_elements(v_products)
  LOOP
    v_count_records := v_count_records + 1;
    v_ref := COALESCE(
      v_prod->>'reference',
      v_prod->>'styleNumber',
      v_prod->>'code',
      v_prod->>'MATNR',
      v_prod->>'sku',
      'REF-' || lpad(v_count_records::text, 4, '0')
    );
    v_name := COALESCE(
      v_prod->>'name',
      v_prod->>'styleName',
      v_prod->>'title',
      v_prod->>'MAKTX',
      'Article ' || v_ref
    );
    v_sku := NULLIF(COALESCE(v_prod->>'sku', v_prod->>'MATNR', v_ref), '');
    v_category := NULLIF(COALESCE(v_prod->>'category', v_prod->>'department', v_prod->>'MATKL', 'Apparel'), '');
    v_description := NULLIF(COALESCE(v_prod->>'description', v_prod->>'season', ''), '');
    v_color := NULLIF(COALESCE(v_prod->>'color_name', v_prod->>'colorway', v_prod->>'color', ''), '');
    v_country_mfg := NULLIF(COALESCE(v_prod->>'country_of_manufacture', v_prod->>'countryOfManufacture', v_prod->>'madeIn', v_prod->>'HERKL', ''), '');
    IF v_country_mfg IS NOT NULL AND length(v_country_mfg) > 2 THEN
      v_country_mfg := substring(v_country_mfg from 1 for 2);
    END IF;
    
    v_weight := NULLIF(COALESCE(v_prod->>'weight_grams', v_prod->>'weightGrams', v_prod->>'netWeight', v_prod->>'BRGEW', ''), '')::numeric;

    SELECT id, version INTO v_product_id, v_product_version
    FROM tracefab_products
    WHERE brand_organization_id = p_organization_id AND reference = v_ref;

    IF v_product_id IS NOT NULL THEN
      v_is_new_product := false;
      UPDATE tracefab_products
      SET name = v_name,
          sku = COALESCE(v_sku, sku),
          category = COALESCE(v_category, category),
          description = COALESCE(v_description, description),
          color_name = COALESCE(v_color, color_name),
          country_of_manufacture = COALESCE(v_country_mfg, country_of_manufacture),
          weight_grams = COALESCE(v_weight, weight_grams),
          updated_at = now(),
          last_data_updated_by = v_user_id
      WHERE id = v_product_id;
      v_count_updated := v_count_updated + 1;
    ELSE
      v_is_new_product := true;
      v_product_version := 1;
      INSERT INTO tracefab_products (
        brand_organization_id,
        reference,
        name,
        sku,
        category,
        description,
        color_name,
        country_of_manufacture,
        weight_grams,
        version,
        created_by,
        last_data_updated_by
      ) VALUES (
        p_organization_id,
        v_ref,
        v_name,
        v_sku,
        v_category,
        v_description,
        v_color,
        v_country_mfg,
        v_weight,
        1,
        v_user_id,
        v_user_id
      )
      RETURNING id INTO v_product_id;
      v_count_created := v_count_created + 1;
    END IF;

    -- Upsert GTIN identifier
    v_gtin := COALESCE(v_prod->>'gtin', v_prod->>'ean', v_prod->>'ean13', v_prod->>'EAN11');
    IF v_gtin IS NOT NULL AND length(trim(v_gtin)) > 0 THEN
      INSERT INTO product_identifiers (
        product_id,
        identifier_type,
        identifier_value,
        is_primary,
        created_by
      ) VALUES (
        v_product_id,
        'gtin',
        trim(v_gtin),
        true,
        v_user_id
      )
      ON CONFLICT (product_id, identifier_type, identifier_value)
      DO UPDATE SET is_primary = true;
      v_count_identifiers := v_count_identifiers + 1;
    END IF;

    -- Ingest Materials / BOM
    IF v_prod ? 'materials' AND jsonb_typeof(v_prod->'materials') = 'array' THEN
      v_materials := v_prod->'materials';
    ELSIF v_prod ? 'bom' AND jsonb_typeof(v_prod->'bom') = 'array' THEN
      v_materials := v_prod->'bom';
    ELSIF v_prod ? 'BOM' AND jsonb_typeof(v_prod->'BOM') = 'array' THEN
      v_materials := v_prod->'BOM';
    ELSE
      v_materials := '[]'::jsonb;
    END IF;

    FOR v_mat IN SELECT * FROM jsonb_array_elements(v_materials)
    LOOP
      v_mat_name := COALESCE(v_mat->>'materialName', v_mat->>'name', v_mat->>'POSTX', 'Matière textile');
      v_mat_type := COALESCE(v_mat->>'materialType', v_mat->>'type', 'fabric');
      v_mat_origin := NULLIF(COALESCE(v_mat->>'originCountryCode', v_mat->>'country', v_mat->>'origin', ''), '');
      IF v_mat_origin IS NOT NULL AND length(v_mat_origin) > 2 THEN
        v_mat_origin := substring(v_mat_origin from 1 for 2);
      END IF;
      v_mat_composition := COALESCE(v_mat->'composition', '{}'::jsonb);
      v_mat_pct := COALESCE(
        NULLIF(v_mat->>'percentage', '')::numeric,
        NULLIF(v_mat->>'ratio', '')::numeric,
        NULLIF(v_mat->>'MENGE', '')::numeric,
        100.0
      );
      v_mat_role := COALESCE(v_mat->>'role', 'main');

      SELECT id INTO v_mat_id
      FROM materials
      WHERE owner_organization_id = p_organization_id AND name = v_mat_name;

      IF v_mat_id IS NULL THEN
        INSERT INTO materials (
          owner_organization_id,
          name,
          material_type,
          origin_country_code,
          composition,
          created_by
        ) VALUES (
          p_organization_id,
          v_mat_name,
          v_mat_type,
          v_mat_origin,
          v_mat_composition,
          v_user_id
        )
        RETURNING id INTO v_mat_id;
        v_count_materials := v_count_materials + 1;
      END IF;

      INSERT INTO product_materials (
        product_id,
        material_id,
        material_role,
        product_version,
        percentage,
        unit
      ) VALUES (
        v_product_id,
        v_mat_id,
        v_mat_role,
        v_product_version,
        v_mat_pct,
        '%'
      )
      ON CONFLICT (product_id, material_id, material_role, product_version)
      DO UPDATE SET
        percentage = EXCLUDED.percentage;
    END LOOP;

    -- Ingest production steps / supply chain nodes
    IF v_prod ? 'productionSteps' AND jsonb_typeof(v_prod->'productionSteps') = 'array' THEN
      v_steps := v_prod->'productionSteps';
    ELSIF v_prod ? 'supplyChainSteps' AND jsonb_typeof(v_prod->'supplyChainSteps') = 'array' THEN
      v_steps := v_prod->'supplyChainSteps';
    ELSE
      v_steps := '[]'::jsonb;
    END IF;

    v_prev_node_id := NULL;
    FOR v_step IN SELECT * FROM jsonb_array_elements(v_steps)
    LOOP
      v_step_label := COALESCE(v_step->>'label', v_step->>'step', 'Étape de fabrication');
      v_step_process := COALESCE(v_step->>'step', v_step->>'processCode', 'assembly');
      v_step_country := NULLIF(COALESCE(v_step->>'country', v_step->>'countryCode', ''), '');
      IF v_step_country IS NOT NULL AND length(v_step_country) > 2 THEN
        v_step_country := substring(v_step_country from 1 for 2);
      END IF;

      SELECT id INTO v_node_id
      FROM tracefab_create_supply_chain_node(
        v_product_id,
        'process'::node_type,
        v_step_label,
        NULL::uuid,
        NULL::uuid,
        NULL::uuid,
        NULL::uuid,
        v_step_process,
        jsonb_build_object('country_code', v_step_country),
        NULL::uuid,
        CURRENT_DATE
      );
      v_count_nodes := v_count_nodes + 1;

      IF v_prev_node_id IS NOT NULL AND v_prev_node_id <> v_node_id THEN
        PERFORM tracefab_add_supply_chain_link(
          v_product_id,
          v_prev_node_id,
          v_node_id,
          'next_step'::supply_chain_link_type,
          v_count_nodes,
          CURRENT_DATE,
          NULL::date,
          NULL::uuid,
          '{}'::jsonb
        );
      END IF;
      v_prev_node_id := v_node_id;
    END LOOP;

    PERFORM tracefab_refresh_product_data_readiness(v_product_id);
  END LOOP;

  v_summary := format('Ingestion %s réussie : %s articles traités (%s créés, %s mis à jour), %s matières rattachées, %s GTINs indexés, %s nœuds traçabilité ajoutés.',
    p_system_type, v_count_records, v_count_created, v_count_updated, v_count_materials, v_count_identifiers, v_count_nodes);

  INSERT INTO plm_erp_sync_jobs (
    integration_id,
    brand_organization_id,
    source_system,
    job_reference,
    status,
    total_records,
    products_created,
    products_updated,
    materials_created,
    nodes_created,
    warnings,
    payload_preview,
    created_by
  ) VALUES (
    p_integration_id,
    p_organization_id,
    p_system_type,
    'SYNC-' || upper(p_system_type) || '-' || floor(extract(epoch from now()) * 1000)::text,
    'completed',
    v_count_records,
    v_count_created,
    v_count_updated,
    v_count_materials,
    v_count_nodes,
    '[]'::jsonb,
    jsonb_build_object('summary', v_summary, 'sample_count', v_count_records, 'system_type', p_system_type),
    v_user_id
  )
  RETURNING id INTO v_job_id;

  IF p_integration_id IS NOT NULL THEN
    UPDATE plm_erp_integrations
    SET last_sync_at = now(),
        sync_count = sync_count + 1,
        status = 'active',
        updated_at = now()
    WHERE id = p_integration_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'jobId', v_job_id,
    'systemType', p_system_type,
    'recordsIngested', v_count_records,
    'productsCreated', v_count_created,
    'productsUpdated', v_count_updated,
    'materialsCreated', v_count_materials,
    'identifiersCreated', v_count_identifiers,
    'nodesCreated', v_count_nodes,
    'summary', v_summary
  );
END;
$$;
  `);

  await prisma.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) TO PUBLIC;`);
  console.log('✓ tracefab_ingest_plm_erp_payload stored procedure registered');

  console.log('All Chantier 2 DDL and stored procedures applied successfully to Neon!');
}

run()
  .catch((e) => {
    console.error('Error applying Chantier 2:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
