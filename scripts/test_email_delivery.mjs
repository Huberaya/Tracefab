import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../api/_lib/email.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const email = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const originalEnvironment = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  TRACEFAB_APP_URL: process.env.TRACEFAB_APP_URL,
};
const originalFetch = globalThis.fetch;

try {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.TRACEFAB_APP_URL;
  const notConfigured = await email.sendSupplierInvitationEmail({
    to: 'supplier@example.test',
    supplierName: 'Supplier',
    brandName: 'Brand',
    invitationToken: 'raw-test-token',
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  assert(notConfigured.status === 'not_configured', 'email must default to manual delivery');

  process.env.RESEND_API_KEY = 're_test_only';
  process.env.EMAIL_FROM = 'Tracefab <no-reply@example.test>';
  process.env.TRACEFAB_APP_URL = 'https://app.example.test';
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: 'email_test_id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const sent = await email.sendSupplierInvitationEmail({
    to: 'supplier@example.test',
    supplierName: 'Supplier <Test>',
    brandName: 'Brand & Co',
    invitationToken: 'raw-test-token',
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  const payload = JSON.parse(request.init.body);
  assert(sent.status === 'sent' && sent.providerId === 'email_test_id', 'successful delivery was not reported');
  assert(request.url === 'https://api.resend.com/emails', 'unexpected email provider endpoint');
  assert(payload.to[0] === 'supplier@example.test', 'recipient was not passed to provider');
  assert(payload.text.includes('raw-test-token'), 'acceptance link omitted the one-time token');
  assert(payload.html.includes('&lt;Test&gt;') && payload.html.includes('Brand &amp; Co'), 'HTML was not escaped');

  const notification = await email.sendDataRequestNotificationEmail({
    to: ['reviewer@example.test', 'REVIEWER@example.test'],
    recipientName: 'Reviewer <One>',
    brandName: 'Brand & Co',
    supplierName: 'Supplier',
    requestTitle: 'Product data',
    requestId: '00000000-0000-0000-0000-000000000001',
    dueAt: new Date('2026-10-01T00:00:00.000Z'),
    event: 'request_submitted',
  });
  const notificationPayload = JSON.parse(request.init.body);
  assert(notification.status === 'sent', 'data request notification was not delivered');
  assert(notificationPayload.to.length === 1 && notificationPayload.to[0] === 'reviewer@example.test', 'notification recipients were not normalized');
  assert(notificationPayload.html.includes('data-requests/00000000-0000-0000-0000-000000000001'), 'request link was omitted');
  assert(notificationPayload.html.includes('Reviewer &lt;One&gt;') && notificationPayload.html.includes('Brand &amp; Co'), 'notification HTML was not escaped');

  globalThis.fetch = async () => { throw new Error('provider unavailable'); };
  const failed = await email.sendSupplierInvitationEmail({
    to: 'supplier@example.test',
    supplierName: 'Supplier',
    brandName: 'Brand',
    invitationToken: 'raw-test-token',
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  assert(failed.status === 'failed', 'provider failure must be converted to a safe delivery status');

  console.log('Transactional email contract passed: manual fallback, Resend payload and safe failure');
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
