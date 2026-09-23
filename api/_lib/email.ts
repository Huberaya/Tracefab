export type EmailDeliveryResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'not_configured' }
  | { status: 'failed' };

type SupplierInvitationEmail = {
  to: string;
  supplierName: string;
  brandName: string;
  invitationToken: string;
  expiresAt: Date;
};

export type DataRequestNotificationEvent =
  | 'request_sent'
  | 'request_submitted'
  | 'response_verified'
  | 'changes_requested';

type DataRequestNotificationEmail = {
  to: string[];
  recipientName: string;
  brandName: string;
  supplierName: string;
  requestTitle: string;
  requestId: string;
  dueAt: Date | null;
  event: DataRequestNotificationEvent;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function configuredEmailUrl(path: string) {
  const appUrl = process.env.TRACEFAB_APP_URL?.trim();
  if (!appUrl) return null;

  try {
    return new URL(path, appUrl).toString();
  } catch {
    return null;
  }
}

export function emailDeliveryConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim()
      && process.env.EMAIL_FROM?.trim()
      && process.env.TRACEFAB_APP_URL?.trim(),
  );
}

export async function sendSupplierInvitationEmail(
  input: SupplierInvitationEmail,
): Promise<EmailDeliveryResult> {
  const invitationUrl = configuredEmailUrl(`/invitations/accept?token=${encodeURIComponent(input.invitationToken)}`);
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!invitationUrl || !apiKey || !from) return { status: 'not_configured' };

  const supplierName = escapeHtml(input.supplierName);
  const brandName = escapeHtml(input.brandName);
  const safeInvitationUrl = escapeHtml(invitationUrl);
  const expiresAt = input.expiresAt.toISOString();

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: `${input.brandName} invited you to Tracefab`,
        text: [
          `Hello ${input.supplierName},`,
          '',
          `${input.brandName} invited your organization to join Tracefab as a supplier.`,
          `Accept the invitation: ${invitationUrl}`,
          `This link expires on ${expiresAt}.`,
        ].join('\n'),
        html: [
          `<p>Hello ${supplierName},</p>`,
          `<p><strong>${brandName}</strong> invited your organization to join Tracefab as a supplier.</p>`,
          `<p><a href="${safeInvitationUrl}">Accept the Tracefab invitation</a></p>`,
          `<p>This link expires on ${escapeHtml(expiresAt)}.</p>`,
        ].join(''),
      }),
    });
  } catch {
    return { status: 'failed' };
  }

  if (!response.ok) return { status: 'failed' };

  let providerId: string | null = null;
  try {
    const payload = await response.json() as { id?: unknown };
    if (typeof payload.id === 'string') providerId = payload.id;
  } catch {
    // A successful provider response without a JSON body is still a delivery.
  }

  return { status: 'sent', providerId };
}

const notificationCopy: Record<DataRequestNotificationEvent, { subject: string; action: string }> = {
  request_sent: {
    subject: 'New Tracefab data request',
    action: 'Please review the request and provide the requested data.',
  },
  request_submitted: {
    subject: 'Tracefab data request ready for review',
    action: 'The supplier submitted the request. Please review the current responses.',
  },
  response_verified: {
    subject: 'Tracefab data response verified',
    action: 'A response was verified by the brand reviewer.',
  },
  changes_requested: {
    subject: 'Tracefab changes requested',
    action: 'The brand reviewer requested changes or additional evidence.',
  },
};

export async function sendDataRequestNotificationEmail(
  input: DataRequestNotificationEmail,
): Promise<EmailDeliveryResult> {
  const recipients = [...new Set(input.to.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const requestUrl = configuredEmailUrl(`/data-requests/${encodeURIComponent(input.requestId)}`);
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!requestUrl || !apiKey || !from || recipients.length === 0) return { status: 'not_configured' };

  const copy = notificationCopy[input.event];
  const recipientName = escapeHtml(input.recipientName || 'Tracefab user');
  const brandName = escapeHtml(input.brandName);
  const supplierName = escapeHtml(input.supplierName);
  const requestTitle = escapeHtml(input.requestTitle);
  const safeRequestUrl = escapeHtml(requestUrl);
  const dueText = input.dueAt ? `Due date: ${input.dueAt.toISOString()}` : 'No due date was set.';

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: copy.subject,
        text: [
          `Hello ${input.recipientName || 'Tracefab user'},`,
          '',
          `${input.brandName} requested data from ${input.supplierName}.`,
          `Request: ${input.requestTitle}`,
          copy.action,
          dueText,
          `Open the request: ${requestUrl}`,
        ].join('\n'),
        html: [
          `<p>Hello ${recipientName},</p>`,
          `<p><strong>${brandName}</strong> requested data from <strong>${supplierName}</strong>.</p>`,
          `<p><strong>Request:</strong> ${requestTitle}</p>`,
          `<p>${escapeHtml(copy.action)}</p>`,
          `<p>${escapeHtml(dueText)}</p>`,
          `<p><a href="${safeRequestUrl}">Open the Tracefab request</a></p>`,
        ].join(''),
      }),
    });
  } catch {
    return { status: 'failed' };
  }

  if (!response.ok) return { status: 'failed' };

  let providerId: string | null = null;
  try {
    const payload = await response.json() as { id?: unknown };
    if (typeof payload.id === 'string') providerId = payload.id;
  } catch {
    // A successful provider response without a JSON body is still a delivery.
  }

  return { status: 'sent', providerId };
}
