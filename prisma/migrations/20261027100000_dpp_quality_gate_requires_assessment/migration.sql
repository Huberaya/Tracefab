-- Barriere `quality.no_open_issues` : exiger une evaluation, pas seulement
-- l'absence d'anomalie.
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- La version posee par 20261021170000_dpp_readiness_truthful_gates testait
-- uniquement `NOT EXISTS (SELECT 1 FROM data_quality_issues ...)`. Un produit
-- jamais evalue n'a aucune ligne d'anomalie : il satisfaisait donc la barriere
-- sans qu'aucun controle ait eu lieu. Une barriere DPP qui recompense l'absence
-- d'evaluation est pire qu'une barriere absente : elle produit un « vert » que
-- personne ne peut defendre devant un auditeur.
--
-- CE QUE LA MIGRATION CHANGE — une seule branche
--
-- `quality.no_open_issues` exige desormais :
--   1. qu'une evaluation qualite soit persistee pour ce produit
--      (au moins une ligne dans `data_quality_scores`) ;
--   2. et qu'aucune anomalie `open` / `acknowledged` ne subsiste.
--
-- Le reste de la fonction est reproduit a l'identique (13 exigences, meme
-- profil `textile_readiness_mvp` v1.0). Aucune table, aucune colonne, aucune
-- policy n'est modifiee : seuls le corps de `tracefab_dpp_requirement_met` et
-- ses privileges sont reposes.
--
-- PORTEE OPERATIONNELLE — ce fichier n'est PAS applique par cette branche.
-- Tant qu'il n'est pas joue sur une base, le comportement observe reste celui
-- de 20261021170000. Voir docs/experience/mission-dpp-2026-10-27/ pour l'etat
-- exact des migrations et la procedure de verification.

CREATE OR REPLACE FUNCTION tracefab_dpp_requirement_met(
  p_requirement_key TEXT,
  p_product_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_count INTEGER;
  v_material_percentage_count INTEGER;
  v_percentage_total NUMERIC;
  v_met BOOLEAN := false;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_product_id;
  IF NOT FOUND THEN RETURN false; END IF;

  CASE p_requirement_key
    WHEN 'product.reference' THEN v_met := length(trim(COALESCE(v_product.reference, ''))) > 0;
    WHEN 'product.name' THEN v_met := length(trim(COALESCE(v_product.name, ''))) > 0;
    WHEN 'product.description' THEN v_met := length(trim(COALESCE(v_product.description, ''))) >= 30;
    WHEN 'product.category' THEN v_met := length(trim(COALESCE(v_product.category, ''))) > 0;
    WHEN 'product.country_of_manufacture' THEN v_met := v_product.country_of_manufacture IS NOT NULL AND length(trim(v_product.country_of_manufacture)) = 2;
    WHEN 'product.required_attributes' THEN
      v_met := length(trim(COALESCE(v_product.color_name, ''))) > 0
        AND COALESCE(array_length(v_product.size_range, 1), 0) > 0
        AND v_product.weight_grams IS NOT NULL AND v_product.weight_grams > 0;
    WHEN 'product.data_ready' THEN v_met := v_product.data_readiness = 'data_ready';
    WHEN 'product.not_draft' THEN v_met := v_product.status::text <> 'draft';
    WHEN 'composition.complete' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE percentage IS NOT NULL), COALESCE(SUM(percentage), 0)
      INTO v_material_count, v_material_percentage_count, v_percentage_total
      FROM product_materials WHERE product_id = p_product_id AND product_version = v_product.version;
      v_met := v_material_count > 0 AND v_material_percentage_count = v_material_count AND abs(v_percentage_total - 100) < 0.01;
    WHEN 'materials.origin_documented' THEN
      v_met := EXISTS (SELECT 1 FROM product_materials pm WHERE pm.product_id=p_product_id AND pm.product_version=v_product.version)
        AND NOT EXISTS (
          SELECT 1 FROM product_materials pm JOIN materials m ON m.id=pm.material_id
          WHERE pm.product_id=p_product_id AND pm.product_version=v_product.version
            AND (m.origin_country_code IS NULL OR length(trim(m.origin_country_code)) <> 2)
        );
    WHEN 'traceability.graph' THEN
      v_met := EXISTS (SELECT 1 FROM supply_chain_links WHERE product_id = p_product_id);
    WHEN 'traceability.documented' THEN
      v_met := EXISTS (SELECT 1 FROM supply_chain_nodes WHERE graph_product_id=p_product_id)
        AND NOT EXISTS (
          SELECT 1 FROM supply_chain_nodes
          WHERE graph_product_id=p_product_id
            AND (source_document_id IS NULL OR status::text NOT IN ('documented','checked_for_consistency','verified_by_reviewer','certified_by_third_party'))
        );
    WHEN 'quality.no_blocking_issues' THEN
      SELECT s.blocking_issues = '[]'::jsonb INTO v_met FROM data_quality_scores s
      WHERE s.product_id=p_product_id ORDER BY s.computed_at DESC LIMIT 1;
      v_met := COALESCE(v_met, false);
    WHEN 'quality.no_open_issues' THEN
      -- « Aucune anomalie ouverte » n'a de sens que si la qualite a ete
      -- REELLEMENT evaluee. La version precedente ne testait que l'absence
      -- d'anomalie : un produit jamais passe par le moteur qualite n'avait
      -- aucune ligne dans `data_quality_issues` et franchissait donc la
      -- barriere sans le moindre controle. C'est un faux vert, pas une
      -- exigence satisfaite. On exige desormais une evaluation persistee
      -- (`data_quality_scores`) en plus de l'absence d'anomalie ouverte.
      v_met := EXISTS (
          SELECT 1 FROM data_quality_scores s WHERE s.product_id = p_product_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM data_quality_issues q
          WHERE q.product_id=p_product_id AND q.status::text IN ('open','acknowledged')
        );
    WHEN 'evidence.product_data' THEN
      v_met := EXISTS (
        SELECT 1 FROM data_points dp JOIN documents d ON d.id=dp.source_document_id
        WHERE dp.product_id=p_product_id AND d.status='available'
      );
    ELSE v_met := false;
  END CASE;
  RETURN COALESCE(v_met, false);
END;
$$;

-- Les privileges ne sont pas herites d'une redefinition : on les repose.
REVOKE EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) FROM tracefab_app;

COMMENT ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) IS
  'Profil interne de preparation technique (13 exigences). Depuis 20261027100000, quality.no_open_issues exige une evaluation qualite persistee : l''absence d''evaluation n''est pas une absence d''anomalie. Ce profil n''est ni une certification, ni une conformite reglementaire, ni une autorisation de publication.';
