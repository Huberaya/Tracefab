export const CATALOG_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const CATALOG_IMPORT_MAX_ROWS = 10_000;

export type CatalogProductImportRow = {
  lineNumber: number;
  reference: string;
  name: string;
  category: string | null;
  sku: string | null;
  description: string | null;
  productFamily: string | null;
  colorName: string | null;
  sizeRange: string[];
  countryOfDesign: string | null;
  countryOfManufacture: string | null;
  weightGrams: number | null;
  careInstructions: Record<string, unknown>;
};

export type CatalogImportIssue = {
  line: number;
  field?: string;
  code: string;
  message: string;
};

export type CatalogImportValidation = {
  isValid: boolean;
  headers: string[];
  rows: CatalogProductImportRow[];
  issues: CatalogImportIssue[];
  warnings: CatalogImportIssue[];
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
};

const REQUIRED_HEADERS = ['reference', 'name'];
const HEADER_ALIASES: Record<string, string[]> = {
  reference: ['reference', 'ref', 'productreference', 'productref', 'référence'],
  name: ['name', 'productname', 'product', 'nom', 'nomproduit'],
  category: ['category', 'productcategory', 'catégorie', 'categorie'],
  sku: ['sku', 'articlecode', 'stylecode', 'codearticle'],
  description: ['description', 'productdescription', 'descriptionproduit'],
  productFamily: ['productfamily', 'family', 'famille', 'familleproduit'],
  colorName: ['color', 'colorname', 'colour', 'couleur'],
  sizeRange: ['sizerange', 'sizes', 'sizeset', 'tailles', 'taillerange'],
  countryOfDesign: ['countryofdesign', 'designcountry', 'paysconception', 'paysdeconception'],
  countryOfManufacture: ['countryofmanufacture', 'manufacturecountry', 'paysfabrication', 'paysdefabrication'],
  weightGrams: ['weightgrams', 'weightg', 'weight', 'poids', 'poidsg'],
  careInstructions: ['careinstructions', 'care', 'entretien', 'consignesentretien'],
};

function normalizeHeader(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function detectDelimiter(header: string) {
  const counts = [',', ';', '\t'].map((delimiter) => ({ delimiter, count: header.split(delimiter).length }));
  return counts.sort((a, b) => b.count - a.count)[0].count > 1 ? counts.sort((a, b) => b.count - a.count)[0].delimiter : ',';
}

export function parseCsvRecords(content: string) {
  const input = content.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(input.split(/\r?\n/, 1)[0] || '');
  const records: Array<{ lineNumber: number; cells: string[] }> = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let lineNumber = 1;
  let rowStart = 1;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      cell = '';
      if (row.some((value) => value.length > 0)) records.push({ lineNumber: rowStart, cells: row });
      row = [];
      lineNumber += 1;
      rowStart = lineNumber;
    } else {
      cell += character;
      if (character === '\n') lineNumber += 1;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value.length > 0)) records.push({ lineNumber: rowStart, cells: row });
  }
  return { delimiter, records };
}

function issue(line: number, code: string, message: string, field?: string): CatalogImportIssue {
  return { line, code, message, ...(field ? { field } : {}) };
}

function valueAt(cells: string[], indexes: Map<string, number>, field: string) {
  const index = indexes.get(field);
  return index === undefined ? '' : String(cells[index] ?? '').trim();
}

function optionalText(value: string, maxLength: number, line: number, field: string, issues: CatalogImportIssue[]) {
  if (!value) return null;
  if (value.length > maxLength) {
    issues.push(issue(line, 'field_too_long', `${field} exceeds the ${maxLength}-character limit.`, field));
    return null;
  }
  return value;
}

function country(value: string, line: number, field: string, issues: CatalogImportIssue[]) {
  if (!value) return null;
  if (!/^[A-Za-z]{2}$/.test(value)) {
    issues.push(issue(line, 'invalid_country_code', `${field} must be an ISO 3166-1 alpha-2 code.`, field));
    return null;
  }
  return value.toUpperCase();
}

function careInstructions(value: string, line: number, issues: CatalogImportIssue[]) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
    return parsed as Record<string, unknown>;
  } catch {
    issues.push(issue(line, 'invalid_json', 'careInstructions must be a JSON object.', 'careInstructions'));
    return {};
  }
}

