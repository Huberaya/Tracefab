-- Chantier Admin 07 — Campagnes et Leads (§1)
--
-- Les deux dernières entrées de la navigation §1. Elles sont indissociables :
-- un lead sans campagne n'a pas de provenance, et une campagne sans lead n'a
-- rien à mesurer.
--
-- POURQUOI DEUX TABLES ET PAS UNE ÉTENDUE DE crm_companies
--   Un lead n'est pas une entreprise. C'est une acquisition brute : non
--   qualifiée, souvent incomplète, potentiellement en double. Lui imposer les
--   19 colonnes de crm_companies (taille, chiffre d'affaires, maturité,
--   priorité, valeur estimée) produirait des lignes vides qu'un lecteur
--   prendrait pour des faits. Le lead est PROMU en entreprise, et la promotion
--   conserve la provenance (§9).
--
-- CLÉS ÉTRANGÈRES
--   Corrigé au chantier 07 : l'affirmation précédente (« le bloc CRM n'a aucune
--   clé étrangère ») était FAUSSE. Elle venait d'une lecture de schema.prisma,
--   où aucune colonne CRM ne porte de @relation, alors que les migrations A01 et
--   A02 créent bien 15 contraintes — crm_tasks.company_id,
--   crm_contacts.company_id, crm_pilots.organization_id, etc. Vérifié en
--   exécutant la chaîne complète sur PostgreSQL : pg_constraint les liste.
--
--   Ces deux colonnes portent donc une FK, comme le reste du bloc, avec
--   ON DELETE SET NULL : supprimer une campagne ou une entreprise détache le
--   lead au lieu de le supprimer — sa provenance doit survivre (§9).
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   Elle ne crée aucune donnée. Aucun lead ni aucune campagne n'est inventé :
--   les lignes viendront d'un opérateur ou d'un import, avec leur source et
--   leur date de collecte (§9).
--   Elle ne modifie aucune politique RLS existante.

-- Types -----------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE crm_campaign_channel AS ENUM (
    'email', 'linkedin', 'phone', 'event', 'webinar',
    'referral', 'partner', 'content', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_campaign_status AS ENUM (
    'draft', 'planned', 'running', 'paused', 'completed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_lead_status AS ENUM (
    'new', 'contacted', 'qualified', 'converted', 'discarded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Campagnes -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crm_campaigns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL,
  name                     TEXT NOT NULL,
  channel                  crm_campaign_channel NOT NULL DEFAULT 'email',
  status                   crm_campaign_status  NOT NULL DEFAULT 'draft',
  objective                TEXT,
  target_audience          TEXT,
  starts_at                TIMESTAMPTZ,
  ends_at                  TIMESTAMPTZ,
  budget_eur               NUMERIC(12,2),
  owner_name               TEXT,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_crm_campaigns_org_name UNIQUE (platform_organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_crm_campaigns_org_status
  ON crm_campaigns (platform_organization_id, status);

/*
 * Aucun compteur n'est stocké ici, volontairement. Un `leads_count` enregistré
 * divergerait du nombre réel dès le premier lead supprimé, et personne ne
 * saurait lequel croire. Les chiffres d'une campagne sont calculés à la lecture.
 */
COMMENT ON COLUMN crm_campaigns.name IS
  'Nom unique par organisation plateforme, comme crm_saved_views.name.';
COMMENT ON COLUMN crm_campaigns.budget_eur IS
  'Budget DÉCLARÉ par l''équipe. Ce n''est pas une dépense constatée.';

-- Leads -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crm_leads (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_organization_id UUID NOT NULL,
  campaign_id              UUID REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  company_name             TEXT NOT NULL,
  contact_name             TEXT,
  contact_job_title        TEXT,
  email                    TEXT,
  phone                    TEXT,
  linkedin_url             TEXT,
  website                  TEXT,
  country_code             TEXT,
  city                     TEXT,
  sector                   TEXT,
  status                   crm_lead_status NOT NULL DEFAULT 'new',
  discard_reason           TEXT,
  converted_company_id     UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  converted_at             TIMESTAMPTZ,
  duplicate_key            TEXT NOT NULL,
  source                   TEXT,
  source_detail            TEXT,
  collected_at             TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_crm_leads_org_duplicate UNIQUE (platform_organization_id, duplicate_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_leads_org_status
  ON crm_leads (platform_organization_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_leads_org_campaign
  ON crm_leads (platform_organization_id, campaign_id);

/*
 * Aucun index partiel : Prisma ne sait pas les exprimer, et un index présent
 * dans une migration mais absent du schéma est une dérive que plus personne ne
 * détecte. Les index sont donc simples ET déclarés dans schema.prisma.
 */
CREATE INDEX IF NOT EXISTS idx_crm_leads_converted
  ON crm_leads (converted_company_id);

COMMENT ON COLUMN crm_leads.duplicate_key IS
  'Empreinte calculée pour éviter les doublons à l''import (§8). Unicité par organisation.';
COMMENT ON COLUMN crm_leads.source IS
  'Provenance (§9). Écrite par l''import ou l''opérateur, jamais déduite du fichier.';
COMMENT ON COLUMN crm_leads.collected_at IS
  'Date de collecte (§9). Une donnée sans date de collecte ne peut pas être évaluée.';
COMMENT ON COLUMN crm_leads.converted_company_id IS
  'Entreprise créée lors de la promotion. Sans clé étrangère, comme tout le bloc CRM.';

-- Attribution des entreprises aux campagnes -----------------------------------

/*
 * crm_companies.source est un texte libre. §15 « conversion par source » agrège
 * donc aujourd'hui des saisies hétérogènes. campaign_id donne une référence
 * stable SANS toucher à la colonne existante : les données déjà saisies restent
 * lisibles telles quelles, et la nouvelle attribution s'ajoute.
 */
ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS campaign_id UUID;

CREATE INDEX IF NOT EXISTS idx_crm_companies_campaign
  ON crm_companies (platform_organization_id, campaign_id);

COMMENT ON COLUMN crm_companies.campaign_id IS
  'Campagne à l''origine du prospect. Sans clé étrangère, comme tout le bloc CRM.';

-- Isolation -------------------------------------------------------------------

/*
 * ENABLE ET FORCE. Sans FORCE, le propriétaire de la table contourne ses
 * propres politiques — et les données de prospection sont précisément celles
 * qui ne doivent jamais être visibles par une marque ou un fournisseur (§16).
 */
ALTER TABLE crm_campaigns     ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_campaigns     FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_leads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_leads         FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_campaigns_select ON crm_campaigns;
CREATE POLICY crm_campaigns_select ON crm_campaigns
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_campaigns_modify ON crm_campaigns;
CREATE POLICY crm_campaigns_modify ON crm_campaigns
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );

DROP POLICY IF EXISTS crm_leads_select ON crm_leads;
CREATE POLICY crm_leads_select ON crm_leads
  FOR SELECT
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager', 'viewer', 'auditor']::membership_role[])
  );

DROP POLICY IF EXISTS crm_leads_modify ON crm_leads;
CREATE POLICY crm_leads_modify ON crm_leads
  FOR ALL
  USING (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  )
  WITH CHECK (
    tracefab_is_platform_org(platform_organization_id)
    AND tracefab_has_org_role(platform_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
  );
