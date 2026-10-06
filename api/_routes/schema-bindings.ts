import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth.js';
import { withTracefabUserContext } from '../_lib/context.js';
import { isUuid } from '../_lib/data-requests.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { getSchema } from '../_lib/schema-catalog.js';
import { sqlBusinessError } from '../_lib/sql-errors.js';

type SubjectType = 'product' | 'material' | 'supplier' | 'data_request';
type SchemaBinding = {
  id: string;
  schemaKey: string;
  schemaVersion: string;
  subjectType: SubjectType;
  subjectId: string;
  boundBy: string | null;
  createdAt: Date;
};
type BindingBody = { schemaKey?: string; schemaVersion?: string; subjectType?: string; subjectId?: string };

const SUBJECT_TYPES = new Set<SubjectType>(['product', 'material', 'supplier', 'data_request']);

function queryValue(req: VercelRequest, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

function subjectType(value: unknown): SubjectType {
  if (typeof value !== 'string' || !SUBJECT_TYPES.has(value as SubjectType)) throw new Error('invalid_schema_subject_type');
  return value as SubjectType;
}

function serializeBinding(row: SchemaBinding) {
  return {
    id: row.id,
    schemaKey: row.schemaKey,
    schemaVersion: row.schemaVersion,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    boundBy: row.boundBy,
    createdAt: row.createdAt,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const { user } = await requireClerkUser(req);
    if (req.method === 'GET') {
      const type = subjectType(queryValue(req, 'subjectType'));
      const id = queryValue(req, 'subjectId');
      if (!isUuid(id)) return json(res, 400, { error: 'invalid_schema_subject_id' });
      const subjectClause = type === 'product'
        ? Prisma.sql`product_id = ${id}::uuid`
        : type === 'material'
          ? Prisma.sql`material_id = ${id}::uuid`
          : type === 'supplier'
            ? Prisma.sql`supplier_id = ${id}::uuid`
            : Prisma.sql`data_request_id = ${id}::uuid`;
      const bindings = await withTracefabUserContext(user.id, user.email, async (tx) => tx.$queryRaw<SchemaBinding[]>`
        SELECT id, schema_key AS "schemaKey", schema_version AS "schemaVersion",
          CASE WHEN product_id IS NOT NULL THEN 'product'
               WHEN material_id IS NOT NULL THEN 'material'
               WHEN supplier_id IS NOT NULL THEN 'supplier'
               ELSE 'data_request' END AS "subjectType",
          COALESCE(product_id, material_id, supplier_id, data_request_id) AS "subjectId",
          bound_by AS "boundBy", created_at AS "createdAt"
        FROM tracefab_schema_bindings
        WHERE ${subjectClause}
        ORDER BY created_at DESC
      `);
      return bindings.map(serializeBinding);
    }

    const body = await readJsonBody<BindingBody>(req);
    const schemaKey = typeof body.schemaKey === 'string' ? body.schemaKey.trim() : '';
    const schemaVersion = typeof body.schemaVersion === 'string' ? body.schemaVersion.trim() : '';
    const type = subjectType(body.subjectType);
    if (!schemaKey || !schemaVersion) return json(res, 400, { error: 'invalid_schema_identity' });
    if (!isUuid(body.subjectId)) return json(res, 400, { error: 'invalid_schema_subject_id' });
    const schema = getSchema(schemaKey, schemaVersion);
    if (!schema || !schema.subjectTypes.includes(type)) return json(res, 400, { error: 'schema_not_allowed_for_subject' });

    const binding = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<SchemaBinding[]>`
        SELECT id, schema_key AS "schemaKey", schema_version AS "schemaVersion",
          CASE WHEN product_id IS NOT NULL THEN 'product'
               WHEN material_id IS NOT NULL THEN 'material'
               WHEN supplier_id IS NOT NULL THEN 'supplier'
               ELSE 'data_request' END AS "subjectType",
          COALESCE(product_id, material_id, supplier_id, data_request_id) AS "subjectId",
          bound_by AS "boundBy", created_at AS "createdAt"
        FROM tracefab_bind_schema(${schemaKey}, ${schemaVersion}, ${type}, ${body.subjectId}::uuid)
      `;
      return rows[0] ?? null;
    });
    if (!binding) throw new Error('schema_binding_failed');
    return json(res, 201, { binding: serializeBinding(binding) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/schema-bindings failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
