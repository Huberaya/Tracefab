-- Chaîne de preuves DPP : une affirmation n'est jamais confondue avec son justificatif.
CREATE TABLE dpp_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE RESTRICT,
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  lifecycle_event_id UUID REFERENCES dpp_lifecycle_events(id) ON DELETE RESTRICT,
  claim_key TEXT NOT NULL CHECK (claim_key ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  statement TEXT NOT NULL CHECK (length(trim(statement)) BETWEEN 1 AND 1000),
  public_statement TEXT CHECK (public_statement IS NULL OR length(trim(public_statement)) BETWEEN 1 AND 500),
  subject_scope TEXT NOT NULL DEFAULT 'model' CHECK (subject_scope IN ('model','variant','batch','unit')),
  subject_reference TEXT,
  validation_status dpp_event_validation_status NOT NULL DEFAULT 'declared',
  valid_from DATE,
  valid_until DATE,
  supersedes_claim_id UUID REFERENCES dpp_claims(id) ON DELETE RESTRICT,
  rejection_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK (validation_status <> 'rejected' OR length(trim(COALESCE(rejection_reason,''))) > 0)
);
CREATE INDEX idx_dpp_claims_product ON dpp_claims(product_id,created_at DESC);
CREATE INDEX idx_dpp_claims_validity ON dpp_claims(product_id,valid_until) WHERE valid_until IS NOT NULL;

CREATE TABLE dpp_claim_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES dpp_claims(id) ON DELETE RESTRICT,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  relationship TEXT NOT NULL DEFAULT 'supports' CHECK (relationship IN ('supports','contradicts','context')),
  coverage_note TEXT CHECK (coverage_note IS NULL OR length(trim(coverage_note)) <= 500),
  verification_result TEXT NOT NULL DEFAULT 'pending' CHECK (verification_result IN ('pending','accepted','rejected')),
  verification_reason TEXT,
  public_label TEXT CHECK (public_label IS NULL OR length(trim(public_label)) BETWEEN 1 AND 200),
  linked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(claim_id,document_id,relationship),
  CHECK (verification_result = 'pending' OR length(trim(COALESCE(verification_reason,''))) > 0)
);
CREATE INDEX idx_dpp_claim_evidence_claim ON dpp_claim_evidence(claim_id,linked_at DESC);

CREATE OR REPLACE FUNCTION tracefab_reject_dpp_claim_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RAISE EXCEPTION 'dpp_claims_are_append_only'; END $$;
CREATE TRIGGER dpp_claims_no_update_delete BEFORE UPDATE OR DELETE ON dpp_claims FOR EACH ROW EXECUTE FUNCTION tracefab_reject_dpp_claim_mutation();
CREATE TRIGGER dpp_claim_evidence_no_update_delete BEFORE UPDATE OR DELETE ON dpp_claim_evidence FOR EACH ROW EXECUTE FUNCTION tracefab_reject_dpp_claim_mutation();

CREATE OR REPLACE FUNCTION tracefab_add_dpp_claim(
  p_product_id UUID,p_claim_key TEXT,p_statement TEXT,p_public_statement TEXT DEFAULT NULL,
  p_validation_status dpp_event_validation_status DEFAULT 'declared',p_lifecycle_event_id UUID DEFAULT NULL,
  p_subject_scope TEXT DEFAULT 'model',p_subject_reference TEXT DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,p_valid_until DATE DEFAULT NULL,p_supersedes_claim_id UUID DEFAULT NULL,
  p_rejection_reason TEXT DEFAULT NULL
) RETURNS dpp_claims LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_product tracefab_products; v_claim dpp_claims;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id=p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_product.brand_organization_id,ARRAY['owner','admin','manager','contributor','auditor']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_claim_role_required'; END IF;
  IF p_validation_status IN ('controlled','corroborated','third_party_verified','rejected') AND
     NOT tracefab_has_org_role(v_product.brand_organization_id,ARRAY['owner','admin','manager','auditor']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_verification_role_required'; END IF;
  IF p_lifecycle_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dpp_lifecycle_events WHERE id=p_lifecycle_event_id AND product_id=p_product_id)
  THEN RAISE EXCEPTION 'claim_event_mismatch'; END IF;
  IF p_supersedes_claim_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dpp_claims WHERE id=p_supersedes_claim_id AND product_id=p_product_id)
  THEN RAISE EXCEPTION 'superseded_claim_not_found'; END IF;
  INSERT INTO dpp_claims(product_id,owner_organization_id,lifecycle_event_id,claim_key,statement,public_statement,
    subject_scope,subject_reference,validation_status,valid_from,valid_until,supersedes_claim_id,rejection_reason,created_by)
  VALUES(p_product_id,v_product.brand_organization_id,p_lifecycle_event_id,trim(p_claim_key),trim(p_statement),NULLIF(trim(p_public_statement),''),
    p_subject_scope,NULLIF(trim(p_subject_reference),''),p_validation_status,p_valid_from,p_valid_until,p_supersedes_claim_id,
    NULLIF(trim(p_rejection_reason),''),tracefab_current_user_id()) RETURNING * INTO v_claim;
  RETURN v_claim;
END $$;

