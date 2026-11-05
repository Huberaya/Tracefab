-- TRACEFAB — isolation des compositions produit et matières partagées.
-- Une matière partagée ne doit pas rendre visible la relation d'un produit
-- appartenant à un autre tenant. Le tenant actif borne d'abord le produit ;
-- le partage fournisseur reste autorisé pour les produits du tenant actif.

BEGIN;

DROP POLICY IF EXISTS product_materials_select_authorized ON public.product_materials;
CREATE POLICY product_materials_select_authorized ON public.product_materials
  FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1
      FROM public.tracefab_products p
      WHERE p.id = product_materials.product_id
        AND tracefab_in_active_tenant(p.brand_organization_id)
        AND (
          tracefab_is_org_member(p.brand_organization_id)
          OR EXISTS (
            SELECT 1
            FROM public.materials m
            WHERE m.id = product_materials.material_id
              AND (
                tracefab_can_access_org(m.owner_organization_id)
                OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material'::text, m.id)
              )
          )
        )
    )
  );

CREATE OR REPLACE FUNCTION public.tracefab_add_product_material(p_product_id uuid, p_material_id uuid, p_material_role text, p_percentage numeric, p_unit text DEFAULT '%'::text)
 RETURNS product_materials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product tracefab_products;
  v_material_exists BOOLEAN;
  v_material product_materials;
  v_role TEXT;
  v_unit TEXT;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  IF NOT tracefab_in_active_tenant(v_product.brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  SELECT EXISTS (SELECT 1 FROM materials WHERE id = p_material_id)
  INTO v_material_exists;
  IF NOT v_material_exists THEN
    RAISE EXCEPTION 'material_not_found';
  END IF;

  IF p_percentage IS NOT NULL AND (p_percentage < 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'invalid_material_percentage';
  END IF;

  v_role := NULLIF(trim(COALESCE(p_material_role, '')), '');
  v_unit := NULLIF(trim(COALESCE(p_unit, '%')), '');
  IF v_role IS NULL OR v_unit IS NULL THEN
    RAISE EXCEPTION 'invalid_product_material';
  END IF;

  INSERT INTO product_materials (
    product_id,
    material_id,
    material_role,
    percentage,
    unit,
    product_version
  )
  VALUES (
    p_product_id,
    p_material_id,
    v_role,
    p_percentage,
    v_unit,
    v_product.version
  )
  RETURNING * INTO v_material;

  RETURN v_material;
END;
$function$


CREATE OR REPLACE FUNCTION public.tracefab_material_visible_via_product(p_material_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM product_materials pm
    JOIN tracefab_products p ON p.id = pm.product_id
    WHERE pm.material_id = p_material_id
      AND tracefab_in_active_tenant(p.brand_organization_id)
      AND tracefab_can_access_org(p.brand_organization_id)
  );
$function$


CREATE OR REPLACE FUNCTION public.tracefab_update_product_material(p_product_id uuid, p_material_id uuid, p_material_role text, p_product_version integer, p_percentage numeric, p_unit text)
 RETURNS product_materials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product tracefab_products;
  v_material product_materials;
  v_unit TEXT;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;
  IF NOT tracefab_in_active_tenant(v_product.brand_organization_id) THEN RAISE EXCEPTION 'active_tenant_mismatch'; END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  IF p_product_version <> v_product.version THEN
    RAISE EXCEPTION 'product_material_version_must_match_current_product_version';
  END IF;
  IF p_percentage IS NOT NULL AND (p_percentage < 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'invalid_material_percentage';
  END IF;

  v_unit := NULLIF(trim(COALESCE(p_unit, '%')), '');
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'invalid_product_material';
  END IF;

  UPDATE product_materials
  SET percentage = p_percentage,
      unit = v_unit
  WHERE product_id = p_product_id
    AND material_id = p_material_id
    AND material_role = p_material_role
    AND product_version = p_product_version
  RETURNING * INTO v_material;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_material_not_found';
  END IF;

  RETURN v_material;
END;
$function$


COMMIT;
