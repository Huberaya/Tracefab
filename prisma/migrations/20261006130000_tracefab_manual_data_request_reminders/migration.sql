-- Chantier Brand Console — manual, authenticated supplier reminder.

ALTER TYPE tracefab_notification_event ADD VALUE IF NOT EXISTS 'request_manual_reminder';

CREATE OR REPLACE FUNCTION tracefab_enqueue_manual_data_request_reminder(p_request_id UUID)
RETURNS tracefab_notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request RECORD;
  v_event_key TEXT;
  v_outbox tracefab_notification_outbox;
BEGIN
  SELECT
    r.id,
    r.title,
    r.due_at,
    r.brand_organization_id,
    r.supplier_organization_id,
    brand.display_name AS brand_display_name,
    brand.legal_name AS brand_legal_name,
    supplier.display_name AS supplier_display_name,
    supplier.legal_name AS supplier_legal_name
  INTO v_request
  FROM data_requests r
  JOIN organizations brand ON brand.id = r.brand_organization_id
  JOIN organizations supplier ON supplier.id = r.supplier_organization_id
  WHERE r.id = p_request_id
    AND r.status IN ('sent', 'in_progress', 'changes_requested');

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'data_request_not_remindable';
  END IF;

  -- One click can be retried safely, but a brand can remind again after ten minutes.
  v_event_key := 'data-request:' || v_request.id::TEXT || ':manual:'
    || floor(extract(epoch FROM clock_timestamp()) / 600)::BIGINT::TEXT;

  WITH recipients AS (
    SELECT
      array_remove(array_agg(DISTINCT lower(u.email)), NULL)::TEXT[] AS emails,
      COALESCE((array_agg(u.full_name ORDER BY u.created_at))[1], 'Supplier team') AS recipient_name
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = v_request.supplier_organization_id
      AND m.status = 'active'
  )
  INSERT INTO tracefab_notification_outbox (
    event_key,
    event_type,
    request_id,
    recipient_organization_id,
    recipient_emails,
    recipient_name,
    brand_name,
    supplier_name,
    request_title,
    due_at
  )
  SELECT
    v_event_key,
    'request_manual_reminder'::tracefab_notification_event,
    v_request.id,
    v_request.supplier_organization_id,
    COALESCE(recipients.emails, '{}'::TEXT[]),
    recipients.recipient_name,
    COALESCE(v_request.brand_display_name, v_request.brand_legal_name),
    COALESCE(v_request.supplier_display_name, v_request.supplier_legal_name),
    v_request.title,
    v_request.due_at
  FROM recipients
  ON CONFLICT (event_key) DO NOTHING
  RETURNING * INTO v_outbox;

  IF v_outbox.id IS NULL THEN
    SELECT * INTO v_outbox
    FROM tracefab_notification_outbox
    WHERE event_key = v_event_key;
  END IF;

  RETURN v_outbox;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_enqueue_manual_data_request_reminder(UUID) FROM PUBLIC;

COMMENT ON FUNCTION tracefab_enqueue_manual_data_request_reminder(UUID) IS 'Queues an authenticated brand reminder for an active request, idempotent for ten minutes.';
