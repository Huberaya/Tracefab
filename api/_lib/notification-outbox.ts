import { prisma } from './prisma';
import { sendDataRequestNotificationEmail, type DataRequestNotificationEvent } from './email';

type NotificationOutboxRow = {
  id: string;
  event_key: string;
  event_type: DataRequestNotificationEvent;
  request_id: string;
  response_id: string | null;
  recipient_emails: string[];
  recipient_name: string;
  brand_name: string;
  supplier_name: string;
  request_title: string;
  due_at: Date | null;
  status: string;
  attempts: number;
};

export type NotificationProcessSummary = {
  claimed: number;
  sent: number;
  pending: number;
  failed: number;
  notConfigured: number;
};

export async function processNotificationOutbox(limit: number): Promise<NotificationProcessSummary> {
  const rows = await prisma.$queryRaw<NotificationOutboxRow[]>`
    SELECT * FROM tracefab_claim_notification_outbox(${limit})
  `;
  const summary: NotificationProcessSummary = {
    claimed: rows.length,
    sent: 0,
    pending: 0,
    failed: 0,
    notConfigured: 0,
  };

  for (const row of rows) {
    if (row.recipient_emails.length === 0) {
      await completeOutboxItem(row.id, 'failed', null, 'no_active_recipients', null);
      summary.failed += 1;
      continue;
    }

    const delivery = await sendDataRequestNotificationEmail({
      to: row.recipient_emails,
      recipientName: row.recipient_name,
      brandName: row.brand_name,
      supplierName: row.supplier_name,
      requestTitle: row.request_title,
      requestId: row.request_id,
      dueAt: row.due_at,
      event: row.event_type,
    });

    if (delivery.status === 'sent') {
      await completeOutboxItem(row.id, 'sent', delivery.providerId, null, null);
      summary.sent += 1;
      continue;
    }

    if (delivery.status === 'not_configured') {
      await completeOutboxItem(row.id, 'pending', null, 'email_not_configured', nextAttemptAt(30 * 60 * 1000));
      summary.pending += 1;
      summary.notConfigured += 1;
      continue;
    }

    const permanentlyFailed = row.attempts >= 5;
    await completeOutboxItem(
      row.id,
      permanentlyFailed ? 'failed' : 'pending',
      null,
      'email_provider_delivery_failed',
      permanentlyFailed ? null : nextAttemptAt(retryDelayMs(row.attempts)),
    );
    if (permanentlyFailed) summary.failed += 1;
    else summary.pending += 1;
  }

  return summary;
}

async function completeOutboxItem(
  id: string,
  status: 'pending' | 'sent' | 'failed',
  providerId: string | null,
  error: string | null,
  nextAttempt: Date | null,
) {
  await prisma.$queryRaw`
    SELECT *
    FROM tracefab_complete_notification_outbox(
      ${id}::uuid,
      ${status}::tracefab_notification_status,
      ${providerId},
      ${error},
      ${nextAttempt}
    )
  `;
}

function retryDelayMs(attempts: number) {
  return Math.min(2 * 60 * 60 * 1000, Math.max(60 * 1000, 5 ** Math.max(0, attempts - 1) * 60 * 1000));
}

function nextAttemptAt(delayMs: number) {
  return new Date(Date.now() + delayMs);
}
