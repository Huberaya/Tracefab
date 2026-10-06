import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('Applying Chantier 3 DDL and stored procedures to Neon...');

  // 1. Table pef_emission_factors
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS pef_emission_factors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      factor_type TEXT NOT NULL CHECK (factor_type IN ('raw_material', 'process_step', 'transport_mode', 'end_of_life')),
      factor_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      carbon_kg_co2e NUMERIC(8,4) NOT NULL,
      water_m3 NUMERIC(8,4) NOT NULL DEFAULT 0,
      eutrophication_kg_p NUMERIC(8,5) NOT NULL DEFAULT 0,
      microplastics_risk TEXT NOT NULL DEFAULT 'A' CHECK (microplastics_risk IN ('A', 'B', 'C', 'D', 'E')),
      circularity_recyclability_pct NUMERIC(5,2) NOT NULL DEFAULT 85,
      source_reference TEXT NOT NULL DEFAULT 'PEFCR Apparel & Footwear 2024 / ADEME Base Empreinte',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ pef_emission_factors table verified');

  // Seed standard factors
  await prisma.$executeRawUnsafe(`
    INSERT INTO pef_emission_factors (factor_type, factor_key, name, category, unit, carbon_kg_co2e, water_m3, eutrophication_kg_p, microplastics_risk, circularity_recyclability_pct, source_reference)
    VALUES
      ('raw_material', 'cotton_conventional', 'Coton conventionnel', 'natural_plant', 'kg CO2e / kg', 4.8500, 8.5000, 0.00350, 'A', 90.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'cotton_organic', 'Coton Biologique Certifié (GOTS / OCS)', 'natural_plant', 'kg CO2e / kg', 2.1000, 2.2000, 0.00090, 'A', 95.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'linen', 'Lin d''Europe / Teillage mécanique', 'natural_plant', 'kg CO2e / kg', 1.4500, 0.8500, 0.00045, 'A', 98.00, 'ADEME Base Empreinte 2024'),
      ('raw_material', 'hemp', 'Chanvre textile', 'natural_plant', 'kg CO2e / kg', 1.3000, 0.7000, 0.00040, 'A', 98.00, 'ADEME Base Empreinte 2024'),
      ('raw_material', 'viscose_conventional', 'Viscose conventionnelle', 'manmade_cellulosic', 'kg CO2e / kg', 5.2000, 3.4000, 0.00280, 'A', 80.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'lyocell_tencel', 'Lyocell / Tencel boucle fermée', 'manmade_cellulosic', 'kg CO2e / kg', 2.3000, 1.1000, 0.00075, 'A', 92.00, 'Lenzing EPD / PEFCR 2024'),
      ('raw_material', 'wool_conventional', 'Laine conventionnelle', 'natural_animal', 'kg CO2e / kg', 24.5000, 4.2000, 0.01250, 'A', 85.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'wool_rws', 'Laine Certifiée RWS / Éco-pâturage', 'natural_animal', 'kg CO2e / kg', 14.8000, 2.5000, 0.00620, 'A', 92.00, 'RWS / PEFCR 2024'),
      ('raw_material', 'silk', 'Soie naturelle de mûrier', 'natural_animal', 'kg CO2e / kg', 18.2000, 5.1000, 0.00840, 'A', 80.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'polyester_virgin', 'Polyester Vierge (PET)', 'synthetic', 'kg CO2e / kg', 5.6000, 0.1200, 0.00180, 'D', 65.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'polyester_recycled', 'Polyester Recyclé Certifié (GRS / rPET)', 'synthetic', 'kg CO2e / kg', 2.3500, 0.0500, 0.00085, 'D', 80.00, 'Textile Exchange / PEFCR 2024'),
      ('raw_material', 'polyamide_nylon_virgin', 'Polyamide 6/6.6 Vierge (Nylon)', 'synthetic', 'kg CO2e / kg', 7.9000, 0.1800, 0.00240, 'D', 60.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'polyamide_recycled', 'Polyamide Recyclé (Econyl / GRS)', 'synthetic', 'kg CO2e / kg', 3.4000, 0.0800, 0.00110, 'D', 78.00, 'PEFCR Apparel & Footwear 2024'),
      ('raw_material', 'elastane', 'Élasthanne / Spandex', 'synthetic', 'kg CO2e / kg', 7.2000, 0.1500, 0.00210, 'E', 25.00, 'PEFCR Apparel & Footwear 2024'),
      ('process_step', 'process_spinning', 'Filature textile (Spinning)', 'manufacturing', 'kg CO2e / kg', 1.2500, 0.0800, 0.00030, 'A', 100.00, 'PEFCR Apparel & Footwear 2024'),
      ('process_step', 'process_weaving', 'Tissage mécanique (Weaving)', 'manufacturing', 'kg CO2e / kg', 1.8000, 0.0400, 0.00025, 'A', 100.00, 'PEFCR Apparel & Footwear 2024'),
      ('process_step', 'process_knitting', 'Tricotage circulaire / rectiligne (Knitting)', 'manufacturing', 'kg CO2e / kg', 1.1000, 0.0300, 0.00020, 'A', 100.00, 'PEFCR Apparel & Footwear 2024'),
      ('process_step', 'process_dyeing', 'Teinture & Ennoblissement humide (Dyeing & Finishing)', 'manufacturing', 'kg CO2e / kg', 3.6500, 1.8500, 0.00220, 'B', 100.00, 'PEFCR Apparel & Footwear 2024'),
      ('process_step', 'process_assembly', 'Confection & Assemblage (Garment Assembly)', 'manufacturing', 'kg CO2e / kg', 1.4000, 0.0200, 0.00015, 'A', 100.00, 'PEFCR Apparel & Footwear 2024'),
      ('transport_mode', 'transport_road_eu', 'Transport Routier Intra-Europe (PT, ES, IT, FR)', 'logistics', 'kg CO2e / kg', 0.0850, 0.0005, 0.00002, 'A', 100.00, 'ADEME Base Carbone'),
      ('transport_mode', 'transport_sea_med', 'Transport Maritime Bassin Méditerranéen (TR, MA, TN)', 'logistics', 'kg CO2e / kg', 0.2200, 0.0010, 0.00005, 'A', 100.00, 'IMO GHG Study / PEFCR 2024'),
      ('transport_mode', 'transport_sea_asia', 'Transport Maritime Long-Courrier Asie (CN, VN, BD, IN, PK)', 'logistics', 'kg CO2e / kg', 0.5800, 0.0020, 0.00010, 'A', 100.00, 'IMO GHG Study / PEFCR 2024'),
      ('transport_mode', 'transport_air', 'Fret Aérien (Transport urgent express)', 'logistics', 'kg CO2e / kg', 5.8000, 0.0150, 0.00080, 'A', 100.00, 'ICAO / ADEME 2024')
    ON CONFLICT (factor_key) DO UPDATE SET
      name = EXCLUDED.name,
      carbon_kg_co2e = EXCLUDED.carbon_kg_co2e,
      water_m3 = EXCLUDED.water_m3,
      eutrophication_kg_p = EXCLUDED.eutrophication_kg_p,
      microplastics_risk = EXCLUDED.microplastics_risk,
      circularity_recyclability_pct = EXCLUDED.circularity_recyclability_pct,
      source_reference = EXCLUDED.source_reference;
  `);
  console.log('✓ pef_emission_factors seeded');

  // 2. Table product_pef_assessments
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS product_pef_assessments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
      product_version INTEGER NOT NULL DEFAULT 1,
      brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      assessment_method TEXT NOT NULL DEFAULT 'pefcr_apparel_v1',
      garment_category TEXT NOT NULL DEFAULT 'other',
      garment_weight_kg NUMERIC(6,3) NOT NULL DEFAULT 0.400,
      carbon_footprint_kg_co2e NUMERIC(8,3) NOT NULL DEFAULT 0,
      carbon_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      water_scarcity_m3 NUMERIC(8,3) NOT NULL DEFAULT 0,
      water_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      eutrophication_freshwater_kg_p_eq NUMERIC(8,4) NOT NULL DEFAULT 0,
      microplastics_risk_grade TEXT NOT NULL DEFAULT 'A' CHECK (microplastics_risk_grade IN ('A', 'B', 'C', 'D', 'E')),
      circularity_score INTEGER NOT NULL DEFAULT 50 CHECK (circularity_score >= 0 AND circularity_score <= 100),
      pef_eco_score INTEGER NOT NULL DEFAULT 50 CHECK (pef_eco_score >= 0 AND pef_eco_score <= 100),
      pef_grade TEXT NOT NULL DEFAULT 'C' CHECK (pef_grade IN ('A', 'B', 'C', 'D', 'E')),
      conventional_comparison JSONB NOT NULL DEFAULT '{}'::jsonb,
      data_quality_rating TEXT NOT NULL DEFAULT 'medium' CHECK (data_quality_rating IN ('high', 'medium', 'proxy_based')),
      status data_value_status NOT NULL DEFAULT 'declared',
      methodology_version TEXT NOT NULL DEFAULT 'PEFCR-EU-2024.1',
      raw_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      calculated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT product_pef_unique UNIQUE (product_id, product_version)
    );
  `);
  console.log('✓ product_pef_assessments table verified');

  // 3. Indexes
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_product_pef_product ON product_pef_assessments(product_id, product_version);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_product_pef_org ON product_pef_assessments(brand_organization_id, pef_grade);
  `);

  // 4. RLS and security
  await prisma.$executeRawUnsafe(`ALTER TABLE pef_emission_factors ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE pef_emission_factors FORCE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE product_pef_assessments ENABLE ROW LEVEL SECURITY;`);
  await prisma.$executeRawUnsafe(`ALTER TABLE product_pef_assessments FORCE ROW LEVEL SECURITY;`);

  await prisma.$executeRawUnsafe(`GRANT SELECT ON pef_emission_factors TO PUBLIC;`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON product_pef_assessments TO PUBLIC;`);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS pef_factors_public_read ON pef_emission_factors;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY pef_factors_public_read ON pef_emission_factors
      FOR SELECT TO PUBLIC USING (is_active = true);
  `);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS product_pef_select_org ON product_pef_assessments;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY product_pef_select_org ON product_pef_assessments
      FOR SELECT TO PUBLIC USING (
        tracefab_is_org_member(brand_organization_id)
      );
  `);

  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS product_pef_mutate_brand ON product_pef_assessments;`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY product_pef_mutate_brand ON product_pef_assessments
      FOR ALL TO PUBLIC USING (
        tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
      ) WITH CHECK (
        tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
      );
  `);
  console.log('✓ RLS and security policies enforced');

  // 5. Stored Procedure tracefab_calculate_product_pef
  await prisma.$executeRawUnsafe(`
