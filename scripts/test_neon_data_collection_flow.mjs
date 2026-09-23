import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const prisma = new PrismaClient();
const brandUser = randomUUID();
const brandViewer = randomUUID();
const supplierUser = randomUUID();
const otherUser = randomUUID();
const brandOrganization = randomUUID();
const supplierOrganization = randomUUID();
const relationship = randomUUID();

async function main() {
  await prisma.user.createMany({
    data: [
      { id: brandUser, clerkUserId: `collection_${brandUser}`, email: `${brandUser}@example.test`, fullName: 'Collection Brand' },
      { id: brandViewer, clerkUserId: `collection_${brandViewer}`, email: `${brandViewer}@example.test`, fullName: 'Collection Viewer' },
      { id: supplierUser, clerkUserId: `collection_${supplierUser}`, email: `${supplierUser}@example.test`, fullName: 'Collection Supplier' },
      { id: otherUser, clerkUserId: `collection_${otherUser}`, email: `${otherUser}@example.test`, fullName: 'Collection Other' },
    ],
  });
  await prisma.organizations.createMany({
    data: [
      { id: brandOrganization, type: 'brand', legal_name: 'Collection Brand', country_code: 'FR', created_by: brandUser },
      { id: supplierOrganization, type: 'supplier', legal_name: 'Collection Supplier', country_code: 'PT', created_by: supplierUser },
    ],
  });
  await prisma.organization_memberships.createMany({
    data: [
      { organization_id: brandOrganization, user_id: brandUser, role: 'owner', status: 'active' },
      { organization_id: brandOrganization, user_id: brandViewer, role: 'viewer', status: 'active' },
      { organization_id: supplierOrganization, user_id: supplierUser, role: 'owner', status: 'active' },
    ],
  });
  await prisma.brand_supplier_relationships.create({
    data: {
      id: relationship,
      brand_organization_id: brandOrganization,
      supplier_organization_id: supplierOrganization,
      status: 'active',
      requested_by: brandUser,
    },
  });

  const request = await inUserContext(brandUser, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_create_data_request(
        ${brandOrganization}::uuid,
        ${supplierOrganization}::uuid,
        NULL::uuid,
        'Supplier origin questionnaire',
        'supplier_origin_v1',
        '1.0',
        now() + interval '14 days',
        ${`collection-${brandOrganization}`}
      )
    `;
    assert(rows.length === 1, 'data request was not created');
    return rows[0];
  });

  const item = await inUserContext(brandUser, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_add_data_request_item(
        ${request.id}::uuid,
        'origin_country',
        'Country of origin',
        'country'::data_type,
        true,
        false,
        'Use the manufacturing country.',
        '{}'::jsonb,
        ARRAY[]::text[]
      )
    `;
    assert(rows.length === 1, 'request item was not created');
    return rows[0];
  });

  await expectSqlCode(
    () => inUserContext(brandViewer, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_send_data_request(${request.id}::uuid)
    `),
    'brand_data_request_role_required',
  );

  const sent = await inUserContext(brandUser, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_send_data_request(${request.id}::uuid)
  `);
  assert(sent[0]?.status === 'sent', 'data request was not sent');

  const response = await inUserContext(supplierUser, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_submit_data_response(
        ${item.id}::uuid,
        '"PT"'::jsonb,
        NULL::uuid
      )
    `;
    assert(rows.length === 1, 'supplier response was not created');
    return rows[0];
  });

  const submitted = await inUserContext(supplierUser, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_submit_data_request(${request.id}::uuid)
  `);
  assert(submitted[0]?.status === 'submitted', 'data request was not submitted');

  await expectSqlCode(
    () => inUserContext(brandViewer, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_review_data_response(
        ${response.id}::uuid,
        'verified_by_reviewer'::data_value_status,
        'viewer must not review'
      )
    `),
    'reviewer_role_required',
  );

  const reviewed = await inUserContext(brandUser, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_review_data_response(
      ${response.id}::uuid,
      'verified_by_reviewer'::data_value_status,
      'Reviewed against supplier declaration.'
    )
  `);
  assert(reviewed[0]?.status === 'verified_by_reviewer', 'response was not reviewed');

  const finalRequest = await prisma.data_requests.findUnique({ where: { id: request.id }, select: { status: true, completion_percentage: true } });
  assert(finalRequest?.status === 'approved', 'request was not approved after review');
  assert(String(finalRequest.completion_percentage) === '100.00' || String(finalRequest.completion_percentage) === '100', 'request completion was not 100');

  const notifications = await prisma.$queryRaw`
    SELECT event_type, status, recipient_organization_id, recipient_emails
    FROM tracefab_notification_outbox
    WHERE request_id = ${request.id}::uuid
    ORDER BY created_at
  `;
  assert(notifications.length === 3, 'expected one durable notification per workflow transition');
  assert(notifications.map(({ event_type }) => event_type).join(',') === 'request_sent,request_submitted,response_verified', 'notification event order was not preserved');
  assert(notifications.every(({ status }) => status === 'pending'), 'new notification jobs must be pending');
  assert(notifications[0].recipient_organization_id === supplierOrganization, 'send notification recipient is not the supplier');
  assert(notifications[1].recipient_organization_id === brandOrganization, 'submit notification recipient is not the brand');

  const claimed = await prisma.$queryRaw`
    SELECT id, status, attempts
    FROM tracefab_claim_notification_outbox(1)
  `;
  assert(claimed.length === 1 && claimed[0].status === 'processing' && claimed[0].attempts === 1, 'notification worker claim did not lock one job');
  const completed = await prisma.$queryRaw`
    SELECT status, last_error
    FROM tracefab_complete_notification_outbox(
      ${claimed[0].id}::uuid,
      'pending'::tracefab_notification_status,
      NULL,
      'test_backoff',
      now() + interval '1 minute'
    )
  `;
  assert(completed[0]?.status === 'pending' && completed[0]?.last_error === 'test_backoff', 'notification retry state was not persisted');

  console.log('Neon data collection integration passed: request, item, supplier response, submission, review, notifications, outbox claim and role denial');
}

async function inUserContext(userId, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    return callback(tx);
  });
}

async function expectSqlCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    assert(String(error?.message ?? error).includes(code), `expected SQL error ${code}`);
    return;
  }
  throw new Error(`expected SQL error ${code}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await main();
} finally {
  try {
    await prisma.organizations.deleteMany({ where: { id: { in: [brandOrganization, supplierOrganization] } } });
    await prisma.user.deleteMany({ where: { id: { in: [brandUser, brandViewer, supplierUser, otherUser] } } });
  } finally {
    await prisma.$disconnect();
  }
}
