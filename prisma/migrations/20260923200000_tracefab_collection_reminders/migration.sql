-- Chantier 16 — scheduled due-date reminders for supplier data requests.

ALTER TYPE tracefab_notification_event ADD VALUE IF NOT EXISTS 'request_due_soon';
ALTER TYPE tracefab_notification_event ADD VALUE IF NOT EXISTS 'request_overdue';

CREATE OR REPLACE FUNCTION tracefab_enqueue_due_data_request_reminders(p_horizon_hours INTEGER DEFAULT 72)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request RECORD;
  v_event_type tracefab_notification_event;
  v_event_key TEXT;
  v_inserted INTEGER;
  v_enqueued INTEGER := 0;
BEGIN
  IF p_horizon_hours IS NULL OR p_horizon_hours < 1 OR p_horizon_hours > 720 THEN
    RAISE EXCEPTION 'notification_reminder_horizon_invalid';
  END IF;

  FOR v_request IN
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
    FROM data_requests r
    JOIN organizations brand ON brand.id = r.brand_organization_id
    JOIN organizations supplier ON supplier.id = r.supplier_organization_id
    WHERE r.due_at IS NOT NULL
      AND r.status IN ('sent', 'in_progress', 'changes_requested')
      AND (
        r.due_at < now()
        OR r.due_at <= now() + make_interval(hours => p_horizon_hours)
      )
  LOOP
    IF v_request.due_at < now() THEN
      v_event_type := 'request_overdue'::tracefab_notification_event;
      v_event_key := 'data-request:' || v_request.id::TEXT || ':overdue:' || to_char(now(), 'YYYY-MM-DD');
    ELSE
      v_event_type := 'request_due_soon'::tracefab_notification_event;
      v_event_key := 'data-request:' || v_request.id::TEXT || ':due-soon:' || to_char(now(), 'YYYY-MM-DD');
    END IF;

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
      v_event_type,
      v_request.id,
      v_request.supplier_organization_id,
      COALESCE(recipients.emails, '{}'::TEXT[]),
      recipients.recipient_name,
      COALESCE(v_request.brand_display_name, v_request.brand_legal_name),
      COALESCE(v_request.supplier_display_name, v_request.supplier_legal_name),
      v_request.title,
      v_request.due_at
    FROM recipients
    ON CONFLICT (event_key) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_enqueued := v_enqueued + v_inserted;
  END LOOP;

  RETURN v_enqueued;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_enqueue_due_data_request_reminders(INTEGER) FROM PUBLIC;

COMMENT ON FUNCTION tracefab_enqueue_due_data_request_reminders(INTEGER) IS 'Enqueues at most one due-soon or overdue reminder per request and calendar day.';
