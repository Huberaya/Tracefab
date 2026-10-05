import { randomUUID } from 'node:crypto';

export type NotificationAlertStatus = 'sent' | 'not_configured' | 'failed';

type AlertDetails = Record<string, boolean | number | string | null>;

function alertEndpoint() {
  const configured = process.env.TRACEFAB_NOTIFICATION_ALERT_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('https_required');
    return url;
  } catch {
    return null;
  }
}

function timeoutMs() {
  const value = Number(process.env.TRACEFAB_NOTIFICATION_ALERT_TIMEOUT_MS || 5000);
  return Number.isInteger(value) && value >= 1000 && value <= 15000 ? value : 5000;
}

export function notificationAlertConfigured() {
  return Boolean(alertEndpoint());
}

export function notificationRunId() {
  return randomUUID();
}

export function notificationLog(event: string, details: AlertDetails = {}) {
  console.info(JSON.stringify({ service: 'tracefab-notification', event, occurredAt: new Date().toISOString(), ...details }));
}

export async function emitNotificationAlert(event: string, details: AlertDetails = {}): Promise<NotificationAlertStatus> {
  const endpoint = alertEndpoint();
  if (!endpoint) return 'not_configured';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.TRACEFAB_NOTIFICATION_ALERT_TOKEN?.trim()
          ? { Authorization: `Bearer ${process.env.TRACEFAB_NOTIFICATION_ALERT_TOKEN.trim()}` }
          : {}),
      },
      body: JSON.stringify({
        schema: 'tracefab-notification-alert-v1',
        source: 'tracefab-api',
        event,
        occurredAt: new Date().toISOString(),
        details,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(JSON.stringify({ service: 'tracefab-notification', event: 'alert_delivery_failed', alertEvent: event, status: response.status }));
      return 'failed';
    }
    return 'sent';
  } catch {
    console.error(JSON.stringify({ service: 'tracefab-notification', event: 'alert_delivery_failed', alertEvent: event }));
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