CREATE OR REPLACE FUNCTION tracefab_link_dpp_claim_evidence(
  p_claim_id UUID,p_document_id UUID,p_relationship TEXT DEFAULT 'supports',p_coverage_note TEXT DEFAULT NULL,
  p_verification_result TEXT DEFAULT 'pending',p_verification_reason TEXT DEFAULT NULL,p_public_label TEXT DEFAULT NULL
) RETURNS dpp_claim_evidence LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_claim dpp_claims; v_link dpp_claim_evidence;
BEGIN
  SELECT * INTO v_claim FROM dpp_claims WHERE id=p_claim_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dpp_claim_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_claim.owner_organization_id,ARRAY['owner','admin','manager','contributor','auditor']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_claim_role_required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM documents WHERE id=p_document_id AND owner_organization_id=v_claim.owner_organization_id AND deleted_at IS NULL)
  THEN RAISE EXCEPTION 'invalid_evidence_document'; END IF;
  IF p_verification_result <> 'pending' AND NOT tracefab_has_org_role(v_claim.owner_organization_id,ARRAY['owner','admin','manager','auditor']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_verification_role_required'; END IF;
  INSERT INTO dpp_claim_evidence(claim_id,document_id,relationship,coverage_note,verification_result,verification_reason,public_label,linked_by)
  VALUES(p_claim_id,p_document_id,p_relationship,NULLIF(trim(p_coverage_note),''),p_verification_result,
    NULLIF(trim(p_verification_reason),''),NULLIF(trim(p_public_label),''),tracefab_current_user_id()) RETURNING * INTO v_link;
  RETURN v_link;
END $$;

-- Projection anonyme sans UUID document, nom de fichier, chemin, acteur ni note privée.
CREATE OR REPLACE FUNCTION tracefab_public_dpp_claims(p_product_id UUID)
RETURNS TABLE(id UUID,claim_key TEXT,statement TEXT,validation_status TEXT,valid_from DATE,valid_until DATE,
  expired BOOLEAN,accepted_evidence_count INTEGER,evidence_labels TEXT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT c.id,c.claim_key,c.public_statement,c.validation_status::text,c.valid_from,c.valid_until,
    (c.valid_until IS NOT NULL AND c.valid_until < current_date),
    count(e.id) FILTER(WHERE e.verification_result='accepted')::integer,
    COALESCE(array_agg(e.public_label ORDER BY e.linked_at) FILTER(WHERE e.verification_result='accepted' AND e.public_label IS NOT NULL),'{}')
  FROM dpp_claims c LEFT JOIN dpp_claim_evidence e ON e.claim_id=c.id
  WHERE tracefab_public_context() AND tracefab_product_is_public(c.product_id) AND c.product_id=p_product_id
    AND c.public_statement IS NOT NULL AND c.validation_status <> 'rejected'
  GROUP BY c.id ORDER BY c.created_at DESC
$$;

ALTER TABLE dpp_claims ENABLE ROW LEVEL SECURITY; ALTER TABLE dpp_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE dpp_claim_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE dpp_claim_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY dpp_claims_private_select ON dpp_claims FOR SELECT USING(tracefab_can_access_org(owner_organization_id));
CREATE POLICY dpp_claims_function_insert ON dpp_claims FOR INSERT WITH CHECK(tracefab_is_org_member(owner_organization_id));
CREATE POLICY dpp_claim_evidence_private_select ON dpp_claim_evidence FOR SELECT USING(EXISTS(SELECT 1 FROM dpp_claims c WHERE c.id=claim_id AND tracefab_can_access_org(c.owner_organization_id)));
CREATE POLICY dpp_claim_evidence_function_insert ON dpp_claim_evidence FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM dpp_claims c WHERE c.id=claim_id AND tracefab_is_org_member(c.owner_organization_id)));
REVOKE ALL ON dpp_claims,dpp_claim_evidence FROM PUBLIC; GRANT SELECT ON dpp_claims,dpp_claim_evidence TO PUBLIC;
REVOKE ALL ON FUNCTION tracefab_add_dpp_claim(UUID,TEXT,TEXT,TEXT,dpp_event_validation_status,UUID,TEXT,TEXT,DATE,DATE,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_link_dpp_claim_evidence(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_public_dpp_claims(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_reject_dpp_claim_mutation() FROM PUBLIC;
DO $grants$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tracefab_app') THEN
  GRANT EXECUTE ON FUNCTION tracefab_add_dpp_claim(UUID,TEXT,TEXT,TEXT,dpp_event_validation_status,UUID,TEXT,TEXT,DATE,DATE,UUID,TEXT) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_link_dpp_claim_evidence(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_public_dpp_claims(UUID) TO tracefab_app;
END IF; END $grants$;

COMMENT ON TABLE dpp_claims IS 'Affirmations DPP append-only avec périmètre, validité et confiance explicites.';
COMMENT ON TABLE dpp_claim_evidence IS 'Liens entre affirmations et documents; un lien ou un hash ne prouve pas la véracité.';
COMMENT ON FUNCTION tracefab_public_dpp_claims(UUID) IS 'Projection publique en liste blanche, sans identifiant ni emplacement documentaire.';