CREATE OR REPLACE FUNCTION tracefab_calculate_product_pef(
  p_product_id UUID,
  p_custom_weight_kg NUMERIC DEFAULT NULL,
  p_custom_category TEXT DEFAULT NULL
)
RETURNS product_pef_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_category TEXT;
  v_weight_kg NUMERIC(6,3);
  v_mat_record RECORD;
  v_has_materials BOOLEAN := false;
  v_total_pct NUMERIC := 0;
  
  -- Cumuls d'impact
  v_raw_carbon NUMERIC := 0;
  v_raw_water NUMERIC := 0;
  v_raw_eutro NUMERIC := 0;
  v_circ_sum NUMERIC := 0;
  v_synth_pct NUMERIC := 0;
  
  -- Étapes de transformation
  v_proc_spinning_c NUMERIC := 0;
  v_proc_weaving_c NUMERIC := 0;
  v_proc_dyeing_c NUMERIC := 0;
  v_proc_assembly_c NUMERIC := 0;
  v_proc_dyeing_w NUMERIC := 0;
  v_proc_carbon NUMERIC := 0;
  v_proc_water NUMERIC := 0;
  
  -- Transport
  v_transport_c NUMERIC := 0;
  v_transport_w NUMERIC := 0;
  v_country TEXT;
  
  -- Totaux finaux
  v_total_carbon NUMERIC;
  v_total_water NUMERIC;
  v_total_eutro NUMERIC;
  v_circularity_score INTEGER;
  v_microplastics_grade TEXT;
  v_pef_eco_score INTEGER;
  v_pef_grade TEXT;
  
  -- Benchmark conventionnel
  v_conv_carbon NUMERIC;
  v_conv_water NUMERIC;
  v_carbon_savings_pct NUMERIC;
  v_water_savings_pct NUMERIC;
  
  v_assessment product_pef_assessments;
