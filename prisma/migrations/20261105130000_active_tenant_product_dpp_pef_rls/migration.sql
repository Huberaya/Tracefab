-- TRACEFAB — bornage RLS des donnees produit / DPP / PEF au tenant actif.
--
-- Les politiques historiques verifiaient l'appartenance de l'utilisateur.
-- Pour un compte multi-organisations, cela autorisait la lecture des lignes
-- d'une autre marque alors que l'interface affichait un tenant different.
--
-- Les politiques publiques restent separees et inchangees : elles exigent
-- toujours le contexte public explicite ET la publication DPP validee.

BEGIN;

DROP POLICY IF EXISTS products_select_brand ON public.tracefab_products;
CREATE POLICY products_select_brand ON public.tracefab_products
  FOR SELECT TO PUBLIC
  USING (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_is_org_member(brand_organization_id)
  );

DROP POLICY IF EXISTS products_insert_brand ON public.tracefab_products;
CREATE POLICY products_insert_brand ON public.tracefab_products
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    )
  );

DROP POLICY IF EXISTS products_update_brand ON public.tracefab_products;
CREATE POLICY products_update_brand ON public.tracefab_products
  FOR UPDATE TO PUBLIC
  USING (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    )
  )
  WITH CHECK (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    )
  );

DROP POLICY IF EXISTS dpp_select_brand ON public.dpp_records;
CREATE POLICY dpp_select_brand ON public.dpp_records
  FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1
      FROM public.tracefab_products p
      WHERE p.id = dpp_records.product_id
        AND tracefab_in_active_tenant(p.brand_organization_id)
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

DROP POLICY IF EXISTS product_pef_select_org ON public.product_pef_assessments;
CREATE POLICY product_pef_select_org ON public.product_pef_assessments
  FOR SELECT TO PUBLIC
  USING (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_is_org_member(brand_organization_id)
  );

DROP POLICY IF EXISTS product_pef_mutate_brand ON public.product_pef_assessments;
CREATE POLICY product_pef_mutate_brand ON public.product_pef_assessments
  FOR ALL TO PUBLIC
  USING (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    )
  )
  WITH CHECK (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
    )
  );

COMMIT;