export function validateCatalogProductCsv(content: string): CatalogImportValidation {
  const { records } = parseCsvRecords(content);
  const issues: CatalogImportIssue[] = [];
  const warnings: CatalogImportIssue[] = [];
  if (records.length < 2) {
    return { isValid: false, headers: [], rows: [], issues: [issue(1, 'header_required', 'The CSV must contain a header and at least one data row.')], warnings: [], totalRows: 0, acceptedRows: 0, rejectedRows: 0 };
  }

  const rawHeaders = records[0].cells;
  const indexes = new Map<string, number>();
  rawHeaders.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const field = Object.entries(HEADER_ALIASES).find(([, aliases]) => aliases.some((alias) => normalizeHeader(alias) === normalized))?.[0];
    if (field && !indexes.has(field)) indexes.set(field, index);
  });
  const headers = [...indexes.keys()];
  for (const required of REQUIRED_HEADERS) {
    if (!indexes.has(required)) issues.push(issue(1, 'required_column_missing', `Required column ${required} is missing.`, required));
  }
  if (issues.length > 0) return { isValid: false, headers, rows: [], issues, warnings, totalRows: Math.max(0, records.length - 1), acceptedRows: 0, rejectedRows: Math.max(0, records.length - 1) };

  if (records.length - 1 > CATALOG_IMPORT_MAX_ROWS) {
    issues.push(issue(1, 'row_limit_exceeded', `A catalogue import cannot exceed ${CATALOG_IMPORT_MAX_ROWS} rows.`));
    return { isValid: false, headers, rows: [], issues, warnings, totalRows: records.length - 1, acceptedRows: 0, rejectedRows: records.length - 1 };
  }

  const rows: CatalogProductImportRow[] = [];
  const seenReferences = new Set<string>();
  for (const record of records.slice(1)) {
    const line = record.lineNumber;
    const reference = valueAt(record.cells, indexes, 'reference');
    const name = valueAt(record.cells, indexes, 'name');
    const rowIssueStart = issues.length;
    if (!reference) issues.push(issue(line, 'required_value_missing', 'reference is required.', 'reference'));
    if (!name) issues.push(issue(line, 'required_value_missing', 'name is required.', 'name'));
    if (reference.length > 180) issues.push(issue(line, 'field_too_long', 'reference exceeds the 180-character limit.', 'reference'));
    if (name.length > 240) issues.push(issue(line, 'field_too_long', 'name exceeds the 240-character limit.', 'name'));
    const referenceKey = reference.toLocaleLowerCase();
    if (referenceKey && seenReferences.has(referenceKey)) issues.push(issue(line, 'duplicate_reference_in_file', 'reference is duplicated in this file.', 'reference'));
    if (referenceKey) seenReferences.add(referenceKey);

    const rawWeight = valueAt(record.cells, indexes, 'weightGrams');
    let weightGrams: number | null = null;
    if (rawWeight) {
      weightGrams = Number(rawWeight.replace(',', '.'));
      if (!Number.isFinite(weightGrams) || weightGrams < 0 || weightGrams > 1_000_000) {
        issues.push(issue(line, 'invalid_weight', 'weightGrams must be a number between 0 and 1,000,000.', 'weightGrams'));
        weightGrams = null;
      }
    }

    const row: CatalogProductImportRow = {
      lineNumber: line,
      reference,
      name,
      category: optionalText(valueAt(record.cells, indexes, 'category'), 180, line, 'category', issues),
      sku: optionalText(valueAt(record.cells, indexes, 'sku'), 120, line, 'sku', issues),
      description: optionalText(valueAt(record.cells, indexes, 'description'), 10_000, line, 'description', issues),
      productFamily: optionalText(valueAt(record.cells, indexes, 'productFamily'), 180, line, 'productFamily', issues),
      colorName: optionalText(valueAt(record.cells, indexes, 'colorName'), 120, line, 'colorName', issues),
      sizeRange: valueAt(record.cells, indexes, 'sizeRange').split(/[|;]/).map((value) => value.trim()).filter(Boolean).slice(0, 50),
      countryOfDesign: country(valueAt(record.cells, indexes, 'countryOfDesign'), line, 'countryOfDesign', issues),
      countryOfManufacture: country(valueAt(record.cells, indexes, 'countryOfManufacture'), line, 'countryOfManufacture', issues),
      weightGrams,
      careInstructions: careInstructions(valueAt(record.cells, indexes, 'careInstructions'), line, issues),
    };
    if (issues.length === rowIssueStart) rows.push(row);
  }

  const rejectedRows = Math.max(0, records.length - 1 - rows.length);
  return { isValid: issues.length === 0 && rows.length > 0, headers, rows, issues, warnings, totalRows: records.length - 1, acceptedRows: rows.length, rejectedRows };
}

export function csvCell(value: unknown) {
  const serialized = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const text = serialized === undefined ? '' : String(serialized);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CATALOG_EXPORT_HEADERS = [
  'reference', 'name', 'category', 'sku', 'description', 'productFamily', 'colorName', 'sizeRange',
  'countryOfDesign', 'countryOfManufacture', 'weightGrams', 'careInstructions', 'dataReadiness', 'dataCompletion', 'version', 'compositionJson',
];

export function catalogCsvRow(row: Record<string, unknown>) {
  return CATALOG_EXPORT_HEADERS.map((header) => csvCell(row[header])).join(',');
}
