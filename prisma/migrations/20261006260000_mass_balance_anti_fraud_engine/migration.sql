-- Tracefab Chantier 7 (Moteur Mass-Balance Anti-Fraude & Réconciliation Bilancielle)
-- Détection de la fraude volumétrique par comparaison des Transaction Certificates (TC) et volumes confectionnés

-- 1. Table du Registre des Certificats de Transaction (TC)
CREATE TABLE IF NOT EXISTS transaction_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tc_number TEXT NOT NULL UNIQUE,
  standard TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  seller_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  buyer_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  certified_material_name TEXT NOT NULL,
  total_certified_weight_kg NUMERIC(12, 3) NOT NULL CHECK (total_certified_weight_kg > 0),
  total_certified_meters NUMERIC(12, 3) DEFAULT NULL,
  allocated_weight_kg NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (allocated_weight_kg >= 0),
  allocated_meters NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (allocated_meters >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'revoked', 'expired')),
  issue_date DATE NOT NULL,
  expiry_date DATE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tc_allocation_within_limits CHECK (allocated_weight_kg <= total_certified_weight_kg)
);

CREATE INDEX IF NOT EXISTS idx_tc_seller ON transaction_certificates(seller_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tc_buyer ON transaction_certificates(buyer_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tc_number ON transaction_certificates(tc_number);

-- 2. Table des Allocations de Quantités Certifiées (Anti-Double Dépense)
CREATE TABLE IF NOT EXISTS mass_balance_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_certificate_id UUID NOT NULL REFERENCES transaction_certificates(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  allocated_weight_kg NUMERIC(12, 3) NOT NULL CHECK (allocated_weight_kg > 0),
  allocated_meters NUMERIC(12, 3) DEFAULT 0,
  notes TEXT,
  allocated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mb_alloc_tc ON mass_balance_allocations(transaction_certificate_id);
CREATE INDEX IF NOT EXISTS idx_mb_alloc_product ON mass_balance_allocations(product_id);

-- 3. Table des Réconciliations Bilancielles & Audits Anti-Fraude
CREATE TABLE IF NOT EXISTS mass_balance_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE CASCADE,
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_reference TEXT NOT NULL DEFAULT 'GLOBAL_PRODUCTION',
  production_volume_units INTEGER NOT NULL CHECK (production_volume_units >= 0),
  unit_weight_grams NUMERIC(10, 2) NOT NULL CHECK (unit_weight_grams > 0),
  cutting_waste_pct NUMERIC(5, 2) NOT NULL DEFAULT 12.00 CHECK (cutting_waste_pct >= 0 AND cutting_waste_pct <= 50),
  theoretical_required_kg NUMERIC(12, 3) NOT NULL,
  allocated_certified_kg NUMERIC(12, 3) NOT NULL,
  deficit_kg NUMERIC(12, 3) NOT NULL DEFAULT 0,
  coverage_ratio_pct NUMERIC(6, 2) NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('fully_covered', 'partially_covered', 'severe_deficit', 'unsupported')),
  fraud_risk_score INTEGER NOT NULL CHECK (fraud_risk_score >= 0 AND fraud_risk_score <= 100),
  summary TEXT NOT NULL,
  blocking_issue_created BOOLEAN NOT NULL DEFAULT false,
  quality_issue_id UUID REFERENCES data_quality_issues(id) ON DELETE SET NULL,
  reconciled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mb_reconcil_product ON mass_balance_reconciliations(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mb_reconcil_brand ON mass_balance_reconciliations(brand_organization_id, verdict);

-- 4. Sécurité RLS Stricte (FORCE ROW LEVEL SECURITY)
ALTER TABLE transaction_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_certificates FORCE ROW LEVEL SECURITY;

ALTER TABLE mass_balance_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mass_balance_allocations FORCE ROW LEVEL SECURITY;

ALTER TABLE mass_balance_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mass_balance_reconciliations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_certificates TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON mass_balance_allocations TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON mass_balance_reconciliations TO PUBLIC;

-- RLS Transaction Certificates
DROP POLICY IF EXISTS tc_select_parties ON transaction_certificates;
CREATE POLICY tc_select_parties ON transaction_certificates
  FOR SELECT TO PUBLIC
  USING (
    tracefab_has_org_role(seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer', 'auditor']::membership_role[])
    OR tracefab_has_org_role(buyer_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS tc_insert_parties ON transaction_certificates;
CREATE POLICY tc_insert_parties ON transaction_certificates
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tracefab_has_org_role(seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    OR tracefab_has_org_role(buyer_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

DROP POLICY IF EXISTS tc_update_parties ON transaction_certificates;
CREATE POLICY tc_update_parties ON transaction_certificates
  FOR UPDATE TO PUBLIC
  USING (
    tracefab_has_org_role(seller_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    OR tracefab_has_org_role(buyer_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

-- RLS Allocations
DROP POLICY IF EXISTS mb_allocations_select ON mass_balance_allocations;
CREATE POLICY mb_allocations_select ON mass_balance_allocations
  FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = mass_balance_allocations.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer', 'auditor']::membership_role[])
    )
    OR EXISTS (
      SELECT 1 FROM transaction_certificates tc
      WHERE tc.id = mass_balance_allocations.transaction_certificate_id
        AND (
          tracefab_has_org_role(tc.seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer']::membership_role[])
          OR tracefab_has_org_role(tc.buyer_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer']::membership_role[])
        )
    )
  );

DROP POLICY IF EXISTS mb_allocations_modify ON mass_balance_allocations;
CREATE POLICY mb_allocations_modify ON mass_balance_allocations
  FOR ALL TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = mass_balance_allocations.product_id
        AND tracefab_has_org_role(p.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
    OR EXISTS (
      SELECT 1 FROM transaction_certificates tc
      WHERE tc.id = mass_balance_allocations.transaction_certificate_id
        AND tracefab_has_org_role(tc.seller_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  );

-- RLS Reconciliations
DROP POLICY IF EXISTS mb_reconciliations_select ON mass_balance_reconciliations;
CREATE POLICY mb_reconciliations_select ON mass_balance_reconciliations
  FOR SELECT TO PUBLIC
  USING (
    tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS mb_reconciliations_insert ON mass_balance_reconciliations;
CREATE POLICY mb_reconciliations_insert ON mass_balance_reconciliations
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

-- 5. Procédure Stockée : tracefab_register_transaction_certificate
CREATE OR REPLACE FUNCTION tracefab_register_transaction_certificate(
  p_tc_number TEXT,
  p_standard TEXT,
  p_issuer_name TEXT,
  p_seller_organization_id UUID,
  p_buyer_organization_id UUID,
  p_certified_material_name TEXT,
  p_total_certified_weight_kg NUMERIC,
  p_total_certified_meters NUMERIC DEFAULT NULL,
  p_issue_date DATE DEFAULT CURRENT_DATE,
  p_expiry_date DATE DEFAULT NULL,
  p_document_id UUID DEFAULT NULL
)
RETURNS transaction_certificates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := NULLIF(current_setting('tracefab.user_id', true), '')::uuid;
  v_tc transaction_certificates;
BEGIN
  -- Vérifier les habilitations de l'émetteur ou du récepteur
  IF NOT (
    tracefab_has_org_role(p_seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    OR tracefab_has_org_role(p_buyer_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) THEN
    RAISE EXCEPTION 'access_denied_tc_party_role_required';
  END IF;

  INSERT INTO transaction_certificates (
    tc_number,
    standard,
    issuer_name,
    seller_organization_id,
    buyer_organization_id,
    certified_material_name,
    total_certified_weight_kg,
    total_certified_meters,
    allocated_weight_kg,
    allocated_meters,
    status,
    issue_date,
    expiry_date,
    document_id,
    created_by
  ) VALUES (
    trim(p_tc_number),
    trim(p_standard),
    trim(p_issuer_name),
    p_seller_organization_id,
    p_buyer_organization_id,
    trim(p_certified_material_name),
    p_total_certified_weight_kg,
    p_total_certified_meters,
    0,
    0,
    'active',
    p_issue_date,
    p_expiry_date,
    p_document_id,
    v_user_id
  )
  RETURNING * INTO v_tc;

  RETURN v_tc;
END;
$$;

-- 6. Procédure Stockée : tracefab_allocate_tc_quantity (Verrouillage & Anti-Double Dépense)
CREATE OR REPLACE FUNCTION tracefab_allocate_tc_quantity(
  p_tc_id UUID,
  p_product_id UUID,
  p_allocated_weight_kg NUMERIC,
  p_allocated_meters NUMERIC DEFAULT 0,
  p_order_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS mass_balance_allocations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := NULLIF(current_setting('tracefab.user_id', true), '')::uuid;
  v_tc transaction_certificates;
  v_product tracefab_products;
  v_alloc mass_balance_allocations;
  v_new_allocated NUMERIC;
BEGIN
  -- 1. Verrouillage du certificat pour empêcher tout double-spending simultané
  SELECT * INTO v_tc
  FROM transaction_certificates
  WHERE id = p_tc_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tc_not_found';
  END IF;

  IF v_tc.status != 'active' THEN
    RAISE EXCEPTION 'tc_not_active_cannot_allocate';
  END IF;

  -- 2. Vérification du produit
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  -- 3. Vérification des habilitations
  IF NOT (
    tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    OR tracefab_has_org_role(v_tc.seller_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) THEN
    RAISE EXCEPTION 'access_denied_allocation_role_required';
  END IF;

  -- 4. Contrôle mathématique de non-dépassement (Double-Spending Prevention)
  v_new_allocated := v_tc.allocated_weight_kg + p_allocated_weight_kg;
  IF v_new_allocated > v_tc.total_certified_weight_kg THEN
    RAISE EXCEPTION 'tc_quantity_exceeded_double_spending_prevented: remaining=% kg, requested=% kg',
      (v_tc.total_certified_weight_kg - v_tc.allocated_weight_kg),
      p_allocated_weight_kg;
  END IF;

  -- 5. Création de l'enregistrement d'allocation
  INSERT INTO mass_balance_allocations (
    transaction_certificate_id,
    product_id,
    order_id,
    allocated_weight_kg,
    allocated_meters,
    notes,
    allocated_by
  ) VALUES (
    p_tc_id,
    p_product_id,
    p_order_id,
    p_allocated_weight_kg,
    COALESCE(p_allocated_meters, 0),
    p_notes,
    v_user_id
  )
  RETURNING * INTO v_alloc;

  -- 6. Mise à jour du solde du TC
  UPDATE transaction_certificates
  SET
    allocated_weight_kg = v_new_allocated,
    allocated_meters = allocated_meters + COALESCE(p_allocated_meters, 0),
    status = CASE WHEN v_new_allocated >= total_certified_weight_kg THEN 'exhausted' ELSE 'active' END,
    updated_at = now()
  WHERE id = p_tc_id;

  RETURN v_alloc;
END;
$$;

-- 7. Procédure Stockée : tracefab_reconcile_mass_balance (Calcul de Bilan Massique & Alerte Fraude)
CREATE OR REPLACE FUNCTION tracefab_reconcile_mass_balance(
  p_product_id UUID,
  p_production_volume_units INTEGER,
  p_cutting_waste_pct NUMERIC DEFAULT 12.00,
  p_batch_reference TEXT DEFAULT 'SERIE_PRODUCTION_2026'
)
RETURNS mass_balance_reconciliations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := NULLIF(current_setting('tracefab.user_id', true), '')::uuid;
  v_product tracefab_products;
  v_unit_weight NUMERIC;
  v_theoretical_kg NUMERIC;
  v_allocated_kg NUMERIC := 0;
  v_coverage_pct NUMERIC;
  v_deficit_kg NUMERIC := 0;
  v_verdict TEXT;
  v_fraud_risk INTEGER;
  v_summary TEXT;
  v_blocking_created BOOLEAN := false;
  v_quality_issue_id UUID := NULL;
  v_rec mass_balance_reconciliations;
BEGIN
  -- 1. Récupération du produit
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]) THEN
    RAISE EXCEPTION 'access_denied_brand_role_required';
  END IF;

  v_unit_weight := COALESCE(v_product.weight_grams, 200.00);

  -- 2. Calcul mathématique du besoin théorique avec coefficient de perte de coupe
  -- besoin_kg = volume_unités * (poids_unitaire_g / 1000) * (1 + perte_coupe / 100)
  v_theoretical_kg := ROUND(
    (p_production_volume_units * (v_unit_weight / 1000.0) * (1.0 + (p_cutting_waste_pct / 100.0))),
    3
  );

  -- 3. Somme de toutes les quantités allouées via des TCs actifs
  SELECT COALESCE(SUM(allocated_weight_kg), 0)
  INTO v_allocated_kg
  FROM mass_balance_allocations
  WHERE product_id = p_product_id;

  -- 4. Ratio de couverture et calcul du déficit
  IF v_theoretical_kg > 0 THEN
    v_coverage_pct := ROUND((v_allocated_kg / v_theoretical_kg) * 100.0, 2);
  ELSE
    v_coverage_pct := 100.0;
  END IF;

  v_deficit_kg := GREATEST(0, v_theoretical_kg - v_allocated_kg);

  -- 5. Machine d'arbitrage et détection de fraude volumétrique
  IF v_allocated_kg = 0 THEN
    v_verdict := 'unsupported';
    v_fraud_risk := 100;
    v_summary := format('Aucun Transaction Certificate (TC) alloué pour %s pièces produites (%s kg requis). Allégation non étayée.', p_production_volume_units, v_theoretical_kg);
  ELSIF v_coverage_pct < 50.0 THEN
    v_verdict := 'severe_deficit';
    v_fraud_risk := 95;
    v_summary := format('Alerte Fraude Volumétrique : Seulement %s kg de matière certifiée couverts sur %s kg requis pour %s pièces (couverture %s%%). Déficit de %s kg.', v_allocated_kg, v_theoretical_kg, p_production_volume_units, v_coverage_pct, v_deficit_kg);
  ELSIF v_coverage_pct < 98.0 THEN
    v_verdict := 'partially_covered';
    v_fraud_risk := 40;
    v_summary := format('Couverture partielle : %s%% du volume requis est couvert par les TCs (%s kg / %s kg). Risque modéré.', v_coverage_pct, v_allocated_kg, v_theoretical_kg);
  ELSE
    v_verdict := 'fully_covered';
    v_fraud_risk := 0;
    v_summary := format('Bilan massique conforme : 100%% des %s pièces produites sont couvertes par des Transaction Certificates vérifiés (%s kg alloués pour %s kg requis).', p_production_volume_units, v_allocated_kg, v_theoretical_kg);
  END IF;

  -- 6. Synchronisation automatique avec le Quality Center & Blocage DPP
  IF v_verdict IN ('severe_deficit', 'unsupported') THEN
    INSERT INTO data_quality_issues (
      owner_organization_id,
      product_id,
      rule_key,
      rule_version,
      severity,
      message,
      status,
      details
    ) VALUES (
      v_product.brand_organization_id,
      p_product_id,
      'mass_balance_severe_deficit',
      '1.0',
      'blocking',
      format('Fraude volumétrique détectée : %s pièces déclarées mais seulement %s%% couvertes par des certificats TC.', p_production_volume_units, v_coverage_pct),
      'open',
      jsonb_build_object(
        'theoreticalKg', v_theoretical_kg,
        'allocatedKg', v_allocated_kg,
        'deficitKg', v_deficit_kg,
        'coverageRatioPct', v_coverage_pct,
        'fraudRiskScore', v_fraud_risk
      )
    )
    RETURNING id INTO v_quality_issue_id;

    v_blocking_created := true;
  ELSE
    -- Résoudre l'anomalie si elle existait précédemment et que le déficit a été comblé
    UPDATE data_quality_issues
    SET
      status = 'resolved',
      resolved_at = now()
    WHERE product_id = p_product_id
      AND rule_key = 'mass_balance_severe_deficit'
      AND status = 'open';
  END IF;

  -- 7. Enregistrement de l'audit bilanciel
  INSERT INTO mass_balance_reconciliations (
    product_id,
    brand_organization_id,
    batch_reference,
    production_volume_units,
    unit_weight_grams,
    cutting_waste_pct,
    theoretical_required_kg,
    allocated_certified_kg,
    deficit_kg,
    coverage_ratio_pct,
    verdict,
    fraud_risk_score,
    summary,
    blocking_issue_created,
    quality_issue_id,
    reconciled_by
  ) VALUES (
    p_product_id,
    v_product.brand_organization_id,
    p_batch_reference,
    p_production_volume_units,
    v_unit_weight,
    p_cutting_waste_pct,
    v_theoretical_kg,
    v_allocated_kg,
    v_deficit_kg,
    v_coverage_pct,
    v_verdict,
    v_fraud_risk,
    v_summary,
    v_blocking_created,
    v_quality_issue_id,
    v_user_id
  )
  RETURNING * INTO v_rec;

  RETURN v_rec;
END;
$$;
