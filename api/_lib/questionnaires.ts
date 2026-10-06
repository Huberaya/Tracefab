import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';

export type QuestionnaireItem = {
  fieldKey: string;
  label: string;
  dataType: 'text' | 'number' | 'boolean' | 'date' | 'country' | 'percentage' | 'json' | 'document';
  required: boolean;
  evidenceRequired: boolean;
  helpText: string | null;
  validationRules: Record<string, unknown>;
  evidenceKinds: string[];
};

export type QuestionnaireTemplate = {
  key: string;
  version: string;
  title: string;
  description: string;
  items: QuestionnaireItem[];
};

// Questionnaire definitions are externalized versioned catalog files. The API
// stores the key and version on each request, so catalog evolution never
// changes the meaning of an existing request.
const CATALOG_PATH = join(process.cwd(), 'catalog/questionnaires/product-data-core/1.0.json');

function loadCatalog(): QuestionnaireTemplate[] {
  const parsed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as QuestionnaireTemplate;
  if (!parsed.key || !parsed.version || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('questionnaire_catalog_invalid');
  }
  for (const item of parsed.items) {
    if (!item.fieldKey || !item.label || !item.dataType || typeof item.required !== 'boolean' || typeof item.evidenceRequired !== 'boolean') {
      throw new Error('questionnaire_catalog_item_invalid');
    }
  }
  return [parsed];
}

const TEMPLATES = loadCatalog();

export function questionnaireCatalogSource() {
  return { source: 'versioned_external_catalog', files: ['catalog/questionnaires/product-data-core/1.0.json'] };
}

export function listQuestionnaires() {
  return TEMPLATES.map(({ key, version, title, description, items }) => ({
    key,
    version,
    title,
    description,
    itemCount: items.length,
    requiredItemCount: items.filter((item) => item.required).length,
  }));
}

export function getQuestionnaire(key: unknown, version?: unknown) {
  if (typeof key !== 'string') return null;
  const candidates = TEMPLATES.filter((template) => template.key === key);
  if (typeof version === 'string' && version.trim()) {
    return candidates.find((template) => template.version === version.trim()) ?? null;
  }
  return candidates[0] ?? null;
}

export function questionnaireItemRows(template: QuestionnaireTemplate) {
  return template.items.map((item) => ({
    fieldKey: item.fieldKey,
    label: item.label,
    dataType: item.dataType,
    required: item.required,
    evidenceRequired: item.evidenceRequired,
    helpText: item.helpText,
    validationRules: item.validationRules,
    evidenceKinds: item.evidenceKinds,
  }));
}

type ResponseItem = {
  data_type?: Prisma.data_request_itemsGetPayload<{ select: { data_type: true } }>['data_type'];
  dataType?: QuestionnaireItem['dataType'];
  validation_rules?: unknown;
  validationRules?: unknown;
};

export function validateResponseValue(item: ResponseItem, value: unknown): string | null {
  if (value === null || value === undefined) return 'response_value_required';
  const dataType = item.data_type ?? item.dataType;
  const validationRules = item.validation_rules ?? item.validationRules;

  switch (dataType) {
    case 'text':
      if (typeof value !== 'string') return 'response_value_type_invalid';
      break;
    case 'number':
    case 'percentage':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'response_value_type_invalid';
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return 'response_value_type_invalid';
      break;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        return 'response_value_type_invalid';
      }
      break;
    case 'country':
      if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return 'response_value_type_invalid';
      break;
    case 'json':
    case 'document':
      if (typeof value !== 'object' || value === null) return 'response_value_type_invalid';
      break;
    default:
      return 'response_value_type_invalid';
  }

  const rules = validationRules && typeof validationRules === 'object'
    ? validationRules as Record<string, unknown>
    : {};
  if (typeof rules.min === 'number' && typeof value === 'number' && value < rules.min) return 'response_value_below_minimum';
  if (typeof rules.max === 'number' && typeof value === 'number' && value > rules.max) return 'response_value_above_maximum';
  if (typeof rules.minLength === 'number' && typeof value === 'string' && value.length < rules.minLength) return 'response_value_too_short';
  if (typeof rules.maxLength === 'number' && typeof value === 'string' && value.length > rules.maxLength) return 'response_value_too_long';
  if (Array.isArray(rules.enum) && !rules.enum.includes(value)) return 'response_value_not_allowed';
  if (rules.jsonShape === 'material_composition' && !isMaterialComposition(value)) return 'response_value_shape_invalid';

  return null;
}

function isMaterialComposition(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Record<string, unknown>;
      return typeof row.materialKey === 'string'
        && typeof row.percentage === 'number'
        && Number.isFinite(row.percentage)
        && row.percentage >= 0
        && row.percentage <= 100;
    });
}
