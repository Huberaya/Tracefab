-- =============================================================================
-- Recalcul DPP : preserver la revue humaine, et garder la publication coherente
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- `tracefab_compute_dpp_readiness` est appelee par la console a chaque
-- « Recalculer ». Sa clause `ON CONFLICT ... DO UPDATE` remettait
-- inconditionnellement `reviewed_at` et `reviewed_by` a NULL, et ecrasait
-- `readiness_status` par le statut calcule. Deux consequences, toutes deux
-- mesurees sur PostgreSQL 18.4 avant d'ecrire ce fichier :
--
--   1. RECALCULER UN DOSSIER REVU LE FAISAIT PERDRE SA REVUE. Une revue
--      humaine (qui, quand) disparaissait sans trace, sur une simple pression
--      de bouton. Rien dans l'interface ne l'annoncait.
--
--   2. RECALCULER UN DOSSIER PUBLIE LE FAISAIT PASSER DE `published` A
--      `data_ready` ALORS QUE `tracefab_products.public_slug` restait en
--      place — donc le passeport restait publiquement accessible. L'etat
--      interne disait « non publie », la realite publique disait « publie ».
--
-- CE QUE LA MIGRATION INSTALLE
--
-- A. La revue est conservee si, et seulement si, les donnees qui l'ont motivee
--    n'ont pas change. La comparaison porte sur `input_fingerprint`, l'empreinte
--    du `source_snapshot` (produit, profil, composition, tracabilite, dernier
--    score qualite, resultats par exigence). Trois cas :
--
--      - empreinte identique            -> la revue est conservee ;
--      - empreinte differente           -> la revue est INVALIDEE, avec date et
--                                          motif dans deux colonnes dediees :
--                                          une revue ne survit pas a un
--                                          changement des donnees examinees ;
--      - aucune revue                   -> rien a conserver.
--
--    La comparaison se fait avec `reviewed_basis_fingerprint`, figee au moment
--    de la revue. Les lignes anterieures a cette migration n'en ont pas : on
--    leur applique l'ANCIENNE regle (egalite de `input_fingerprint`, qui inclut
--    les horodatages techniques et est donc plus stricte), puis on les met a
--    niveau en y ecrivant l'empreinte de contenu. Comparer directement
--    l'ancienne empreinte a la nouvelle serait une faute : les deux
--    algorithmes different, et toutes les revues existantes tomberaient au
--    premier recalcul, y compris celles dont le contenu n'a pas bouge.
--
-- B. La visibilite publique exige DEJA, dans le modele existant
--    (`tracefab_product_is_public`), trois conditions simultanees : un
--    `public_slug`, un `readiness_status = published`, et un `reviewed_at` non
--    NULL. Autrement dit : *public = revu*. Le recalcul violait cette
--    invariant en effacant la revue d'un dossier publie — le passeport restait
--    avec son slug et son statut, mais devenait invisible sans que rien ne le
--    dise. La migration rend cet invariant vrai par construction : elle ne
--    laisse jamais un dossier publie sans revue valide.
--
-- C. Un passeport publie qui ne satisfait plus les exigences, OU dont les
--    donnees examinees ont change, est SUSPENDU,
--    atomiquement et avec trace. POLITIQUE RETENUE, explicitement : un
--    passeport public affirme un etat ; s'il ne le satisfait plus, il est
--    retire de la circulation publique (le slug est efface, donc la route
--    publique ne le resout plus) plutot que de continuer a l'affirmer. Le
--    retrait est reversible : apres correction, recalcul, nouvelle revue et
--    nouvelle publication. Chaque transition laisse un evenement de cycle de
--    vie et une ligne d'audit.
--
--    Un passeport publie qui satisfait toujours les exigences ET dont les
--    donnees examinees n'ont pas change le reste : le recalcul ne le retrograde
--    plus.
--
-- D. Ce qu'est un « changement significatif » — la definition est explicite,
--    parce que c'est elle qui decide si une revue survit :
--
--      entre dans l'empreinte de revue : la fiche produit (reference, nom,
--      description, categorie, pays, readiness, completion), le profil
--      d'exigences, la composition, les liens de tracabilite, le contenu du
--      dernier score qualite, et le verdict de chacune des exigences ;
--
--      en est EXCLU : les horodatages et identifiants volatils —
--      `captured_at`, `product.updated_at`, `latest_quality_score.computed_at`
--      et `.score_id`. Motif mesure : publier ecrit `public_slug` et
--      `updated_at` sur le produit, ce qui changeait l'empreinte et invalidait
--      la revue d'un dossier pourtant inchange sur le fond. Une revue qui tombe
--      parce qu'un slug a ete ecrit n'est pas une revue qui a perdu sa base.
--
--    Cette empreinte de revue est une colonne NOUVELLE
--    (`review_basis_fingerprint`). `input_fingerprint`, deja exposee par l'API,
--    n'est pas modifiee : changer le sens d'une valeur publiee serait pire que
--    le defaut corrige.
--
-- CE QUE LA MIGRATION NE FAIT PAS
--
-- - Elle ne supprime aucun passeport publie sans trace : la suspension ecrit
--   un evenement `publication_suspended` et une entree `audit_logs`.
-- - Elle ne modifie ni le profil d'exigences, ni les autres fonctions DPP.
-- - Elle n'est appliquee a aucune base distante par cette branche.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Traces de revue
-- -----------------------------------------------------------------------------
ALTER TABLE dpp_records
  ADD COLUMN IF NOT EXISTS review_basis_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_basis_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS review_invalidated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_invalidation_reason TEXT;

