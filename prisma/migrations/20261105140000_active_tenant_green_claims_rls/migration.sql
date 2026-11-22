-- TRACEFAB — bornage RLS des allégations vertes de marque au tenant actif.
--
-- product_green_claims porte brand_organization_id directement : sa politique
-- historique d'appartenance permettait à un utilisateur membre de A et B de
-- lire les allégations de B depuis le contexte actif A, sans passer par RLS
-- de tracefab_products. Le test Neon direct sous tracefab_app reproduit cette
-- fuite. Les allégations restent privées ; aucune politique publique n'existe.

BEGIN;

DROP POLICY IF EXISTS product_claims_select_org ON public.product_green_claims;
CREATE POLICY product_claims_select_org ON public.product_green_claims
  FOR SELECT TO PUBLIC
  USING (
    tracefab_in_active_tenant(brand_organization_id)
    AND tracefab_is_org_member(brand_organization_id)
  );

DROP POLICY IF EXISTS product_claims_mutate_brand ON public.product_green_claims;
CREATE POLICY product_claims_mutate_brand ON public.product_green_claims
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
