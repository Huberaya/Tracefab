-- TRACEFAB — cloisonnement du DPP privé et des fonctions SECURITY DEFINER.
-- Les lignes sont rattachées au produit : les droits partagés sur l'organisation
-- propriétaire ne doivent pas exposer les claims/événements/identités d'un autre
-- tenant. Les fonctions SECURITY DEFINER contournent la RLS du propriétaire :
-- elles vérifient donc explicitement le tenant actif avant toute lecture/écriture.

BEGIN;

DROP POLICY IF EXISTS dpp_claims_private_select ON public.dpp_claims;
CREATE POLICY dpp_claims_private_select ON public.dpp_claims
  FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM public.tracefab_products p
      WHERE p.id = dpp_claims.product_id
        AND tracefab_in_active_tenant(p.brand_organization_id)
    )
    AND tracefab_can_access_org(owner_organization_id)
  );

DROP POLICY IF EXISTS dpp_events_private_select ON public.dpp_lifecycle_events;
CREATE POLICY dpp_events_private_select ON public.dpp_lifecycle_events
  FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM public.tracefab_products p
      WHERE p.id = dpp_lifecycle_events.product_id
        AND tracefab_in_active_tenant(p.brand_organization_id)
    )
    AND tracefab_can_access_org(owner_organization_id)
  );

DROP POLICY IF EXISTS dpp_identity_private_select ON public.dpp_resolvable_identifiers;
CREATE POLICY dpp_identity_private_select ON public.dpp_resolvable_identifiers
  FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM public.tracefab_products p
      WHERE p.id = dpp_resolvable_identifiers.product_id
        AND tracefab_in_active_tenant(p.brand_organization_id)
    )
    AND tracefab_can_access_org(owner_organization_id)
  );