COMMENT ON COLUMN dpp_records.review_basis_fingerprint IS
  'Empreinte du contenu examine, hors horodatages volatils. Recalculee a chaque recalcul.';
COMMENT ON COLUMN dpp_records.reviewed_basis_fingerprint IS
  'Valeur de review_basis_fingerprint figee au moment de la revue. Une revue ne survit que si elle est identique au recalcul.';
COMMENT ON COLUMN dpp_records.review_invalidated_at IS
  'Date a laquelle une revue existante a ete invalidée par un recalcul. NULL si aucune revue n''a ete invalidée.';
COMMENT ON COLUMN dpp_records.review_invalidation_reason IS
  'Motif traçable de l''invalidation : source_snapshot_changed, publication_suspended_nonconforming, publication_suspended_review_stale.';

-- -----------------------------------------------------------------------------
-- 2. Suspension atomique d'un passeport publie devenu non conforme
--
--    Ecrite comme fonction a part pour deux raisons : elle est appelee depuis le
--    recalcul (qui peut etre declenche par un `auditor`, role qui n'a pas le
--    droit de publier), et elle doit rester NON exposée au role runtime.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tracefab_suspend_nonconforming_publication(
  p_product_id UUID,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_record dpp_records;
  v_summary TEXT;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_record FROM dpp_records
   WHERE product_id = p_product_id
   ORDER BY computed_at DESC
   FOR UPDATE
   LIMIT 1;

  -- Rien a faire si le dossier n'est pas publie, ou si le slug est deja absent :
  -- la fonction doit pouvoir etre appelee sans effet de bord.
  IF NOT FOUND OR v_record.readiness_status <> 'published' THEN
    RETURN false;
  END IF;

  v_summary := 'Publication suspendue automatiquement : les exigences de '
            || 'preparation ne sont plus satisfaites (' || COALESCE(p_reason, 'non_precise') || ')';

  -- Le slug est la SEULE source de verite de la visibilite publique
  -- (tracefab_product_is_public ne lit que public_slug). L'effacer retire le
  -- passeport de la circulation ; le conserver alors que le dossier n'est plus
  -- conforme laisserait une affirmation publique que rien ne soutient.
  UPDATE tracefab_products
     SET public_slug = NULL, updated_at = now()
   WHERE id = p_product_id;

  UPDATE dpp_records
     SET readiness_status = 'review_required'::dpp_readiness_status
   WHERE id = v_record.id;

  PERFORM tracefab_add_dpp_event(
    p_product_id, 'publication_suspended', v_summary, now(),
    'system', 'controlled', v_summary, jsonb_build_object('reason', p_reason),
    '{}', NULL, NULL, 'model', NULL);

  INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (v_product.brand_organization_id, tracefab_current_user_id(),
          'dpp.publication_auto_suspended', 'dpp_record', v_record.id,
          jsonb_build_object('product_id', p_product_id, 'reason', p_reason,
                             'previous_slug', v_product.public_slug));

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION tracefab_suspend_nonconforming_publication(UUID, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION tracefab_suspend_nonconforming_publication(UUID, TEXT) FROM tracefab_app';
  END IF;
END $$;

COMMENT ON FUNCTION tracefab_suspend_nonconforming_publication(UUID, TEXT) IS
  'Suspension atomique et tracee d''un passeport publie devenu non conforme. Interne : jamais exposee au role runtime.';

-- -----------------------------------------------------------------------------
-- 3. Recalcul : conserver la revue justifiee, suspendre la publication rompue
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tracefab_compute_dpp_readiness(
  p_product_id UUID,
  p_profile_key TEXT DEFAULT 'textile_readiness_mvp',
  p_profile_version TEXT DEFAULT '1.0'
)
RETURNS dpp_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_profile dpp_requirement_profiles;
  v_requirement JSONB;
  v_requirement_key TEXT;
  v_met BOOLEAN;
  v_missing_fields JSONB := '[]'::jsonb;
  v_blocking_issues JSONB := '[]'::jsonb;
  v_readiness dpp_readiness_status;
  v_source_snapshot JSONB;
  v_fingerprint TEXT;
  v_record dpp_records;
  v_existing dpp_records;
  v_has_review_required BOOLEAN := false;
  v_requirement_results JSONB := '[]'::jsonb;
  v_composition_snapshot JSONB := '[]'::jsonb;
  v_traceability_snapshot JSONB := '[]'::jsonb;
  v_quality_snapshot JSONB := '{}'::jsonb;
  v_basis TEXT;
  v_review_kept BOOLEAN := false;
  v_invalidation_reason TEXT;
  v_was_published BOOLEAN := false;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'dpp_readiness_role_required';
  END IF;

  SELECT * INTO v_profile
  FROM dpp_requirement_profiles
  WHERE profile_key = p_profile_key
    AND profile_version = p_profile_version
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_dpp_requirement_profile_not_found';
  END IF;

  FOR v_requirement IN
    SELECT value FROM jsonb_array_elements(v_profile.definition -> 'requirements')
  LOOP
    v_requirement_key := v_requirement ->> 'key';
    v_met := tracefab_dpp_requirement_met(v_requirement_key, p_product_id);
    v_requirement_results := v_requirement_results || jsonb_build_array(
      jsonb_build_object(
        'key', v_requirement_key,
        'met', v_met
      )
    );

    IF NOT v_met THEN
      v_missing_fields := v_missing_fields || jsonb_build_array(
        jsonb_build_object(
          'key', v_requirement_key,
          'label', v_requirement ->> 'label',
          'blocking', COALESCE((v_requirement ->> 'blocking')::boolean, true)
        )
      );

      IF COALESCE((v_requirement ->> 'blocking')::boolean, true) THEN
        v_blocking_issues := v_blocking_issues || jsonb_build_array(
          jsonb_build_object(
            'key', v_requirement_key,
            'label', v_requirement ->> 'label',
            'reason', 'requirement_not_met'
          )
        );
      END IF;
    END IF;
  END LOOP;

  IF v_product.data_readiness = 'needs_review'
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT s.blocking_issues
         FROM data_quality_scores s
         WHERE s.product_id = p_product_id
         ORDER BY s.computed_at DESC
         LIMIT 1
       ) latest_score
       WHERE latest_score.blocking_issues <> '[]'::jsonb
     ) THEN
    v_has_review_required := true;
  END IF;

  v_readiness := CASE
    WHEN jsonb_array_length(v_blocking_issues) > 0 AND v_has_review_required
      THEN 'review_required'::dpp_readiness_status
    WHEN jsonb_array_length(v_blocking_issues) > 0
      THEN 'in_progress'::dpp_readiness_status
    WHEN v_has_review_required
      THEN 'review_required'::dpp_readiness_status
    ELSE 'data_ready'::dpp_readiness_status
  END;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'material_id', pm.material_id,
        'material_role', pm.material_role,
        'percentage', pm.percentage,
        'unit', pm.unit,
        'product_version', pm.product_version
      ) ORDER BY pm.material_id, pm.material_role, pm.product_version
    ),
    '[]'::jsonb
  )
  INTO v_composition_snapshot
  FROM product_materials pm
  WHERE pm.product_id = p_product_id
    AND pm.product_version = v_product.version;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'link_id', scl.id,
        'source_node_id', scl.source_node_id,
        'target_node_id', scl.target_node_id,
        'link_type', scl.link_type,
        'sequence_number', scl.sequence_number
      ) ORDER BY scl.sequence_number NULLS LAST, scl.id
    ),
    '[]'::jsonb
  )
  INTO v_traceability_snapshot
  FROM supply_chain_links scl
  WHERE scl.product_id = p_product_id;

  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'score_id', s.id,
        'computed_at', s.computed_at,
        'completeness', s.completeness,
        'freshness', s.freshness,
        'documentation_coverage', s.documentation_coverage,
        'consistency', s.consistency,
        'missing_fields', s.missing_fields,
        'blocking_issues', s.blocking_issues
      )
      FROM data_quality_scores s
      WHERE s.product_id = p_product_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ),
    '{}'::jsonb
  )
  INTO v_quality_snapshot;

  v_source_snapshot := jsonb_build_object(
    'product', jsonb_build_object(
      'id', v_product.id,
      'version', v_product.version,
      'reference', v_product.reference,
      'name', v_product.name,
      'description', v_product.description,
      'category', v_product.category,
      'country_of_manufacture', v_product.country_of_manufacture,
      'data_readiness', v_product.data_readiness,
      'data_completion', v_product.data_completion,
      'updated_at', v_product.updated_at
    ),
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'key', v_profile.profile_key,
      'version', v_profile.profile_version,
      'definition', v_profile.definition
    ),
    'composition', v_composition_snapshot,
    'traceability_links', v_traceability_snapshot,
    'latest_quality_score', v_quality_snapshot,
    'requirement_results', v_requirement_results,
    'captured_at', now()
  );
  -- Algorithme d'empreinte INCHANGE : `input_fingerprint` est expose par l'API,
  -- le modifier changerait le sens d'une valeur deja publiee. Les revues
  -- anterieures a cette migration (reviewed_basis_fingerprint NULL) restent
  -- donc comparables via l'empreinte du dossier.
  v_fingerprint := md5((v_source_snapshot - 'captured_at')::TEXT);

  -- Empreinte de REVUE : meme contenu, moins les horodatages et identifiants
  -- volatils. C'est elle qui decide si une revue survit (voir en-tete, §D).
  v_basis := md5((
    (v_source_snapshot - 'captured_at')
      || jsonb_build_object(
           'product', (v_source_snapshot -> 'product') - 'updated_at',
           'latest_quality_score',
             (v_source_snapshot -> 'latest_quality_score') - 'computed_at' - 'score_id'
         )
  )::TEXT);

  SELECT * INTO v_existing
  FROM dpp_records
  WHERE product_id = p_product_id
    AND product_version = v_product.version
    AND requirement_profile_key = v_profile.profile_key
    AND requirement_profile_version = v_profile.profile_version
  FOR UPDATE;

  IF FOUND THEN
    v_was_published := v_existing.readiness_status = 'published';

    -- A1 : la revue ne survit que si le CONTENU examine est identique.
    --
    -- Deux regimes, et il ne faut pas les confondre :
    --   * revue posterieure a cette migration : `reviewed_basis_fingerprint`
    --     existe, on la compare a l'empreinte de contenu recalculée ;
    --   * revue anterieure : aucune empreinte de revue n'a ete figee. On
    --     applique alors l'ANCIENNE regle (egalite de `input_fingerprint`),
    --     qui est plus stricte — elle inclut les horodatages techniques — donc
    --     jamais plus permissive. Comparer l'ancienne empreinte a la nouvelle
    --     (deux algorithmes differents) invaliderait TOUTES les revues
    --     existantes au premier recalcul, y compris celles dont le contenu n'a
    --     pas bouge : c'est le defaut qu'on vient corriger, pas le refaire.
    -- Une revue anterieure conservee est immediatement mise a niveau : la
    -- ligne recoit `reviewed_basis_fingerprint`, et les recalculs suivants
    -- utilisent le regime de contenu.
    IF v_existing.reviewed_at IS NOT NULL THEN
      IF v_existing.reviewed_basis_fingerprint IS NOT NULL THEN
        v_review_kept := v_existing.reviewed_basis_fingerprint = v_basis;
      ELSE
        v_review_kept := v_existing.input_fingerprint IS NOT NULL
                         AND v_existing.input_fingerprint = v_fingerprint;
      END IF;
      IF NOT v_review_kept THEN
        v_invalidation_reason := 'source_snapshot_changed';
      END IF;
    END IF;

    -- A2 : un dossier publie ne peut pas rester publie sans base valide.
    -- L'invariant du modele est « public = slug + published + revue ». Le
    -- recalcul doit donc suspendre des que l'une des trois branches casse,
    -- sinon le passeport devient invisible sans que rien ne le signale, ou
    -- reste visible alors qu'il n'est plus soutenu.
    IF v_was_published AND jsonb_array_length(v_blocking_issues) > 0 THEN
      PERFORM tracefab_suspend_nonconforming_publication(
        p_product_id, 'requirements_no_longer_met');
      v_invalidation_reason := 'publication_suspended_nonconforming';
    ELSIF v_was_published AND NOT v_review_kept THEN
      PERFORM tracefab_suspend_nonconforming_publication(
        p_product_id, 'reviewed_data_changed');
      v_invalidation_reason := 'publication_suspended_review_stale';
    END IF;

    -- Statut conserve : un dossier publie et toujours soutenu le reste ; un
    -- dossier revu et toujours soutenu reste revu. Sinon, statut recalcule.
    IF v_was_published AND jsonb_array_length(v_blocking_issues) = 0
       AND v_review_kept AND v_readiness = 'data_ready' THEN
      v_readiness := 'published'::dpp_readiness_status;
    ELSIF v_review_kept AND v_readiness = 'data_ready'
          AND v_existing.readiness_status IN ('ready_to_publish','published') THEN
      v_readiness := v_existing.readiness_status;
    END IF;

    UPDATE dpp_records SET
      requirement_profile_id = v_profile.id,
      readiness_status = v_readiness,
      missing_fields = v_missing_fields,
      blocking_issues = v_blocking_issues,
      computed_at = now(),
      computed_by = tracefab_current_user_id(),
      input_fingerprint = v_fingerprint,
      source_snapshot = v_source_snapshot,
      review_basis_fingerprint = v_basis,
      reviewed_at = CASE WHEN v_review_kept THEN v_existing.reviewed_at ELSE NULL END,
      reviewed_by = CASE WHEN v_review_kept THEN v_existing.reviewed_by ELSE NULL END,
      -- Mise a niveau : une revue anterieure conservee recoit ici l'empreinte
      -- de contenu, au lieu de rester indefiniment dans l'ancien regime.
      reviewed_basis_fingerprint = CASE WHEN v_review_kept THEN v_basis ELSE NULL END,
      review_invalidated_at = CASE
        WHEN v_review_kept THEN v_existing.review_invalidated_at
        WHEN v_invalidation_reason IS NOT NULL THEN now()
        ELSE v_existing.review_invalidated_at END,
      review_invalidation_reason = CASE
        WHEN v_review_kept THEN v_existing.review_invalidation_reason
        WHEN v_invalidation_reason IS NOT NULL THEN v_invalidation_reason
        ELSE v_existing.review_invalidation_reason END
    WHERE id = v_existing.id
    RETURNING * INTO v_record;

    RETURN v_record;
  END IF;

  INSERT INTO dpp_records (
    product_id,
    product_version,
    requirement_profile_key,
    requirement_profile_version,
    requirement_profile_id,
    readiness_status,
    missing_fields,
    blocking_issues,
    public_projection,
    computed_at,
    computed_by,
    input_fingerprint,
    source_snapshot,
    review_basis_fingerprint,
    reviewed_at,
    reviewed_by
  )
  VALUES (
    p_product_id,
    v_product.version,
    v_profile.profile_key,
    v_profile.profile_version,
    v_profile.id,
    v_readiness,
    v_missing_fields,
    v_blocking_issues,
    '{}'::jsonb,
    now(),
    tracefab_current_user_id(),
    v_fingerprint,
    v_source_snapshot,
    v_basis,
    NULL,
    NULL
  )
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

