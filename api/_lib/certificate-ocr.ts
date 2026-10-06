export interface CertificateOcrResult {
  standard: 'GOTS' | 'GRS' | 'OEKO_TEX' | 'BLUESIGN' | 'SMETA' | 'ISO_14001' | 'UNKNOWN';
  licenseNumber?: string;
  issuerName?: string;
  issuedDate?: string;
  expiryDate?: string;
  coveredCategories: string[];
  daysUntilExpiry?: number;
  expiryAlert?: 'EXPIRED' | 'CRITICAL_30D' | 'WARNING_60D' | 'VALID';
  confidenceScore: number;
}

/**
 * Intelligent parser extracting standard accreditation data from certificate text or simulated OCR payload.
 */
export function parseCertificateOcr(rawText: string): CertificateOcrResult {
  const text = rawText.toUpperCase();
  let standard: CertificateOcrResult['standard'] = 'UNKNOWN';
  let licenseNumber: string | undefined;
  let issuerName: string | undefined;
  let issuedDate: string | undefined;
  let expiryDate: string | undefined;
  const categories: string[] = [];

  // 1. Identify Standard
  if (text.includes('GOTS') || text.includes('GLOBAL ORGANIC TEXTILE')) {
    standard = 'GOTS';
    issuerName = text.includes('CONTROL UNION') ? 'Control Union' : 'ECOCERT';
  } else if (text.includes('GRS') || text.includes('GLOBAL RECYCLED STANDARD')) {
    standard = 'GRS';
    issuerName = 'IDFL Laboratory and Institute';
  } else if (text.includes('OEKO-TEX') || text.includes('STANDARD 100') || text.includes('STEP')) {
    standard = 'OEKO_TEX';
    issuerName = text.includes('HOHENSTEIN') ? 'Hohenstein Textile Testing Institute' : 'Centexbel';
  } else if (text.includes('BLUESIGN')) {
    standard = 'BLUESIGN';
    issuerName = 'Bluesign Technologies AG';
  } else if (text.includes('SMETA') || text.includes('SEDEX')) {
    standard = 'SMETA';
    issuerName = 'Bureau Veritas / Sedex';
  } else if (text.includes('ISO 14001')) {
    standard = 'ISO_14001';
    issuerName = 'DNV GL / SGS';
  }

  // 2. Extract License or Certificate ID
  const licenseMatch = rawText.match(/(?:certificate|licence|license|report)\s*(?:no\.?|number|id)?[:\s]*([A-Z0-9.\-\/]{5,25})/i);
  if (licenseMatch) {
    licenseNumber = licenseMatch[1].trim();
  }

  // 3. Extract Expiry Date
  const expiryMatch = rawText.match(/(?:valid until|expiry date|expires on|valid through|expiration)[:\s]*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2}|[0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
  if (expiryMatch) {
    let dateStr = expiryMatch[1].replace(/\//g, '-');
    if (dateStr.length === 10 && dateStr.charAt(2) === '-') {
      // Convert DD-MM-YYYY to YYYY-MM-DD
      const parts = dateStr.split('-');
      dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    expiryDate = dateStr;
  }

  // 4. Extract Issue Date
  const issueMatch = rawText.match(/(?:issued on|date of issue|issued at)[:\s]*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2}|[0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i);
  if (issueMatch) {
    let dateStr = issueMatch[1].replace(/\//g, '-');
    if (dateStr.length === 10 && dateStr.charAt(2) === '-') {
      const parts = dateStr.split('-');
      dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    issuedDate = dateStr;
  }

  // 5. Extract Covered Categories
  if (text.includes('SPINNING') || text.includes('YARN')) categories.push('Spinning / Yarn');
  if (text.includes('WEAVING') || text.includes('KNITTING') || text.includes('FABRIC')) categories.push('Fabric / Weaving / Knitting');
  if (text.includes('DYEING') || text.includes('FINISHING') || text.includes('PRINTING')) categories.push('Wet Processing / Dyeing');
  if (text.includes('CONFECTION') || text.includes('GARMENT') || text.includes('MANUFACTURING') || text.includes('CMT')) categories.push('Garment Manufacturing / CMT');

  // 6. Calculate Days until Expiry and Proactive Alerts
  let daysUntilExpiry: number | undefined;
  let expiryAlert: CertificateOcrResult['expiryAlert'] = 'VALID';

  if (expiryDate) {
    const expiryTime = new Date(expiryDate).getTime();
    const now = Date.now();
    const diffDays = Math.ceil((expiryTime - now) / (1000 * 60 * 60 * 24));
    daysUntilExpiry = diffDays;

    if (diffDays < 0) {
      expiryAlert = 'EXPIRED';
    } else if (diffDays <= 30) {
      expiryAlert = 'CRITICAL_30D';
    } else if (diffDays <= 60) {
      expiryAlert = 'WARNING_60D';
    } else {
      expiryAlert = 'VALID';
    }
  }

  const confidenceScore = standard !== 'UNKNOWN' && licenseNumber ? 0.95 : standard !== 'UNKNOWN' ? 0.75 : 0.40;

  return {
    standard,
    licenseNumber,
    issuerName,
    issuedDate,
    expiryDate,
    coveredCategories: categories.length > 0 ? categories : ['General Apparel & Textile'],
    daysUntilExpiry,
    expiryAlert,
    confidenceScore,
  };
}
