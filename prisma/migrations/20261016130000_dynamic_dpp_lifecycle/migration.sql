-- Passeport dynamique : registre append-only, publication explicite et historique public en liste blanche.
-- Cette migration est preparee pour `prisma migrate deploy`; elle ne doit pas etre appliquee directement en production.

DO $$ BEGIN
  CREATE TYPE dpp_event_validation_status AS ENUM ('declared', 'documented', 'controlled', 'corroborated', 'third_party_verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE dpp_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES tracefab_products(id) ON DELETE RESTRICT,
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'passport_created', 'data_submitted', 'evidence_added', 'manufacturing_step',
    'data_corrected', 'repair', 'reuse', 'recycling', 'publication_reviewed',
    'published', 'publication_suspended', 'publication_withdrawn'
  )),
  subject_scope TEXT NOT NULL DEFAULT 'model' CHECK (subject_scope IN ('model', 'variant', 'batch', 'unit')),
  subject_reference TEXT,
  business_occurred_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL DEFAULT 'actor_declaration' CHECK (source_kind IN ('actor_declaration', 'document', 'system', 'third_party')),
  validation_status dpp_event_validation_status NOT NULL DEFAULT 'declared',
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 500),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  public_summary TEXT CHECK (public_summary IS NULL OR length(trim(public_summary)) BETWEEN 1 AND 500),
  evidence_document_ids UUID[] NOT NULL DEFAULT '{}',
  corrects_event_id UUID REFERENCES dpp_lifecycle_events(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (event_type <> 'data_corrected' OR corrects_event_id IS NOT NULL),
  CHECK (business_occurred_at IS NULL OR business_occurred_at <= recorded_at + interval '5 minutes'),
  UNIQUE (owner_organization_id, idempotency_key)
);

CREATE INDEX idx_dpp_events_product_recorded ON dpp_lifecycle_events(product_id, recorded_at DESC, id DESC);
CREATE INDEX idx_dpp_events_owner_recorded ON dpp_lifecycle_events(owner_organization_id, recorded_at DESC);

-- Append-only, y compris pour le role applicatif. Une correction est un nouvel evenement.
CREATE OR REPLACE FUNCTION tracefab_reject_dpp_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'dpp_events_are_append_only'; END; $$;
CREATE TRIGGER dpp_events_no_update_delete BEFORE UPDATE OR DELETE ON dpp_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION tracefab_reject_dpp_event_mutation();

CREATE OR REPLACE FUNCTION tracefab_add_dpp_event(
  p_product_id UUID, p_event_type TEXT, p_summary TEXT,
  p_business_occurred_at TIMESTAMPTZ DEFAULT NULL,
  p_source_kind TEXT DEFAULT 'actor_declaration',
  p_validation_status dpp_event_validation_status DEFAULT 'declared',
  p_public_summary TEXT DEFAULT NULL, p_details JSONB DEFAULT '{}'::jsonb,
  p_evidence_document_ids UUID[] DEFAULT '{}', p_corrects_event_id UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL, p_subject_scope TEXT DEFAULT 'model',
  p_subject_reference TEXT DEFAULT NULL
) RETURNS dpp_lifecycle_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_product tracefab_products; v_event dpp_lifecycle_events; v_document_count integer;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_product_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager','contributor','auditor']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_event_role_required'; END IF;
  IF p_validation_status IN ('controlled','corroborated','third_party_verified','rejected')
     AND NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager','auditor']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_verification_role_required'; END IF;
  IF p_event_type IN ('published','publication_suspended','publication_withdrawn','publication_reviewed')
     AND NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_publish_review_role_required'; END IF;
  IF p_corrects_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM dpp_lifecycle_events e WHERE e.id=p_corrects_event_id AND e.product_id=p_product_id
  ) THEN RAISE EXCEPTION 'corrected_event_not_found'; END IF;
  SELECT count(*) INTO v_document_count FROM documents d
   WHERE d.id = ANY(COALESCE(p_evidence_document_ids, '{}'))
     AND d.owner_organization_id = v_product.brand_organization_id AND d.deleted_at IS NULL;
  IF v_document_count <> cardinality(COALESCE(p_evidence_document_ids, '{}')) THEN RAISE EXCEPTION 'invalid_evidence_document'; END IF;
  INSERT INTO dpp_lifecycle_events(product_id, owner_organization_id, event_type, subject_scope,
    subject_reference, business_occurred_at, actor_user_id, source_kind, validation_status,
    summary, details, public_summary, evidence_document_ids, corrects_event_id, idempotency_key)
  VALUES (p_product_id, v_product.brand_organization_id, p_event_type, p_subject_scope,
    NULLIF(trim(p_subject_reference),''), p_business_occurred_at, tracefab_current_user_id(), p_source_kind,
    p_validation_status, trim(p_summary), COALESCE(p_details,'{}'), NULLIF(trim(p_public_summary),''),
    COALESCE(p_evidence_document_ids,'{}'), p_corrects_event_id, NULLIF(trim(p_idempotency_key),''))
  ON CONFLICT (owner_organization_id, idempotency_key) DO NOTHING RETURNING * INTO v_event;
  IF v_event.id IS NULL THEN SELECT * INTO v_event FROM dpp_lifecycle_events
    WHERE owner_organization_id=v_product.brand_organization_id AND idempotency_key=p_idempotency_key; END IF;
  RETURN v_event;
