-- ============================================================================
-- 20261108120400 — `tracefab_add_supply_chain_link` : statut ENUM typé
--
-- MIGRATION ADDITIVE. Aucune migration appliquée n'est réécrite : la fonction
-- est REDÉFINIE (CREATE OR REPLACE), comme une correction « forward » doit le
-- faire. `20260923130000_tracefab_neon_initial`, qui la crée, garde son
-- empreinte — elle est appliquée en Production et en Préproduction.
--
-- LE DÉFAUT, MESURÉ PAR APPEL RÉEL (PostgreSQL 17.11, replay Prisma complet)
--
--   La fonction insère un `CASE` de littéraux dans une colonne de type ENUM :
--
--       status,
--       ...
--       CASE WHEN p_evidence_document_id IS NULL THEN 'declared'
--            ELSE 'documented' END,
--
--   PostgreSQL résout un `CASE` de littéraux en `text` et refuse l'affectation
--   à une colonne `data_value_status` :
--
--       ERROR 42804: column "status" is of type data_value_status
--                    but expression is of type text
--                    @ PL/pgSQL function tracefab_add_supply_chain_link(...)
--                      line 21 at SQL statement
--
--   Conséquence : tout appel de la fonction échoue, quel que soit le jeu
--   d'arguments valide. Les refus d'autorisation, eux, se produisent APRÈS les
--   contrôles de rôle et fonctionnent : c'est pourquoi le défaut est resté
--   invisible — les tests négatifs passaient, le chemin nominal jamais.
--
--   Le défaut est INDÉPENDANT des PR #110/#112/#113/#114 : il est dans la
--   chaîne actuelle de `origin/main`, et aucun replay ne peut le voir (le corps
--   d'une fonction n'est pas exécuté par une migration).
--
-- CE QUE CETTE MIGRATION FAIT
--
--   Elle redéfinit la fonction à l'identique, à une seule différence : les deux
--   littéraux du `CASE` sont explicitement typés `data_value_status`.
--   Rien d'autre n'est modifié — ni la signature, ni le corps, ni les contrôles.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
--   — aucun GRANT ni REVOKE : les privilèges existants sont conservés tels
--     quels (`EXECUTE` à `tracefab_app` par le registre runtime, rien à PUBLIC) ;
--   — aucun changement de propriétaire : `CREATE OR REPLACE` conserve le
--     propriétaire de la fonction ;
--   — aucun changement de politique RLS ni de déclencheur ;
--   — aucune écriture dans `_prisma_migrations` ; aucune donnée métier.
--
-- REJOUABLE : `CREATE OR REPLACE` sur une définition identique est sans effet.
-- ============================================================================

CREATE OR REPLACE FUNCTION tracefab_add_supply_chain_link(
  p_product_id UUID,
  p_source_node_id UUID,
  p_target_node_id UUID,
  p_link_type supply_chain_link_type,
  p_sequence_number INTEGER DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,
  p_valid_until DATE DEFAULT NULL,
  p_evidence_document_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS supply_chain_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_link supply_chain_links;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND OR NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF p_sequence_number IS NOT NULL AND p_sequence_number < 0 THEN
    RAISE EXCEPTION 'traceability_sequence_must_be_positive';
  END IF;

  INSERT INTO supply_chain_links (
    product_id,
    source_node_id,
    target_node_id,
    link_type,
    sequence_number,
    valid_from,
    valid_until,
    evidence_document_id,
    metadata,
    status,
    declared_by
  )
  VALUES (
    p_product_id,
    p_source_node_id,
    p_target_node_id,
    p_link_type,
    p_sequence_number,
    p_valid_from,
    p_valid_until,
    p_evidence_document_id,
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_evidence_document_id IS NULL THEN 'declared'::data_value_status
         ELSE 'documented'::data_value_status END,
    tracefab_current_user_id()
  )
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$$;
