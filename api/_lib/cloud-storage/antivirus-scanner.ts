import { createHash } from 'node:crypto';
import type { AntivirusScanResult } from './types.js';
import { scanWithAntivirus } from '../storage.js';

const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// Magic bytes signatures
const MAGIC_BYTES = {
  PDF: Buffer.from('%PDF-'),
  PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG: Buffer.from([0xff, 0xd8, 0xff]),
  ZIP: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  EXE_MZ: Buffer.from([0x4d, 0x5a]),
  ELF: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  MACH_O_64: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
};

function matchesPrefix(buffer: Buffer, prefix: Buffer): boolean {
  if (buffer.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buffer[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Forensic heuristic analysis of document bytes.
 */
export function analyzeDocumentBytes(
  bytes: Buffer | ArrayBuffer,
  filename: string,
  contentType: string
): AntivirusScanResult {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const sha256 = createHash('sha256').update(new Uint8Array(buf)).digest('hex');
  const now = new Date().toISOString();

  const details: AntivirusScanResult['details'] = {
    fileHeaderValid: true,
    suspiciousKeywordsFound: [],
    embeddedScriptsFound: false,
    eicarDetected: false,
  };

  const rawStr = buf.toString('latin1');

  // 1. EICAR Test detection
  if (rawStr.includes(EICAR_SIGNATURE)) {
    details.eicarDetected = true;
    return {
      clean: false,
      status: 'infected',
      engine: 'Tracefab Forensics & Heuristics v2',
      threatName: 'EICAR_Standard_AntiVirus_Test_Signature',
      mimeType: contentType,
      sha256,
      scannedAt: now,
      details,
    };
  }

  // 2. Executable disguised as document
  const isExeHeader = matchesPrefix(buf, MAGIC_BYTES.EXE_MZ) ||
                      matchesPrefix(buf, MAGIC_BYTES.ELF) ||
                      matchesPrefix(buf, MAGIC_BYTES.MACH_O_64);

  if (isExeHeader && (contentType === 'application/pdf' || contentType.startsWith('image/'))) {
    details.fileHeaderValid = false;
    return {
      clean: false,
      status: 'infected',
      engine: 'Tracefab Forensics & Heuristics v2',
      threatName: 'Executable_Payload_Spoofed_MimeType',
      mimeType: 'application/x-dosexec',
      sha256,
      scannedAt: now,
      details,
    };
  }

  // 3. MIME type header verification
  if (contentType === 'application/pdf' && !matchesPrefix(buf, MAGIC_BYTES.PDF)) {
    details.fileHeaderValid = false;
    return {
      clean: false,
      status: 'suspicious',
      engine: 'Tracefab Forensics & Heuristics v2',
      threatName: 'Corrupted_Or_Invalid_PDF_Header',
      mimeType: 'application/octet-stream',
      sha256,
      scannedAt: now,
      details,
    };
  }

  // 4. PDF Active Script / Exploit Analysis
  if (contentType === 'application/pdf') {
    const suspiciousTokens = ['/JavaScript', '/JS', '/Launch', '/OpenAction', '/RichMedia'];
    for (const token of suspiciousTokens) {
      if (rawStr.includes(token)) {
        details.suspiciousKeywordsFound.push(token);
        if (token === '/JavaScript' || token === '/JS' || token === '/Launch') {
          details.embeddedScriptsFound = true;
        }
      }
    }

    if (details.embeddedScriptsFound) {
      return {
        clean: false,
        status: 'suspicious',
        engine: 'Tracefab Forensics & Heuristics v2',
        threatName: 'PDF_Active_Script_Execution_Vulnerability',
        mimeType: contentType,
        sha256,
        scannedAt: now,
        details,
      };
    }
  }

  // Une heuristique sans alerte n'est PAS un antivirus et ne peut pas
  // certifier qu'un fichier est sain. Ce resultat reste non verifie.
  return {
    clean: false,
    status: 'error',
    engine: 'Tracefab heuristics (not an antivirus)',
    threatName: 'antivirus_verdict_unavailable',
    mimeType: contentType,
    sha256,
    scannedAt: now,
    details,
  };
}

/**
 * Pipeline antivirus : aucun repli heuristique ne peut produire un verdict
 * positif. Utilise le meme contrat authentifie et fail-closed que le depot
 * de documents ; l'identite effective du moteur externe n'est pas supposee.
 */
export async function runAntivirusPipeline(
  bytes: ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<AntivirusScanResult> {
  try {
    const scan = await scanWithAntivirus(bytes, filename, contentType);
    const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    return {
      clean: scan.clean,
      status: scan.clean ? 'clean' : 'infected',
      engine: 'External antivirus (tracefab-v1; engine not attested)',
      threatName: scan.threat,
      mimeType: scan.mimeType || contentType,
      sha256,
      scannedAt: new Date().toISOString(),
      details: {
        fileHeaderValid: null,
        suspiciousKeywordsFound: [],
        embeddedScriptsFound: null,
        eicarDetected: null,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('private_storage_antivirus_')) throw error;
    throw new Error('private_storage_antivirus_unreachable');
  }
}
