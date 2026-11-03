import { randomBytes } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { cronAuthorized, cronSecretConfigured } from '../../_lib/worker-auth.js';
import { prisma } from '../../_lib/prisma.js';
import { etatCleIdentite } from '../../_lib/identite-jeton.js';

type IdentityRow = {
  role_courant: string;
  role_session: string;
  base: string;
  version: string;
  version_num: number;
  pid: number;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
};
type MembershipRow = {
  role_atteint: string;
  profondeur: number;
  privilegie: boolean;
  peut_prendre: boolean;
  herite: boolean;
};
type ValueRow = { value: string | null };
type PidRow = { pid: number };

function sqlState(error: unknown): string | null {
  const e = error as { code?: unknown; meta?: { code?: unknown }; cause?: { code?: unknown }; message?: unknown };
  for (const candidate of [e?.meta?.code, e?.cause?.code, e?.code]) {
    if (typeof candidate === 'string' && /^[0-5][0-9A-Z]{4}$/.test(candidate)) return candidate;
  }
  const match = String(e?.message ?? '').match(/\b([0-5][0-9A-Z]{4})\b/);
  return match?.[1] ?? null;
}

function erreurCodeOnly(error: unknown) {
  return sqlState(error) ?? 'ERREUR_TECHNIQUE';
}

