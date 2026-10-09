-- Migration: 20261009120000_fix_materials_policy_recursion
--
-- CE QUE CORRIGE CETTE MIGRATION
--
-- `SELECT ... FROM materials` echoue avec « infinite recursion detected in
-- policy for relation "materials" » des que la requete est evaluee par un
-- role soumis a la RLS.
--
-- Le cycle :
--   materials_select_authorized        interroge product_materials
--   product_materials_select_authorized interroge materials
--
-- Chaque sous-requete declenche la politique de l'autre table, sans fin.
--
-- POURQUOI PERSONNE NE L'AVAIT VU
--
-- L'application se connecte sous `neondb_owner`, qui porte BYPASSRLS. Avec
-- cet attribut, aucune politique n'est jamais evaluee : le cycle existait
-- mais n'etait jamais parcouru. Le defaut est apparu a la premiere requete
-- executee sous un role reellement soumis a la RLS.
--
-- Autrement dit : la politique de `materials` n'a jamais fonctionne. Elle
-- n'etait pas permissive a tort — elle etait inexecutable.
--
-- LE CORRECTIF
--
-- On casse une des deux aretes du cycle. Le detour par les produits devient
-- une fonction SECURITY DEFINER, comme tous les autres predicats du schema
-- (`tracefab_can_access_org`, `tracefab_is_org_member`, …). Executee sous le
-- proprietaire, sa sous-requete ne redeclenche pas les politiques, donc la
-- recursion disparait.
--
-- La logique d'autorisation est conservee a l'identique : une matiere reste
-- visible si l'organisation la possede, si elle est partagee, si elle entre
-- dans un produit de la marque, ou si elle appartient a un fournisseur lie
-- par une relation active. Seule la mecanique d'evaluation change.

CREATE OR REPLACE FUNCTION tracefab_material_visible_via_product(p_material_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM product_materials pm
    JOIN tracefab_products p ON p.id = pm.product_id
    WHERE pm.material_id = p_material_id
      AND tracefab_can_access_org(p.brand_organization_id)
  );
$$;

COMMENT ON FUNCTION tracefab_material_visible_via_product(uuid) IS
  'Detour produit de materials_select_authorized. SECURITY DEFINER pour casser le cycle materials <-> product_materials.';

DROP POLICY IF EXISTS materials_select_authorized ON materials;

CREATE POLICY materials_select_authorized ON materials
  FOR SELECT TO PUBLIC
  USING (
    tracefab_can_access_org(owner_organization_id)
    OR tracefab_can_access_shared_subject(owner_organization_id, 'material'::text, id)
    OR tracefab_material_visible_via_product(id)
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships rel
      WHERE rel.supplier_organization_id = materials.owner_organization_id
        AND tracefab_is_org_member(rel.brand_organization_id)
        AND rel.status = 'active'::relationship_status
    )
  );

-- Le role applicatif doit pouvoir appeler la fonction.
GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO PUBLIC;
