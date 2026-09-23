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

// Templates are immutable, versioned application contracts for now. A future
// admin workflow can promote them to database configuration without changing
// the request/item API because every request stores both key and version.
const TEMPLATES: QuestionnaireTemplate[] = [
  {
    key: 'product-data-core',
    version: '1.0',
    title: 'Product data core',
    description: 'Minimum product, composition and manufacturing data requested from a supplier.',
    items: [
      {
        fieldKey: 'product_description',
        label: 'Product description',
        dataType: 'text',
        required: true,
        evidenceRequired: false,
        helpText: 'Describe the product and its intended use.',
        validationRules: { minLength: 10, maxLength: 2000 },
        evidenceKinds: [],
      },
      {
        fieldKey: 'country_of_manufacture',
        label: 'Country of manufacture',
        dataType: 'country',
        required: true,
        evidenceRequired: false,
        helpText: 'Use the ISO 3166-1 alpha-2 country code.',
        validationRules: {},
        evidenceKinds: [],
      },
      {
        fieldKey: 'main_material_percentage',
        label: 'Main material percentage',
        dataType: 'percentage',
        required: true,
        evidenceRequired: true,
        helpText: 'Percentage by mass of the main material.',
        validationRules: { min: 0, max: 100 },
        evidenceKinds: ['technical_spec', 'certificate'],
      },
      {
        fieldKey: 'material_composition',
        label: 'Material composition',
        dataType: 'json',
        required: true,
        evidenceRequired: true,
        helpText: 'Provide an array of materials and their percentages.',
        validationRules: { jsonShape: 'material_composition' },
        evidenceKinds: ['technical_spec'],
      },
      {
        fieldKey: 'manufacturing_site_name',
        label: 'Manufacturing site name',
        dataType: 'text',
        required: false,
        evidenceRequired: false,
        helpText: null,
        validationRules: { maxLength: 240 },
        evidenceKinds: [],
      },
    ],
  },
];

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
