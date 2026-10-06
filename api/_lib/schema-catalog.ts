import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SchemaField = {
  fieldKey: string;
  label: string;
  dataType: 'text' | 'number' | 'boolean' | 'date' | 'country' | 'percentage' | 'json' | 'document';
  required: boolean;
  evidenceRequired: boolean;
  validationRules: Record<string, unknown>;
};

export type SchemaDefinition = {
  key: string;
  version: string;
  subjectTypes: Array<'product' | 'material' | 'supplier' | 'data_request'>;
  title: string;
  description: string;
  fields: SchemaField[];
};

const CATALOG_ROOT = join(process.cwd(), 'catalog/schemas');
const DATA_TYPES = new Set(['text', 'number', 'boolean', 'date', 'country', 'percentage', 'json', 'document']);
const SUBJECT_TYPES = new Set(['product', 'material', 'supplier', 'data_request']);

function filesUnder(directory: string): string[] {
  if (!statSafe(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.name.endsWith('.json') ? [path] : [];
  });
}

function statSafe(path: string) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function validateSchema(value: unknown, path: string): SchemaDefinition {
  if (!value || typeof value !== 'object') throw new Error(`schema_catalog_invalid:${path}`);
  const schema = value as Partial<SchemaDefinition>;
  if (typeof schema.key !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,159}$/.test(schema.key)) throw new Error(`schema_key_invalid:${path}`);
  if (typeof schema.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(schema.version)) throw new Error(`schema_version_invalid:${path}`);
  if (typeof schema.title !== 'string' || typeof schema.description !== 'string' || !Array.isArray(schema.subjectTypes) || !Array.isArray(schema.fields)) throw new Error(`schema_metadata_invalid:${path}`);
  const subjectTypes = schema.subjectTypes.filter((value): value is SchemaDefinition['subjectTypes'][number] => typeof value === 'string' && SUBJECT_TYPES.has(value));
  if (subjectTypes.length !== schema.subjectTypes.length || subjectTypes.length === 0) throw new Error(`schema_subject_type_invalid:${path}`);
  const fields = schema.fields.map((field) => {
    if (!field || typeof field !== 'object') throw new Error(`schema_field_invalid:${path}`);
    const candidate = field as Partial<SchemaField>;
    if (typeof candidate.fieldKey !== 'string' || !candidate.fieldKey || typeof candidate.label !== 'string' || typeof candidate.dataType !== 'string' || !DATA_TYPES.has(candidate.dataType) || typeof candidate.required !== 'boolean' || typeof candidate.evidenceRequired !== 'boolean') {
      throw new Error(`schema_field_invalid:${path}`);
    }
    return { fieldKey: candidate.fieldKey, label: candidate.label, dataType: candidate.dataType as SchemaField['dataType'], required: candidate.required, evidenceRequired: candidate.evidenceRequired, validationRules: candidate.validationRules && typeof candidate.validationRules === 'object' ? candidate.validationRules as Record<string, unknown> : {} };
  });
  if (fields.length === 0) throw new Error(`schema_fields_empty:${path}`);
  return { key: schema.key, version: schema.version, subjectTypes, title: schema.title, description: schema.description, fields };
}

let cache: SchemaDefinition[] | null = null;

export function listSchemas(): SchemaDefinition[] {
  if (!cache) {
    cache = filesUnder(CATALOG_ROOT).sort().map((path) => validateSchema(JSON.parse(readFileSync(path, 'utf8')), path));
  }
  return cache;
}

export function getSchema(key: unknown, version?: unknown) {
  if (typeof key !== 'string') return null;
  const candidates = listSchemas().filter((schema) => schema.key === key);
  if (typeof version === 'string' && version.trim()) return candidates.find((schema) => schema.version === version.trim()) ?? null;
  return candidates[0] ?? null;
}

export function schemaCatalogSource() {
  return { source: 'versioned_external_catalog', directory: 'catalog/schemas', count: listSchemas().length };
}
