/**
 * Robust CSV parser and serializer supporting comma and semicolon delimiters,
 * quoted fields with embedded commas/newlines, and header normalization.
 */

export function parseCsvRows(csvText: string): Array<Record<string, string>> {
  const clean = csvText.replace(/^\uFEFF/, '').trim(); // Remove UTF-8 BOM if present
  if (!clean) return [];

  // Determine delimiter: detect if first line contains more semicolons than commas
  const firstLine = clean.split(/\r?\n/)[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const nextChar = clean[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === delimiter && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++; // skip CRLF
      }
      currentRow.push(currentField.trim());
      currentField = '';
      if (currentRow.some((f) => f.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) {
      rows.push(currentRow);
    }
  }

  if (rows.length < 2) return [];

  const rawHeaders = rows[0];
  const normalizedHeaders = rawHeaders.map((h) => normalizeHeaderKey(h));

  const result: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const record: Record<string, string> = {};
    for (let c = 0; c < normalizedHeaders.length; c++) {
      const header = normalizedHeaders[c];
      if (header) {
        const val = row[c] || '';
        record[header] = val;
        // Also provide camelCase version for TypeScript friendliness
        const camel = header.replace(/_([a-z0-9])/g, (_, g) => g.toUpperCase());
        record[camel] = val;
      }
    }
    result.push(record);
  }

  return result;
}

export function normalizeHeaderKey(header: string): string {
  return header
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents (ex: référence -> reference)
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export const parseCsv = parseCsvRows;

export function formatCsv(headers: Array<{ key: string; label: string }>, rows: Array<Record<string, any>>): string {
  const escapeCell = (val: any) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerLine = headers.map((h) => escapeCell(h.label)).join(',');
  const lines = [headerLine];

  for (const row of rows) {
    const line = headers.map((h) => escapeCell(row[h.key])).join(',');
    lines.push(line);
  }

  return lines.join('\n');
}

export function toCsv(
  rowsOrHeaders: any,
  headersOrRows?: any
): string {
  if (Array.isArray(rowsOrHeaders) && Array.isArray(headersOrRows)) {
    if (typeof rowsOrHeaders[0]?.key === 'string') {
      return formatCsv(rowsOrHeaders, headersOrRows);
    }
    return formatCsv(headersOrRows, rowsOrHeaders);
  }
  return '';
}
