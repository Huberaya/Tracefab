-- TRACEFAB — règles de confiance explicites pour le passeport dynamique.
--
-- Cette migration corrige un défaut mesuré : une organisation pouvait déclarer
-- elle-même un statut « third_party_verified » (événement ou affirmation) sans
-- organisme vérificateur, sans mandat et sans preuve. Un badge de confiance
-- n'est pas une décoration : il doit correspondre à une règle vérifiable.
--
-- Principes retenus :
--   * une affirmation naît « declared » ; elle change de statut par une revue
--     append-only, jamais par une mise à jour silencieuse ;
--   * « documented » / « controlled » exigent au moins une preuve acceptée ;
--     « corroborated » exige au moins deux documents distincts acceptés ;
--   * « third_party_verified » exige un organisme de type verifier, dont
--     l'utilisateur est membre avec un rôle de contrôle, et un mandat actif
--     (brand_supplier_relationships) accordé par la marque ;
--   * un fournisseur ordinaire ne reçoit aucun droit supplémentaire : seuls
--     les organismes explicitement liés comme verifier peuvent lire le
--     périmètre d'audit et enregistrer une revue.
--
-- Les documents restent privés : le vérificateur voit les métadonnées de
-- preuve (libellé public, résultat, périmètre), pas le fichier lui-même.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Colonne de vérification tierce sur les événements
-- ---------------------------------------------------------------------------
ALTER TABLE dpp_lifecycle_events
  ADD COLUMN IF NOT EXISTS verified_by_organization_id UUID
  REFERENCES organizations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_dpp_events_verifier
  ON dpp_lifecycle_events(verified_by_organization_id)
  WHERE verified_by_organization_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Revue d'affirmation append-only
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dpp_claim_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES dpp_claims(id) ON DELETE RESTRICT,
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  reviewer_organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT,
  resulting_status dpp_event_validation_status NOT NULL,
  method TEXT NOT NULL,
  notes TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (resulting_status IN ('documented','controlled','corroborated','third_party_verified','rejected')),
  CHECK (length(trim(method)) BETWEEN 1 AND 200),
  CHECK (notes IS NULL OR length(trim(notes)) <= 2000),
  CHECK (resulting_status <> 'rejected' OR length(trim(COALESCE(notes,''))) > 0),
  CHECK (resulting_status <> 'third_party_verified' OR reviewer_organization_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dpp_claim_reviews_claim
  ON dpp_claim_reviews(claim_id, reviewed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dpp_claim_reviews_owner
  ON dpp_claim_reviews(owner_organization_id, reviewed_at DESC);

CREATE OR REPLACE FUNCTION tracefab_reject_dpp_claim_review_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'dpp_claim_reviews_are_append_only';
END $$;

DROP TRIGGER IF EXISTS dpp_claim_reviews_no_update_delete ON dpp_claim_reviews;
CREATE TRIGGER dpp_claim_reviews_no_update_delete
  BEFORE UPDATE OR DELETE ON dpp_claim_reviews
  FOR EACH ROW EXECUTE FUNCTION tracefab_reject_dpp_claim_review_mutation();

-- ---------------------------------------------------------------------------
-- 3. Mandats de vérification tierce
-- ---------------------------------------------------------------------------
-- Un organisme `verifier` ne peut pas s'auto-inviter sur le passeport d'une
-- marque. Le mandat est explicite, accordé par la marque, révocable et
-- conservé : révoquer ne supprime pas la trace de la relation.
CREATE TABLE IF NOT EXISTS dpp_verification_mandates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  verifier_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL DEFAULT 'product_passport_review'
    CHECK (scope IN ('product_passport_review')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  notes TEXT CHECK (notes IS NULL OR length(trim(notes)) <= 1000),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  CHECK (brand_organization_id <> verifier_organization_id),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dpp_verification_mandates_active
  ON dpp_verification_mandates(brand_organization_id, verifier_organization_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_dpp_verification_mandates_verifier
  ON dpp_verification_mandates(verifier_organization_id, status);

CREATE OR REPLACE FUNCTION tracefab_grant_dpp_verification_mandate(
  p_brand_organization_id UUID,
  p_verifier_organization_id UUID,
  p_notes TEXT DEFAULT NULL
) RETURNS dpp_verification_mandates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mandate dpp_verification_mandates; v_type organization_type;
BEGIN
  IF NOT tracefab_has_org_role(p_brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_mandate_role_required'; END IF;
  SELECT o.type INTO v_type FROM organizations o
   WHERE o.id = p_verifier_organization_id AND o.status = 'active'::organization_status;
  IF v_type IS DISTINCT FROM 'verifier'::organization_type
  THEN RAISE EXCEPTION 'third_party_verifier_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM dpp_verification_mandates m
              WHERE m.brand_organization_id = p_brand_organization_id
                AND m.verifier_organization_id = p_verifier_organization_id
                AND m.status = 'active')
  THEN RAISE EXCEPTION 'dpp_verification_mandate_already_active'; END IF;
  INSERT INTO dpp_verification_mandates(brand_organization_id, verifier_organization_id, notes, granted_by)
  VALUES(p_brand_organization_id, p_verifier_organization_id, NULLIF(trim(p_notes),''), tracefab_current_user_id())
  RETURNING * INTO v_mandate;
  INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
  VALUES(p_brand_organization_id,tracefab_current_user_id(),'dpp.verification_mandate.granted','dpp_verification_mandate',v_mandate.id,
    jsonb_build_object('verifier_organization_id',p_verifier_organization_id));
  RETURN v_mandate;
END $$;

CREATE OR REPLACE FUNCTION tracefab_revoke_dpp_verification_mandate(
  p_mandate_id UUID,
  p_reason TEXT
) RETURNS dpp_verification_mandates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mandate dpp_verification_mandates;
BEGIN
  SELECT * INTO v_mandate FROM dpp_verification_mandates WHERE id = p_mandate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dpp_verification_mandate_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_mandate.brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
  THEN RAISE EXCEPTION 'dpp_mandate_role_required'; END IF;
  IF length(trim(COALESCE(p_reason,''))) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'dpp_mandate_revocation_reason_required'; END IF;
  IF v_mandate.status = 'revoked' THEN RETURN v_mandate; END IF;
  UPDATE dpp_verification_mandates
     SET status='revoked', revoked_by=tracefab_current_user_id(), revoked_at=now(), revoked_reason=trim(p_reason)
   WHERE id=p_mandate_id RETURNING * INTO v_mandate;
  INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
  VALUES(v_mandate.brand_organization_id,tracefab_current_user_id(),'dpp.verification_mandate.revoked','dpp_verification_mandate',v_mandate.id,
    jsonb_build_object('verifier_organization_id',v_mandate.verifier_organization_id));
  RETURN v_mandate;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Helpers de mandat vérificateur
-- ---------------------------------------------------------------------------

-- Vrai si l'utilisateur courant est membre actif d'un organisme vérificateur
-- relié à la marque par une relation active. SECURITY DEFINER : la fonction
-- lit les relations et appartenances sans exposer ces tables au rôle runtime.
CREATE OR REPLACE FUNCTION tracefab_is_mandated_verifier(p_brand_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM dpp_verification_mandates m
    JOIN organizations o ON o.id = m.verifier_organization_id
    WHERE m.brand_organization_id = p_brand_organization_id
      AND m.status = 'active'
      AND o.type = 'verifier'::organization_type
      AND o.status = 'active'::organization_status
      AND tracefab_is_org_member(m.verifier_organization_id)
  );
$$;

-- Résolution d'un produit pour un vérificateur mandaté. Ne donne accès qu'aux
-- identifiants nécessaires au parcours de revue, jamais aux documents.
CREATE OR REPLACE FUNCTION tracefab_verifier_product(p_product_id UUID)
RETURNS TABLE(id UUID, brand_organization_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.brand_organization_id
  FROM tracefab_products p
  WHERE p.id = p_product_id
    AND tracefab_is_mandated_verifier(p.brand_organization_id);
$$;

-- Nom public d'un organisme vérificateur : display_name uniquement, jamais la
-- raison sociale, le contact ou un identifiant technique.
CREATE OR REPLACE FUNCTION tracefab_public_verifier_name(p_organization_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN o.type = 'verifier'::organization_type
     AND o.status = 'active'::organization_status
    THEN NULLIF(trim(o.display_name), '')
    ELSE NULL
  END
  FROM organizations o
  WHERE o.id = p_organization_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Création d'affirmation : toujours « declared »
-- ---------------------------------------------------------------------------
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
  -- Une affirmation ne peut pas naître avec un statut que personne n'a contrôlé.
  IF p_validation_status <> 'declared'::dpp_event_validation_status
  THEN RAISE EXCEPTION 'dpp_claim_initial_status_must_be_declared'; END IF;
  IF p_lifecycle_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dpp_lifecycle_events WHERE id=p_lifecycle_event_id AND product_id=p_product_id)
  THEN RAISE EXCEPTION 'claim_event_mismatch'; END IF;
  IF p_supersedes_claim_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dpp_claims WHERE id=p_supersedes_claim_id AND product_id=p_product_id)
  THEN RAISE EXCEPTION 'superseded_claim_not_found'; END IF;
  INSERT INTO dpp_claims(product_id,owner_organization_id,lifecycle_event_id,claim_key,statement,public_statement,
    subject_scope,subject_reference,validation_status,valid_from,valid_until,supersedes_claim_id,rejection_reason,created_by)
  VALUES(p_product_id,v_product.brand_organization_id,p_lifecycle_event_id,trim(p_claim_key),trim(p_statement),NULLIF(trim(p_public_statement),''),
    p_subject_scope,NULLIF(trim(p_subject_reference),''),'declared',p_valid_from,p_valid_until,p_supersedes_claim_id,
    NULLIF(trim(p_rejection_reason),''),tracefab_current_user_id()) RETURNING * INTO v_claim;
  RETURN v_claim;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Revue d'affirmation : machine à états testable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tracefab_review_dpp_claim(
  p_claim_id UUID,
  p_resulting_status dpp_event_validation_status,
  p_method TEXT,
  p_notes TEXT DEFAULT NULL,
  p_reviewer_organization_id UUID DEFAULT NULL
) RETURNS dpp_claim_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claim dpp_claims;
  v_review dpp_claim_reviews;
  v_verifier_type organization_type;
  v_evidence_count integer;
BEGIN
  SELECT * INTO v_claim FROM dpp_claims WHERE id = p_claim_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dpp_claim_not_found'; END IF;

  IF p_resulting_status NOT IN ('documented','controlled','corroborated','third_party_verified','rejected')
  THEN RAISE EXCEPTION 'invalid_claim_review_status'; END IF;

  IF length(trim(COALESCE(p_method,''))) NOT BETWEEN 1 AND 200
  THEN RAISE EXCEPTION 'claim_review_method_required'; END IF;

  SELECT count(DISTINCT e.document_id)::integer
    INTO v_evidence_count
    FROM dpp_claim_evidence e
   WHERE e.claim_id = p_claim_id
     AND e.relationship = 'supports'
     AND e.verification_result = 'accepted';

  IF p_reviewer_organization_id IS NULL THEN
    -- Revue interne à la marque : le vérificateur ne peut pas s'auto-attribuer
    -- un statut troisième partie ; seuls documented/controlled/corroborated
    -- sont accessibles, sur preuves acceptées.
    IF NOT tracefab_has_org_role(v_claim.owner_organization_id,
      ARRAY['owner','admin','manager','auditor']::membership_role[])
    THEN RAISE EXCEPTION 'dpp_claim_review_role_required'; END IF;

    IF p_resulting_status = 'third_party_verified'::dpp_event_validation_status
    THEN RAISE EXCEPTION 'third_party_verifier_role_required'; END IF;

    IF p_resulting_status IN ('documented','controlled') AND v_evidence_count < 1
    THEN RAISE EXCEPTION 'dpp_claim_evidence_required'; END IF;
    IF p_resulting_status = 'corroborated' AND v_evidence_count < 2
    THEN RAISE EXCEPTION 'dpp_claim_corroboration_required'; END IF;
  ELSE
    SELECT o.type INTO v_verifier_type
      FROM organizations o
     WHERE o.id = p_reviewer_organization_id
       AND o.status = 'active'::organization_status;
    IF v_verifier_type IS DISTINCT FROM 'verifier'::organization_type
    THEN RAISE EXCEPTION 'third_party_verifier_invalid'; END IF;

    IF NOT tracefab_has_org_role(p_reviewer_organization_id,
      ARRAY['owner','admin','manager','auditor']::membership_role[])
    THEN RAISE EXCEPTION 'third_party_verifier_role_required'; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM dpp_verification_mandates m
       WHERE m.brand_organization_id = v_claim.owner_organization_id
         AND m.verifier_organization_id = p_reviewer_organization_id
         AND m.status = 'active'
    ) THEN RAISE EXCEPTION 'dpp_verification_mandate_required'; END IF;

    IF p_resulting_status NOT IN ('third_party_verified','rejected')
    THEN RAISE EXCEPTION 'third_party_review_status_invalid'; END IF;

    IF p_resulting_status = 'third_party_verified' AND v_evidence_count < 1
    THEN RAISE EXCEPTION 'dpp_claim_evidence_required'; END IF;
  END IF;

  IF p_resulting_status = 'rejected'
     AND length(trim(COALESCE(p_notes,''))) = 0
  THEN RAISE EXCEPTION 'claim_rejection_reason_required'; END IF;

  INSERT INTO dpp_claim_reviews(claim_id,owner_organization_id,reviewer_organization_id,
    resulting_status,method,notes,reviewed_by)
  VALUES(p_claim_id,v_claim.owner_organization_id,p_reviewer_organization_id,
    p_resulting_status,trim(p_method),NULLIF(trim(p_notes),''),tracefab_current_user_id())
  RETURNING * INTO v_review;

  RETURN v_review;
END $$;

-- L'ancienne version acceptait une revue arbitraire sans preuve : elle est
-- remplacée par la fonction ci-dessus, qui conserve la même signature.

-- ---------------------------------------------------------------------------
-- 6. Événements : statut documenté/tiers vérifié adossé à des preuves
-- ---------------------------------------------------------------------------
-- La signature reçoit un quatorzième paramètre optionnel. L'ancienne fonction
-- est supprimée pour qu'aucun appel à 13 arguments ne contourne les règles.
DROP FUNCTION IF EXISTS tracefab_add_dpp_event(UUID,TEXT,TEXT,TIMESTAMPTZ,TEXT,dpp_event_validation_status,TEXT,JSONB,UUID[],UUID,TEXT,TEXT,TEXT);

CREATE OR REPLACE FUNCTION tracefab_add_dpp_event(
  p_product_id UUID, p_event_type TEXT, p_summary TEXT,
  p_business_occurred_at TIMESTAMPTZ DEFAULT NULL,
  p_source_kind TEXT DEFAULT 'actor_declaration',
  p_validation_status dpp_event_validation_status DEFAULT 'declared',
  p_public_summary TEXT DEFAULT NULL, p_details JSONB DEFAULT '{}'::jsonb,
  p_evidence_document_ids UUID[] DEFAULT '{}', p_corrects_event_id UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL, p_subject_scope TEXT DEFAULT 'model',
  p_subject_reference TEXT DEFAULT NULL,
  p_verified_by_organization_id UUID DEFAULT NULL
) RETURNS dpp_lifecycle_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_product tracefab_products;
  v_event dpp_lifecycle_events;
  v_document_count integer;
  v_distinct_documents integer;
  v_verifier_type organization_type;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_product_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  -- Un vérificateur mandaté peut enregistrer un événement third_party_verified
  -- sans être membre de la marque ; tous les autres statuts restent réservés
  -- aux rôles de la marque.
  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager','contributor','auditor']::membership_role[]) THEN
    IF p_validation_status <> 'third_party_verified'::dpp_event_validation_status
       OR p_verified_by_organization_id IS NULL
       OR NOT tracefab_has_org_role(p_verified_by_organization_id, ARRAY['owner','admin','manager','auditor']::membership_role[])
    THEN RAISE EXCEPTION 'dpp_event_role_required'; END IF;
  END IF;
  IF p_verified_by_organization_id IS NULL
     AND p_validation_status IN ('controlled','corroborated','third_party_verified','rejected')
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

  SELECT count(DISTINCT d)::integer INTO v_distinct_documents
    FROM unnest(COALESCE(p_evidence_document_ids, '{}')) AS d;

  -- Les événements systeme de publication sont produits par la fonction
  -- transactionnelle elle-meme : ils n'ont pas de document externe et ne
  -- peuvent pas etre fabriques par un appelant.
  IF p_source_kind = 'system' THEN
    IF p_event_type NOT IN ('published','publication_suspended','publication_withdrawn','publication_reviewed')
       OR p_validation_status <> 'controlled'::dpp_event_validation_status
    THEN RAISE EXCEPTION 'system_event_source_reserved'; END IF;
  ELSE
    IF p_validation_status = 'documented' AND v_distinct_documents < 1
    THEN RAISE EXCEPTION 'dpp_event_evidence_required'; END IF;
    IF p_validation_status IN ('controlled','corroborated','third_party_verified')
       AND v_distinct_documents < 1
    THEN RAISE EXCEPTION 'dpp_event_evidence_required'; END IF;
    IF p_validation_status = 'corroborated' AND v_distinct_documents < 2
    THEN RAISE EXCEPTION 'dpp_event_corroboration_required'; END IF;
  END IF;

  IF p_validation_status = 'third_party_verified' THEN
    IF p_verified_by_organization_id IS NULL
    THEN RAISE EXCEPTION 'third_party_verifier_organization_required'; END IF;
    SELECT o.type INTO v_verifier_type FROM organizations o
     WHERE o.id = p_verified_by_organization_id AND o.status = 'active'::organization_status;
    IF v_verifier_type IS DISTINCT FROM 'verifier'::organization_type
    THEN RAISE EXCEPTION 'third_party_verifier_invalid'; END IF;
    IF NOT tracefab_has_org_role(p_verified_by_organization_id,
      ARRAY['owner','admin','manager','auditor']::membership_role[])
    THEN RAISE EXCEPTION 'third_party_verifier_role_required'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM dpp_verification_mandates m
       WHERE m.brand_organization_id = v_product.brand_organization_id
         AND m.verifier_organization_id = p_verified_by_organization_id
         AND m.status = 'active'
    ) THEN RAISE EXCEPTION 'dpp_verification_mandate_required'; END IF;
  ELSIF p_verified_by_organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'verified_organization_not_allowed';
  END IF;

  INSERT INTO dpp_lifecycle_events(product_id, owner_organization_id, event_type, subject_scope,
    subject_reference, business_occurred_at, actor_user_id, source_kind, validation_status,
    summary, details, public_summary, evidence_document_ids, corrects_event_id, idempotency_key,
    verified_by_organization_id)
  VALUES (p_product_id, v_product.brand_organization_id, p_event_type, p_subject_scope,
    NULLIF(trim(p_subject_reference),''), p_business_occurred_at, tracefab_current_user_id(), p_source_kind,
    p_validation_status, trim(p_summary), COALESCE(p_details,'{}'), NULLIF(trim(p_public_summary),''),
    COALESCE(p_evidence_document_ids,'{}'), p_corrects_event_id, NULLIF(trim(p_idempotency_key),''),
    p_verified_by_organization_id)
  ON CONFLICT (owner_organization_id, idempotency_key) DO NOTHING RETURNING * INTO v_event;
  IF v_event.id IS NULL THEN SELECT * INTO v_event FROM dpp_lifecycle_events
    WHERE owner_organization_id=v_product.brand_organization_id AND idempotency_key=p_idempotency_key; END IF;
  RETURN v_event;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Projection publique des affirmations : statut effectif + vérificateur
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS tracefab_public_dpp_claims(UUID);

CREATE OR REPLACE FUNCTION tracefab_public_dpp_claims(p_product_id UUID)
RETURNS TABLE(
  id UUID,
  claim_key TEXT,
  statement TEXT,
  validation_status TEXT,
  valid_from DATE,
  valid_until DATE,
  expired BOOLEAN,
  accepted_evidence_count INTEGER,
  evidence_labels TEXT[],
  contradicting_evidence_count INTEGER,
  verifier_display_name TEXT,
  reviewed_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH latest_review AS (
    SELECT DISTINCT ON (r.claim_id)
           r.claim_id, r.resulting_status, r.reviewer_organization_id, r.reviewed_at
      FROM dpp_claim_reviews r
     ORDER BY r.claim_id, r.reviewed_at DESC, r.id DESC
  )
  SELECT c.id,
    c.claim_key,
    c.public_statement,
    COALESCE(r.resulting_status, c.validation_status)::text,
    c.valid_from,
    c.valid_until,
    (c.valid_until IS NOT NULL AND c.valid_until < current_date),
    count(e.id) FILTER (WHERE e.relationship='supports' AND e.verification_result='accepted')::integer,
    COALESCE(array_agg(e.public_label ORDER BY e.linked_at)
      FILTER (WHERE e.relationship='supports' AND e.verification_result='accepted' AND e.public_label IS NOT NULL), '{}'),
    count(e.id) FILTER (WHERE e.relationship='contradicts' AND e.verification_result='accepted')::integer,
    CASE WHEN COALESCE(r.resulting_status, c.validation_status) = 'third_party_verified'::dpp_event_validation_status
         THEN tracefab_public_verifier_name(r.reviewer_organization_id) END,
    r.reviewed_at
  FROM dpp_claims c
  LEFT JOIN latest_review r ON r.claim_id = c.id
  LEFT JOIN dpp_claim_evidence e ON e.claim_id = c.id
  WHERE tracefab_public_context()
    AND tracefab_product_is_public(c.product_id)
    AND c.product_id = p_product_id
    AND c.public_statement IS NOT NULL
    AND COALESCE(r.resulting_status, c.validation_status) <> 'rejected'::dpp_event_validation_status
    AND NOT EXISTS (SELECT 1 FROM dpp_claims n WHERE n.supersedes_claim_id = c.id)
  GROUP BY c.id, r.resulting_status, r.reviewer_organization_id, r.reviewed_at
  ORDER BY c.created_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- 8. RLS : lecture d'audit pour un vérificateur mandaté, écriture inchangée
-- ---------------------------------------------------------------------------
ALTER TABLE dpp_verification_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpp_verification_mandates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dpp_verification_mandates_select ON dpp_verification_mandates;
CREATE POLICY dpp_verification_mandates_select ON dpp_verification_mandates
  FOR SELECT USING (
    tracefab_can_access_org(brand_organization_id)
    OR tracefab_is_org_member(verifier_organization_id)
  );

DROP POLICY IF EXISTS dpp_verification_mandates_function_insert ON dpp_verification_mandates;
CREATE POLICY dpp_verification_mandates_function_insert ON dpp_verification_mandates
  FOR INSERT WITH CHECK (
    tracefab_has_org_role(brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
  );

DROP POLICY IF EXISTS dpp_verification_mandates_function_update ON dpp_verification_mandates;
CREATE POLICY dpp_verification_mandates_function_update ON dpp_verification_mandates
  FOR UPDATE USING (
    tracefab_has_org_role(brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
  );

ALTER TABLE dpp_claim_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpp_claim_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dpp_claim_reviews_private_select ON dpp_claim_reviews;
CREATE POLICY dpp_claim_reviews_private_select ON dpp_claim_reviews
  FOR SELECT USING (
    tracefab_can_access_org(owner_organization_id)
    OR (reviewer_organization_id IS NOT NULL AND tracefab_is_org_member(reviewer_organization_id))
  );

DROP POLICY IF EXISTS dpp_claim_reviews_function_insert ON dpp_claim_reviews;
CREATE POLICY dpp_claim_reviews_function_insert ON dpp_claim_reviews
  FOR INSERT WITH CHECK (
    tracefab_has_org_role(owner_organization_id, ARRAY['owner','admin','manager','auditor']::membership_role[])
    OR (reviewer_organization_id IS NOT NULL AND tracefab_has_org_role(reviewer_organization_id, ARRAY['owner','admin','manager','auditor']::membership_role[]))
  );

DROP POLICY IF EXISTS dpp_claims_verifier_select ON dpp_claims;
CREATE POLICY dpp_claims_verifier_select ON dpp_claims
  FOR SELECT USING (tracefab_is_mandated_verifier(owner_organization_id));

DROP POLICY IF EXISTS dpp_claim_evidence_verifier_select ON dpp_claim_evidence;
CREATE POLICY dpp_claim_evidence_verifier_select ON dpp_claim_evidence
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM dpp_claims c
       WHERE c.id = dpp_claim_evidence.claim_id
         AND tracefab_is_mandated_verifier(c.owner_organization_id)
    )
  );

DROP POLICY IF EXISTS dpp_events_verifier_select ON dpp_lifecycle_events;
CREATE POLICY dpp_events_verifier_select ON dpp_lifecycle_events
  FOR SELECT USING (tracefab_is_mandated_verifier(owner_organization_id));

-- Les documents ne reçoivent AUCUNE politique vérificateur : le mandat porte
-- sur les métadonnées de preuve, pas sur le fichier ni son emplacement.

REVOKE ALL ON dpp_claim_reviews FROM PUBLIC;
GRANT SELECT ON dpp_claim_reviews TO PUBLIC;
REVOKE ALL ON dpp_verification_mandates FROM PUBLIC;
GRANT SELECT ON dpp_verification_mandates TO PUBLIC;

REVOKE ALL ON FUNCTION tracefab_review_dpp_claim(UUID,dpp_event_validation_status,TEXT,TEXT,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_add_dpp_claim(UUID,TEXT,TEXT,TEXT,dpp_event_validation_status,UUID,TEXT,TEXT,DATE,DATE,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_add_dpp_event(UUID,TEXT,TEXT,TIMESTAMPTZ,TEXT,dpp_event_validation_status,TEXT,JSONB,UUID[],UUID,TEXT,TEXT,TEXT,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_public_dpp_claims(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_is_mandated_verifier(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_verifier_product(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_public_verifier_name(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_grant_dpp_verification_mandate(UUID,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_revoke_dpp_verification_mandate(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_reject_dpp_claim_review_mutation() FROM PUBLIC;

DO $grants$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tracefab_app') THEN
  GRANT EXECUTE ON FUNCTION tracefab_review_dpp_claim(UUID,dpp_event_validation_status,TEXT,TEXT,UUID) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_add_dpp_claim(UUID,TEXT,TEXT,TEXT,dpp_event_validation_status,UUID,TEXT,TEXT,DATE,DATE,UUID,TEXT) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_add_dpp_event(UUID,TEXT,TEXT,TIMESTAMPTZ,TEXT,dpp_event_validation_status,TEXT,JSONB,UUID[],UUID,TEXT,TEXT,TEXT,UUID) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_public_dpp_claims(UUID) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_is_mandated_verifier(UUID) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_verifier_product(UUID) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_public_verifier_name(UUID) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_grant_dpp_verification_mandate(UUID,UUID,TEXT) TO tracefab_app;
  GRANT EXECUTE ON FUNCTION tracefab_revoke_dpp_verification_mandate(UUID,TEXT) TO tracefab_app;
END IF; END $grants$;

COMMENT ON TABLE dpp_verification_mandates IS 'Mandats explicites accordes par une marque a un organisme verifier; la revocation est conservee.';
COMMENT ON TABLE dpp_claim_reviews IS 'Revues append-only des affirmations DPP. Le statut public effectif est la dernière revue non rejetée, jamais une écriture silencieuse.';
COMMENT ON COLUMN dpp_claim_reviews.reviewer_organization_id IS 'Organisme vérificateur mandaté pour third_party_verified; NULL pour une revue interne à la marque.';
COMMENT ON COLUMN dpp_lifecycle_events.verified_by_organization_id IS 'Organisme vérificateur identifié pour un événement third_party_verified; jamais un simple badge.';
COMMENT ON FUNCTION tracefab_public_verifier_name(UUID) IS 'Nom d affichage public d un organisme verifier uniquement; aucune donnee de contact.';

COMMIT;
