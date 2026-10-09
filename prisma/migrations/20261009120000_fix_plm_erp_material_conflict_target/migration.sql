-- Correction de tracefab_ingest_plm_erp_payload : cible ON CONFLICT invalide.
--
-- DÉFAUT
--   L'ingestion PLM/ERP insérait la composition avec
--       ON CONFLICT (product_id, material_id)
--   alors que la clé primaire de product_materials est
--       (product_id, material_id, material_role, product_version)
--   PostgreSQL n'accepte qu'une cible correspondant exactement à une contrainte
--   d'unicité existante. Résultat : 42P10, et la procédure échouait au premier
--   matériau — elle n'a jamais pu terminer une ingestion.
--
-- DÉCOUVERTE
--   En exécutant test:neon:plm-erp-gs1 contre un PostgreSQL réel. Ni la lecture
--   du SQL ni la validation du schéma Prisma ne pouvaient le révéler : le corps
--   d'une fonction n'est pas analysé par rapport aux contraintes des tables.
--
-- Les migrations étant immuables une fois appliquées, la fonction est redéfinie
-- ici intégralement plutôt que modifiée sur place.

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

    SELECT id INTO v_product_id
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
        percentage,
        unit
      ) VALUES (
        v_product_id,
        v_mat_id,
        v_mat_role,
        v_mat_pct,
        '%'
      )
      /*
       * La cible de conflit DOIT être la clé primaire complète :
       *   PRIMARY KEY (product_id, material_id, material_role, product_version)
       *
       * La version d'origine indiquait (product_id, material_id). PostgreSQL
       * exige qu'une cible ON CONFLICT corresponde exactement à une contrainte
       * d'unicité existante ; sur deux colonnes seulement, aucune ne correspond
       * et l'ingestion échoue en 42P10 « there is no unique or exclusion
       * constraint matching the ON CONFLICT specification » — dès le premier
       * matériau du premier produit. La procédure n'avait donc jamais pu
       * s'exécuter jusqu'au bout.
       *
       * `material_role = EXCLUDED.material_role` est retiré du DO UPDATE : ce
       * champ fait partie de la cible de conflit, l'y réécrire est au mieux
       * inutile, au pire trompeur sur l'intention.
       */
      ON CONFLICT (product_id, material_id, material_role, product_version)
      DO UPDATE SET
        percentage = EXCLUDED.percentage,
        unit = EXCLUDED.unit;
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
      FROM supply_chain_nodes
      WHERE product_id = v_product_id AND label = v_step_label;

      IF v_node_id IS NULL THEN
        /*
         * `country_code` et `created_by` n'existent pas sur supply_chain_nodes :
         * la table porte `metadata` (JSONB) et `declared_by`. La version
         * d'origine visait un schéma qui n'a jamais existé, et l'ingestion
         * échouait en 42703 dès la première étape de production.
         *
         * Le pays va dans `metadata` : c'est un attribut déclaratif de l'étape,
         * pas une colonne de premier ordre — et en inventer une ici créerait une
         * colonne que rien d'autre ne lit.
         */
        /*
         * PAS de product_id ici.
         *
         * Le trigger tracefab_node_requires_exactly_one_reference impose
         * exactement UNE référence parmi (organization_id, supplier_site_id,
         * product_id, material_id, process_code) — num_nonnulls() <> 1 lève.
         * Un nœud d'étape de production référence son process_code, et c'est
         * tout ; le rattachement au produit passe par supply_chain_links, qui
         * porte bien product_id. Poser les deux faisait échouer l'insertion.
         */
        INSERT INTO supply_chain_nodes (
          node_type,
          label,
          process_code,
          metadata,
          declared_by
        ) VALUES (
          'process',
          v_step_label,
          v_step_process,
          CASE WHEN v_step_country IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('country_code', v_step_country) END,
          v_user_id
        )
        RETURNING id INTO v_node_id;
        v_count_nodes := v_count_nodes + 1;
      END IF;

      IF v_prev_node_id IS NOT NULL AND v_prev_node_id <> v_node_id THEN
        /* `created_by` n'existe pas non plus sur supply_chain_links : `declared_by`. */
        INSERT INTO supply_chain_links (
          product_id,
          source_node_id,
          target_node_id,
          link_type,
          declared_by
        ) VALUES (
          v_product_id,
          v_prev_node_id,
          v_node_id,
          'next_step',
          v_user_id
        )
        ON CONFLICT DO NOTHING;
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

COMMENT ON FUNCTION tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) IS
  'Automated ingestion pipeline from enterprise PLM/ERP systems (Centric, Lectra, SAP, GS1) into Tracefab products, materials, GTINs, and supply chain graphs. '
  'Corrigé : la cible ON CONFLICT de product_materials est la clé primaire complète.';
