/**
 * Preuve par execution — chantier 1A-B : authentification et RLS.
 *
 * Execute sur PostgreSQL avec le role runtime reel (`tracefab_app`, sans
 * BYPASSRLS). Demonstration :
 *   1. premiere connexion : provisionnement de l'utilisateur interne depuis
 *      l'identite Clerk (code reel de api/_lib/auth.ts::provisionUserFromClerk)
 *      — l'INSERT doit passer par le contexte worker ;
 *   2. connexion d'un utilisateur deja provisionne : la relecture + mise a jour
 *      fonctionne sans violation d'unicite ;
 *   3. le chemin HISTORIQUE (upsert nu, sans contexte) echoue sous la RLS —
 *      c'etait le bug de bascule ;
 *   4. politiques INSERT/UPDATE de `users` : sans contexte worker, rien
 *      ne s'ecrit ; l'UPDATE « soi-meme » via tracefab.user_id fonctionne,
 *      l'UPDATE d'un AUTRE utilisateur non ;
 *   5. isolation entre organisations : un utilisateur ne voit pas les lignes
 *      d'une autre organisation.
 *
 * La verification du jeton Clerk n'est pas testee ici (service externe) :
 * c'est signale comme tel dans le rapport, pas simule en silence.
 *
 * Sortie 2 si la base n'est pas disponible : un test qui ne tourne pas ne
 * vaut pas un test qui passe.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestPrisma, injectPrismaSingleton } from './lib/test_prisma_client.mjs';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.error('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  process.exit(2);
}

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };

/* ------------------------------------------------- fixtures */

const proprio = new pg.Client({ connectionString: URL_PROPRIO });
await proprio.connect();

const U = {
  orgA: 'a1000000-0000-4000-8000-000000000001',
  orgB: 'a1000000-0000-4000-8000-000000000002',
  userB: 'a1000000-0000-4000-8000-000000000003',
  prodB: 'a1000000-0000-4000-8000-000000000004',
};

await proprio.query('DELETE FROM organization_memberships WHERE organization_id = ANY($1)', [[U.orgA, U.orgB]]);
await proprio.query('DELETE FROM tracefab_products WHERE id = $1', [U.prodB]);
await proprio.query('DELETE FROM users WHERE id = $1 OR clerk_user_id LIKE $2', [U.userB, 'clerk_auth_test_%']);
await proprio.query('DELETE FROM organizations WHERE id = ANY($1)', [[U.orgA, U.orgB]]);

await proprio.query(
  `INSERT INTO organizations (id, type, legal_name, display_name, country_code) VALUES
   ($1, 'brand', 'Maison Auth A', 'Maison A', 'FR'),
   ($2, 'brand', 'Maison Auth B', 'Maison B', 'PT')`,
  [U.orgA, U.orgB]);
await proprio.query(
  `INSERT INTO users (id, clerk_user_id, email, full_name) VALUES ($1, 'clerk_auth_test_b', 'b@auth.test', 'User B')`,
  [U.userB]);
await proprio.query(
  `INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
   VALUES ('a1000000-0000-4000-8000-00000000000f', $1, $2, 'owner', 'active')`,
  [U.orgB, U.userB]);
