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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function configuredEmailUrl(token: string) {
  const appUrl = process.env.TRACEFAB_APP_URL?.trim();
  if (!appUrl) return null;

  try {
    const url = new URL('/invitations/accept', appUrl);
    url.searchParams.set('token', token);
    return url.toString();
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
  const invitationUrl = configuredEmailUrl(input.invitationToken);
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
