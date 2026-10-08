-- -----------------------------------------------------------------------------
-- TRACEFAB COMMAND CENTER — Chantier Admin 01
-- CRM de prospection : companies, contacts, activities.
--
-- ISOLATION. Ces tables appartiennent à TRACEFAB, jamais à un client. Chaque
-- ligne porte platform_organization_id, qui doit référencer une organisation de
-- type `platform`. Les politiques RLS exigent DEUX conditions :
--   1. l'appelant a un rôle dans cette organisation ;
--   2. cette organisation est bien de type `platform`.
-- Une marque ou un fournisseur n'a de rôle dans aucune organisation `platform`,
-- et même s'il en obtenait un dans une organisation ordinaire, la condition 2
-- échouerait. Aucune politique ne leur accorde quoi que ce soit ici.
-- -----------------------------------------------------------------------------

-- Types -----------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE crm_company_type AS ENUM (
    'fashion_brand', 'textile_brand', 'manufacturer', 'textile_supplier', 'mill',
    'dye_house', 'garment_factory', 'luxury_brand', 'sportswear', 'outdoor',
    'retailer', 'marketplace', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_pipeline_stage AS ENUM (
    'new', 'qualified', 'to_contact', 'contacted', 'replied',
    'meeting', 'demo', 'pilot', 'customer', 'lost'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_priority AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_maturity AS ENUM ('unknown', 'low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_contact_status AS ENUM (
    'to_contact', 'contacted', 'replied', 'meeting', 'unresponsive', 'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_activity_type AS ENUM (
    'created', 'status_change', 'note', 'email', 'call', 'meeting',
    'demo', 'proposal', 'pilot', 'conversion', 'lost'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crm_companies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  website                  TEXT,
  country_code             VARCHAR(2),
  city                     TEXT,
  industry                 TEXT,
  company_type             crm_company_type NOT NULL DEFAULT 'other',
  employee_band            TEXT,
  revenue_band             TEXT,
  product_count            INTEGER,
  supplier_count           INTEGER,
  maturity                 crm_maturity NOT NULL DEFAULT 'unknown',
  priority                 crm_priority NOT NULL DEFAULT 'medium',
  stage                    crm_pipeline_stage NOT NULL DEFAULT 'new',
  lost_reason              TEXT,
  source                   TEXT,
  source_detail            TEXT,
  collected_at             TIMESTAMPTZ,
  owner_user_id            UUID,
  owner_name               TEXT,
  notes                    TEXT,
  estimated_value_eur      INTEGER,
  last_contact_at          TIMESTAMPTZ,
  next_contact_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Un doublon de prospection est le défaut le plus coûteux d'un CRM : le même
  -- prospect contacté deux fois par deux commerciaux. Contrainte dure, pas un
  -- simple avertissement d'interface.
  CONSTRAINT crm_companies_org_name_key UNIQUE (platform_organization_id, name),
  -- Les compteurs sont des déclarations, pas des mesures : jamais de valeur
  -- négative qui laisserait croire à un calcul.
  CONSTRAINT crm_companies_product_count_positive CHECK (product_count IS NULL OR product_count >= 0),
  CONSTRAINT crm_companies_supplier_count_positive CHECK (supplier_count IS NULL OR supplier_count >= 0),
  CONSTRAINT crm_companies_value_positive CHECK (estimated_value_eur IS NULL OR estimated_value_eur >= 0),
  -- Une perte sans raison est une perte inexploitable.
  CONSTRAINT crm_companies_lost_requires_reason CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  platform_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name               TEXT,
  last_name                TEXT,
  job_title                TEXT,
  email                    TEXT,
  phone                    TEXT,
  linkedin_url             TEXT,
  country_code             VARCHAR(2),
  language                 VARCHAR(8),
  is_decision_maker        BOOLEAN NOT NULL DEFAULT false,
  influence_level          INTEGER NOT NULL DEFAULT 0,
  status                   crm_contact_status NOT NULL DEFAULT 'to_contact',
  notes                    TEXT,
  last_contact_at          TIMESTAMPTZ,
  next_action              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_contacts_influence_range CHECK (influence_level BETWEEN 0 AND 5)
);

CREATE TABLE IF NOT EXISTS crm_activities (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  platform_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type                     crm_activity_type NOT NULL DEFAULT 'note',
  summary                  TEXT NOT NULL,
  detail                   TEXT,
  from_stage               crm_pipeline_stage,
  to_stage                 crm_pipeline_stage,
  actor_user_id            UUID,
  actor_name               TEXT,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_companies_org_stage        ON crm_companies(platform_organization_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_companies_org_priority     ON crm_companies(platform_organization_id, priority);
CREATE INDEX IF NOT EXISTS idx_crm_companies_org_country      ON crm_companies(platform_organization_id, country_code);
CREATE INDEX IF NOT EXISTS idx_crm_companies_org_next_contact ON crm_companies(platform_organization_id, next_contact_at);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_company           ON crm_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_org_status        ON crm_contacts(platform_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_activities_company_time    ON crm_activities(company_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_org_time        ON crm_activities(platform_organization_id, occurred_at);

DROP TRIGGER IF EXISTS crm_companies_set_updated_at ON crm_companies;
CREATE TRIGGER crm_companies_set_updated_at BEFORE UPDATE ON crm_companies
  FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();

DROP TRIGGER IF EXISTS crm_contacts_set_updated_at ON crm_contacts;
CREATE TRIGGER crm_contacts_set_updated_at BEFORE UPDATE ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();

-- Row Level Security ----------------------------------------------------------

ALTER TABLE crm_companies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;

-- Même le propriétaire de la table est soumis aux politiques : sans cela, un
-- rôle applicatif disposant des droits table contournerait tout l'édifice.
ALTER TABLE crm_companies  FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts   FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_activities FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_companies  TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_contacts   TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_activities TO PUBLIC;

/*
 * Prédicat partagé : membre de l'organisation ET organisation de type platform.
 * La seconde condition est ce qui rend ces données invisibles aux marques et aux
 * fournisseurs, qui n'appartiennent qu'à des organisations `brand` / `supplier`.
 */
CREATE OR REPLACE FUNCTION tracefab_is_platform_org(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.id = p_organization_id
      AND o.type = 'platform'
      AND o.status = 'active'
  );
$$;

REVOKE EXECUTE ON FUNCTION tracefab_is_platform_org(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_is_platform_org(UUID) TO PUBLIC;

DROP POLICY IF EXISTS crm_companies_select ON crm_companies;
CREATE POLICY crm_companies_select ON crm_companies
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_companies_modify ON crm_companies;
CREATE POLICY crm_companies_modify ON crm_companies
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

DROP POLICY IF EXISTS crm_contacts_select ON crm_contacts;
CREATE POLICY crm_contacts_select ON crm_contacts
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_contacts_modify ON crm_contacts;
CREATE POLICY crm_contacts_modify ON crm_contacts
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

DROP POLICY IF EXISTS crm_activities_select ON crm_activities;
CREATE POLICY crm_activities_select ON crm_activities
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_activities_insert ON crm_activities;
CREATE POLICY crm_activities_insert ON crm_activities
  FOR INSERT
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

-- Une journalisation d'activité n'a de valeur que si elle ne peut pas être
-- réécrite après coup : l'historique commercial est une preuve.
REVOKE UPDATE, DELETE ON crm_activities FROM PUBLIC;

-- Cohérence : un contact et ses activités appartiennent à la même organisation
-- platform que l'entreprise. Sans cela, une politique correcte sur une table
-- pourrait être contournée en rattachant une ligne à une autre organisation.
CREATE OR REPLACE FUNCTION tracefab_crm_company_matches_platform()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_platform UUID;
BEGIN
  SELECT platform_organization_id INTO v_platform
  FROM crm_companies
  WHERE id = NEW.company_id;

  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'crm company % does not exist', NEW.company_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_platform <> NEW.platform_organization_id THEN
    RAISE EXCEPTION 'crm row organization does not match its company'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_crm_company_matches_platform() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_crm_company_matches_platform() TO PUBLIC;

DROP TRIGGER IF EXISTS crm_contacts_platform_match ON crm_contacts;
CREATE TRIGGER crm_contacts_platform_match BEFORE INSERT OR UPDATE ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION tracefab_crm_company_matches_platform();

DROP TRIGGER IF EXISTS crm_activities_platform_match ON crm_activities;
CREATE TRIGGER crm_activities_platform_match BEFORE INSERT OR UPDATE ON crm_activities
  FOR EACH ROW EXECUTE FUNCTION tracefab_crm_company_matches_platform();
