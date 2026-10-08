-- -----------------------------------------------------------------------------
-- TRACEFAB COMMAND CENTER — Chantier Admin 03
-- Acquisition : listes de prospection (§7), import CSV (§8), recherche avancée (§9).
--
-- Même modèle d'isolation que les Chantiers 01 et 02 : chaque ligne porte
-- platform_organization_id, et les politiques exigent tracefab_is_platform_org().
-- Une marque ou un fournisseur n'a de rôle dans aucune organisation `platform`.
--
-- `collected_at` et `source_detail` existent depuis le Chantier 01. Cette
-- migration ne les recrée pas : l'import CSV les alimente, il ne les invente pas.
-- -----------------------------------------------------------------------------

-- Types -----------------------------------------------------------------------

/*
 * `unknown` est un état explicite, pas un vide. Il signifie « non qualifié ».
 * Le confondre avec `low` ferait trier l'équipe commerciale sur une absence de
 * donnée — exactement ce que la règle « ne jamais inventer de donnée » interdit.
 */
DO $$ BEGIN
  CREATE TYPE crm_interest_level AS ENUM ('unknown', 'low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Recherche avancée (§9) ------------------------------------------------------

/*
 * Deux colonnes NOT NULL DEFAULT : sur PostgreSQL 11+, ajouter une colonne avec
 * une constante par défaut ne réécrit pas la table. Les lignes existantes sont
 * donc `unknown` — « non qualifié » — et non `low`.
 */
ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS dpp_interest crm_interest_level NOT NULL DEFAULT 'unknown';

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS traceability_interest crm_interest_level NOT NULL DEFAULT 'unknown';

/*
 * Index sur les critères de §9 qui n'en avaient pas : taille, nombre de produits
 * et nombre de fournisseurs. Sans eux, un filtre `product_count >= 200` sur
 * l'ensemble du portefeuille est un scan séquentiel à chaque frappe.
 */
CREATE INDEX IF NOT EXISTS idx_crm_companies_org_dpp_interest
  ON crm_companies (platform_organization_id, dpp_interest);

CREATE INDEX IF NOT EXISTS idx_crm_companies_org_traceability_interest
  ON crm_companies (platform_organization_id, traceability_interest);

CREATE INDEX IF NOT EXISTS idx_crm_companies_org_product_count
  ON crm_companies (platform_organization_id, product_count);

CREATE INDEX IF NOT EXISTS idx_crm_companies_org_supplier_count
  ON crm_companies (platform_organization_id, supplier_count);

CREATE INDEX IF NOT EXISTS idx_crm_companies_org_employee_band
  ON crm_companies (platform_organization_id, employee_band);

-- Listes de prospection (§7) --------------------------------------------------

/*
 * Une liste n'est qu'un jeu de filtres nommé. Les filtres sont en `jsonb` : leur
 * forme évolue avec les critères de §9 sans nouvelle migration à chaque ajout.
 *
 * UNIQUE (organisation, nom) : deux listes homonymes dans la même équipe ne sont
 * pas deux listes, c'est une collision.
 */
CREATE TABLE IF NOT EXISTS crm_saved_views (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL,
  name                     TEXT NOT NULL,
  filters                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID,
  created_by_name          TEXT,
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT uq_crm_saved_views_org_name UNIQUE (platform_organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_crm_saved_views_org_created
  ON crm_saved_views (platform_organization_id, created_at);

CREATE TRIGGER crm_saved_views_updated_at
  BEFORE UPDATE ON crm_saved_views
  FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();

-- Isolation -------------------------------------------------------------------

/*
 * ENABLE ET FORCE. Sans FORCE, le propriétaire de la table contourne ses propres
 * politiques — et les données de prospection sont précisément celles qui ne
 * doivent jamais être visibles par une marque ou un fournisseur (§16).
 */
ALTER TABLE crm_saved_views   ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_saved_views   FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_saved_views_select ON crm_saved_views;
CREATE POLICY crm_saved_views_select ON crm_saved_views
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_saved_views_modify ON crm_saved_views;
CREATE POLICY crm_saved_views_modify ON crm_saved_views
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );
