import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSchema, listSchemas, schemaCatalogSource } from '../../_lib/schema-catalog.js';
import type { SchemaDefinition } from '../../_lib/schema-catalog.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

const SUBJECT_TYPES = new Set<SchemaDefinition['subjectTypes'][number]>(['product', 'material', 'supplier', 'data_request']);

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const key = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
  const version = Array.isArray(req.query.version) ? req.query.version[0] : req.query.version;
  const subjectType = Array.isArray(req.query.subjectType) ? req.query.subjectType[0] : req.query.subjectType;
  if (subjectType && (typeof subjectType !== 'string' || !SUBJECT_TYPES.has(subjectType as SchemaDefinition['subjectTypes'][number]))) {
    return json(res, 400, { error: 'invalid_schema_subject_type' });
  }
  const normalizedSubjectType = subjectType as SchemaDefinition['subjectTypes'][number] | undefined;
  if (key) {
    const schema = getSchema(key, version);
    if (!schema || (normalizedSubjectType && !schema.subjectTypes.includes(normalizedSubjectType))) return json(res, 404, { error: 'schema_not_found' });
    return json(res, 200, { source: schemaCatalogSource(), schema });
  }
  const schemas = listSchemas().filter((schema) => !normalizedSubjectType || schema.subjectTypes.includes(normalizedSubjectType));
  return json(res, 200, { source: schemaCatalogSource(), schemas });
}
