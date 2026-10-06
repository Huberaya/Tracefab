-- Tracefab Chantier 5 — Gestion Collaborative des Non-Conformités & Plans d'Actions Correctives (CAP / 8D)
-- Résolution bilatérale Marque <-> Fournisseur des blocages qualité, preuves documentaires et conformité DPP

-- 1. Table des Plans d'Actions Correctives (CAP)
CREATE TABLE IF NOT EXISTS quality_corrective_action_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_issue_id UUID NOT NULL REFERENCES data_quality_issues(id) ON DELETE CASCADE,
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'submitted', 'approved', 'rejected', 'closed')),
  priority TEXT NOT NULL DEFAULT 'high' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  due_date DATE NOT NULL,
  supplier_response_summary TEXT,
  supporting_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  review_verdict TEXT CHECK (review_verdict IN ('approved', 'rejected')),
  review_notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cap_issue ON quality_corrective_action_plans(quality_issue_id);
CREATE INDEX IF NOT EXISTS idx_cap_brand ON quality_corrective_action_plans(brand_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_cap_supplier ON quality_corrective_action_plans(supplier_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_cap_due_date ON quality_corrective_action_plans(due_date, status);

-- 2. Table des Messages et Échanges du Fil de Remédiation
CREATE TABLE IF NOT EXISTS quality_cap_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cap_id UUID NOT NULL REFERENCES quality_corrective_action_plans(id) ON DELETE CASCADE,
  sender_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('brand', 'supplier', 'auditor')),
  message TEXT NOT NULL,
  attachment_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cap_messages_cap ON quality_cap_messages(cap_id, created_at ASC);

-- 3. Row Level Security & FORCE RLS
ALTER TABLE quality_corrective_action_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_corrective_action_plans FORCE ROW LEVEL SECURITY;

ALTER TABLE quality_cap_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_cap_messages FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON quality_corrective_action_plans TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON quality_cap_messages TO PUBLIC;

DROP POLICY IF EXISTS quality_cap_select ON quality_corrective_action_plans;
CREATE POLICY quality_cap_select ON quality_corrective_action_plans
  FOR SELECT TO PUBLIC USING (
    tracefab_is_org_member(brand_organization_id)
    OR tracefab_is_org_member(supplier_organization_id)
  );

DROP POLICY IF EXISTS quality_cap_insert_brand ON quality_corrective_action_plans;
CREATE POLICY quality_cap_insert_brand ON quality_corrective_action_plans
  FOR INSERT TO PUBLIC WITH CHECK (
    tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

DROP POLICY IF EXISTS quality_cap_update_parties ON quality_corrective_action_plans;
CREATE POLICY quality_cap_update_parties ON quality_corrective_action_plans
  FOR UPDATE TO PUBLIC USING (
    tracefab_is_org_member(brand_organization_id)
    OR tracefab_is_org_member(supplier_organization_id)
  );

DROP POLICY IF EXISTS quality_cap_messages_select ON quality_cap_messages;
CREATE POLICY quality_cap_messages_select ON quality_cap_messages
  FOR SELECT TO PUBLIC USING (
    EXISTS (
      SELECT 1 FROM quality_corrective_action_plans cap
      WHERE cap.id = quality_cap_messages.cap_id
        AND (tracefab_is_org_member(cap.brand_organization_id) OR tracefab_is_org_member(cap.supplier_organization_id))
    )
  );

DROP POLICY IF EXISTS quality_cap_messages_insert ON quality_cap_messages;
CREATE POLICY quality_cap_messages_insert ON quality_cap_messages
  FOR INSERT TO PUBLIC WITH CHECK (
    tracefab_is_org_member(sender_organization_id)
  );

-- 4. Procédure Stockée : tracefab_create_quality_cap
CREATE OR REPLACE FUNCTION tracefab_create_quality_cap(
  p_quality_issue_id UUID,
  p_supplier_organization_id UUID,
  p_title TEXT,
  p_instructions TEXT,
  p_due_date DATE,
  p_priority TEXT DEFAULT 'high'
)
RETURNS quality_corrective_action_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
  v_cap quality_corrective_action_plans;
  v_user_id UUID := tracefab_current_user_id();
BEGIN
  -- Vérifier l'issue qualité
  SELECT * INTO v_issue
  FROM data_quality_issues
  WHERE id = p_quality_issue_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality_issue_not_found';
  END IF;

  -- Vérifier les habilitations de la marque
  IF NOT tracefab_has_org_role(
    v_issue.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'quality_brand_role_required';
  END IF;

  IF p_due_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'cap_due_date_must_be_future';
  END IF;

  -- Création du plan d'action
  INSERT INTO quality_corrective_action_plans (
    quality_issue_id,
    brand_organization_id,
    supplier_organization_id,
    product_id,
    title,
    instructions,
    status,
    priority,
    due_date,
    created_by
  )
  VALUES (
    p_quality_issue_id,
    v_issue.owner_organization_id,
    p_supplier_organization_id,
    v_issue.product_id,
    trim(p_title),
    trim(p_instructions),
    'requested',
    p_priority,
    p_due_date,
    v_user_id
  )
  RETURNING * INTO v_cap;

  -- Passer l'issue en cours d'investigation si elle était open
  UPDATE data_quality_issues
  SET status = 'acknowledged',
      acknowledged_at = now(),
      acknowledged_by = v_user_id,
      details = jsonb_set(
        COALESCE(details, '{}'::jsonb),
        '{active_cap_id}',
        to_jsonb(v_cap.id::text)
      )
  WHERE id = p_quality_issue_id
    AND status = 'open';

  -- Message initial dans le fil de médiation
  INSERT INTO quality_cap_messages (
    cap_id,
    sender_organization_id,
    sender_user_id,
    sender_role,
    message
  )
  VALUES (
    v_cap.id,
    v_issue.owner_organization_id,
    v_user_id,
    'brand',
    format('Ouverture du Plan d''Action Corrective : %s. Échéance fixée au %s.', p_title, p_due_date)
  );

  RETURN v_cap;
END;
$$;

-- 5. Procédure Stockée : tracefab_submit_quality_remediation
CREATE OR REPLACE FUNCTION tracefab_submit_quality_remediation(
  p_cap_id UUID,
  p_response_summary TEXT,
  p_supporting_document_id UUID DEFAULT NULL,
  p_message TEXT DEFAULT NULL
)
RETURNS quality_corrective_action_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap quality_corrective_action_plans;
  v_user_id UUID := tracefab_current_user_id();
BEGIN
  SELECT * INTO v_cap
  FROM quality_corrective_action_plans
  WHERE id = p_cap_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cap_not_found';
  END IF;

  -- Vérifier que l'utilisateur appartient à l'organisation fournisseur
  IF NOT tracefab_is_org_member(v_cap.supplier_organization_id) THEN
    RAISE EXCEPTION 'cap_supplier_membership_required';
  END IF;

  IF length(trim(COALESCE(p_response_summary, ''))) = 0 THEN
    RAISE EXCEPTION 'cap_response_summary_required';
  END IF;

  -- Mise à jour du plan d'action
  UPDATE quality_corrective_action_plans
  SET status = 'submitted',
      supplier_response_summary = trim(p_response_summary),
      supporting_document_id = p_supporting_document_id,
      submitted_at = now(),
      submitted_by = v_user_id,
      updated_at = now()
  WHERE id = p_cap_id
  RETURNING * INTO v_cap;

  -- Enregistrement du message dans le fil de médiation
  INSERT INTO quality_cap_messages (
    cap_id,
    sender_organization_id,
    sender_user_id,
    sender_role,
    message,
    attachment_document_id
  )
  VALUES (
    v_cap.id,
    v_cap.supplier_organization_id,
    v_user_id,
    'supplier',
    COALESCE(trim(p_message), trim(p_response_summary)),
    p_supporting_document_id
  );

  RETURN v_cap;
END;
$$;

-- 6. Procédure Stockée : tracefab_review_quality_remediation
CREATE OR REPLACE FUNCTION tracefab_review_quality_remediation(
  p_cap_id UUID,
  p_verdict TEXT,
  p_review_notes TEXT DEFAULT NULL
)
RETURNS quality_corrective_action_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap quality_corrective_action_plans;
  v_user_id UUID := tracefab_current_user_id();
BEGIN
  SELECT * INTO v_cap
  FROM quality_corrective_action_plans
  WHERE id = p_cap_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cap_not_found';
  END IF;

  -- Vérifier que l'utilisateur est manager de la marque
  IF NOT tracefab_has_org_role(
    v_cap.brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'quality_brand_role_required';
  END IF;

  IF p_verdict NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_cap_verdict';
  END IF;

  IF p_verdict = 'approved' THEN
    -- 1. Approuver le CAP
    UPDATE quality_corrective_action_plans
    SET status = 'approved',
        review_verdict = 'approved',
        review_notes = trim(p_review_notes),
        reviewed_at = now(),
        reviewed_by = v_user_id,
        updated_at = now()
    WHERE id = p_cap_id
    RETURNING * INTO v_cap;

    -- 2. Clôturer et résoudre l'issue qualité
    UPDATE data_quality_issues
    SET status = 'resolved',
        resolved_at = now(),
        resolved_by = v_user_id,
        details = jsonb_set(
          COALESCE(details, '{}'::jsonb),
          '{resolution}',
          jsonb_build_object(
            'resolved_by_cap_id', v_cap.id,
            'resolved_at', now(),
            'notes', p_review_notes
          )
        )
    WHERE id = v_cap.quality_issue_id;

    -- 3. Recalculer le score qualité produit si associé
    IF v_cap.product_id IS NOT NULL THEN
      PERFORM tracefab_compute_product_quality(v_cap.product_id);
    END IF;

    -- 4. Message de clôture
    INSERT INTO quality_cap_messages (
      cap_id,
      sender_organization_id,
      sender_user_id,
      sender_role,
      message
    )
    VALUES (
      v_cap.id,
      v_cap.brand_organization_id,
      v_user_id,
      'brand',
      format('Remédiation acceptée et validée par la marque. Non-conformité résolue. %s', COALESCE(p_review_notes, ''))
    );

  ELSE
    -- Rejet de la remédiation : le fournisseur doit corriger
    UPDATE quality_corrective_action_plans
    SET status = 'rejected',
        review_verdict = 'rejected',
        review_notes = trim(p_review_notes),
        reviewed_at = now(),
        reviewed_by = v_user_id,
        updated_at = now()
    WHERE id = p_cap_id
    RETURNING * INTO v_cap;

    INSERT INTO quality_cap_messages (
      cap_id,
      sender_organization_id,
      sender_user_id,
      sender_role,
      message
    )
    VALUES (
      v_cap.id,
      v_cap.brand_organization_id,
      v_user_id,
      'brand',
      format('Remédiation rejetée. Compléments requis : %s', COALESCE(p_review_notes, 'Justificatifs insuffisants.'))
    );
  END IF;

  RETURN v_cap;
END;
$$;
