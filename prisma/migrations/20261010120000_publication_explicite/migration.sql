-- Publication explicite — la publication ne depend plus du seul statut actif.
--
-- POURQUOI CETTE MIGRATION
--
-- La migration 20261009180000_public_read_context (section 7) publiait tous
-- les produits ACTIFS : `SET public_slug = lower(reference) WHERE status =
-- 'active'`. Un audit technique a releve a raison qu'une publication publique
-- doit dependre d'un ETAT DE PUBLICATION EXPLICITE et d'une AUTORISATION
-- DEMONTRABLE — pas d'un effet de bord du statut editorial. Un produit « actif
-- dans le catalogue » n'est pas un produit « publie pour le consommateur ».
--
-- L'etat explicite est porte par dpp_records : readiness_status = 'published'
-- (decision de publier) et reviewed_at / reviewed_by (qui a autorise).
--
-- Cette migration fait deux choses :
--   1. elle RETIRE les public_slug poses par le backfill quand aucun dpp_record
--      publie et relu ne les autorise ;
--   2. elle DURCIT la barriere de lecture publique : tracefab_product_is_public
--      exige desormais le public_slug ET l'etat publie + relu. Les politiques
--      publiques qui en dependent (produits, identifiants, compositions,
--      matieres, PEF, DPP, masse bilancielle, graphe, sites) deviennent donc
--      toutes tributaires de l'etat explicite, sans les reecrire une par une.
--
-- PLAN DE RETOUR ARRIERE
--
-- La publication retiree est reproductible par :
--   UPDATE tracefab_products SET public_slug = lower(reference)
--    WHERE status = 'active' AND public_slug IS NULL;
-- (on revient alors exactement au comportement du backfill d'origine).
-- Pour un seul produit, sa marque re-publie explicitement en posant le
-- public_slug apres avoir cree (ou relu) son dpp_record publie.
--
-- COMPATIBILITE
--
-- `prisma migrate deploy` applique ceci sur les bases ayant deja la
-- migration 20261009180000. Sur base vierge, l'ordre naturel produit le meme
-- resultat : le backfill publie, puis ceci depublie ce qui n'a pas d'etat
-- explicite — il n'existe encore aucun dpp_record sur une base vierge.
-- Aucune donnee n'est supprimee : seule la visibilite publique change.

-- ---------------------------------------------------------------------------
-- 1. Retrait des publications sans etat explicite
-- ---------------------------------------------------------------------------

UPDATE tracefab_products p
   SET public_slug = NULL
 WHERE p.public_slug IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM dpp_records d
     WHERE d.product_id = p.id
       AND d.readiness_status = 'published'
       AND d.reviewed_at IS NOT NULL
   );

-- ---------------------------------------------------------------------------
-- 2. La barriere de lecture exige l'etat publie explicite
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_product_is_public(p_product_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM tracefab_products p
    WHERE p.id = p_product_id
      AND p.public_slug IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM dpp_records d
        WHERE d.product_id = p.id
          AND d.readiness_status = 'published'
          AND d.reviewed_at IS NOT NULL
      )
  );
$$;

COMMENT ON FUNCTION tracefab_product_is_public(uuid) IS
  'Un produit est publiquement resolvable si et seulement s''il porte un '
  'public_slug ET un dpp_records en readiness_status published, relu '
  '(reviewed_at). La publication est un acte explicite et autorise, jamais un '
  'effet de bord du statut actif.';

-- La politique sur la table produit elle-meme : meme condition, sans quoi la
-- politique resterait « public_slug IS NOT NULL » et servirait des produits
-- que la fonction refuse deja ailleurs.

DROP POLICY IF EXISTS products_select_public ON tracefab_products;
CREATE POLICY products_select_public ON tracefab_products
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(id));

-- Matieres et sites rattaches : la condition inlinait public_slug IS NOT NULL.
CREATE OR REPLACE FUNCTION tracefab_material_is_public(p_material_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM product_materials pm
    WHERE pm.material_id = p_material_id
      AND tracefab_product_is_public(pm.product_id)
  );
$$;

CREATE OR REPLACE FUNCTION tracefab_supplier_site_is_public(p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM supply_chain_nodes n
    WHERE n.supplier_site_id = p_site_id
      AND tracefab_product_is_public(n.product_id)
  );
$$;

-- L'identite de marque exposable : la condition EXISTS inlinait public_slug.
CREATE OR REPLACE FUNCTION tracefab_public_brand(p_organization_id uuid)
RETURNS TABLE (display_name text, country_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.display_name, o.country_code
  FROM organizations o
  WHERE o.id = p_organization_id
    AND EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.brand_organization_id = o.id
        AND tracefab_product_is_public(p.id)
    );
$$;
