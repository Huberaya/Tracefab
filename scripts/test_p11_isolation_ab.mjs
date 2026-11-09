#!/usr/bin/env node
/**
 * P0 Isolation A/B — preuve P11 avec le véritable rôle tracefab_app.
 * Lecture et contrôles ACL uniquement ; transaction systématiquement annulée.
 * Le jeton est signé en mémoire avec la clé Preview, jamais journalisé.
 */
import { createHmac } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const key = process.env.TRACEFAB_IDENTITY_KEY?.trim();
if (!url || !key || key.length < 64 || key.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(key)) {
  console.error('P11_ISOLATION_AB=NOT_RUN — configuration DB/HMAC absente ou invalide');
  process.exit(2);
}

const A = {
  org: 'dc90cd7a-ee4a-4a3c-adae-5d96f2a48780',
  user: '5f861438-383e-470f-bb7d-a1c359f77713',
  product: '3c121743-a6e0-4df4-a65a-0de6a683d398',
};
const B = {
  org: '586d989b-5b4f-40bd-b762-6b48b93f98b0',
  user: '06500096-6674-4a9d-aa07-9b521945bab2',
  product: '48638653-946e-4c77-a29f-69712ac060db',
};
const now = Math.floor(Date.now() / 1000);
const body = `v1|${A.user}|${A.org}|tracefab_identity|${now + 60}`;
const tokenA = `${body}.${createHmac('sha256', Buffer.from(key, 'hex')).update(body).digest('hex')}`;
const client = new pg.Client({
  connectionString: url,
  ssl: /sslmode=(require|verify-full|verify-ca)/i.test(url) ? { rejectUnauthorized: true } : false,
  application_name: 'tracefab-p0-isolation-ab-proof',
});
let assertions = 0;
let failures = 0;
function check(ok, label, detail = '') {
  assertions += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
try {
  await client.connect();
  await client.query('BEGIN');
  const role = (await client.query(`
    SELECT current_user AS role,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass
  `)).rows[0];
  check(role.role === 'tracefab_app' && role.bypass === false,
    'connexion sous le véritable rôle tracefab_app, NOBYPASSRLS', JSON.stringify(role));

  const strict = (await client.query('SELECT strict FROM tracefab_identity_politique WHERE singleton')).rows[0]?.strict;
  check(strict === true, 'politique HMAC strict activée');

  await client.query("SELECT set_config('tracefab.active_organization_id', $1, true)", [A.org]);
  // GUC volontairement falsifié vers B : l'identité signée doit prévaloir.
  await client.query("SELECT set_config('tracefab.user_id', $1, true)", [B.user]);
  await client.query("SELECT set_config('tracefab.identity', $1, true)", [tokenA]);
  const effective = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  check(effective === A.user, 'identité A authentifiée par HMAC malgré le GUC user_id falsifié');

  const access = (await client.query(
    'SELECT tracefab_can_access_org($1::uuid) AS a, tracefab_can_access_org($2::uuid) AS b',
    [A.org, B.org])).rows[0];
  check(access.a === true && access.b === false,
    'fonction SECURITY DEFINER : A autorisé, B refusé', JSON.stringify(access));

  const ownOrg = await client.query('SELECT id FROM organizations WHERE id=$1::uuid', [A.org]);
  const foreignOrg = await client.query('SELECT id FROM organizations WHERE id=$1::uuid', [B.org]);
  check(ownOrg.rowCount === 1 && foreignOrg.rowCount === 0,
    'RLS organizations : lecture positive A et absence de visibilité B',
    `A=${ownOrg.rowCount}, B=${foreignOrg.rowCount}`);

  const ownProduct = await client.query('SELECT id FROM tracefab_products WHERE id=$1::uuid', [A.product]);
  const foreignProduct = await client.query('SELECT id FROM tracefab_products WHERE id=$1::uuid', [B.product]);
  check(ownProduct.rowCount === 1 && foreignProduct.rowCount === 0,
    'RLS tracefab_products : produit A visible, produit B invisible',
    `A=${ownProduct.rowCount}, B=${foreignProduct.rowCount}`);

  const acl = (await client.query(`
    SELECT has_table_privilege(current_user,'public.tracefab_products','SELECT') AS s,
           has_table_privilege(current_user,'public.tracefab_products','INSERT') AS i,
           has_table_privilege(current_user,'public.tracefab_products','UPDATE') AS u,
           has_table_privilege(current_user,'public.tracefab_products','DELETE') AS d
  `)).rows[0];
  check(acl.s === true && acl.i === false && acl.u === false && acl.d === false,
    'ACL produit : SELECT autorisé, DML direct non accordé', JSON.stringify(acl));

  await client.query("SELECT set_config('tracefab.active_organization_id', $1, true)", [B.org]);
  const rebound = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  const reboundRows = await client.query('SELECT id FROM tracefab_products WHERE id=$1::uuid', [B.product]);
  check(rebound === null && reboundRows.rowCount === 0,
    'jeton A réutilisé sous contexte B : identité refusée et aucune ligne B visible');

  await client.query("SELECT set_config('tracefab.identity', '', true)");
  await client.query("SELECT set_config('tracefab.user_id', $1, true)", [B.user]);
  const forged = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  check(forged === null, 'GUC forgé sans jeton : identité refusée en mode strict');

  await client.query('ROLLBACK');
  console.log(`P11_ISOLATION_AB=${assertions - failures}/${assertions}`);
  if (failures) process.exitCode = 1;
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('P11_ISOLATION_AB=ERROR —', String(error?.message || error).split('\n')[0]);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
