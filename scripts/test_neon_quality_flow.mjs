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
const brandOrganization = randomUUID();
const supplierOrganization = randomUUID();
const supplierId = randomUUID();
let productId;

async function main() {
  await prisma.user.createMany({
    data: [
      { id: brandUser, clerkUserId: `quality_${brandUser}`, email: `${brandUser}@example.test`, fullName: 'Quality Brand' },
      { id: brandViewer, clerkUserId: `quality_${brandViewer}`, email: `${brandViewer}@example.test`, fullName: 'Quality Viewer' },
      { id: supplierUser, clerkUserId: `quality_${supplierUser}`, email: `${supplierUser}@example.test`, fullName: 'Quality Supplier' },
    ],
  });
  await prisma.organizations.createMany({
    data: [
      { id: brandOrganization, type: 'brand', legal_name: 'Quality Brand', country_code: 'FR', created_by: brandUser },
      { id: supplierOrganization, type: 'supplier', legal_name: 'Quality Supplier', country_code: 'PT', created_by: supplierUser },
    ],
  });
  await prisma.organization_memberships.createMany({
    data: [
      { organization_id: brandOrganization, user_id: brandUser, role: 'owner', status: 'active' },
      { organization_id: brandOrganization, user_id: brandViewer, role: 'viewer', status: 'active' },
      { organization_id: supplierOrganization, user_id: supplierUser, role: 'owner', status: 'active' },
    ],
  });
  await prisma.suppliers.create({
    data: {
      id: supplierId,
      organization_id: supplierOrganization,
      onboarding_status: 'in_progress',
      activity_types: [],
      profile_version: 1,
      profile_completion: 0,
    },
  });

  await inUserContext(brandUser, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_create_product(
        ${brandOrganization}::uuid,
        'QUALITY-PRODUCT',
        'Quality Product',
        'shirt',
        'QUALITY-SKU'
      )
    `;
    assert(rows.length === 1, 'quality product was not created');
    productId = rows[0].id;
  });

  const supplierScore = await inUserContext(supplierUser, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_compute_supplier_quality(${supplierId}::uuid, 'supplier_quality_test_v1')
    `;
    assert(rows.length === 1, 'supplier quality score was not computed');
    return rows[0];
  });
  assert(supplierScore.supplier_id === supplierId, 'supplier quality subject mismatch');
  assert(Number(supplierScore.completeness) < 100, 'incomplete supplier should not have full completeness');
  assert(Array.isArray(supplierScore.missing_fields) && supplierScore.missing_fields.includes('supplier_profile'), 'supplier quality missing field explanation is absent');

  const supplierIssues = await prisma.data_quality_issues.findMany({
    where: { supplier_id: supplierId },
    orderBy: { detected_at: 'asc' },
  });
  assert(supplierIssues.length > 0, 'supplier quality issues were not created');

  const acknowledged = await inUserContext(supplierUser, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_acknowledge_quality_issue(${supplierIssues[0].id}::uuid)
  `);
  assert(acknowledged[0]?.status === 'acknowledged', 'quality issue was not acknowledged');

  await expectSqlCode(
    () => inUserContext(brandViewer, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_waive_quality_issue(${supplierIssues[0].id}::uuid, 'viewer cannot waive')
    `),
    'quality_issue_waive_role_required',
  );

  const waived = await inUserContext(supplierUser, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_waive_quality_issue(${supplierIssues[0].id}::uuid, 'Supplier accepts this known onboarding gap.')
  `);
  assert(waived[0]?.status === 'waived', 'quality issue was not waived');

  const productScore = await inUserContext(brandUser, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_compute_product_quality(${productId}::uuid, 'product_quality_test_v1')
    `;
    assert(rows.length === 1, 'product quality score was not computed');
    return rows[0];
  });
  assert(productScore.product_id === productId, 'product quality subject mismatch');

  await expectSqlCode(
    () => inUserContext(brandViewer, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_compute_product_quality(${productId}::uuid, 'product_quality_test_v1')
    `),
    'product_quality_access_denied',
  );

  console.log('Neon quality integration passed: explainable supplier/product scores, issue acknowledgement, waiver and role denial');
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
    await prisma.user.deleteMany({ where: { id: { in: [brandUser, brandViewer, supplierUser] } } });
  } finally {
    await prisma.$disconnect();
  }
}
