export interface BomImportRow {
  lineNumber: number;
  materialName: string;
  materialType: 'fiber' | 'yarn' | 'fabric' | 'trim' | 'packaging' | 'other';
  percentage: number;
  originCountry: string;
  recycledPercentage?: number;
  certificationStandard?: string;
  certificationNumber?: string;
  supplierLotNumber?: string;
  tier?: 'Tier 1' | 'Tier 2' | 'Tier 3' | 'Tier 4';
}

export interface BomValidationResult {
  isValid: boolean;
  totalPercentage: number;
  rowsCount: number;
  parsedRows: BomImportRow[];
  errors: Array<{ line: number; message: string }>;
  warnings: Array<{ line: number; message: string }>;
  detectedStandards: string[];
}

/**
 * Universal Parser for Supplier CSV / TSV / Excel-text Bill of Materials & Lot declarations.
 * Handles diverse delimiters (; or , or \t) and multi-language headers (FR/EN/PT).
 */
export function parseSupplierBomCsv(csvContent: string): BomValidationResult {
  const lines = csvContent
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  if (lines.length < 2) {
    return {
      isValid: false,
      totalPercentage: 0,
      rowsCount: 0,
      parsedRows: [],
      errors: [{ line: 1, message: 'File is empty or missing data rows.' }],
      warnings: [],
      detectedStandards: [],
    };
  }

  // Detect delimiter
  const firstLine = lines[0];
  const delimiter = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';

  // Normalize header keys
  const headers = firstLine.split(delimiter).map(h => h.trim().toLowerCase().replace(/['"]/g, ''));

  const findColIndex = (candidates: string[]): number => {
    return headers.findIndex(h => candidates.some(c => h.includes(c)));
  };

  const nameIdx = findColIndex(['nom', 'material', 'matiere', 'composant', 'name', 'item']);
  const typeIdx = findColIndex(['type', 'categorie', 'category', 'role']);
  const pctIdx = findColIndex(['pourcentage', 'percentage', 'pct', '%', 'ratio', 'share']);
  const countryIdx = findColIndex(['pays', 'country', 'origin', 'origine']);
  const certIdx = findColIndex(['certif', 'standard', 'label', 'norme']);
  const certNumIdx = findColIndex(['licence', 'license', 'cert_num', 'numero', 'number']);
  const lotIdx = findColIndex(['lot', 'batch', 'serial']);
  const tierIdx = findColIndex(['tier', 'echelon', 'niveau']);

  if (nameIdx === -1 || pctIdx === -1) {
    return {
      isValid: false,
      totalPercentage: 0,
      rowsCount: 0,
      parsedRows: [],
      errors: [{ line: 1, message: 'Mandatory columns missing. File must include at least Material Name and Percentage (%).' }],
      warnings: [],
      detectedStandards: [],
    };
  }

  const parsedRows: BomImportRow[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const warnings: Array<{ line: number; message: string }> = [];
  const standardsSet = new Set<string>();
  let totalPercentage = 0;

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    const cols = rawLine.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length <= 1) continue;

    const lineNum = i + 1;
    const materialName = cols[nameIdx] || '';
    if (!materialName) {
      errors.push({ line: lineNum, message: 'Material name cannot be blank.' });
      continue;
    }

    // Parse Percentage
    const rawPct = (cols[pctIdx] || '').replace(/%/g, '').replace(/,/g, '.').trim();
    const pct = parseFloat(rawPct);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      errors.push({ line: lineNum, message: `Invalid percentage value: "${cols[pctIdx]}". Must be between 0.1 and 100.` });
      continue;
    }

    totalPercentage += pct;

    // Parse Type
    let materialType: BomImportRow['materialType'] = 'fiber';
    if (typeIdx !== -1 && cols[typeIdx]) {
      const t = cols[typeIdx].toLowerCase();
      if (t.includes('fil') || t.includes('yarn')) materialType = 'yarn';
      else if (t.includes('tissu') || t.includes('fabric') || t.includes('knit')) materialType = 'fabric';
      else if (t.includes('trim') || t.includes('bouton') || t.includes('accessoire') || t.includes('zip')) materialType = 'trim';
      else if (t.includes('pack') || t.includes('emballage')) materialType = 'packaging';
    }

    // Parse Country (ISO2)
    let originCountry = 'PT';
    if (countryIdx !== -1 && cols[countryIdx]) {
      const c = cols[countryIdx].trim().toUpperCase();
      if (c.length === 2) originCountry = c;
      else if (c.includes('PORTUGAL')) originCountry = 'PT';
      else if (c.includes('FRANCE')) originCountry = 'FR';
      else if (c.includes('ITAL') || c.includes('ITALIE')) originCountry = 'IT';
      else if (c.includes('TURK') || c.includes('TURQUIE')) originCountry = 'TR';
      else {
        warnings.push({ line: lineNum, message: `Country code "${c}" normalized to default PT. Recommend ISO-2 format.` });
      }
    }

    const certificationStandard = certIdx !== -1 && cols[certIdx] ? cols[certIdx].trim().toUpperCase() : undefined;
    if (certificationStandard) standardsSet.add(certificationStandard);

    const certificationNumber = certNumIdx !== -1 && cols[certNumIdx] ? cols[certNumIdx].trim() : undefined;
    const supplierLotNumber = lotIdx !== -1 && cols[lotIdx] ? cols[lotIdx].trim() : undefined;
    const tier = tierIdx !== -1 && cols[tierIdx] ? (cols[tierIdx].trim() as BomImportRow['tier']) : 'Tier 4';

    parsedRows.push({
      lineNumber: lineNum,
      materialName,
      materialType,
      percentage: pct,
      originCountry,
      certificationStandard,
      certificationNumber,
      supplierLotNumber,
      tier,
    });
  }

  totalPercentage = Number(totalPercentage.toFixed(2));

  // Check sum equals 100%
  if (Math.abs(totalPercentage - 100) > 0.5) {
    errors.push({
      line: 0,
      message: `Total composition percentage is ${totalPercentage}%. European labeling regulation requires sum to equal 100% (±0.5%).`,
    });
  }

  const isValid = errors.length === 0 && parsedRows.length > 0;

  return {
    isValid,
    totalPercentage,
    rowsCount: parsedRows.length,
    parsedRows,
    errors,
    warnings,
    detectedStandards: Array.from(standardsSet),
  };
}