COMMENT ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) IS
  'Recalcul technique des exigences de preparation. Depuis 20261027130000 : conserve la revue si l''empreinte des donnees est identique, l''invalide sinon (motif trace), preserve le statut published d''un dossier toujours conforme, et suspend atomiquement un passeport publie devenu non conforme.';

-- -----------------------------------------------------------------------------
-- 4. La revue fige l'empreinte examinee
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tracefab_mark_dpp_ready_to_publish(p_dpp_record_id UUID)
RETURNS dpp_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_record dpp_records;
  v_brand_organization_id UUID;
  v_all_met BOOLEAN;
BEGIN
  SELECT r.* INTO v_record FROM dpp_records r
  WHERE r.id = p_dpp_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dpp_record_not_found'; END IF;

  SELECT p.brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products p WHERE p.id = v_record.product_id;
  IF NOT tracefab_has_org_role(v_brand_organization_id, ARRAY['owner','admin','manager']::membership_role[]) THEN
    RAISE EXCEPTION 'dpp_publish_review_role_required';
  END IF;
  IF v_record.readiness_status <> 'data_ready' THEN
    RAISE EXCEPTION 'dpp_record_not_data_ready';
  END IF;

  SELECT bool_and(tracefab_dpp_requirement_met(requirement_key, v_record.product_id))
  INTO v_all_met
  FROM unnest(ARRAY[
    'product.reference','product.name','product.description','product.category',
    'product.country_of_manufacture','product.required_attributes',
    'composition.complete','materials.origin_documented','traceability.graph',
    'traceability.documented','quality.no_open_issues','evidence.product_data',
    'product.not_draft'
  ]::text[]) AS requirement_key;
  IF v_all_met IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'dpp_publication_requirements_not_met';
  END IF;

  UPDATE dpp_records SET
    readiness_status = 'ready_to_publish',
    reviewed_at = now(),
    reviewed_by = tracefab_current_user_id(),
    -- L'empreinte du CONTENU examine est figee ici : c'est elle qui permettra
    -- de dire, plus tard, si un recalcul a change les donnees de la revue.
    reviewed_basis_fingerprint = v_record.review_basis_fingerprint,
    review_invalidated_at = NULL,
    review_invalidation_reason = NULL
  WHERE id = p_dpp_record_id
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

COMMENT ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) IS
  'Revue humaine. Depuis 20261027130000, fige reviewed_basis_fingerprint afin qu''un recalcul puisse prouver si le contenu examine a change.';

-- -----------------------------------------------------------------------------
-- 5. Privilages : la fonction de suspension reste interne
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) TO tracefab_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) TO tracefab_app';
  END IF;
END $$;
