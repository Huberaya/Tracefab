import { randomUUID } from 'node:crypto';
// Client partage : engine standard en CI, moteur client WASM + adaptateur pg
// sur un poste sans acces aux binaires Prisma (voir scripts/lib/test_prisma_client.mjs).
// Meme URL, donc meme role et meme base : la semantique du test est inchangee.
import { createTestPrisma } from './lib/test_prisma_client.mjs';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const prisma = await createTestPrisma(process.env.DATABASE_URL);
const brandUser = randomUUID();
const brandViewer = randomUUID();
const supplierUser = randomUUID();
// Un viewer DU FOURNISSEUR : il est dans le bon locataire, mais sans le role
// requis. Il sert a prouver le refus par ROLE, distinct du refus par LOCATAIRE.
const supplierViewer = randomUUID();
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
      { id: supplierViewer, clerkUserId: `quality_${supplierViewer}`, email: `${supplierViewer}@example.test`, fullName: 'Quality Supplier Viewer' },
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
      { organization_id: supplierOrganization, user_id: supplierViewer, role: 'viewer', status: 'active' },
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

  await inUserContext(brandUser, brandOrganization, async (tx) => {
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

  const supplierScore = await inUserContext(supplierUser, supplierOrganization, async (tx) => {
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

  const acknowledged = await inUserContext(supplierUser, supplierOrganization, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_acknowledge_quality_issue(${supplierIssues[0].id}::uuid)
  `);
  assert(acknowledged[0]?.status === 'acknowledged', 'quality issue was not acknowledged');

  // DEUX REFUS DISTINCTS, et non un seul.
  //
  // 1. Un viewer de la MARQUE, locataire marque actif, appelle une fonction qui
  //    porte sur une anomalie dont l'organisation proprietaire est le
  //    FOURNISSEUR : la garde de locataire actif (`20261105190000`, PR #111)
  //    refuse AVANT la garde de role, avec `active_tenant_mismatch`. Mesure
  //    identique sur la base PR #111 seule : ce n'est pas un effet de la
  //    branche courante, c'est le comportement voulu — un membre d'un autre
  //    locataire n'a pas a apprendre qu'il lui manque un role.
  await expectSqlCode(
    () => inUserContext(brandViewer, brandOrganization, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_waive_quality_issue(${supplierIssues[0].id}::uuid, 'viewer cannot waive')
    `),
    'active_tenant_mismatch',
  );

  // 2. Un viewer DU FOURNISSEUR, dans SON locataire, franchit la garde de
  //    locataire et se heurte a la garde de ROLE : c'est cette assertion qui
  //    preserve le refus par role, plutot que de le perdre.
  await expectSqlCode(
    () => inUserContext(supplierViewer, supplierOrganization, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_waive_quality_issue(${supplierIssues[0].id}::uuid, 'viewer cannot waive')
    `),
    'quality_issue_waive_role_required',
  );

  const waived = await inUserContext(supplierUser, supplierOrganization, async (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_waive_quality_issue(${supplierIssues[0].id}::uuid, 'Supplier accepts this known onboarding gap.')
  `);
  assert(waived[0]?.status === 'waived', 'quality issue was not waived');

  const productScore = await inUserContext(brandUser, brandOrganization, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM tracefab_compute_product_quality(${productId}::uuid, 'product_quality_test_v1')
    `;
    assert(rows.length === 1, 'product quality score was not computed');
    return rows[0];
  });
  assert(productScore.product_id === productId, 'product quality subject mismatch');

  await expectSqlCode(
    () => inUserContext(brandViewer, brandOrganization, async (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_compute_product_quality(${productId}::uuid, 'product_quality_test_v1')
    `),
    'product_quality_access_denied',
  );

  console.log('Neon quality integration passed: explainable supplier/product scores, issue acknowledgement, waiver and role denial');
}

async function inUserContext(userId, organizationId, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.active_organization_id', ${organizationId}, true)`;
    return callback(tx);
  });
}

async function expectSqlCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    const message = String(error?.message ?? error);
    // Le message OBSERVE est reporte : sans lui, un echec dit seulement quel
    // code manquait, jamais ce qui a ete leve a la place. Le journal du job
    // n'etant pas lisible depuis la session de travail, cette precision est ce
    // qui rend l'echec diagnosticable.
    assert(message.includes(code), `expected SQL error ${code}, observe : ${message.split('\n')[0]}`);
    return;
  }
  throw new Error(`expected SQL error ${code}, aucune erreur levee`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await main();
} catch (error) {
  // Une suite qui echoue sans nommer son echec coute une investigation
  // complete : le journal du job est heberge hors de l'API GitHub et n'est pas
  // lisible depuis la session de travail. La ligne `::error::` ci-dessous
  // devient une annotation du check, donc lisible. L'echec reste un echec.
  console.log(`::error::test:neon:quality — ${String(error?.message ?? error).replace(/\n/g, ' | ')}`);
  throw error;
} finally {
  try {
    await prisma.organizations.deleteMany({ where: { id: { in: [brandOrganization, supplierOrganization] } } });
    await prisma.user.deleteMany({ where: { id: { in: [brandUser, brandViewer, supplierUser, supplierViewer] } } });
  } finally {
    await prisma.$disconnect();
  }
}
