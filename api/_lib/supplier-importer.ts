import { CATALOG_IMPORT_MAX_BYTES } from './catalog-importer.js';

export const SUPPLIER_IMPORT_MAX_ROWS = 500;
export { CATALOG_IMPORT_MAX_BYTES };

export type SupplierImportRow = {
  lineNumber: number;
  email: string;
  legalName: string;
  displayName: string | null;
  countryCode: string | null;
};

export type SupplierImportIssue = {
  line: number;
  field?: string;
  code: string;
  message: string;
};

export type SupplierImportValidation = {
  isValid: boolean;
  headers: string[];
  rows: SupplierImportRow[];
  issues: SupplierImportIssue[];
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
};

function normalizeHeader(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function detectDelimiter(header: string) {
  const candidates = [',', ';', '\t'];
  return candidates.sort((a, b) => header.split(b).length - header.split(a).length)[0];
}

function parseRecords(content: string) {
  const input = content.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(input.split(/\r?\n/, 1)[0] || '');
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim()); cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      cells.push(cell.trim()); cell = '';
      if (cells.some((value) => value)) records.push({ line: startLine, cells });
      cells = []; line += 1; startLine = line;
    } else {
      cell += character;
      if (character === '\n') line += 1;
    }
  }
  if (cell || cells.length) { cells.push(cell.trim()); if (cells.some((value) => value)) records.push({ line: startLine, cells }); }
  return records;
}

function issue(line: number, code: string, message: string, field?: string): SupplierImportIssue {
  return { line, code, message, ...(field ? { field } : {}) };
}

export function validateSupplierCsv(content: string): SupplierImportValidation {
  const records = parseRecords(content);
  if (records.length < 2) return { isValid: false, headers: [], rows: [], issues: [issue(1, 'header_required', 'The CSV must contain a header and at least one supplier row.')], totalRows: 0, acceptedRows: 0, rejectedRows: 0 };
  const aliases: Record<string, string[]> = {
    email: ['email', 'emailaddress', 'contactemail', 'courriel'],
    legalName: ['legalname', 'companyname', 'raison sociale', 'raisonsociale', 'nomlegal'],
    displayName: ['displayname', 'brandname', 'tradingname', 'nomcommercial'],
    countryCode: ['countrycode', 'country', 'pays', 'payscode'],
  };
  const indexes = new Map<string, number>();
  records[0].cells.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const key = Object.entries(aliases).find(([, values]) => values.some((value) => normalizeHeader(value) === normalized))?.[0];
    if (key && !indexes.has(key)) indexes.set(key, index);
  });
  const headers = [...indexes.keys()];
  const issues: SupplierImportIssue[] = [];
  for (const required of ['email', 'legalName']) if (!indexes.has(required)) issues.push(issue(1, 'required_column_missing', `Required column ${required} is missing.`, required));
  const totalRows = records.length - 1;
  if (totalRows > SUPPLIER_IMPORT_MAX_ROWS) issues.push(issue(1, 'row_limit_exceeded', `A supplier import cannot exceed ${SUPPLIER_IMPORT_MAX_ROWS} rows.`));
  if (issues.length) return { isValid: false, headers, rows: [], issues, totalRows, acceptedRows: 0, rejectedRows: totalRows };

  const rows: SupplierImportRow[] = [];
  const seen = new Set<string>();
  for (const record of records.slice(1)) {
    const read = (field: string) => String(record.cells[indexes.get(field) ?? -1] ?? '').trim();
    const email = read('email').toLowerCase();
    const legalName = read('legalName');
    const displayName = read('displayName') || null;
    const countryCodeRaw = read('countryCode');
    const countryCode = countryCodeRaw ? countryCodeRaw.toUpperCase() : null;
    const start = issues.length;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) issues.push(issue(record.line, 'invalid_supplier_email', 'email must be a valid email address.', 'email'));
    if (!legalName || legalName.length > 180) issues.push(issue(record.line, 'invalid_supplier_legal_name', 'legalName is required and must be at most 180 characters.', 'legalName'));
    if (displayName && displayName.length > 180) issues.push(issue(record.line, 'invalid_supplier_display_name', 'displayName must be at most 180 characters.', 'displayName'));
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) issues.push(issue(record.line, 'invalid_country_code', 'countryCode must be ISO 3166-1 alpha-2.', 'countryCode'));
    if (email && seen.has(email)) issues.push(issue(record.line, 'duplicate_email_in_file', 'email is duplicated in this file.', 'email'));
    if (email) seen.add(email);
    if (issues.length === start) rows.push({ lineNumber: record.line, email, legalName, displayName, countryCode });
  }
  return { isValid: issues.length === 0 && rows.length > 0, headers, rows, issues, totalRows, acceptedRows: rows.length, rejectedRows: totalRows - rows.length };
}