END $$;

CREATE OR REPLACE FUNCTION tracefab_set_dpp_publication(p_product_id UUID, p_action TEXT, p_public_slug TEXT DEFAULT NULL)
RETURNS dpp_records LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_product tracefab_products; v_record dpp_records; v_type TEXT; v_summary TEXT;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id=p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_publish_review_role_required'; END IF;
  SELECT * INTO v_record FROM dpp_records WHERE product_id=p_product_id ORDER BY computed_at DESC FOR UPDATE LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'dpp_record_not_found'; END IF;
  IF p_action='publish' THEN
    IF v_record.readiness_status <> 'ready_to_publish' OR v_record.reviewed_at IS NULL THEN RAISE EXCEPTION 'dpp_record_not_ready_to_publish'; END IF;
    IF NULLIF(trim(p_public_slug),'') IS NULL OR trim(p_public_slug) !~ '^[a-z0-9][a-z0-9-]{2,79}$' THEN RAISE EXCEPTION 'invalid_public_slug'; END IF;
    UPDATE dpp_records SET readiness_status='published' WHERE id=v_record.id RETURNING * INTO v_record;
    UPDATE tracefab_products SET public_slug=trim(p_public_slug), updated_at=now() WHERE id=p_product_id;
    v_type:='published'; v_summary:='Passeport publie';
  ELSIF p_action IN ('suspend','withdraw') THEN
    IF v_record.readiness_status <> 'published' THEN RAISE EXCEPTION 'dpp_record_not_published'; END IF;
    UPDATE dpp_records SET readiness_status='ready_to_publish' WHERE id=v_record.id RETURNING * INTO v_record;
    UPDATE tracefab_products SET public_slug=NULL, updated_at=now() WHERE id=p_product_id;
    v_type:=CASE WHEN p_action='suspend' THEN 'publication_suspended' ELSE 'publication_withdrawn' END;
    v_summary:=CASE WHEN p_action='suspend' THEN 'Publication suspendue' ELSE 'Publication retiree' END;
  ELSE RAISE EXCEPTION 'invalid_publication_action'; END IF;
  PERFORM tracefab_add_dpp_event(p_product_id,v_type,v_summary,now(),'system','controlled',v_summary,'{}','{}',NULL,NULL,'model',NULL);
  INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
  VALUES(v_product.brand_organization_id,tracefab_current_user_id(),'dpp.'||p_action,'dpp_record',v_record.id,jsonb_build_object('product_id',p_product_id));
  RETURN v_record;
END $$;

ALTER TABLE dpp_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpp_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dpp_events_private_select ON dpp_lifecycle_events FOR SELECT USING (tracefab_can_access_org(owner_organization_id));
-- Necessaire avec FORCE RLS pour la fonction SECURITY DEFINER; aucun droit
-- INSERT direct n'est accorde au role applicatif.
CREATE POLICY dpp_events_function_insert ON dpp_lifecycle_events FOR INSERT WITH CHECK (
  tracefab_has_org_role(owner_organization_id, ARRAY['owner','admin','manager','contributor','auditor']::membership_role[])
);
CREATE POLICY dpp_events_public_select ON dpp_lifecycle_events FOR SELECT USING (
  tracefab_public_context() AND public_summary IS NOT NULL AND validation_status <> 'rejected' AND tracefab_product_is_public(product_id)
);

REVOKE ALL ON dpp_lifecycle_events FROM PUBLIC;
GRANT SELECT ON dpp_lifecycle_events TO PUBLIC;
REVOKE ALL ON FUNCTION tracefab_add_dpp_event(UUID,TEXT,TEXT,TIMESTAMPTZ,TEXT,dpp_event_validation_status,TEXT,JSONB,UUID[],UUID,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_add_dpp_event(UUID,TEXT,TEXT,TIMESTAMPTZ,TEXT,dpp_event_validation_status,TEXT,JSONB,UUID[],UUID,TEXT,TEXT,TEXT) TO PUBLIC;
REVOKE ALL ON FUNCTION tracefab_set_dpp_publication(UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_set_dpp_publication(UUID,TEXT,TEXT) TO PUBLIC;
REVOKE ALL ON FUNCTION tracefab_reject_dpp_event_mutation() FROM PUBLIC;

COMMENT ON TABLE dpp_lifecycle_events IS 'Registre applicatif append-only des evenements DPP. Il preserve les corrections mais ne constitue pas une immutabilite cryptographique.';
COMMENT ON COLUMN dpp_lifecycle_events.public_summary IS 'Projection publique volontaire et minimale; NULL signifie prive.';
COMMENT ON COLUMN dpp_lifecycle_events.validation_status IS 'Niveau de confiance explicite; un hash ou un document seul ne vaut pas verification.';
