-- Contexte de lecture publique — la condition qui rend la bascule RLS possible.
--
-- POURQUOI CETTE MIGRATION
--
-- Le role de connexion de production, `neondb_owner`, porte BYPASSRLS. Aucune
-- des 107 politiques n'a donc jamais ete evaluee : la couche RLS est inerte.
-- Basculer l'application sur `tracefab_app` (sans BYPASSRLS) armerait les
-- politiques, mais cassait six routes publiques : sans contexte, chacune des
-- dix tables lues par le DPP public renvoyait 0 ligne.
--
-- La cause n'est pas technique, elle est conceptuelle : l'application n'avait
-- jamais defini ce qui est PUBLIC. `/api/dpp/:id` resolvait n'importe quel
-- produit par reference, SKU ou GTIN, brouillons compris. Avec BYPASSRLS, rien
-- ne s'y opposait.
--
-- Cette migration repond a la question, puis l'outille :
--   1. un produit est public s'il porte un `public_slug` — publier est un acte
--      delibere, pas un effet de bord du statut ;
--   2. les lectures publiques exigent un drapeau de session explicite, pose par
--      les routes publiques et par elles seules ;
--   3. la marque n'est jamais exposee ligne entiere : `organizations` contient
--      `registration_number` et `clerk_organization_id`. RLS filtre des lignes,
--      pas des colonnes — une fonction dediee ne rend que le nom et le pays.

-- ---------------------------------------------------------------------------
-- 1. Le drapeau de contexte public
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_public_context()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(current_setting('tracefab.public_context', true), 'false') = 'true';
$$;

COMMENT ON FUNCTION tracefab_public_context() IS
  'Vrai lorsque la transaction courante sert une route publique anonyme. '
  'Pose par withTracefabPublicContext(), jamais par une route authentifiee.';

-- ---------------------------------------------------------------------------
-- 2. Ce qui est public, et rien d''autre
--
-- SECURITY DEFINER : ces predicats sont appeles DEPUIS les politiques des
-- tables qu'ils interrogent. Sans cela, evaluer la politique de
-- `product_materials` declencherait celle de `tracefab_products`, qui
-- declencherait a nouveau la premiere — la recursion infinie deja rencontree
-- entre `materials` et `product_materials` (migration 34).
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
  );
$$;

COMMENT ON FUNCTION tracefab_product_is_public(uuid) IS
  'Un produit est publiquement resolvable si et seulement s''il porte un '
  'public_slug. Un brouillon ne l''est jamais.';

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
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. La marque, deux colonnes seulement
--
-- Aucune politique publique sur `organizations` : la table porte
-- `legal_name`, `registration_number` et `clerk_organization_id`. Le DPP
-- public n'a besoin que du nom affiche et du pays.
-- ---------------------------------------------------------------------------

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
    );
$$;

COMMENT ON FUNCTION tracefab_public_brand(uuid) IS
  'Identite de marque exposable sur un DPP public : nom affiche et pays. '
  'Ni raison sociale, ni numero d''immatriculation, ni identifiant Clerk.';

-- ---------------------------------------------------------------------------
-- 4. Les politiques de lecture publique
--
-- Permissives : elles s'ajoutent aux politiques tenant existantes sans les
-- affaiblir. Une requete sans le drapeau de contexte public ne gagne rien.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS products_select_public ON tracefab_products;
CREATE POLICY products_select_public ON tracefab_products
  FOR SELECT USING (tracefab_public_context() AND public_slug IS NOT NULL);

DROP POLICY IF EXISTS product_identifiers_select_public ON product_identifiers;
CREATE POLICY product_identifiers_select_public ON product_identifiers
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS product_materials_select_public ON product_materials;
CREATE POLICY product_materials_select_public ON product_materials
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS materials_select_public ON materials;
CREATE POLICY materials_select_public ON materials
  FOR SELECT USING (tracefab_public_context() AND tracefab_material_is_public(id));

DROP POLICY IF EXISTS product_pef_select_public ON product_pef_assessments;
CREATE POLICY product_pef_select_public ON product_pef_assessments
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS dpp_select_public ON dpp_records;
CREATE POLICY dpp_select_public ON dpp_records
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS mb_reconciliations_select_public ON mass_balance_reconciliations;
CREATE POLICY mb_reconciliations_select_public ON mass_balance_reconciliations
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS nodes_select_public ON supply_chain_nodes;
CREATE POLICY nodes_select_public ON supply_chain_nodes
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS links_select_public ON supply_chain_links;
CREATE POLICY links_select_public ON supply_chain_links
  FOR SELECT USING (tracefab_public_context() AND tracefab_product_is_public(product_id));

DROP POLICY IF EXISTS supplier_sites_select_public ON supplier_sites;
CREATE POLICY supplier_sites_select_public ON supplier_sites
  FOR SELECT USING (tracefab_public_context() AND tracefab_supplier_site_is_public(id));

-- ---------------------------------------------------------------------------
-- 5. Le webhook Clerk
--
-- `users` ne portait AUCUNE politique INSERT, et son UPDATE etait limite a
-- soi-meme. Le webhook Clerk appelle `users.upsert` pour un utilisateur qui
-- n'existe pas encore et qui n'est, par definition, pas l'appelant. Sous
-- BYPASSRLS cela passait ; sous `tracefab_app` cela echouerait.
--
-- Les ecritures sur `organizations` et `organization_memberships` passent
-- deja par des fonctions SECURITY DEFINER (`tracefab_sync_clerk_*`) : elles
-- n'ont pas besoin de politique supplementaire.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS users_insert_worker ON users;
CREATE POLICY users_insert_worker ON users
  FOR INSERT WITH CHECK (current_setting('tracefab.worker_context', true) = 'true');

DROP POLICY IF EXISTS users_update_worker ON users;
CREATE POLICY users_update_worker ON users
  FOR UPDATE USING (current_setting('tracefab.worker_context', true) = 'true')
  WITH CHECK (current_setting('tracefab.worker_context', true) = 'true');

-- ---------------------------------------------------------------------------
-- 6. Droits du role applicatif
--
-- Les politiques ne servent a rien sans le GRANT correspondant : RLS filtre
-- des lignes a l'interieur d'un droit deja accorde.
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION tracefab_public_context() TO tracefab_app;
GRANT EXECUTE ON FUNCTION tracefab_product_is_public(uuid) TO tracefab_app;
GRANT EXECUTE ON FUNCTION tracefab_material_is_public(uuid) TO tracefab_app;
GRANT EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) TO tracefab_app;
GRANT EXECUTE ON FUNCTION tracefab_public_brand(uuid) TO tracefab_app;

-- ---------------------------------------------------------------------------
-- 7. Publication initiale
--
-- Sans cette etape, la barriere serait correcte et le DPP public vide :
-- aucun des 17 produits ne portait de public_slug. Les 8 produits ACTIFS
-- deviennent publiquement resolvables ; les 9 brouillons ne le deviennent
-- pas, et c'est le but.
--
-- Le slug derive de `reference`, deja unique par marque
-- (tracefab_products_brand_organization_id_reference_key) : la contrainte
-- (brand_organization_id, public_slug) ne peut donc pas etre violee.
-- ---------------------------------------------------------------------------

UPDATE tracefab_products
   SET public_slug = lower(reference)
 WHERE status = 'active'
   AND public_slug IS NULL;