await proprio.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status)
   VALUES ($1, $2, 'AUTH-B-001', 'Produit Secret B', 'active')`,
  [U.prodB, U.orgB]);

console.log('  fixtures en place (organisation A provisionnee, organisation B isolee)');

/* ------------------------------------------------- role runtime reel */

const prisma = await createTestPrisma(URL_APP);
injectPrismaSingleton(prisma);
const { provisionUserFromClerk } = await import('../api/_lib/auth.ts');
const { withTracefabUserContext } = await import('../api/_lib/context.ts');

const CLERK_ID = 'clerk_auth_test_first';
const CLEAN = async () => {
  await proprio.query("DELETE FROM users WHERE clerk_user_id LIKE 'clerk_auth_test_%' AND id <> $1", [U.userB]);
};
await CLEAN();

console.log('\n  1. premiere connexion — provisionnement par le code reel');

let user1;
try {
  user1 = await provisionUserFromClerk({
    clerkUserId: CLERK_ID,
    email: 'first@auth.test',
    fullName: 'Premiere Connexion',
  });
  assert.ok(user1.id, 'l utilisateur interne doit etre cree');
  const ligne = (await proprio.query('SELECT email, full_name FROM users WHERE id = $1', [user1.id])).rows[0];
  assert.equal(ligne.email, 'first@auth.test');
  ok('premiere connexion : utilisateur cree via withTracefabWorkerContext');
} catch (e) {
  ko(`premiere connexion echoue sous tracefab_app : ${e.message}`);
}

console.log('\n  2. utilisateur deja provisionne — reconnexion et mise a jour');

try {
  const user2 = await provisionUserFromClerk({
    clerkUserId: CLERK_ID,
    email: 'first+rename@auth.test',
    fullName: 'Connexion Suivante',
  });
  assert.equal(user2.id, user1.id, 'meme utilisateur interne, pas un doublon');
  const ligne = (await proprio.query('SELECT email, full_name FROM users WHERE id = $1', [user1.id])).rows[0];
  assert.equal(ligne.email, 'first+rename@auth.test');
  assert.equal(ligne.full_name, 'Connexion Suivante');
  ok('reconnexion : meme utilisateur, email et nom mis a jour');
} catch (e) {
  ko(`reconnexion echoue : ${e.message}`);
}

console.log('\n  3. le chemin historique (upsert nu sans contexte) echoue — bug de bascule');

try {
  await prisma.user.upsert({
    where: { clerkUserId: 'clerk_auth_test_raw' },
    create: { clerkUserId: 'clerk_auth_test_raw', email: 'raw@auth.test', fullName: 'Sans Contexte' },
    update: { email: 'raw@auth.test' },
  });
  ko('un upsert sans contexte worker a reussi — la politique users_insert_worker ne s applique pas ?');
} catch (e) {
  ok('un upsert sans contexte worker est refuse par la RLS (comportement attendu)');
}

console.log('\n  4. politiques INSERT/UPDATE sur users');

const directInsert = await proprio.query(
  "SELECT count(*)::int n FROM pg_policies WHERE tablename = 'users' AND cmd = 'INSERT' AND policyname = 'users_insert_worker'");
if (Number(directInsert.rows[0].n) === 1) ok('politique INSERT worker presente (users_insert_worker)');
else ko('politique users_insert_worker introuvable');

try {
  // users_update_self (20260923) : id = tracefab_current_user_id().
  await withTracefabUserContext(user1.id, 'first@auth.test', async (tx) => {
    await tx.user.update({ where: { id: user1.id }, data: { fullName: 'Via User Context' } });
  });
  const ligne = (await proprio.query('SELECT full_name FROM users WHERE id = $1', [user1.id])).rows[0];
  assert.equal(ligne.full_name, 'Via User Context');
  ok('UPDATE de soi-meme via tracefab.user_id : possible (users_update_self)');
} catch (e) {
  ko(`UPDATE de soi-meme refuse : ${e.message}`);
}

try {
  await withTracefabUserContext(user1.id, 'first@auth.test', async (tx) => {
    await tx.user.update({ where: { id: U.userB }, data: { fullName: 'Piratage' } });
  });
  const ligne = (await proprio.query('SELECT full_name FROM users WHERE id = $1', [U.userB])).rows[0];
  if (ligne.full_name === 'User B') ok('UPDATE d un autre utilisateur : sans effet (0 ligne), isolation tenue');
  else ko('un utilisateur a pu modifier un autre utilisateur');
} catch (e) {
  ok('UPDATE d un autre utilisateur : rejete par la RLS');
}

console.log('\n  5. isolation entre organisations');

const visible = await withTracefabUserContext(user1.id, 'first@auth.test', async (tx) => {
  return tx.$queryRaw`SELECT id::text FROM organizations`;
});
const visibles = visible.map((r) => r.id);
if (!visibles.includes(U.orgB)) ok('organisation B invisible pour un utilisateur de A (contexte user)');
else ko('organisation B visible depuis un utilisateur de A');

const prodVisible = await withTracefabUserContext(user1.id, 'first@auth.test', async (tx) => {
  return tx.$queryRaw`SELECT count(*)::int AS n FROM tracefab_products WHERE id = ${U.prodB}::uuid`;
});
if (Number(prodVisible[0].n) === 0) ok('produit de l organisation B invisible depuis A');
else ko('produit de l organisation B visible depuis A');

// Et en contexte public, le produit B (non publie) ne sort pas non plus.
const { withTracefabPublicContext } = await import('../api/_lib/context.ts');
const pub = await withTracefabPublicContext(async (tx) => {
  return tx.$queryRaw`SELECT count(*)::int AS n FROM tracefab_products WHERE id = ${U.prodB}::uuid`;
});
if (Number(pub[0].n) === 0) ok('produit B non publie invisible en contexte public');
else ko('produit B non publie visible en contexte public');

/* ------------------------------------------------- resultat */

await CLEAN();
await prisma.$disconnect();
await proprio.end();

if (echecs) {
  console.log(`\n  ${echecs} echec(s).`);
  process.exit(1);
}
console.log('\nProvisionnement et isolation demontres sur le role runtime reel.');
