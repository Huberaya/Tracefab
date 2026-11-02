// R11 (30/10) : garde de cible AVANT tout import susceptible de construire un
// client ou d'ouvrir une connexion. Import placé en PREMIÈRE position : en ESM
// il s'évalue avant les imports suivants. Aucune écriture sans cible jetable.
import './lib/garde_import.mjs';

import { randomUUID } from 'node:crypto';
import { nomRoleEphemere } from './lib/ephemeral-role.mjs';
import { createTestPrisma, fermerPrismaDeTest, injectPrismaSingleton } from './lib/test_prisma_client.mjs';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

// Chantier B (30/10) : ce script construisait `new PrismaClient()` sans
// `datasourceUrl`, ce qui exige un moteur Prisma NATIF et le rendait
// inexécutable hors de la CI. `createTestPrisma` est le point d'entrée prévu
// par le dépôt : moteur standard quand il est disponible (CI), repli
// moteur WASM + adaptateur `pg` sinon. Les assertions du test sont inchangées ;
// seule la façon d'obtenir le client l'est.
const prisma = await createTestPrisma(process.env.DATABASE_URL);
injectPrismaSingleton(prisma);
// Nom UNIQUE par execution (et non `_${process.pid}`, reutilisable) et plus
// aucun `DROP ROLE IF EXISTS` preventif : un role preexistant ne doit jamais
// etre supprime pour faire passer un test.
const role = nomRoleEphemere('tf_rls_adv');
const ownerId = randomUUID();
const viewerId = randomUUID();
const otherUserId = randomUUID();
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const supplierId = randomUUID();
const otherSupplierId = randomUUID();
const pointId = randomUUID();
const otherPointId = randomUUID();
const ownerEmail = `tracefab-owner-${process.pid}@example.test`;
const viewerEmail = `tracefab-viewer-${process.pid}@example.test`;
const otherEmail = `tracefab-other-${process.pid}@example.test`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectFailure(operation, marker) {
  try {
    await operation();
  } catch (error) {
    assert(String(error?.message ?? error).includes(marker), `expected ${marker}, received ${String(error?.message ?? error)}`);
    return;
  }
  throw new Error(`expected operation to fail with ${marker}`);
}

async function main() {
  await prisma.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
  await prisma.$executeRawUnsafe(`GRANT ${role} TO CURRENT_USER`);
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  // Depuis la migration 20261021120000, PUBLIC n'a plus EXECUTE sur les
  // fonctions : sans ce GRANT, le role de sonde s'arrete en 42501 AVANT la RLS
  // et le test ne mesure plus l'isolation. Mesure du 30/10 : la suite, jamais
  // branchee en CI, echouait sur `permission denied for function
  // tracefab_current_user_email`. Meme correctif que test_neon_security.
  await prisma.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

  await prisma.user.createMany({ data: [
    { id: ownerId, clerkUserId: `clerk_${ownerId}`, email: ownerEmail, fullName: 'Advanced Owner' },
    { id: viewerId, clerkUserId: `clerk_${viewerId}`, email: viewerEmail, fullName: 'Advanced Viewer' },
    { id: otherUserId, clerkUserId: `clerk_${otherUserId}`, email: otherEmail, fullName: 'Other Tenant' },
  ] });
  await prisma.organizations.createMany({ data: [
    { id: organizationId, type: 'supplier', legal_name: 'Advanced Supplier A', display_name: 'Supplier A', status: 'active', created_by: ownerId },
    { id: otherOrganizationId, type: 'supplier', legal_name: 'Advanced Supplier B', display_name: 'Supplier B', status: 'active', created_by: otherUserId },
  ] });
  await prisma.organization_memberships.createMany({ data: [
    { organization_id: organizationId, user_id: ownerId, role: 'owner', status: 'active', joined_at: new Date() },
    { organization_id: organizationId, user_id: viewerId, role: 'viewer', status: 'active', joined_at: new Date() },
    { organization_id: otherOrganizationId, user_id: otherUserId, role: 'owner', status: 'active', joined_at: new Date() },
  ] });
  await prisma.suppliers.createMany({ data: [
    { id: supplierId, organization_id: organizationId, onboarding_status: 'in_progress' },
    { id: otherSupplierId, organization_id: otherOrganizationId, onboarding_status: 'in_progress' },
  ] });

  await runAs(ownerId, ownerEmail, async (tx) => {
    const visibleOrganizations = await tx.$queryRaw`SELECT id FROM organizations ORDER BY id`;
    assert(visibleOrganizations.length === 1 && visibleOrganizations[0].id === organizationId, 'supplier organization RLS leaked another tenant');

    await tx.data_points.create({ data: {
      id: pointId,
      owner_organization_id: organizationId,
      supplier_id: supplierId,
      data_key: 'country_of_manufacture',
      value: 'PT',
      data_type: 'country',
      status: 'declared',
      declared_by: ownerId,
      version: 1,
    } });
    await tx.data_points.create({ data: {
      id: otherPointId,
      owner_organization_id: organizationId,
      supplier_id: supplierId,
      data_key: 'country_of_manufacture',
      value: 'PT',
      data_type: 'country',
      status: 'documented',
      declared_by: ownerId,
      version: 2,
      supersedes_id: pointId,
    } });
    const versions = await tx.data_points.findMany({ where: { supplier_id: supplierId, data_key: 'country_of_manufacture' }, orderBy: { version: 'asc' }, select: { version: true, supersedes_id: true } });
    assert(versions.length === 2 && versions[1].version === 2 && versions[1].supersedes_id === pointId, 'data point version chain is not preserved');
  });

  await expectFailure(
    () => runAs(viewerId, viewerEmail, (tx) => tx.data_points.create({ data: {
      owner_organization_id: organizationId,
      supplier_id: supplierId,
      data_key: 'annual_production_capacity',
      value: 100,
      data_type: 'number',
      status: 'declared',
      declared_by: viewerId,
      version: 1,
    } })),
    'row-level security',
  );

  await expectFailure(
    () => runAs(ownerId, ownerEmail, (tx) => tx.organization_memberships.update({ where: { organization_id_user_id: { organization_id: organizationId, user_id: ownerId } }, data: { status: 'suspended' } })),
    'last_owner_membership_required',
  );
  await expectFailure(
    () => runAs(ownerId, ownerEmail, (tx) => tx.organization_invitations.create({ data: {
      organization_id: organizationId,
      email: `cannot-owner-${process.pid}@example.test`,
      target_role: 'owner',
      token_hash: `hash-${process.pid}`,
      invited_by: ownerId,
      expires_at: new Date(Date.now() + 86400000),
    } })),
    'owner_role_not_invitable',
  );

  console.log('Neon Supplier Portal advanced integration passed: tenant isolation, data-point versioning, role RLS and owner invariants');
}

async function runAs(userId, email, callback) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${email}, true)`;
    return callback(tx);
  });
}

try {
  await main();
} finally {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.organizations.deleteMany({ where: { id: { in: [organizationId, otherOrganizationId] } } });
      await tx.user.deleteMany({ where: { id: { in: [ownerId, viewerId, otherUserId] } } });
    });
  } finally {
    try {
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ${role} FROM CURRENT_USER`);
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      // `$disconnect()` seul ne ferme pas le pool pg sur le chemin WASM.
      await fermerPrismaDeTest(prisma);
    }
  }
}
