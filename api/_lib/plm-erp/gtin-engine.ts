import type { GtinValidationResult, Gs1DigitalLinkOptions } from './types.js';

/**
 * Calculates the standard GS1 Modulo-10 check digit for an unpadded sequence of digits.
 * Applies alternating weight 3 (for odd positions from the right) and weight 1 (for even positions).
 */
export function calculateGs1CheckDigit(digitsWithoutCheck: string): number {
  const digits = digitsWithoutCheck.replace(/\D/g, '');
  let sum = 0;
  let multiplier = 3;

  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = parseInt(digits[i], 10);
    sum += digit * multiplier;
    multiplier = multiplier === 3 ? 1 : 3;
  }

  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

/**
 * Validates a GTIN string (GTIN-8, GTIN-12, GTIN-13, GTIN-14).
 */
export function validateGtin(rawGtin: string): GtinValidationResult {
  const clean = String(rawGtin || '').trim().replace(/\D/g, '');
  const len = clean.length;

  let format: GtinValidationResult['format'] = 'INVALID';
  if (len === 8) format = 'GTIN-8';
  else if (len === 12) format = 'GTIN-12';
  else if (len === 13) format = 'GTIN-13';
  else if (len === 14) format = 'GTIN-14';

  if (format === 'INVALID') {
    return {
      raw: rawGtin,
      cleanGtin: clean,
      isValid: false,
      format: 'INVALID',
      checkDigit: -1,
      calculatedCheckDigit: -1,
      digitalLinkUri: '',
      error: `Invalid length (${len}). Must be 8, 12, 13, or 14 digits.`,
    };
  }

  const payload = clean.slice(0, -1);
  const providedCheckDigit = parseInt(clean.slice(-1), 10);
  const calculatedCheckDigit = calculateGs1CheckDigit(payload);
  const isValid = providedCheckDigit === calculatedCheckDigit;

  const digitalLinkUri = isValid
    ? buildGs1DigitalLink({ gtin: clean })
    : '';

  return {
    raw: rawGtin,
    cleanGtin: clean,
    isValid,
    format,
    checkDigit: providedCheckDigit,
    calculatedCheckDigit,
    digitalLinkUri,
    error: isValid ? undefined : `Checksum mismatch: expected ${calculatedCheckDigit}, provided ${providedCheckDigit}.`,
  };
}

/**
 * Builds a standard GS1 Digital Link URI conformant to GS1 Digital Link Standard 1.2
 * Format: https://id.tracefab.com/01/{GTIN}/21/{serial}?linkType={linkType}&10={lot}
 */
export function buildGs1DigitalLink(options: Gs1DigitalLinkOptions): string {
  const domain = options.domain || 'https://id.tracefab.com';
  const cleanGtin = options.gtin.trim().replace(/\D/g, '');

  let path = `${domain.replace(/\/+$/, '')}/01/${cleanGtin}`;
  if (options.serial) {
    path += `/21/${encodeURIComponent(options.serial.trim())}`;
  }

  const queryParams = new URLSearchParams();
  if (options.lot) {
    queryParams.set('10', options.lot.trim());
  }
  if (options.linkType) {
    queryParams.set('linkType', options.linkType);
  }

  const queryString = queryParams.toString();
  return queryString ? `${path}?${queryString}` : path;
}

/**
 * Parses a GS1 Digital Link URI or query path.
 */
export function parseGs1DigitalLink(uriOrPath: string): {
  gtin?: string;
  serial?: string;
  lot?: string;
  linkType?: string;
} {
  try {
    const url = uriOrPath.startsWith('http')
      ? new URL(uriOrPath)
      : new URL(`https://id.tracefab.com${uriOrPath.startsWith('/') ? '' : '/'}${uriOrPath}`);

    const segments = url.pathname.split('/').filter(Boolean);
    let gtin: string | undefined;
    let serial: string | undefined;

    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === '01' && segments[i + 1]) {
        gtin = segments[i + 1].replace(/\D/g, '');
      } else if (segments[i] === '21' && segments[i + 1]) {
        serial = decodeURIComponent(segments[i + 1]);
      }
    }

    const lot = url.searchParams.get('10') || undefined;
    const linkType = url.searchParams.get('linkType') || undefined;

    return { gtin, serial, lot, linkType };
  } catch {
    return {};
  }
}
