-- État de publication explicite — la publication n'est plus un effet de bord du statut.
--
-- POURQUOI CETTE MIGRATION
--
-- Deux défauts mesurés, de même nature :
--
--   1. La publication dérivait du statut. La migration 20261009180000 posait
--      `public_slug = lower(reference)` sur tout produit `status = 'active'`.
--      Son propre commentaire annonçait « publier est un acte délibéré, pas un
--      effet de bord du statut » — puis faisait exactement l'inverse.
--
--   2. Rien n'empêchait un brouillon d'être public. `public_slug` et `status`
--      sont deux colonnes indépendantes, et les politiques publiques ne testaient
--      que `public_slug IS NOT NULL`. Mesuré : un produit `status = 'draft'`
--      porteur d'un slug EST résolu sur une route anonyme. Dormant tant que les
--      données restent cohérentes, mais c'est une coïncidence de données, pas une
--      garantie de schéma.
--
--   3. Aucun code de l'API n'écrit `public_slug` : il n'existe aucun acte de
--      publication dans le produit. La colonne n'était posée que par cette
--      migration et par du SQL direct. Sans trace de qui a publié ni quand, la
--      publication n'est pas démontrable.
--
-- CE QUE FAIT CETTE MIGRATION
--
--   - deux colonnes additives : `published_at` (quand) et `published_by` (qui) ;
--   - un garde qui rend impossible un slug sans date de publication ;
--   - les quatre fonctions publiques et la politique `products_select_public`
--     exigent désormais les deux conditions.
--
-- CE QU'ELLE NE FAIT PAS
--
--   Elle ne supprime aucun slug, ne dépublie rien, ne touche aucune autre
--   colonne. Les produits déjà publiés le restent.
--
-- PLAN DE RETOUR ARRIÈRE
--
--   DROP TRIGGER IF EXISTS tracefab_products_publication_explicite ON tracefab_products;
--   DROP FUNCTION IF EXISTS tracefab_products_publication_explicite();
--   -- puis restaurer les quatre fonctions et la politique telles que définies
--   -- dans 20261009180000_public_read_context (elles y sont en clair), et :
--   ALTER TABLE tracefab_products DROP COLUMN IF EXISTS published_by;
--   ALTER TABLE tracefab_products DROP COLUMN IF EXISTS published_at;
--
--   Aucune donnée autre que ces deux colonnes n'est affectée : le retour arrière
--   ne perd rien de ce qui existait avant.

-- ---------------------------------------------------------------------------
-- 1. Les deux colonnes
-- ---------------------------------------------------------------------------

ALTER TABLE tracefab_products
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid;

ALTER TABLE tracefab_products
  DROP CONSTRAINT IF EXISTS tracefab_products_published_by_fkey;
ALTER TABLE tracefab_products
  ADD CONSTRAINT tracefab_products_published_by_fkey
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN tracefab_products.published_at IS
  'Date de l acte de publication. NULL = jamais publié. Un public_slug sans '
  'cette date est refusé par tracefab_products_publication_explicite().';

COMMENT ON COLUMN tracefab_products.published_by IS
  'Utilisateur à l origine de la publication. NULL pour les produits publiés en '
  'masse par la migration 20261009180000 : aucun individu n a pris cette '
  'décision, et l écrire serait mentir sur la provenance.';

-- ---------------------------------------------------------------------------
-- 2. Rattrapage des produits déjà publiés
-- ---------------------------------------------------------------------------
--
-- Horodatage fixe, pas now() : une migration rejouée ne doit pas déplacer la
-- date de publication. `published_by` reste NULL, volontairement — voir le
-- commentaire de colonne.

UPDATE tracefab_products
   SET published_at = '2026-10-09T18:00:00Z'::timestamptz
 WHERE public_slug IS NOT NULL
   AND published_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Le garde : un slug sans publication explicite est impossible
-- ---------------------------------------------------------------------------
--
-- C'est lui qui ferme le défaut 2. Sans lui, la cohérence entre `public_slug`
-- et l'état de publication resterait une convention que rien ne vérifie.

CREATE OR REPLACE FUNCTION tracefab_products_publication_explicite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.public_slug IS NOT NULL AND NEW.published_at IS NULL THEN
    RAISE EXCEPTION
      'publication_explicite_requise: public_slug est posé sans published_at. '
      'Publier est un acte délibéré : poser la date (et l auteur) de publication.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tracefab_products_publication_explicite() IS
  'Refuse un public_slug non accompagné de published_at. Rend la publication '
  'explicite au niveau du schéma, et non par convention.';

DROP TRIGGER IF EXISTS tracefab_products_publication_explicite ON tracefab_products;
CREATE TRIGGER tracefab_products_publication_explicite
  BEFORE INSERT OR UPDATE OF public_slug, published_at ON tracefab_products
  FOR EACH ROW EXECUTE FUNCTION tracefab_products_publication_explicite();

-- ---------------------------------------------------------------------------
-- 4. Les prédicats publics exigent les deux conditions
-- ---------------------------------------------------------------------------
--
-- Les quatre fonctions sont réécrites ensemble : n'en corriger qu'une laisserait
-- passer les données des trois autres. `material_is_public` et
-- `supplier_site_is_public` joignent tracefab_products, donc un matériau rattaché
-- à un produit slugged-mais-non-publié resterait public sans ce rappel.
--
-- SECURITY DEFINER et search_path figé : inchangés, pour la même raison de
-- récursion qu'à la migration 34.

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
      AND p.published_at IS NOT NULL
  );
$$;

COMMENT ON FUNCTION tracefab_product_is_public(uuid) IS
  'Un produit est publiquement résolvable s''il porte un public_slug ET une '
  'date de publication. Un brouillon ne l''est jamais, même slugged.';

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
    JOIN tracefab_products p ON p.id = pm.product_id
    WHERE pm.material_id = p_material_id
      AND p.public_slug IS NOT NULL
      AND p.published_at IS NOT NULL
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
    JOIN tracefab_products p ON p.id = n.product_id
    WHERE n.supplier_site_id = p_site_id
      AND p.public_slug IS NOT NULL
      AND p.published_at IS NOT NULL
  );
$$;

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
        AND p.public_slug IS NOT NULL
        AND p.published_at IS NOT NULL
    );
$$;

DROP POLICY IF EXISTS products_select_public ON tracefab_products;
CREATE POLICY products_select_public ON tracefab_products
  FOR SELECT USING (
    tracefab_public_context()
    AND public_slug IS NOT NULL
    AND published_at IS NOT NULL
  );
