-- -----------------------------------------------------------------------------
-- TRACEFAB COMMAND CENTER — Chantier Admin 02
-- Tâches commerciales, rendez-vous, pilotes, conversion prospect → client.
--
-- Même modèle d'isolation que le Chantier 01 : chaque ligne porte
-- platform_organization_id, et les politiques exigent tracefab_is_platform_org().
-- Une marque ou un fournisseur n'a de rôle dans aucune organisation `platform`.
-- -----------------------------------------------------------------------------

-- Types -----------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE crm_task_type AS ENUM (
    'call', 'email', 'follow_up', 'book_demo', 'prepare_demo',
    'send_proposal', 'follow_pilot', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_task_status AS ENUM ('open', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_meeting_mode AS ENUM ('onsite', 'video', 'call');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_pilot_status AS ENUM ('planned', 'active', 'completed', 'abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crm_tasks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id               UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  contact_id               UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  type                     crm_task_type NOT NULL DEFAULT 'follow_up',
  title                    TEXT NOT NULL,
  detail                   TEXT,
  due_at                   TIMESTAMPTZ,
  priority                 crm_priority NOT NULL DEFAULT 'medium',
  status                   crm_task_status NOT NULL DEFAULT 'open',
  assignee_user_id         UUID,
  assignee_name            TEXT,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Une tâche « faite » sans date de fin n'est pas auditable : on ne peut plus
  -- dire quand la journée commerciale s'est réellement déroulée.
  CONSTRAINT crm_tasks_done_requires_completed_at
    CHECK (status <> 'done' OR completed_at IS NOT NULL),
  CONSTRAINT crm_tasks_open_has_no_completed_at
    CHECK (status = 'done' OR completed_at IS NULL)
);

CREATE TABLE IF NOT EXISTS crm_meetings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id               UUID NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  contact_id               UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  subject                  TEXT NOT NULL,
  starts_at                TIMESTAMPTZ NOT NULL,
  ends_at                  TIMESTAMPTZ,
  mode                     crm_meeting_mode NOT NULL DEFAULT 'video',
  location                 TEXT,
  attendees                TEXT,
  outcome                  TEXT,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_meetings_ends_after_starts
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS crm_pilots (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id               UUID NOT NULL UNIQUE REFERENCES crm_companies(id) ON DELETE CASCADE,
  organization_id          UUID REFERENCES organizations(id) ON DELETE SET NULL,
  starts_at                TIMESTAMPTZ,
  ends_at                  TIMESTAMPTZ,
  status                   crm_pilot_status NOT NULL DEFAULT 'planned',
  supplier_count           INTEGER,
  product_count            INTEGER,
  objectives               TEXT,
  progress_pct             INTEGER,
  data_completeness_pct    INTEGER,
  evidence_coverage_pct    INTEGER,
  dpp_readiness_pct        INTEGER,
  issues                   TEXT,
  results                  TEXT,
  commercial_potential_eur INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Un pilote par entreprise : deux pilotes simultanés pour le même prospect
  -- rendraient toute mesure de résultat illisible.
  CONSTRAINT crm_pilots_percentages_in_range CHECK (
    (progress_pct          IS NULL OR progress_pct          BETWEEN 0 AND 100) AND
    (data_completeness_pct IS NULL OR data_completeness_pct BETWEEN 0 AND 100) AND
    (evidence_coverage_pct IS NULL OR evidence_coverage_pct BETWEEN 0 AND 100) AND
    (dpp_readiness_pct     IS NULL OR dpp_readiness_pct     BETWEEN 0 AND 100)
  ),
  CONSTRAINT crm_pilots_counts_positive CHECK (
    (supplier_count IS NULL OR supplier_count >= 0) AND
    (product_count  IS NULL OR product_count  >= 0)
  ),
  CONSTRAINT crm_pilots_potential_positive
    CHECK (commercial_potential_eur IS NULL OR commercial_potential_eur >= 0),
  CONSTRAINT crm_pilots_ends_after_starts
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

-- Conversion prospect → client -------------------------------------------------
--
-- Deux colonnes, pas une nouvelle table. La conversion ne déplace rien : la
-- ligne `crm_companies` reste, ses contacts, activités et rendez-vous restent
-- attachés par company_id. Rien n'est perdu parce que rien n'est déplacé.

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_value_eur INTEGER;

/*
 * linked_organization_id a été RETIRÉE (chantier 07).
 *
 * Elle faisait doublon avec crm_companies.organization_id, ajoutée par le
 * chantier 06 pour les vues Suppliers et Product Usage : deux colonnes pour un
 * même concept — « l'organisation TRACEFAB derrière cette entreprise » — qui
 * pouvaient diverger sans que rien ne les réconcilie.
 *
 * Celle du chantier 06 est conservée parce qu'elle est validée (UUID contrôlé,
 * existence de l'organisation vérifiée) alors que celle-ci recevait un
 * .trim().slice(0, 64) : une chaîne quelconque dans une colonne UUID sous clé
 * étrangère, ce qui échouait en base sur toute valeur non UUID.
 *
 * Le lien reste écrit à la conversion — voir companies/[companyId]/stage.ts.
 */

-- Une conversion sans date n'est pas une conversion mesurable, et un client sans
-- conversion datée fausse la durée moyenne avant conversion.
ALTER TABLE crm_companies
  DROP CONSTRAINT IF EXISTS crm_companies_customer_requires_converted_at;
ALTER TABLE crm_companies
  ADD CONSTRAINT crm_companies_customer_requires_converted_at
  CHECK (stage <> 'customer' OR converted_at IS NOT NULL);

ALTER TABLE crm_companies
  DROP CONSTRAINT IF EXISTS crm_companies_converted_value_positive;
ALTER TABLE crm_companies
  ADD CONSTRAINT crm_companies_converted_value_positive
  CHECK (converted_value_eur IS NULL OR converted_value_eur >= 0);

CREATE INDEX IF NOT EXISTS idx_crm_companies_org_converted ON crm_companies(platform_organization_id, converted_at);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_org_status_due  ON crm_tasks(platform_organization_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_company         ON crm_tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_contact         ON crm_tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_org_assignee    ON crm_tasks(platform_organization_id, assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_meetings_org_starts   ON crm_meetings(platform_organization_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_crm_meetings_company      ON crm_meetings(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_pilots_org_status     ON crm_pilots(platform_organization_id, status);

DROP TRIGGER IF EXISTS crm_tasks_set_updated_at ON crm_tasks;
CREATE TRIGGER crm_tasks_set_updated_at BEFORE UPDATE ON crm_tasks
  FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();

DROP TRIGGER IF EXISTS crm_meetings_set_updated_at ON crm_meetings;
CREATE TRIGGER crm_meetings_set_updated_at BEFORE UPDATE ON crm_meetings
  FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();

DROP TRIGGER IF EXISTS crm_pilots_set_updated_at ON crm_pilots;
CREATE TRIGGER crm_pilots_set_updated_at BEFORE UPDATE ON crm_pilots
  FOR EACH ROW EXECUTE FUNCTION tracefab_set_updated_at();

-- Row Level Security ----------------------------------------------------------

ALTER TABLE crm_tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_meetings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pilots    ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_tasks     FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_meetings  FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_pilots    FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_tasks    TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_meetings TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_pilots   TO PUBLIC;

DROP POLICY IF EXISTS crm_tasks_select ON crm_tasks;
CREATE POLICY crm_tasks_select ON crm_tasks
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_tasks_modify ON crm_tasks;
CREATE POLICY crm_tasks_modify ON crm_tasks
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

DROP POLICY IF EXISTS crm_meetings_select ON crm_meetings;
CREATE POLICY crm_meetings_select ON crm_meetings
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_meetings_modify ON crm_meetings;
CREATE POLICY crm_meetings_modify ON crm_meetings
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

DROP POLICY IF EXISTS crm_pilots_select ON crm_pilots;
CREATE POLICY crm_pilots_select ON crm_pilots
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_pilots_modify ON crm_pilots;
CREATE POLICY crm_pilots_modify ON crm_pilots
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

/*
 * Version tolérante au company_id NULL.
 *
 * `crm_tasks.company_id` est nullable : une tâche du jour peut ne concerner
 * aucune entreprise. La version du Chantier 01 levait « company does not exist »
 * sur un NULL. Pour crm_contacts et crm_activities, dont company_id est NOT NULL,
 * le comportement ne change pas — le garde-fou reste identique.
 */
CREATE OR REPLACE FUNCTION tracefab_crm_company_matches_platform()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_platform UUID;
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

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

-- Cohérence d'organisation : une tâche, un rendez-vous ou un pilote ne peut pas
-- être rattaché à une entreprise d'une autre organisation. Sans ce contrôle, une
-- politique correcte sur une table serait contournable depuis l'autre.
DROP TRIGGER IF EXISTS crm_tasks_company_match ON crm_tasks;
CREATE TRIGGER crm_tasks_company_match BEFORE INSERT OR UPDATE ON crm_tasks
  FOR EACH ROW EXECUTE FUNCTION tracefab_crm_company_matches_platform();

DROP TRIGGER IF EXISTS crm_meetings_company_match ON crm_meetings;
CREATE TRIGGER crm_meetings_company_match BEFORE INSERT OR UPDATE ON crm_meetings
  FOR EACH ROW EXECUTE FUNCTION tracefab_crm_company_matches_platform();

DROP TRIGGER IF EXISTS crm_pilots_company_match ON crm_pilots;
CREATE TRIGGER crm_pilots_company_match BEFORE INSERT OR UPDATE ON crm_pilots
  FOR EACH ROW EXECUTE FUNCTION tracefab_crm_company_matches_platform();
