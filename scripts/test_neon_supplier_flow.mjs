import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const supplierUser = randomUUID();
const wrongUser = randomUUID();
const brandOrganization = randomUUID();
let supplierOrganization;

const brandEmail = `flow_brand_${brandUser}@example.test`;
const supplierEmail = `flow_supplier_${supplierUser}@example.test`;
const wrongEmail = `flow_wrong_${wrongUser}@example.test`;

async function main() {
  await prisma.user.createMany({
    data: [
      { id: brandUser, clerkUserId: `flow_${brandUser}`, email: brandEmail, fullName: 'Flow Brand' },
      { id: supplierUser, clerkUserId: `flow_${supplierUser}`, email: supplierEmail, fullName: 'Flow Supplier' },
      { id: wrongUser, clerkUserId: `flow_${wrongUser}`, email: wrongEmail, fullName: 'Wrong Email' },
    ],
  });
  await prisma.organizations.create({
    data: {
      id: brandOrganization,
      type: 'brand',
      legal_name: 'Flow Test Brand',
      display_name: 'Flow Test Brand',
      country_code: 'FR',
      created_by: brandUser,
    },
  });
  await prisma.organization_memberships.create({
    data: { organization_id: brandOrganization, user_id: brandUser, role: 'owner', status: 'active' },
  });

  const invitationHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  const invitation = await inUserContext(brandUser, brandEmail, brandOrganization, (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_invite_supplier(
      ${brandOrganization}::uuid,
      ${supplierEmail},
      'Flow Test Supplier',
      'Flow Test Supplier',
      'FR',
      ${invitationHash}
    )
  `);
  assert(invitation.length === 1, 'supplier invitation was not created');
  supplierOrganization = invitation[0].supplier_organization_id;

  await expectSqlCode(
    () => inUserContext(wrongUser, wrongEmail, brandOrganization, (tx) => tx.$queryRaw`
      SELECT * FROM tracefab_accept_organization_invitation(${invitationHash})
    `),
    'invitation_email_mismatch',
  );

  const accepted = await inUserContext(supplierUser, supplierEmail, brandOrganization, (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_accept_organization_invitation(${invitationHash})
  `);
  assert(accepted.length === 1, 'supplier invitation was not accepted');
  const supplierId = accepted[0].supplier_id;
  // `tracefab_update_supplier_profile` / `tracefab_submit_supplier_profile` sont
  // gardees par `tracefab_require_active_tenant_for_organization(v_supplier.
  // organization_id)` : le locataire a armer pour ces appels est celui du
  // FOURNISSEUR, pas celui de la marque invitante. Le prendre dans le retour de
  // l'acceptation evite de le supposer.
  supplierOrganization = accepted[0].organization_id;

  const updated = await inUserContext(supplierUser, supplierEmail, supplierOrganization, (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_update_supplier_profile(
      ${supplierId}::uuid,
      ${'A complete supplier profile summary for the Neon integration test.'},
      ${'Flow Contact'},
      ${supplierEmail},
      '+33123456789',
      '1_10',
      2000,
      ${['dyeing', 'finishing']}::text[]
    )
  `);
  assert(updated[0]?.onboarding_status === 'in_progress', 'supplier profile was not updated');

  await prisma.supplier_sites.create({
    data: { supplier_id: supplierId, name: 'Flow Test Site', country_code: 'FR', city: 'Nantes' },
  });
  const submitted = await inUserContext(supplierUser, supplierEmail, supplierOrganization, (tx) => tx.$queryRaw`
    SELECT * FROM tracefab_submit_supplier_profile(${supplierId}::uuid)
  `);
  assert(submitted[0]?.onboarding_status === 'submitted', 'complete supplier profile was not submitted');
  assert(String(submitted[0]?.profile_completion) === '100', 'supplier profile completion was not 100');

  console.log('Neon supplier integration passed: invite, email-bound acceptance, profile update and submission');
}

// Le locataire actif est OBLIGATOIRE des lors que la fonction appelee est
// bornee a la tenancy : `tracefab_in_active_tenant()` rend `false` quand
// `tracefab.active_organization_id` n'est pas arme, et la garde leve alors
// `active_tenant_mismatch`. Le passer explicitement garde le test
// representatif du runtime, qui nomme toujours le locataire de la requete.
async function inUserContext(userId, email, activeOrganizationId, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${email}, true)`;
    if (activeOrganizationId) {
      await tx.$executeRaw`SELECT set_config('tracefab.active_organization_id', ${activeOrganizationId}, true)`;
    }
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
    await prisma.organizations.deleteMany({ where: { id: brandOrganization } });
    if (supplierOrganization) {
      await prisma.organizations.deleteMany({ where: { id: supplierOrganization } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [brandUser, supplierUser, wrongUser] } } });
  } finally {
    await prisma.$disconnect();
  }
}
