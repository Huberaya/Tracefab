import { createHash, createSign } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import type { DppPassData, SourcedField, AppleWalletOptions } from './types.js';
import { fieldDisplay, PROVENANCE_LABELS_FR } from './types.js';

// Minimal standard 1x1 transparent PNG buffer
const MINIMAL_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Rend un champ pour la carte : la valeur si elle est presentable, sinon
 * l'etat explicite (« Non renseigne », « Indisponible », « Non verifie »).
 * Aucune valeur de remplissage : une carte doit pouvoir afficher un trou
 * annonce comme tel.
 */
function champ<T>(field: SourcedField<T> | undefined): string {
  if (!field) return PROVENANCE_LABELS_FR.unavailable;
  return fieldDisplay(field);
}

/**
 * Builds the official pass.json structure adhering to Apple Wallet PassKit specification.
 *
 * Regle chantier 1A-C : la carte ne presente QUE des donnees resolues depuis
 * la base (avec leur etat de provenance), ou des etats explicites. Les
 * anciennes mentions « ESPR CONFORME », « certifie conforme », « Fibres
 * naturelles certifiees » ou « Traçabilite ... auditee » etaient des
 * affirmations reglementaires ou commerciales sans source : retirees.
 */
export function buildPassJson(data: DppPassData, options?: AppleWalletOptions): Record<string, any> {
  const passTypeIdentifier = options?.passTypeIdentifier || process.env.APPLE_PASS_TYPE_IDENTIFIER || 'pass.com.tracefab.dpp';
  const teamIdentifier = options?.teamIdentifier || process.env.APPLE_TEAM_IDENTIFIER || 'TRACEFAB01';

  const materialsDetail = data.materials?.length
    ? data.materials.map((m) => `• ${champ(m.percentage)} ${champ(m.name)}${m.originCountry.value ? ` (Origine: ${champ(m.originCountry)})` : ''}`).join('\n')
    : champ(data.composition);

  const pefDetail = [
    `• Empreinte carbone: ${champ(data.carbonFootprintKgCo2e)}${data.carbonFootprintKgCo2e.status === 'sourced' ? ' kg CO₂e' : ''}`,
    `• Consommation en eau: ${champ(data.waterScarcityM3)}${data.waterScarcityM3.status === 'sourced' ? ' m³' : ''}`,
    `• Score de circularite: ${champ(data.circularityScore)}${data.circularityScore.status === 'sourced' ? '/100' : ''}`,
  ].join('\n');

  return {
    formatVersion: 1,
    passTypeIdentifier,
    serialNumber: data.serialNumber.value || `DPP-${data.gtin.value || data.productReference.value || data.productId}`,
    teamIdentifier,
    organizationName: champ(data.brandName),
    description: `Passeport Numérique de Produit - ${champ(data.productName)}`,
    logoText: champ(data.brandName).toUpperCase(),
    foregroundColor: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(20, 36, 26)', // Rich luxury deep forest green
    labelColor: 'rgb(168, 189, 173)',
    storeCard: {
      headerFields: [
        {
          key: 'provenance',
          label: 'PROVENANCE DES DONNEES',
          value: data.presentation.source === 'live'
            ? 'Donnees sourcees'
            : data.presentation.source === 'partial'
              ? `Donnees partielles (${data.presentation.missingFieldCount} champ(s) sans source)`
              : 'Aucune donnee sourcee',
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      primaryFields: [
        {
          key: 'product_name',
          label: 'DESIGNATION',
          value: champ(data.productName),
        },
      ],
      secondaryFields: [
        {
          key: 'pef_grade',
          label: 'ECO-SCORE PEF',
          value: data.pefGrade.status === 'sourced'
            ? `Grade ${champ(data.pefGrade)} (${champ(data.carbonFootprintKgCo2e)} kg CO2e)`
            : champ(data.pefGrade),
        },
        {
          key: 'origin',
          label: 'CONFECTION',
          value: champ(data.countryOfManufacture),
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      auxiliaryFields: [
        {
          key: 'composition',
          label: 'COMPOSITION',
          value: champ(data.composition),
        },
        {
          key: 'gtin',
          label: 'GS1 GTIN',
          value: champ(data.gtin),
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      backFields: [
        {
          key: 'dpp_url',
          label: 'PASSEPORT NUMERIQUE DE PRODUIT (DPP)',
          value: data.dppUrl,
        },
        {
          key: 'espr_notice',
          label: 'CADRE REGLEMENTAIRE EUROPEEN',
          value: 'Passeport produit au sens du Règlement Ecodesign (UE) 2024/1781. Les donnees ci-dessus proviennent des sources indiquees ; les champs sans source sont annonces comme tels.',
        },
        {
          key: 'product_id',
          label: 'REFERENCE & SKU',
          value: `${champ(data.productReference)} (SKU: ${champ(data.sku)})`,
        },
        {
          key: 'materials_detail',
          label: 'DECOMPOSITION DES MATIERES',
          value: materialsDetail,
        },
        {
          key: 'pef_detail',
          label: 'BILAN ENVIRONNEMENTAL (ACV PEF)',
          value: pefDetail,
        },
        {
          key: 'supply_chain',
          label: 'TRACABILITE SUPPLY CHAIN',
          value: champ(data.supplyChainSummary),
        },
        {
          key: 'tc_ref',
          label: 'TRANSACTION CERTIFICATE (TC)',
          value: champ(data.transactionCertificateNumber),
        },
        {
          key: 'care_instructions',
          label: "CONSEILS D'ENTRETIEN",
          value: champ(data.careInstructions),
        },
        {
          key: 'recycling',
          label: 'FIN DE VIE & RECYCLAGE',
          value: champ(data.recyclingInstructions),
        },
      ],
    },
    barcode: {
      message: data.digitalLinkUri.value || data.dppUrl,
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1',
      altText: data.gtin.value || data.productReference.value || data.productId,
    },
    barcodes: [
      {
        message: data.digitalLinkUri.value || data.dppUrl,
        format: 'PKBarcodeFormatQR',
        messageEncoding: 'iso-8859-1',
        altText: data.gtin.value || data.productReference.value || data.productId,
      },
    ],
  };
}

/**
 * Native ZIP generator without external npm dependency to ensure 100% serverless compatibility.
 */
function createPkpassZip(files: Record<string, Buffer>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const [name, buf] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(buf);
    const uncompressedSize = buf.length;
    const compressed = deflateRawSync(buf);
    const compressedSize = compressed.length;

    // Local file header (30 bytes + name length)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
    localHeader.writeUInt16LE(8, 8);          // Compression method (8 = Deflate)
    localHeader.writeUInt16LE(0, 10);         // Last mod file time
    localHeader.writeUInt16LE(0, 12);         // Last mod file date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);         // Extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressed);

    // Central directory file header (46 bytes + name length)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central header signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed
    centralHeader.writeUInt16LE(0, 8);          // Flags
    centralHeader.writeUInt16LE(8, 10);         // Compression method (Deflate)
    centralHeader.writeUInt16LE(0, 12);         // Mod time
    centralHeader.writeUInt16LE(0, 14);         // Mod date
    centralHeader.writeUInt32LE(crc, 16);       // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // Extra length
    centralHeader.writeUInt16LE(0, 32);         // Comment length
    centralHeader.writeUInt16LE(0, 34);         // Disk number start
    centralHeader.writeUInt16LE(0, 36);         // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);         // External file attributes
    centralHeader.writeUInt32LE(offset, 42);    // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirBuffer = Buffer.concat(centralHeaders);
  const centralDirSize = centralDirBuffer.length;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                 // EOCD signature
  eocd.writeUInt16LE(0, 4);                          // Number of this disk
  eocd.writeUInt16LE(0, 6);                          // Disk where central directory starts
  eocd.writeUInt16LE(Object.keys(files).length, 8);   // Number of central directory records on this disk
  eocd.writeUInt16LE(Object.keys(files).length, 10);  // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);            // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);          // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                         // Comment length

  return Buffer.concat([...localHeaders, centralDirBuffer, eocd]);
}

/**
 * Generates an Apple Wallet .pkpass ZIP bundle with SHA-1 manifest and cryptographic signature.
 */
export async function generateApplePkpass(data: DppPassData, options?: AppleWalletOptions): Promise<Buffer> {
  const passJson = buildPassJson(data, options);
  const passBuffer = Buffer.from(JSON.stringify(passJson, null, 2), 'utf-8');

  // Bundle files: pass.json and required icons
  const files: Record<string, Buffer> = {
    'pass.json': passBuffer,
    'icon.png': MINIMAL_PNG_BUFFER,
    'icon@2x.png': MINIMAL_PNG_BUFFER,
    'logo.png': MINIMAL_PNG_BUFFER,
    'logo@2x.png': MINIMAL_PNG_BUFFER,
  };

  // Generate manifest.json with SHA-1 hashes
  const manifest: Record<string, string> = {};
  for (const [filename, content] of Object.entries(files)) {
    manifest[filename] = createHash('sha1').update(content as any).digest('hex');
  }

  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  files['manifest.json'] = manifestBuffer;

  // Cryptographic signature handling
  let signatureBuffer: Buffer;
  const certPem = options?.passCertificatePem || process.env.APPLE_PASS_CERTIFICATE_PEM;
  const keyPem = options?.passKeyPem || process.env.APPLE_PASS_KEY_PEM;

  if (certPem && keyPem && !options?.useMockSignature) {
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(manifestBuffer as any);
      signatureBuffer = signer.sign(keyPem);
    } catch (e) {
      console.warn('Production Apple sign failed, falling back to development mock signature:', e);
      signatureBuffer = Buffer.from(
        `PKCS7_DEV_SIGNATURE_${createHash('sha256').update(manifestBuffer as any).digest('hex')}`,
        'utf-8'
      );
    }
  } else {
    // Development / test fallback signature
    signatureBuffer = Buffer.from(
      `PKCS7_DEV_SIGNATURE_${createHash('sha256').update(manifestBuffer as any).digest('hex')}`,
      'utf-8'
    );
  }

  files['signature'] = signatureBuffer;

  return createPkpassZip(files);
}