/**
 * P10.7 one-shot Production proof.
 *
 * Invoked only by Vercel Cron, whose Authorization: Bearer CRON_SECRET header
 * is verified server-side. All measurements use the shared Prisma client,
 * exactly as application routes do. Every database transaction is rolled back
 * where it performs the read-only write-refusal witness. No secret or URL is
 * returned or logged. This route and its temporary cron are removed by
 * restoring the original Production deployment after collecting evidence.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!cronSecretConfigured()) return json(res, 503, { error: 'cron_not_configured' });
  if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  const roleExpected = 'tracefab_app';
  const table = `tracefab_p107_ro_${randomBytes(4).toString('hex')}`;
  const measured = {
    identity: null as IdentityRow | null,
    memberships: [] as MembershipRow[],
    contextVisible: false,
    writeSqlState: null as string | null,
  };
  let transactionError: string | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      // Must be the first statement in this transaction.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

      const identityRows = await tx.$queryRawUnsafe<IdentityRow[]>(`
        SELECT current_user AS role_courant,
               session_user AS role_session,
               current_database() AS base,
               pg_catalog.version() AS version,
               current_setting('server_version_num')::int AS version_num,
               pg_catalog.pg_backend_pid() AS pid,
               (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superuser,
               (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypassrls,
               (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) AS createrole,
               (SELECT rolcreatedb FROM pg_catalog.pg_roles WHERE rolname = current_user) AS createdb
      `);
      measured.identity = identityRows[0] ?? null;

      measured.memberships = await tx.$queryRawUnsafe<MembershipRow[]>(`
        WITH RECURSIVE atteignables(oid, profondeur) AS (
          SELECT r.oid, 0 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
          UNION
          SELECT m.roleid, a.profondeur + 1
            FROM atteignables a
            JOIN pg_catalog.pg_auth_members m ON m.member = a.oid
           WHERE a.profondeur < 8
        )
        SELECT r.rolname AS role_atteint,
               min(a.profondeur)::int AS profondeur,
               bool_or(r.rolsuper OR r.rolbypassrls) AS privilegie,
               pg_catalog.pg_has_role(current_user, r.oid, 'SET') AS peut_prendre,
               pg_catalog.pg_has_role(current_user, r.oid, 'USAGE') AS herite
          FROM atteignables a
          JOIN pg_catalog.pg_roles r ON r.oid = a.oid
         WHERE a.profondeur > 0
         GROUP BY r.rolname, r.oid
         ORDER BY 2, 1
      `);

      await tx.$queryRawUnsafe(`SELECT pg_catalog.set_config('tracefab.p107_portee', 'pose', true)`);
      const pendant = await tx.$queryRawUnsafe<ValueRow[]>(
        `SELECT current_setting('tracefab.p107_portee', true) AS value`,
      );
      measured.contextVisible = pendant[0]?.value === 'pose';

      await tx.$executeRawUnsafe('SAVEPOINT p107_write_probe');
      try {
        await tx.$executeRawUnsafe(`CREATE TABLE public.${table} (x integer)`);
        measured.writeSqlState = 'ECRITURE_ACCEPTEE';
        await tx.$executeRawUnsafe(`DROP TABLE public.${table}`);
      } catch (error) {
        measured.writeSqlState = sqlState(error) ?? 'ERREUR_TECHNIQUE';
      }
      // Recover the transaction after SQLSTATE 25006 and guarantee that even
      // an unexpectedly accepted CREATE is rolled back before commit.
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT p107_write_probe');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT p107_write_probe');
    });
  } catch (error) {
    transactionError = erreurCodeOnly(error);
  }

  let contextAfter: string | null = null;
  let contextAfterError: string | null = null;
  try {
    const apres = await prisma.$queryRawUnsafe<ValueRow[]>(
      `SELECT current_setting('tracefab.p107_portee', true) AS value`,
    );
    contextAfter = apres[0]?.value ?? null;
  } catch (error) {
    contextAfterError = erreurCodeOnly(error);
  }

  const pids: number[] = [];
  let poolerError: string | null = null;
  try {
    for (let i = 0; i < 3; i += 1) {
      const pid = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<PidRow[]>(
          'SELECT pg_catalog.pg_backend_pid() AS pid',
        );
        return rows[0]?.pid;
      });
      if (typeof pid === 'number') pids.push(pid);
    }
  } catch (error) {
    poolerError = erreurCodeOnly(error);
  }

  const identity = measured.identity;
  const memberships = measured.memberships;
  const contextVisible = measured.contextVisible;
  const writeSqlState = measured.writeSqlState;
  const privileged = memberships.filter((m) => m.privilegie);
  const canTakePrivileged = privileged.some((m) => m.peut_prendre);
  const contextAbsentAfter = contextAfter === null || contextAfter === '';
  const identityKey = etatCleIdentite();
  const stops: string[] = [];

  if (!identity) stops.push('identité runtime non mesurée');
  if (identity && identity.role_courant !== roleExpected) stops.push(`current_user différent du rôle attendu (${identity.role_courant})`);
  if (identity && identity.role_session !== roleExpected) stops.push(`session_user différent du rôle attendu (${identity.role_session})`);
  if (identity?.superuser !== false) stops.push('SUPERUSER présent ou non mesuré');
  if (identity?.bypassrls !== false) stops.push('BYPASSRLS présent ou non mesuré');
  if (identity?.createrole !== false) stops.push('CREATEROLE présent ou non mesuré');
  if (identity?.createdb !== false) stops.push('CREATEDB présent ou non mesuré');
  if (canTakePrivileged) stops.push('capacité effective SET ROLE vers un rôle privilégié');
  if (writeSqlState !== '25006') stops.push(`lecture seule non prouvée (résultat ${writeSqlState ?? 'non exécuté'})`);
  if (!contextVisible) stops.push('contexte transactionnel non visible dans sa transaction');
  if (!contextAbsentAfter) stops.push('contexte transactionnel encore visible après la transaction');
  if (transactionError) stops.push(`transaction de mesure en erreur (${transactionError})`);
  if (contextAfterError) stops.push(`contrôle du contexte après transaction en erreur (${contextAfterError})`);
  if (poolerError || pids.length !== 3) stops.push(`mode du pooler non mesuré (${poolerError ?? 'transactions incomplètes'})`);
  if (identityKey === 'invalide') stops.push('TRACEFAB_IDENTITY_KEY présente mais malformée');

  const proof = {
    schema: 'tracefab-p107-runtime-proof-v2',
    measuredAt: new Date().toISOString(),
    roleExpected,
    identity: identity ? {
      currentUser: identity.role_courant,
      sessionUser: identity.role_session,
      database: identity.base,
      postgresVersion: identity.version,
      postgresVersionNum: identity.version_num,
      backendPid: identity.pid,
      attributes: {
        superuser: identity.superuser,
        bypassRls: identity.bypassrls,
        createRole: identity.createrole,
        createDb: identity.createdb,
      },
    } : null,
    memberships: memberships.map((m) => ({
      role: m.role_atteint,
      depth: m.profondeur,
      privileged: m.privilegie,
      canSetRole: m.peut_prendre,
      inheritsPrivileges: m.herite,
    })),
    privilegedRolesReachable: privileged.map((m) => m.role_atteint),
    canEscalateToPrivilegedRole: canTakePrivileged,
    pooler: {
      mode: pids.length === 3 ? (new Set(pids).size > 1 ? 'transaction_pooling' : 'session_or_direct') : 'not_measured',
      backendCount: new Set(pids).size,
      transactions: pids.length,
      error: poolerError,
    },
    transactionalContext: {
      visibleInsideTransaction: contextVisible,
      absentAfterTransaction: contextAbsentAfter,
      error: contextAfterError,
    },
    readOnly: { sqlState: writeSqlState, proven: writeSqlState === '25006' },
    identityKeyState: identityKey,
    transactionError,
    stops,
    verdict: stops.length === 0 ? 'IDENTITE_CONFORME' : 'ARRET',
  };

  // Log only the proof object. It contains no connection string, password, or key.
  console.info(JSON.stringify(proof));
  res.setHeader('Cache-Control', 'no-store');
  return json(res, proof.verdict === 'IDENTITE_CONFORME' ? 200 : 409, proof);
}
