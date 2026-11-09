#!/usr/bin/env node
/**
 * P0 Isolation A/B — preuve P11 avec le véritable rôle tracefab_app.
 * Deux organisations existantes et indépendantes ; lecture seule, transaction annulée.
 * Les jetons HMAC sont signés en mémoire et ne sont jamais journalisés.
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
  material: '991e472a-74e6-4044-bf88-479dba3c22fe',
  node: '8d8cbf3e-4494-41dd-87c3-ae15586e1f77',
  link: 'b5c9a17e-863a-415e-9031-3ec357230e6e',
};
const B = {
  org: '443b2ae8-6750-4c4d-ae14-09e0af6d09a0',
  user: '833d4bf6-342e-44f4-bc4e-076f77fbad7a',
  product: 'ccea0dc3-7906-4ed0-9060-4eaca7d0bb7a',
  material: 'b1306d7c-64eb-4f6f-af8f-8035557fc2fe',
  node: 'e208ec23-c2ef-497b-9ab4-df8acb139f4d',
  link: '9d7b8013-0072-4efb-a82e-1ecec4d72b18',
  dataPoint: '445e50e6-147c-45b2-b093-f0e50f75b87e',
};
function signedToken(identity) {
  const body = `v1|${identity.user}|${identity.org}|tracefab_identity|${Math.floor(Date.now() / 1000) + 60}`;
  return `${body}.${createHmac('sha256', Buffer.from(key, 'hex')).update(body).digest('hex')}`;
}
const tokenA = signedToken(A);
const tokenB = signedToken(B);
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
async function context(identity, token, forgedUser = identity.user) {
  await client.query("SELECT set_config('tracefab.active_organization_id', $1, true)", [identity.org]);
  await client.query("SELECT set_config('tracefab.user_id', $1, true)", [forgedUser]);
  await client.query("SELECT set_config('tracefab.identity', $1, true)", [token]);
}
async function visible(table, id) {
  return (await client.query(`SELECT id FROM public.${table} WHERE id=$1::uuid`, [id])).rowCount;
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

  await context(A, tokenA, B.user);
  const effectiveA = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  check(effectiveA === A.user, 'identité A authentifiée par HMAC malgré le GUC user_id falsifié vers B');

  const access = (await client.query(
    'SELECT tracefab_can_access_org($1::uuid) AS a, tracefab_can_access_org($2::uuid) AS b',
    [A.org, B.org])).rows[0];
  check(access.a === true && access.b === false,
    'fonction SECURITY DEFINER : A autorisé, B refusé', JSON.stringify(access));

  const aRows = {
    org: await visible('organizations', A.org),
    product: await visible('tracefab_products', A.product),
    material: await visible('materials', A.material),
    node: await visible('supply_chain_nodes', A.node),
    link: await visible('supply_chain_links', A.link),
  };
  const bRows = {
    org: await visible('organizations', B.org),
    product: await visible('tracefab_products', B.product),
    material: await visible('materials', B.material),
    node: await visible('supply_chain_nodes', B.node),
    link: await visible('supply_chain_links', B.link),
    dataPoint: await visible('data_points', B.dataPoint),
  };
  check(Object.values(aRows).every(n => n === 1) && Object.values(bRows).every(n => n === 0),
    'RLS sous A : accès positif A et refus négatif B sur organisations, produits, matières, nœuds et liens',
    `A=${JSON.stringify(aRows)} B=${JSON.stringify(bRows)}`);

  await context(B, tokenB);
  const effectiveB = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  const bRowsPositive = {
    org: await visible('organizations', B.org),
    product: await visible('tracefab_products', B.product),
    material: await visible('materials', B.material),
    node: await visible('supply_chain_nodes', B.node),
    link: await visible('supply_chain_links', B.link),
    dataPoint: await visible('data_points', B.dataPoint),
  };
  const aRowsNegative = {
    org: await visible('organizations', A.org),
    product: await visible('tracefab_products', A.product),
    material: await visible('materials', A.material),
    node: await visible('supply_chain_nodes', A.node),
    link: await visible('supply_chain_links', A.link),
  };
  check(effectiveB === B.user && Object.values(bRowsPositive).every(n => n === 1)
    && Object.values(aRowsNegative).every(n => n === 0),
    'RLS sous B : accès positif B et refus négatif A, y compris data_points',
    `B=${JSON.stringify(bRowsPositive)} A=${JSON.stringify(aRowsNegative)}`);

  await context(B, tokenA);
  const rebound = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  check(rebound === null && await visible('tracefab_products', B.product) === 0,
    'jeton A réutilisé sous contexte B : identité refusée et aucune ligne B visible');

  await context(A, '');
  const forged = (await client.query('SELECT tracefab_current_user_id() AS user_id')).rows[0]?.user_id;
  check(forged === null, 'GUC user_id forgé sans jeton : identité refusée en mode strict');

  const acl = (await client.query(`
    SELECT has_table_privilege(current_user,'public.tracefab_products','SELECT') AS s,
           has_table_privilege(current_user,'public.tracefab_products','INSERT') AS i,
           has_table_privilege(current_user,'public.tracefab_products','UPDATE') AS u,
           has_table_privilege(current_user,'public.tracefab_products','DELETE') AS d
  `)).rows[0];
  check(acl.s === true && acl.i === false && acl.u === false && acl.d === false,
    'ACL produit : SELECT autorisé, DML direct non accordé', JSON.stringify(acl));

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
