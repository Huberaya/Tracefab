-- Chantier 15 — durable notification outbox for data-collection events.
-- The outbox contains notification metadata only. It never stores invitation
-- tokens, provider secrets or raw response values.

DO $$ BEGIN
  CREATE TYPE tracefab_notification_event AS ENUM (
    'request_sent',
    'request_submitted',
    'response_verified',
    'changes_requested'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tracefab_notification_status AS ENUM ('pending', 'processing', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tracefab_notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE CHECK (length(trim(event_key)) > 0),
  event_type tracefab_notification_event NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  request_id UUID NOT NULL REFERENCES data_requests(id) ON DELETE CASCADE,
  response_id UUID REFERENCES data_responses(id) ON DELETE CASCADE,
  recipient_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_emails TEXT[] NOT NULL DEFAULT '{}',
  recipient_name TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  request_title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status tracefab_notification_status NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracefab_notification_outbox_claim
  ON tracefab_notification_outbox(status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tracefab_notification_outbox_request
  ON tracefab_notification_outbox(request_id, created_at);

ALTER TABLE tracefab_notification_outbox ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION tracefab_enqueue_data_request_notification(
  p_event_key TEXT,
  p_event_type tracefab_notification_event,
  p_data_request_id UUID,
  p_data_response_id UUID DEFAULT NULL,
  p_recipient_organization_id UUID DEFAULT NULL
)
RETURNS tracefab_notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_response data_responses;
  v_recipient_organization_id UUID;
  v_outbox tracefab_notification_outbox;
BEGIN
  IF p_event_key IS NULL OR length(trim(p_event_key)) = 0 THEN
    RAISE EXCEPTION 'notification_event_key_required';
  END IF;

  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF p_event_type = 'request_sent' THEN
    IF v_request.status <> 'sent' THEN
      RAISE EXCEPTION 'notification_request_status_mismatch';
    END IF;
    v_recipient_organization_id := v_request.supplier_organization_id;
  ELSIF p_event_type = 'request_submitted' THEN
    IF v_request.status <> 'submitted' THEN
      RAISE EXCEPTION 'notification_request_status_mismatch';
    END IF;
    v_recipient_organization_id := v_request.brand_organization_id;
  ELSE
    IF p_data_response_id IS NULL THEN
      RAISE EXCEPTION 'notification_response_required';
    END IF;

    SELECT * INTO v_response
    FROM data_responses
    WHERE id = p_data_response_id;

    IF NOT FOUND OR v_response.data_request_item_id NOT IN (
      SELECT id FROM data_request_items WHERE data_request_id = p_data_request_id
    ) THEN
      RAISE EXCEPTION 'data_response_not_found';
    END IF;

    IF (p_event_type = 'response_verified' AND v_response.status <> 'verified_by_reviewer')
       OR (p_event_type = 'changes_requested' AND v_response.status <> 'needs_review') THEN
      RAISE EXCEPTION 'notification_response_status_mismatch';
    END IF;
    v_recipient_organization_id := v_request.supplier_organization_id;
  END IF;

  IF p_recipient_organization_id IS NOT NULL
     AND p_recipient_organization_id <> v_recipient_organization_id THEN
    RAISE EXCEPTION 'notification_recipient_mismatch';
  END IF;

  WITH organization_context AS (
    SELECT
      v_request.id AS request_id,
      v_request.title AS request_title,
      v_request.due_at,
      brand.display_name AS brand_display_name,
      brand.legal_name AS brand_legal_name,
      supplier.display_name AS supplier_display_name,
      supplier.legal_name AS supplier_legal_name
    FROM organizations brand
    JOIN organizations supplier ON supplier.id = v_request.supplier_organization_id
    WHERE brand.id = v_request.brand_organization_id
  ), recipients AS (
    SELECT
      array_remove(array_agg(DISTINCT lower(u.email)), NULL)::TEXT[] AS emails,
      COALESCE((array_agg(u.full_name ORDER BY u.created_at))[1], 'Tracefab team') AS recipient_name
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = v_recipient_organization_id
      AND m.status = 'active'
  )
  INSERT INTO tracefab_notification_outbox (
    event_key,
    event_type,
    request_id,
    response_id,
    recipient_organization_id,
    recipient_emails,
    recipient_name,
    brand_name,
    supplier_name,
    request_title,
    due_at
  )
  SELECT
    trim(p_event_key),
    p_event_type,
    context.request_id,
    p_data_response_id,
    v_recipient_organization_id,
    COALESCE(recipients.emails, '{}'::TEXT[]),
    recipients.recipient_name,
    COALESCE(context.brand_display_name, context.brand_legal_name),
    COALESCE(context.supplier_display_name, context.supplier_legal_name),
    context.request_title,
    context.due_at
  FROM organization_context context
  CROSS JOIN recipients
  ON CONFLICT (event_key) DO NOTHING
  RETURNING * INTO v_outbox;

  IF v_outbox.id IS NULL THEN
    SELECT * INTO v_outbox
    FROM tracefab_notification_outbox
    WHERE event_key = trim(p_event_key);
  END IF;

  RETURN v_outbox;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_enqueue_data_request_transition_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM tracefab_enqueue_data_request_notification(
      'data-request:' || NEW.id::TEXT || ':sent',
      'request_sent',
      NEW.id,
      NULL,
      NEW.supplier_organization_id
    );
  ELSIF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM tracefab_enqueue_data_request_notification(
      'data-request:' || NEW.id::TEXT || ':submitted:' || COALESCE(to_char(NEW.submitted_at, 'YYYYMMDDHH24MISSUSOF'), NEW.id::TEXT),
      'request_submitted',
      NEW.id,
      NULL,
      NEW.brand_organization_id
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_enqueue_data_response_review_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id UUID;
  v_supplier_organization_id UUID;
  v_event_type tracefab_notification_event;
BEGIN
  IF NEW.status NOT IN ('verified_by_reviewer', 'needs_review')
     OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT r.id, r.supplier_organization_id
  INTO v_request_id, v_supplier_organization_id
  FROM data_request_items i
  JOIN data_requests r ON r.id = i.data_request_id
  WHERE i.id = NEW.data_request_item_id;

  IF v_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE
    WHEN NEW.status = 'verified_by_reviewer' THEN 'response_verified'::tracefab_notification_event
    ELSE 'changes_requested'::tracefab_notification_event
  END;

  PERFORM tracefab_enqueue_data_request_notification(
    'data-response:' || NEW.id::TEXT || ':' || NEW.status::TEXT || ':' || COALESCE(to_char(NEW.reviewed_at, 'YYYYMMDDHH24MISSUSOF'), NEW.id::TEXT),
    v_event_type,
    v_request_id,
    NEW.id,
    v_supplier_organization_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_requests_enqueue_notification ON data_requests;
CREATE TRIGGER data_requests_enqueue_notification
  AFTER UPDATE ON data_requests
  FOR EACH ROW EXECUTE FUNCTION tracefab_enqueue_data_request_transition_notification();

DROP TRIGGER IF EXISTS data_responses_enqueue_notification ON data_responses;
CREATE TRIGGER data_responses_enqueue_notification
  AFTER UPDATE ON data_responses
  FOR EACH ROW EXECUTE FUNCTION tracefab_enqueue_data_response_review_notification();

CREATE OR REPLACE FUNCTION tracefab_claim_notification_outbox(p_limit INTEGER DEFAULT 10)
RETURNS SETOF tracefab_notification_outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT id
    FROM tracefab_notification_outbox
    WHERE (
      status IN ('pending', 'failed')
      OR (status = 'processing' AND locked_at < now() - interval '15 minutes')
    )
      AND available_at <= now()
      AND attempts < 5
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
  )
  UPDATE tracefab_notification_outbox o
  SET status = 'processing',
      attempts = o.attempts + 1,
      locked_at = now(),
      updated_at = now()
  FROM candidates
  WHERE o.id = candidates.id
  RETURNING o.*;
$$;

CREATE OR REPLACE FUNCTION tracefab_complete_notification_outbox(
  p_id UUID,
  p_status tracefab_notification_status,
  p_provider_id TEXT DEFAULT NULL,
  p_last_error TEXT DEFAULT NULL,
  p_next_attempt_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS tracefab_notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_outbox tracefab_notification_outbox;
BEGIN
  IF p_status NOT IN ('pending', 'sent', 'failed') THEN
    RAISE EXCEPTION 'notification_completion_status_invalid';
  END IF;

  UPDATE tracefab_notification_outbox
  SET status = p_status,
      provider_id = COALESCE(p_provider_id, provider_id),
      last_error = NULLIF(left(p_last_error, 1000), ''),
      available_at = COALESCE(p_next_attempt_at, available_at),
      locked_at = NULL,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      updated_at = now()
  WHERE id = p_id
    AND status = 'processing'
  RETURNING * INTO v_outbox;

  IF v_outbox.id IS NULL THEN
    RAISE EXCEPTION 'notification_outbox_item_not_processing';
  END IF;

  RETURN v_outbox;
END;
$$;

REVOKE ALL ON tracefab_notification_outbox FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_enqueue_data_request_notification(TEXT, tracefab_notification_event, UUID, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_enqueue_data_request_transition_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_enqueue_data_response_review_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_claim_notification_outbox(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_complete_notification_outbox(UUID, tracefab_notification_status, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

COMMENT ON TABLE tracefab_notification_outbox IS 'Durable email notifications without invitation tokens or raw response values.';
COMMENT ON COLUMN tracefab_notification_outbox.event_key IS 'Idempotency key for a business transition notification.';
COMMENT ON FUNCTION tracefab_claim_notification_outbox(INTEGER) IS 'Claims pending notification jobs with SKIP LOCKED for a trusted worker.';