BEGIN
  -- Vérification du produit et des droits
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pef_product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'pef_brand_role_required';
  END IF;

  -- Détermination de la catégorie et du poids
  v_category := COALESCE(p_custom_category, v_product.category, 'other');
  IF p_custom_weight_kg IS NOT NULL AND p_custom_weight_kg > 0 THEN
    v_weight_kg := p_custom_weight_kg;
  ELSE
    CASE lower(v_category)
      WHEN 'jeans', 'denim', 'jeans_denim' THEN v_weight_kg := 0.650;
      WHEN 'tshirt', 't-shirt', 'tee' THEN v_weight_kg := 0.180;
      WHEN 'jacket', 'coat', 'jacket_coat', 'outerwear' THEN v_weight_kg := 0.950;
      WHEN 'dress', 'robe' THEN v_weight_kg := 0.350;
      WHEN 'knitwear', 'sweater', 'pull' THEN v_weight_kg := 0.450;
      WHEN 'shirt', 'chemise' THEN v_weight_kg := 0.220;
      WHEN 'pants', 'trousers', 'pantalon' THEN v_weight_kg := 0.400;
      ELSE v_weight_kg := 0.400;
    END CASE;
  END IF;

  v_country := COALESCE(v_product.country_of_manufacture, 'PT');

  -- 1. Calcul des impacts des matières premières
  FOR v_mat_record IN (
    SELECT 
      pm.percentage,
      m.id AS mat_id,
      m.name AS mat_name,
      m.material_type,
      COALESCE((m.composition->>'is_recycled')::boolean, false) AS is_recycled,
      EXISTS (
        SELECT 1 FROM certifications c 
        WHERE (c.product_id = p_product_id OR c.owner_organization_id = m.owner_organization_id)
          AND c.status IN ('documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party')
          AND (c.expires_at IS NULL OR c.expires_at >= CURRENT_DATE)
      ) AS has_cert
    FROM product_materials pm
    JOIN materials m ON m.id = pm.material_id
    WHERE pm.product_id = p_product_id
      AND pm.product_version = v_product.version
  ) LOOP
    v_has_materials := true;
    v_total_pct := v_total_pct + v_mat_record.percentage;
    
    DECLARE
      v_ratio NUMERIC := (v_mat_record.percentage / 100.0) * v_weight_kg;
      v_name_l TEXT := lower(v_mat_record.mat_name);
      v_type_l TEXT := lower(v_mat_record.material_type);
      v_is_bio BOOLEAN := (v_name_l LIKE '%bio%' OR v_name_l LIKE '%organic%' OR v_name_l LIKE '%gots%' OR v_mat_record.has_cert);
      v_is_rec BOOLEAN := (v_mat_record.is_recycled OR v_name_l LIKE '%recycl%' OR v_name_l LIKE '%grs%');
      v_f_carbon NUMERIC := 4.85;
      v_f_water NUMERIC := 8.50;
      v_f_eutro NUMERIC := 0.0035;
      v_f_circ NUMERIC := 85;
    BEGIN
      IF v_name_l LIKE '%coton%' OR v_name_l LIKE '%cotton%' OR v_type_l = 'cotton' THEN
        IF v_is_bio THEN
          v_f_carbon := 2.10; v_f_water := 2.20; v_f_eutro := 0.0009; v_f_circ := 95;
        ELSE
          v_f_carbon := 4.85; v_f_water := 8.50; v_f_eutro := 0.0035; v_f_circ := 90;
        END IF;
      ELSIF v_name_l LIKE '%lin%' OR v_name_l LIKE '%linen%' THEN
        v_f_carbon := 1.45; v_f_water := 0.85; v_f_eutro := 0.00045; v_f_circ := 98;
      ELSIF v_name_l LIKE '%chanvre%' OR v_name_l LIKE '%hemp%' THEN
        v_f_carbon := 1.30; v_f_water := 0.70; v_f_eutro := 0.00040; v_f_circ := 98;
      ELSIF v_name_l LIKE '%polyest%' OR v_type_l = 'polyester' THEN
        v_synth_pct := v_synth_pct + v_mat_record.percentage;
        IF v_is_rec THEN
          v_f_carbon := 2.35; v_f_water := 0.05; v_f_eutro := 0.00085; v_f_circ := 80;
        ELSE
          v_f_carbon := 5.60; v_f_water := 0.12; v_f_eutro := 0.00180; v_f_circ := 65;
        END IF;
      ELSIF v_name_l LIKE '%polyami%' OR v_name_l LIKE '%nylon%' THEN
        v_synth_pct := v_synth_pct + v_mat_record.percentage;
        IF v_is_rec THEN
          v_f_carbon := 3.40; v_f_water := 0.08; v_f_eutro := 0.00110; v_f_circ := 78;
        ELSE
          v_f_carbon := 7.90; v_f_water := 0.18; v_f_eutro := 0.00240; v_f_circ := 60;
        END IF;
      ELSIF v_name_l LIKE '%laine%' OR v_name_l LIKE '%wool%' THEN
        IF v_is_bio OR v_name_l LIKE '%rws%' THEN
          v_f_carbon := 14.80; v_f_water := 2.50; v_f_eutro := 0.0062; v_f_circ := 92;
        ELSE
          v_f_carbon := 24.50; v_f_water := 4.20; v_f_eutro := 0.0125; v_f_circ := 85;
        END IF;
      ELSIF v_name_l LIKE '%soie%' OR v_name_l LIKE '%silk%' THEN
        v_f_carbon := 18.20; v_f_water := 5.10; v_f_eutro := 0.0084; v_f_circ := 80;
      ELSIF v_name_l LIKE '%elasthan%' OR v_name_l LIKE '%spandex%' THEN
        v_synth_pct := v_synth_pct + v_mat_record.percentage;
        v_f_carbon := 7.20; v_f_water := 0.15; v_f_eutro := 0.0021; v_f_circ := 25;
      ELSIF v_name_l LIKE '%viscose%' OR v_name_l LIKE '%tencel%' OR v_name_l LIKE '%lyocell%' THEN
        IF v_name_l LIKE '%tencel%' OR v_name_l LIKE '%lyocell%' THEN
          v_f_carbon := 2.30; v_f_water := 1.10; v_f_eutro := 0.00075; v_f_circ := 92;
        ELSE
          v_f_carbon := 5.20; v_f_water := 3.40; v_f_eutro := 0.0028; v_f_circ := 80;
        END IF;
      END IF;

      v_raw_carbon := v_raw_carbon + (v_ratio * v_f_carbon);
      v_raw_water := v_raw_water + (v_ratio * v_f_water);
      v_raw_eutro := v_raw_eutro + (v_ratio * v_f_eutro);
      v_circ_sum := v_circ_sum + (v_f_circ * (v_mat_record.percentage / 100.0));
    END;
  END LOOP;

  -- Valeur par défaut si aucune matière renseignée
  IF NOT v_has_materials OR v_total_pct = 0 THEN
    v_raw_carbon := v_weight_kg * 4.85;
    v_raw_water := v_weight_kg * 8.50;
    v_raw_eutro := v_weight_kg * 0.0035;
    v_circ_sum := 70;
  END IF;

  -- 2. Étapes de transformation industrielle
  v_proc_spinning_c := v_weight_kg * 1.25;
  v_proc_weaving_c := v_weight_kg * 1.80;
  v_proc_dyeing_c := v_weight_kg * 3.65;
  v_proc_assembly_c := v_weight_kg * 1.40;
  v_proc_dyeing_w := v_weight_kg * 1.85;

  v_proc_carbon := v_proc_spinning_c + v_proc_weaving_c + v_proc_dyeing_c + v_proc_assembly_c;
  v_proc_water := v_proc_dyeing_w + (v_weight_kg * 0.14);

  -- 3. Transport selon le pays de fabrication
  CASE UPPER(v_country)
    WHEN 'FR', 'PT', 'ES', 'IT', 'DE', 'BE', 'NL', 'PL', 'RO' THEN
      v_transport_c := v_weight_kg * 0.085;
      v_transport_w := v_weight_kg * 0.0005;
    WHEN 'TR', 'MA', 'TN', 'EG' THEN
      v_transport_c := v_weight_kg * 0.220;
      v_transport_w := v_weight_kg * 0.0010;
    ELSE
      v_transport_c := v_weight_kg * 0.580;
      v_transport_w := v_weight_kg * 0.0020;
  END CASE;

  -- 4. Totaux d'impact
  v_total_carbon := round((v_raw_carbon + v_proc_carbon + v_transport_c)::numeric, 3);
  v_total_water := round((v_raw_water + v_proc_water + v_transport_w)::numeric, 3);
  v_total_eutro := round((v_raw_eutro + (v_weight_kg * 0.0029))::numeric, 4);

  -- Score de circularité (0-100)
  v_circularity_score := round(v_circ_sum)::integer;
  IF v_synth_pct > 5 AND v_synth_pct < 95 THEN
    v_circularity_score := GREATEST(20, v_circularity_score - 15);
  END IF;

  -- Risque de microplastiques
  IF v_synth_pct = 0 THEN
    v_microplastics_grade := 'A';
  ELSIF v_synth_pct <= 20 THEN
    v_microplastics_grade := 'B';
  ELSIF v_synth_pct <= 50 THEN
    v_microplastics_grade := 'C';
  ELSIF v_synth_pct <= 80 THEN
    v_microplastics_grade := 'D';
  ELSE
    v_microplastics_grade := 'E';
  END IF;

  -- Benchmark conventionnel pour comparaison
  v_conv_carbon := round(((v_weight_kg * 5.20) + v_proc_carbon + (v_weight_kg * 0.580))::numeric, 3);
  v_conv_water := round(((v_weight_kg * 9.20) + v_proc_water + (v_weight_kg * 0.0020))::numeric, 3);

  IF v_conv_carbon > 0 THEN
    v_carbon_savings_pct := round((((v_conv_carbon - v_total_carbon) / v_conv_carbon) * 100.0)::numeric, 1);
  ELSE
    v_carbon_savings_pct := 0;
  END IF;

  IF v_conv_water > 0 THEN
    v_water_savings_pct := round((((v_conv_water - v_total_water) / v_conv_water) * 100.0)::numeric, 1);
  ELSE
    v_water_savings_pct := 0;
  END IF;

  -- Score PEF global (0-100) & Grade A-E
  DECLARE
    v_carbon_intensity NUMERIC := v_total_carbon / GREATEST(v_weight_kg, 0.100);
    v_water_intensity NUMERIC := v_total_water / GREATEST(v_weight_kg, 0.100);
    v_score_raw NUMERIC := 100.0 - (v_carbon_intensity * 2.8) - (v_water_intensity * 2.5);
  BEGIN
    IF v_carbon_savings_pct > 20 THEN v_score_raw := v_score_raw + 10; END IF;
    IF v_circularity_score > 80 THEN v_score_raw := v_score_raw + 5; END IF;
    IF v_microplastics_grade = 'A' THEN v_score_raw := v_score_raw + 5; END IF;

    v_pef_eco_score := LEAST(98, GREATEST(12, round(v_score_raw)::integer));

    IF v_pef_eco_score >= 80 THEN
      v_pef_grade := 'A';
    ELSIF v_pef_eco_score >= 65 THEN
      v_pef_grade := 'B';
    ELSIF v_pef_eco_score >= 50 THEN
      v_pef_grade := 'C';
    ELSIF v_pef_eco_score >= 35 THEN
      v_pef_grade := 'D';
    ELSE
      v_pef_grade := 'E';
    END IF;
  END;

  -- Insertion / Mise à jour dans product_pef_assessments
  INSERT INTO product_pef_assessments (
    product_id,
    product_version,
    brand_organization_id,
    assessment_method,
    garment_category,
    garment_weight_kg,
    carbon_footprint_kg_co2e,
    carbon_breakdown,
    water_scarcity_m3,
    water_breakdown,
    eutrophication_freshwater_kg_p_eq,
    microplastics_risk_grade,
    circularity_score,
    pef_eco_score,
    pef_grade,
    conventional_comparison,
    data_quality_rating,
    status,
    methodology_version,
    raw_parameters,
    calculated_by,
    calculated_at,
    updated_at
  )
  VALUES (
    p_product_id,
    v_product.version,
    v_product.brand_organization_id,
    'pefcr_apparel_v1',
    v_category,
    v_weight_kg,
    v_total_carbon,
    jsonb_build_object(
      'raw_materials_kg_co2e', round(v_raw_carbon, 3),
      'spinning_kg_co2e', round(v_proc_spinning_c, 3),
      'weaving_knitting_kg_co2e', round(v_proc_weaving_c, 3),
      'dyeing_finishing_kg_co2e', round(v_proc_dyeing_c, 3),
      'assembly_kg_co2e', round(v_proc_assembly_c, 3),
      'transport_kg_co2e', round(v_transport_c, 3)
    ),
    v_total_water,
    jsonb_build_object(
      'raw_materials_m3', round(v_raw_water, 3),
      'dyeing_finishing_m3', round(v_proc_dyeing_w, 3),
      'manufacturing_other_m3', round(v_weight_kg * 0.14, 3),
      'transport_m3', round(v_transport_w, 3)
    ),
    v_total_eutro,
    v_microplastics_grade,
    v_circularity_score,
    v_pef_eco_score,
    v_pef_grade,
    jsonb_build_object(
      'conventional_carbon_kg_co2e', v_conv_carbon,
      'carbon_savings_pct', v_carbon_savings_pct,
      'conventional_water_m3', v_conv_water,
      'water_savings_pct', v_water_savings_pct
    ),
    CASE WHEN v_has_materials THEN 'high' ELSE 'proxy_based' END,
    'documented'::data_value_status,
    'PEFCR-EU-2024.1',
    jsonb_build_object(
      'country_of_manufacture', v_country,
      'materials_count', (SELECT count(*) FROM product_materials WHERE product_id = p_product_id AND product_version = v_product.version),
      'synthetic_percentage', v_synth_pct
    ),
    tracefab_current_user_id(),
    now(),
    now()
  )
  ON CONFLICT (product_id, product_version) DO UPDATE SET
    garment_category = EXCLUDED.garment_category,
    garment_weight_kg = EXCLUDED.garment_weight_kg,
    carbon_footprint_kg_co2e = EXCLUDED.carbon_footprint_kg_co2e,
    carbon_breakdown = EXCLUDED.carbon_breakdown,
    water_scarcity_m3 = EXCLUDED.water_scarcity_m3,
    water_breakdown = EXCLUDED.water_breakdown,
    eutrophication_freshwater_kg_p_eq = EXCLUDED.eutrophication_freshwater_kg_p_eq,
    microplastics_risk_grade = EXCLUDED.microplastics_risk_grade,
    circularity_score = EXCLUDED.circularity_score,
    pef_eco_score = EXCLUDED.pef_eco_score,
    pef_grade = EXCLUDED.pef_grade,
    conventional_comparison = EXCLUDED.conventional_comparison,
    data_quality_rating = EXCLUDED.data_quality_rating,
    status = EXCLUDED.status,
    raw_parameters = EXCLUDED.raw_parameters,
    calculated_by = EXCLUDED.calculated_by,
    calculated_at = EXCLUDED.calculated_at,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_assessment;

  -- 5. Injection automatique dans la projection publique DPP
  UPDATE dpp_records
  SET public_projection = jsonb_set(
    COALESCE(public_projection, '{}'::jsonb),
    '{environmental_footprint}',
    jsonb_build_object(
      'pef_grade', v_assessment.pef_grade,
      'pef_eco_score', v_assessment.pef_eco_score,
      'carbon_footprint_kg_co2e', v_assessment.carbon_footprint_kg_co2e,
      'water_scarcity_m3', v_assessment.water_scarcity_m3,
      'circularity_score', v_assessment.circularity_score,
      'microplastics_risk_grade', v_assessment.microplastics_risk_grade,
      'conventional_comparison', v_assessment.conventional_comparison,
      'methodology', 'PEFCR Apparel & Footwear 2024 / Loi AGEC',
      'calculated_at', v_assessment.calculated_at
    ),
    true
  )
  WHERE product_id = p_product_id;

  RETURN v_assessment;
END;
$$;
  `);
  console.log('✓ tracefab_calculate_product_pef stored procedure registered');

  console.log('All Chantier 3 DDL and stored procedures applied successfully to Neon!');
}

run()
  .catch((e) => {
    console.error('Error applying Chantier 3:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