CREATE OR REPLACE FUNCTION public.tracefab_add_dpp_claim(p_product_id uuid, p_claim_key text, p_statement text, p_public_statement text DEFAULT NULL::text, p_validation_status dpp_event_validation_status DEFAULT 'declared'::dpp_event_validation_status, p_lifecycle_event_id uuid DEFAULT NULL::uuid, p_subject_scope text DEFAULT 'model'::text, p_subject_reference text DEFAULT NULL::text, p_valid_from date DEFAULT NULL::date, p_valid_until date DEFAULT NULL::date, p_supersedes_claim_id uuid DEFAULT NULL::uuid, p_rejection_reason text DEFAULT NULL::text)
 RETURNS dpp_claims
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_product tracefab_products; v_claim dpp_claims;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id=p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  IF NOT tracefab_in_active_tenant(v_product.brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.tracefab_add_dpp_event(p_product_id uuid, p_event_type text, p_summary text, p_business_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_source_kind text DEFAULT 'actor_declaration'::text, p_validation_status dpp_event_validation_status DEFAULT 'declared'::dpp_event_validation_status, p_public_summary text DEFAULT NULL::text, p_details jsonb DEFAULT '{}'::jsonb, p_evidence_document_ids uuid[] DEFAULT '{}'::uuid[], p_corrects_event_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_subject_scope text DEFAULT 'model'::text, p_subject_reference text DEFAULT NULL::text)
 RETURNS dpp_lifecycle_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_product tracefab_products; v_event dpp_lifecycle_events; v_document_count integer;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_product_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  IF NOT tracefab_in_active_tenant(v_product.brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.tracefab_add_product_identifier(p_product_id uuid, p_identifier_type text, p_identifier_value text, p_is_primary boolean DEFAULT false)
 RETURNS product_identifiers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_identifier product_identifiers;
  v_brand_organization_id UUID;
  v_type TEXT;
  v_value TEXT;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  IF NOT tracefab_in_active_tenant(v_brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  v_type := lower(trim(COALESCE(p_identifier_type, '')));
  v_value := trim(COALESCE(p_identifier_value, ''));
  IF v_type NOT IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln', 'gpc') OR v_value = '' THEN
    RAISE EXCEPTION 'invalid_product_identifier';
  END IF;

  INSERT INTO product_identifiers (
    product_id,
    identifier_type,
    identifier_value,
    is_primary,
    created_by
  )
  VALUES (
    p_product_id,
    v_type,
    v_value,
    COALESCE(p_is_primary, false),
    tracefab_current_user_id()
  )
  RETURNING * INTO v_identifier;

  RETURN v_identifier;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tracefab_audit_product_green_claims(p_product_id uuid)
 RETURNS green_claims_audits
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product tracefab_products;
  v_claim RECORD;
  v_cert_record RECORD;
  
  v_total_claims INTEGER := 0;
  v_verified_count INTEGER := 0;
  v_prohibited_count INTEGER := 0;
  v_unsubstantiated_count INTEGER := 0;
  v_score INTEGER := 100;
  v_verdict TEXT := 'compliant';
  v_blocking JSONB := '[]'::jsonb;
  v_audit green_claims_audits;
BEGIN
  -- Vérification produit & droits
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'green_claims_product_not_found';
  END IF;
  IF NOT tracefab_in_active_tenant(v_product.brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'green_claims_brand_role_required';
  END IF;

  -- 1. Si aucune allégation déclarée manuellement, analyser la description du produit
  IF NOT EXISTS (SELECT 1 FROM product_green_claims WHERE product_id = p_product_id AND product_version = v_product.version) THEN
    IF v_product.description IS NOT NULL AND length(trim(v_product.description)) > 0 THEN
      DECLARE
        v_desc TEXT := lower(v_product.description);
      BEGIN
        IF v_desc ~* '(bio|biologique|organic)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Fibres Biologiques', 'product_level');
        END IF;

        IF v_desc ~* '(recyclé|recycled|rpet)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Fibres Recyclées', 'product_level');
        END IF;

        IF v_desc ~* '(éco-responsable|durable|vert|naturel)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Vêtement Éco-responsable', 'product_level');
        END IF;

        IF v_desc ~* '(neutre en carbone|zéro émission|compensé)' THEN
          INSERT INTO product_green_claims (product_id, product_version, brand_organization_id, claim_text, claim_type)
          VALUES (p_product_id, v_product.version, v_product.brand_organization_id, 'Neutre en carbone', 'product_level');
        END IF;
      END;
    END IF;
  END IF;

  -- 2. Évaluer chaque allégation du produit
  FOR v_claim IN (
    SELECT * FROM product_green_claims
    WHERE product_id = p_product_id AND product_version = v_product.version
  ) LOOP
    v_total_claims := v_total_claims + 1;
    
    DECLARE
      v_claim_lower TEXT := lower(v_claim.claim_text);
      v_status TEXT := 'unsubstantiated';
      v_risk TEXT := 'medium';
      v_blocking_flag BOOLEAN := false;
      v_explanation TEXT := '';
      v_advice TEXT := '';
      v_cert_id UUID := NULL;
    BEGIN
      -- A. Vérifier si l'allégation contient un terme expressément interdit (neutralité carbone ou terme vague)
      IF v_claim_lower ~* '(neutre en carbone|neutralité carbone|carbon neutral|zéro émission|compensé carbone)' THEN
        v_status := 'prohibited_claim';
        v_risk := 'critical';
        v_blocking_flag := true;
        v_explanation := 'L''allégation de neutralité carbone basée sur la compensation est strictement interdite par la Directive Européenne (UE) 2024/825.';
        v_advice := 'Supprimer l''allégation. Publier l''empreinte carbone brute calculée selon le PEF sans affirmer la neutralité.';
        v_prohibited_count := v_prohibited_count + 1;

      ELSIF v_claim_lower ~* '(éco-responsable|vert|durable|ami de la nature|propre)' THEN
        v_status := 'prohibited_claim';
        v_risk := 'high';
        v_blocking_flag := true;
        v_explanation := 'Les mentions génériques non mesurables sont prohibées sans certification d''excellence environnementale globale (ex: Écolabel Européen).';
        v_advice := 'Remplacer par une assertion précise sur la matière (ex: "Contient 98% de coton biologique certifié").';
        v_prohibited_count := v_prohibited_count + 1;

      -- B. Vérifier si allégation bio étayée par certificat GOTS / OCS
      ELSIF v_claim_lower ~* '(bio|biologique|organic)' THEN
        SELECT id INTO v_cert_record
        FROM certifications
        WHERE (product_id = p_product_id OR owner_organization_id = v_product.brand_organization_id)
          AND standard_code IN ('GOTS', 'OCS', 'GOTS_ORGANIC', 'ORGANIC_100')
          AND status IN ('documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party')
          AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
        LIMIT 1;

        IF FOUND THEN
          v_status := 'verified';
          v_risk := 'low';
          v_cert_id := v_cert_record.id;
          v_explanation := 'Allégation biologique étayée par un certificat valide conforme à la directive Green Claims.';
          v_verified_count := v_verified_count + 1;
        ELSE
          v_status := 'unsubstantiated';
          v_risk := 'high';
          v_blocking_flag := true;
          v_explanation := 'Allégation biologique sans certificat de transaction GOTS ou OCS vérifié.';
          v_advice := 'Téléverser et faire certifier un certificat GOTS valide pour la matière composant ce produit.';
          v_unsubstantiated_count := v_unsubstantiated_count + 1;
        END IF;

      -- C. Vérifier si allégation recyclé étayée par certificat GRS / RCS
      ELSIF v_claim_lower ~* '(recyclé|recycled|rpet)' THEN
        SELECT id INTO v_cert_record
        FROM certifications
        WHERE (product_id = p_product_id OR owner_organization_id = v_product.brand_organization_id)
          AND standard_code IN ('GRS', 'RCS', 'RECYCLED_CLAIM')
          AND status IN ('documented', 'checked_for_consistency', 'verified_by_reviewer', 'certified_by_third_party')
          AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
        LIMIT 1;

        IF FOUND THEN
          v_status := 'verified';
          v_risk := 'low';
          v_cert_id := v_cert_record.id;
          v_explanation := 'Allégation de matière recyclée vérifiée avec chaîne de contrôle conforme GRS.';
          v_verified_count := v_verified_count + 1;
        ELSE
          v_status := 'unsubstantiated';
          v_risk := 'high';
          v_blocking_flag := true;
          v_explanation := 'Mention recyclée non justifiée par un certificat de chaîne de traçabilité (GRS / RCS).';
          v_advice := 'Fournir un certificat GRS attestant du taux exact de fibres recyclées.';
          v_unsubstantiated_count := v_unsubstantiated_count + 1;
        END IF;

      ELSE
        v_status := 'partially_substantiated';
        v_risk := 'medium';
        v_explanation := 'Allégation nécessitant un justificatif probatoire d''audit tiers.';
      END IF;

      UPDATE product_green_claims
      SET status = v_status,
          risk_level = v_risk,
          is_blocking_for_dpp = v_blocking_flag,
          supporting_certification_id = v_cert_id,
          compliance_explanation = v_explanation,
          remediation_suggestion = v_advice,
          verified_at = now(),
          updated_at = now()
      WHERE id = v_claim.id;

      IF v_blocking_flag THEN
        v_blocking := v_blocking || jsonb_build_object(
          'claim_id', v_claim.id,
          'claim_text', v_claim.claim_text,
          'reason', v_explanation,
          'remediation', v_advice
        );
      END IF;
    END;
  END LOOP;

  -- 3. Calcul du Score Global de Conformité
  IF v_total_claims = 0 THEN
    v_score := 100;
    v_verdict := 'compliant';
  ELSE
    v_score := GREATEST(0, 100 - (v_prohibited_count * 40) - (v_unsubstantiated_count * 25));
    IF v_prohibited_count > 0 OR v_score < 50 THEN
      v_verdict := 'non_compliant_greenwashing_risk';
    ELSIF v_unsubstantiated_count > 0 OR v_score < 80 THEN
      v_verdict := 'warning_attention_needed';
    ELSE
      v_verdict := 'compliant';
    END IF;
  END IF;

  -- 4. Enregistrement / Mise à jour dans green_claims_audits
  INSERT INTO green_claims_audits (
    product_id,
    product_version,
    brand_organization_id,
    total_claims_analyzed,
    verified_claims_count,
    prohibited_claims_count,
    unsubstantiated_claims_count,
    green_claims_score,
    audit_verdict,
    blocking_issues,
    audit_summary,
    audited_at
  )
  VALUES (
    p_product_id,
    v_product.version,
    v_product.brand_organization_id,
    v_total_claims,
    v_verified_count,
    v_prohibited_count,
    v_unsubstantiated_count,
    v_score,
    v_verdict,
    v_blocking,
    format('Audit Green Claims : %s allégations (%s vérifiées, %s interdites, %s non étayées). Score : %s/100.', 
           v_total_claims, v_verified_count, v_prohibited_count, v_unsubstantiated_count, v_score),
    now()
  )
  ON CONFLICT (product_id, product_version) DO UPDATE SET
    total_claims_analyzed = EXCLUDED.total_claims_analyzed,
    verified_claims_count = EXCLUDED.verified_claims_count,
    prohibited_claims_count = EXCLUDED.prohibited_claims_count,
    unsubstantiated_claims_count = EXCLUDED.unsubstantiated_claims_count,
    green_claims_score = EXCLUDED.green_claims_score,
    audit_verdict = EXCLUDED.audit_verdict,
    blocking_issues = EXCLUDED.blocking_issues,
    audit_summary = EXCLUDED.audit_summary,
    audited_at = EXCLUDED.audited_at
  RETURNING * INTO v_audit;

  -- 5. Injection dans dpp_records
  UPDATE dpp_records
  SET public_projection = jsonb_set(
    COALESCE(public_projection, '{}'::jsonb),
    '{green_claims_compliance}',
    jsonb_build_object(
      'score', v_audit.green_claims_score,
      'verdict', v_audit.audit_verdict,
      'verified_claims_count', v_audit.verified_claims_count,
      'is_greenwashing_risk', (v_audit.audit_verdict = 'non_compliant_greenwashing_risk'),
      'audited_at', v_audit.audited_at
    ),
    true
  )
  WHERE product_id = p_product_id;

  RETURN v_audit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tracefab_create_dpp_identity(p_product_id uuid, p_public_id text, p_granularity text, p_qualifier text DEFAULT NULL::text)
 RETURNS dpp_resolvable_identifiers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE p tracefab_products;r dpp_resolvable_identifiers;BEGIN SELECT * INTO p FROM tracefab_products WHERE id=p_product_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found';END IF;
 IF NOT tracefab_in_active_tenant(p.brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;
 IF NOT tracefab_has_org_role(p.brand_organization_id,ARRAY['owner','admin','manager']::membership_role[]) THEN RAISE EXCEPTION 'dpp_identity_role_required';END IF;
 INSERT INTO dpp_resolvable_identifiers(product_id,owner_organization_id,public_id,granularity,qualifier,created_by)
 VALUES(p_product_id,p.brand_organization_id,lower(trim(p_public_id)),p_granularity,NULLIF(trim(p_qualifier),''),tracefab_current_user_id()) RETURNING * INTO r;RETURN r;END $function$;

CREATE OR REPLACE FUNCTION public.tracefab_link_dpp_claim_evidence(p_claim_id uuid, p_document_id uuid, p_relationship text DEFAULT 'supports'::text, p_coverage_note text DEFAULT NULL::text, p_verification_result text DEFAULT 'pending'::text, p_verification_reason text DEFAULT NULL::text, p_public_label text DEFAULT NULL::text)
 RETURNS dpp_claim_evidence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_claim dpp_claims; v_link dpp_claim_evidence;
BEGIN
  SELECT * INTO v_claim FROM dpp_claims WHERE id=p_claim_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dpp_claim_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id=v_claim.product_id AND tracefab_in_active_tenant(p.brand_organization_id)) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;
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
END $function$;

CREATE OR REPLACE FUNCTION public.tracefab_replace_dpp_identity(p_identity_id uuid, p_replacement_public_id text, p_reason text)
 RETURNS dpp_resolvable_identifiers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE old dpp_resolvable_identifiers;replacement dpp_resolvable_identifiers;BEGIN SELECT * INTO old FROM dpp_resolvable_identifiers WHERE id=p_identity_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'dpp_identity_not_found';END IF;
 IF NOT EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id=old.product_id AND tracefab_in_active_tenant(p.brand_organization_id)) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;
 IF NOT tracefab_has_org_role(old.owner_organization_id,ARRAY['owner','admin','manager']::membership_role[]) THEN RAISE EXCEPTION 'dpp_identity_role_required';END IF;
 IF lower(trim(p_replacement_public_id)) !~ '^[a-z0-9][a-z0-9-]{7,79}$' OR length(trim(COALESCE(p_reason,'')))=0 THEN RAISE EXCEPTION 'invalid_replacement_identity';END IF;
 -- Libère d'abord l'unicité de portée, puis crée le remplaçant dans la même transaction.
 UPDATE dpp_resolvable_identifiers SET status='retired',retired_at=now(),reason=trim(p_reason) WHERE id=old.id;
 INSERT INTO dpp_resolvable_identifiers(product_id,owner_organization_id,public_id,granularity,qualifier,created_by)
 VALUES(old.product_id,old.owner_organization_id,lower(trim(p_replacement_public_id)),old.granularity,old.qualifier,tracefab_current_user_id()) RETURNING * INTO replacement;
 UPDATE dpp_resolvable_identifiers SET status='replaced',replaced_by_id=replacement.id WHERE id=old.id RETURNING * INTO old;RETURN old;END $function$;

CREATE OR REPLACE FUNCTION public.tracefab_update_product_identifier(p_product_id uuid, p_identifier_id uuid, p_identifier_value text, p_is_primary boolean)
 RETURNS product_identifiers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_identifier product_identifiers;
  v_brand_organization_id UUID;
  v_value TEXT;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  IF NOT tracefab_in_active_tenant(v_brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  v_value := trim(COALESCE(p_identifier_value, ''));
  IF v_value = '' THEN
    RAISE EXCEPTION 'invalid_product_identifier';
  END IF;

  UPDATE product_identifiers
  SET identifier_value = v_value,
      is_primary = COALESCE(p_is_primary, false)
  WHERE id = p_identifier_id
    AND product_id = p_product_id
  RETURNING * INTO v_identifier;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_identifier_not_found';
  END IF;

  RETURN v_identifier;
END;
$function$;

COMMIT;
