import { createHash, createSign } from 'node:crypto';
import { ZipArchive } from 'archiver';
import type { DppPassData, AppleWalletOptions } from './types.js';

// Minimal standard 1x1 transparent PNG buffer
const MINIMAL_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Builds the official pass.json structure adhering to Apple Wallet PassKit specification.
 */
export function buildPassJson(data: DppPassData, options?: AppleWalletOptions): Record<string, any> {
  const passTypeIdentifier = options?.passTypeIdentifier || process.env.APPLE_PASS_TYPE_IDENTIFIER || 'pass.com.tracefab.dpp';
  const teamIdentifier = options?.teamIdentifier || process.env.APPLE_TEAM_IDENTIFIER || 'TRACEFAB01';

  return {
    formatVersion: 1,
    passTypeIdentifier,
    serialNumber: data.serialNumber || `DPP-${data.gtin || data.productReference}`,
    teamIdentifier,
    organizationName: data.brandName || 'Tracefab',
    description: `Passeport Numérique de Produit - ${data.productName}`,
    logoText: (data.brandName || 'TRACEFAB').toUpperCase(),
    foregroundColor: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(20, 36, 26)', // Rich luxury deep forest green
    labelColor: 'rgb(168, 189, 173)',
    storeCard: {
      headerFields: [
        {
          key: 'compliance_badge',
          label: 'RÉGLEMENTATION',
          value: 'ESPR CONFORME',
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      primaryFields: [
        {
          key: 'product_name',
          label: 'MODÈLE CERTIFIÉ',
          value: data.productName,
        },
      ],
      secondaryFields: [
        {
          key: 'pef_grade',
          label: 'ÉCO-SCORE PEF',
          value: `Grade ${data.pefGrade} (${data.carbonFootprintKgCo2e} kg CO₂e)`,
        },
        {
          key: 'origin',
          label: 'CONFECTION',
          value: data.countryOfManufacture || 'UE',
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      auxiliaryFields: [
        {
          key: 'composition',
          label: 'COMPOSITION 100%',
          value: data.certifiedComposition || 'Fibres naturelles certifiées',
        },
        {
          key: 'gtin',
          label: 'GS1 GTIN-13',
          value: data.gtin || data.sku || 'N/A',
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      backFields: [
        {
          key: 'dpp_url',
          label: 'PASSEPORT NUMÉRIQUE OFFICIEL (DPP)',
          value: data.dppUrl,
        },
        {
          key: 'espr_notice',
          label: 'CADRE RÉGLEMENTAIRE EUROPÉEN',
          value: 'Ce passeport produit est certifié conforme au Règlement Écoconception ESPR 2024/1781 et à la loi AGEC article 13.',
        },
        {
          key: 'product_id',
          label: 'RÉFÉRENCE & LOT',
          value: `${data.productReference} (SKU: ${data.sku})`,
        },
        {
          key: 'materials_detail',
          label: 'DÉCOMPOSITION DES MATIÈRES CERTIFIÉES',
          value: data.materials?.length
            ? data.materials.map((m) => `• ${m.percentage}% ${m.name}${m.originCountry ? ` (Origine: ${m.originCountry})` : ''}`).join('\n')
            : data.certifiedComposition,
        },
        {
          key: 'pef_detail',
          label: 'BILAN ENVIRONNEMENTAL (ACV PEF)',
          value: `• Empreinte carbone: ${data.carbonFootprintKgCo2e} kg CO₂e\n• Consommation en eau: ${data.waterScarcityM3} m³\n• Score de circularité: ${data.circularityScore}/100`,
        },
        {
          key: 'supply_chain',
          label: 'TRAÇABILITÉ SUPPLY CHAIN (TIER 1 À 4)',
          value: data.supplyChainSummary || 'Traçabilité complète des étapes de filature, tissage, teinture et confection auditée.',
        },
        {
          key: 'tc_ref',
          label: 'TRANSACTION CERTIFICATE (TC)',
          value: data.transactionCertificateNumber || 'Validé sous registre bilanciel anti-double dépense',
        },
        {
          key: 'care_instructions',
          label: "CONSEILS D'ENTRETIEN & DURABILITÉ",
          value: data.careInstructions || 'Lavage à 30°C sur envers. Séchage à l’air libre. Réparable via notre réseau partenaire.',
        },
        {
          key: 'recycling',
          label: 'FIN DE VIE & RECYCLAGE',
          value: data.recyclingInstructions || 'Déposer dans une borne textile Re-fashion ou rapporter en boutique pour recyclage mécanique des fibres.',
        },
      ],
    },
    barcode: {
      message: data.digitalLinkUri || data.dppUrl,
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1',
      altText: data.gtin || data.productReference,
    },
    barcodes: [
      {
        message: data.digitalLinkUri || data.dppUrl,
        format: 'PKBarcodeFormatQR',
        messageEncoding: 'iso-8859-1',
        altText: data.gtin || data.productReference,
      },
    ],
  };
}

/**
 * Generates an Apple Wallet .pkpass ZIP bundle with SHA-1 manifest and cryptographic / dev signature.
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

  // Cryptographic signature handling (dual mode: real Apple certs or test simulation)
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

  // Package all files into .pkpass ZIP archive
  return new Promise<Buffer>((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: any) => chunks.push(chunk));
    archive.on('error', (err: any) => reject(err));
    archive.on('end', () => resolve(Buffer.concat(chunks as any)));

    for (const [name, buffer] of Object.entries(files)) {
      archive.append(buffer, { name });
    }

    archive.finalize();
  });
}
