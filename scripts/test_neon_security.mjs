import { randomUUID } from 'node:crypto';
// Client partage : engine standard en CI, moteur client WASM + adaptateur pg
// sur un poste sans acces aux binaires Prisma (voir scripts/lib/test_prisma_client.mjs).
// Meme URL, donc meme role et meme base : la semantique du test est inchangee.
import { createTestPrisma } from './lib/test_prisma_client.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const prisma = await createTestPrisma(process.env.DATABASE_URL);
const role = `tracefab_rls_test_${process.pid}`;
const userA = randomUUID();
const userB = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
const supplierA = randomUUID();
const supplierB = randomUUID();
const clerkA = `test_${userA}`;
const clerkB = `test_${userB}`;

async function main() {
  await prisma.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
  await prisma.$executeRawUnsafe(`GRANT ${role} TO CURRENT_USER`);
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await prisma.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  // Le role runtime reel (tracefab_app) detient SELECT sur les 51 tables ; les
  // migrations ont retire tout octroi a PUBLIC. Sans ce GRANT, le role de test
  // s'arrete sur 42501 AVANT la RLS et ne prouve rien de l'isolation : ce n'est
  // pas la politique qui refuse, c'est l'absence de privilege. On lui donne donc
  // le meme perimetre de lecture que le runtime, pour que la seule barriere
  // restante soit la RLS — ce que ce test pretend mesurer.
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);

  await prisma.user.createMany({
    data: [
      { id: userA, clerkUserId: clerkA, email: `${clerkA}@example.test`, fullName: 'RLS Test A' },
      { id: userB, clerkUserId: clerkB, email: `${clerkB}@example.test`, fullName: 'RLS Test B' },
    ],
  });
  await prisma.organizations.createMany({
    data: [
      { id: orgA, type: 'brand', legal_name: 'RLS Brand A', display_name: 'Brand A', status: 'active', created_by: userA },
      { id: orgB, type: 'brand', legal_name: 'RLS Brand B', display_name: 'Brand B', status: 'active', created_by: userB },
    ],
  });
  await prisma.organization_memberships.createMany({
    data: [
      { organization_id: orgA, user_id: userA, role: 'viewer', status: 'active' },
      { organization_id: orgB, user_id: userB, role: 'owner', status: 'active' },
    ],
  });
  await prisma.suppliers.createMany({
    data: [
      { id: supplierA, organization_id: orgA, onboarding_status: 'in_progress' },
      { id: supplierB, organization_id: orgB, onboarding_status: 'in_progress' },
    ],
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userA}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${`${clerkA}@example.test`}, true)`;

    const visibleOrganizations = await tx.$queryRaw`SELECT id FROM organizations ORDER BY id`;
    assert(visibleOrganizations.length === 1 && visibleOrganizations[0].id === orgA, 'organization RLS leaked another tenant');

    const visibleSuppliers = await tx.$queryRaw`SELECT id FROM suppliers ORDER BY id`;
    assert(visibleSuppliers.length === 1 && visibleSuppliers[0].id === supplierA, 'supplier RLS leaked another tenant');

    await expectSqlCode(
      () => tx.$queryRaw`
        SELECT * FROM tracefab_update_supplier_profile(
          ${supplierA}::uuid,
          'must not write', NULL, NULL, NULL, NULL, NULL, ARRAY[]::text[]
        )
      `,
      'supplier_profile_role_required',
    );
  });

  // Ecriture directe : elle doit etre refusee. Le refus peut venir de deux
  // barrieres — le privilege (42501 : tracefab_app n'a que SELECT sur
  // suppliers) ou la RLS (0 ligne). Les deux satisfont la propriete testee,
  // et l'assertion d'origine (0 ligne) supposait un schema ou le DML etait
  // accorde a PUBLIC, ce que 20261014130000 et 20261023120000 ont revoque.
  // On accepte les deux, sans accepter une ecriture reussie.
  let ecritureDirecte;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userA}, true)`;
      await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${`${clerkA}@example.test`}, true)`;
      const n = await tx.$executeRaw`
        UPDATE suppliers SET profile_summary = 'must not write' WHERE id = ${supplierA}::uuid
      `;
      return n;
    }).then((n) => { ecritureDirecte = { lignes: n }; }, (e) => {
      const m = String(e?.message ?? e);
      const code = m.match(/Code: `([0-9A-Z]+)`/)?.[1];
      ecritureDirecte = { code, message: m.split('\n')[0] };
    });
  } catch (e) {
    ecritureDirecte = { erreur: String(e?.message ?? e) };
  }
  const refusee = ecritureDirecte.lignes === 0
    || ecritureDirecte.code === '42501'
    || /permission denied/.test(String(ecritureDirecte.message ?? ''));
  assert(refusee, `viewer could update a supplier directly (${JSON.stringify(ecritureDirecte)})`);

  console.log('Neon security integration passed: tenant isolation and insufficient-role denial');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

try {
  await main();
} finally {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.organizations.deleteMany({ where: { id: { in: [orgA, orgB] } } });
      await tx.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    });
  } finally {
    try {
      // Les GRANT sur les tables doivent etre revoques avant DROP ROLE :
      // PostgreSQL refuse de supprimer un role qui detient des privileges.
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`REVOKE ${role} FROM CURRENT_USER`);
      await prisma.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await prisma.$disconnect();
    }
  }
}
