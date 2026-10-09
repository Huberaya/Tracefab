import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const prisma = new PrismaClient();
const role = `tracefab_product_rls_test_${process.pid}`;
const ownerA = randomUUID();
const viewerA = randomUUID();
const ownerB = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
let productAId;
let productBId;

async function main() {
  await prisma.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
  await prisma.$executeRawUnsafe(`GRANT ${role} TO CURRENT_USER`);
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);

  await prisma.user.createMany({
    data: [
      { id: ownerA, clerkUserId: `product_${ownerA}`, email: `${ownerA}@example.test`, fullName: 'Product Owner A' },
      { id: viewerA, clerkUserId: `product_${viewerA}`, email: `${viewerA}@example.test`, fullName: 'Product Viewer A' },
      { id: ownerB, clerkUserId: `product_${ownerB}`, email: `${ownerB}@example.test`, fullName: 'Product Owner B' },
    ],
  });
  await prisma.organizations.createMany({
    data: [
      { id: orgA, type: 'brand', legal_name: 'Product Brand A', country_code: 'FR', created_by: ownerA },
      { id: orgB, type: 'brand', legal_name: 'Product Brand B', country_code: 'PT', created_by: ownerB },
    ],
  });
  await prisma.organization_memberships.createMany({
    data: [
      { organization_id: orgA, user_id: ownerA, role: 'owner', status: 'active' },
      { organization_id: orgA, user_id: viewerA, role: 'viewer', status: 'active' },
      { organization_id: orgB, user_id: ownerB, role: 'owner', status: 'active' },
    ],
  });

  await inUserContext(ownerA, async (tx) => {
    const materialRows = await tx.$queryRaw`
      SELECT * FROM tracefab_create_material(
        ${orgA}::uuid, 'fiber', 'Organic cotton', '{"organic":true}'::jsonb, 'FR'
      )
    `;
    assert(materialRows.length === 1, 'brand material was not created');
    assert(typeof materialRows[0].id === 'string', 'material id missing');
    const actualMaterialA = materialRows[0].id;

    const productRows = await tx.$queryRaw`
      SELECT * FROM tracefab_create_product(${orgA}::uuid, 'TF-PROD-A', 'Product A', 'shirt', 'SKU-A')
    `;
    assert(productRows.length === 1, 'product A was not created');
    const actualProductA = productRows[0].id;
    productAId = actualProductA;

    const compositionRows = await tx.$queryRaw`
      SELECT * FROM tracefab_add_product_material(${actualProductA}::uuid, ${actualMaterialA}::uuid, 'main', 100, '%')
    `;
    assert(compositionRows.length === 1, 'product composition was not added');

    const identifierRows = await tx.$queryRaw`
      SELECT * FROM tracefab_add_product_identifier(${actualProductA}::uuid, 'internal', 'INTERNAL-A', true)
    `;
    assert(identifierRows.length === 1, 'product identifier was not added');

    const updateRows = await tx.$queryRaw`
      SELECT * FROM tracefab_update_product_data(
        ${actualProductA}::uuid,
        'TF-PROD-A', 'SKU-A', 'Product A', 'shirt',
        'A product description long enough for the completeness rule.',
        'tops', 'navy', ${['S', 'M', 'L']}::text[], 'FR', 'PT', 240,
        '{"wash":"30C"}'::jsonb
      )
    `;
    assert(updateRows.length === 1, 'product data was not updated');

    const revisionRows = await tx.$queryRaw`
      SELECT * FROM tracefab_start_product_revision(${actualProductA}::uuid)
    `;
    assert(revisionRows[0]?.version === 2, 'product revision did not increment version');
    assert(typeof actualProductA === 'string', 'product id missing');
  });

  await inUserContext(ownerB, async (tx) => {
    const productRows = await tx.$queryRaw`
      SELECT * FROM tracefab_create_product(${orgB}::uuid, 'TF-PROD-B', 'Product B', 'trousers', 'SKU-B')
    `;
    assert(productRows.length === 1, 'product B was not created');
    const materialRows = await tx.$queryRaw`
      SELECT * FROM tracefab_create_material(${orgB}::uuid, 'fiber', 'Linen', '{}'::jsonb, 'PT')
    `;
    assert(materialRows.length === 1, 'brand B material was not created');
    productBId = productRows[0].id;
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${viewerA}, true)`;
    const visibleProducts = await tx.$queryRaw`SELECT id FROM tracefab_products ORDER BY reference`;
    assert(visibleProducts.length === 1, 'product RLS leaked another brand');
    assert(visibleProducts[0].id !== productBId, 'product B was visible to brand A viewer');

    const directUpdateCount = await tx.$executeRaw`
      UPDATE tracefab_products SET name = 'must not write' WHERE id = ${productAId}::uuid
    `;
    assert(directUpdateCount === 0, 'viewer could update a product directly');

    await expectSqlCode(
      () => tx.$queryRaw`
        SELECT * FROM tracefab_update_product_data(
          ${productAId}::uuid, 'TF-PROD-A', 'SKU-A', 'must not write', NULL, NULL, NULL, NULL,
          ARRAY[]::text[], NULL, NULL, NULL, '{}'::jsonb
        )
      `,
      'brand_product_role_required',
    );
  });

  console.log('Neon product integration passed: product data, revision, composition, identifiers and RLS isolation');
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
    await prisma.organizations.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerA, viewerA, ownerB] } } });
  } finally {
    try {
      await prisma.$executeRawUnsafe(`REVOKE ${role} FROM CURRENT_USER`);
      await prisma.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await prisma.$disconnect();
    }
  }
}
