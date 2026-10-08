-- Chantier 03 — Website & Trust Center.
-- Leads pre-tenant (demande de demo, contact, pilote) captures par le site
-- public. Table write-only depuis l'API : aucune politique de lecture n'est
-- ouverte hors contexte worker interne, les donnees restent donc
-- inaccessibles depuis n'importe quel jeton utilisateur.

CREATE TABLE IF NOT EXISTS tracefab_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'demo' CHECK (kind IN ('demo', 'contact', 'pilot')),
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  company TEXT CHECK (company IS NULL OR length(trim(company)) BETWEEN 1 AND 160),
  role TEXT CHECK (role IS NULL OR length(trim(role)) <= 80),
  message TEXT CHECK (message IS NULL OR length(message) <= 2000),
  source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 500),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled', 'discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tracefab_leads_created
  ON tracefab_leads(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracefab_leads_status
  ON tracefab_leads(status) WHERE status = 'new';

ALTER TABLE tracefab_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracefab_leads FORCE ROW LEVEL SECURITY;

-- Insertion uniquement via le contexte d'ingestion publique pose par l'API
-- de confiance dans sa transaction (voir api/_routes/leads.ts).
CREATE POLICY tracefab_leads_insert_public ON tracefab_leads
  FOR INSERT TO PUBLIC WITH CHECK (
    current_setting('tracefab.public_ingest', true) = 'true'
  );

-- Lecture et mise a jour reservees au contexte worker interne (operations),
-- jamais a une session utilisateur.
CREATE POLICY tracefab_leads_select_worker ON tracefab_leads
  FOR SELECT TO PUBLIC USING (
    current_setting('tracefab.worker_context', true) = 'true'
  );

CREATE POLICY tracefab_leads_update_worker ON tracefab_leads
  FOR UPDATE TO PUBLIC USING (
    current_setting('tracefab.worker_context', true) = 'true'
  ) WITH CHECK (
    current_setting('tracefab.worker_context', true) = 'true'
  );

GRANT SELECT, INSERT, UPDATE ON tracefab_leads TO PUBLIC;

COMMENT ON TABLE tracefab_leads IS 'Pre-tenant website leads (demo, contact, pilot). Write-only through the trusted API; readable only in internal worker context.';
COMMENT ON COLUMN tracefab_leads.kind IS 'demo = landing demo modal, contact = contact page, pilot = pilot program request.';
COMMENT ON COLUMN tracefab_leads.source_url IS 'Page the lead was submitted from; never includes request headers or IP.';
