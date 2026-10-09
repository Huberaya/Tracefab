import jwt from 'jsonwebtoken';
import type { DppPassData, GoogleWalletOptions } from './types.js';

export interface GoogleWalletResult {
  saveUrl: string;
  jwtToken: string;
  isSimulated: boolean;
  passObject: Record<string, any>;
}

/**
 * Builds and signs a Google Wallet Pass object for Digital Product Passports.
 */
export function generateGoogleWalletPass(data: DppPassData, options?: GoogleWalletOptions): GoogleWalletResult {
  const issuerId = options?.issuerId || process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000022314567';
  const classId = options?.classId || `${issuerId}.dpp_textile_v1`;
  const objectId = `${issuerId}.dpp_${(data.gtin || data.productReference).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const genericClass = {
    id: classId,
    issuerName: data.brandName || 'Tracefab',
    reviewStatus: 'UNDER_REVIEW',
  };

  const genericObject = {
    id: objectId,
    classId: classId,
    cardTitle: {
      defaultValue: {
        language: 'fr',
        value: data.brandName || 'Tracefab',
      },
    },
    header: {
      defaultValue: {
        language: 'fr',
        value: data.productName,
      },
    },
    subheader: {
      defaultValue: {
        language: 'fr',
        value: `Éco-Score PEF Grade ${data.pefGrade}`,
      },
    },
    barcode: {
      type: 'QR_CODE',
      value: data.digitalLinkUri || data.dppUrl,
      alternateText: data.gtin || data.productReference,
    },
    hexBackgroundColor: '#14241A',
    logo: {
      sourceUri: {
        uri: 'https://tracefab.com/assets/logo-wallet.png',
      },
      contentDescription: {
        defaultValue: {
          language: 'fr',
          value: 'Tracefab Logo',
        },
      },
    },
    textModulesData: [
      {
        id: 'compliance',
        header: 'CONFORMITÉ',
        body: 'ESPR UE 2024 / Loi AGEC Art. 13',
      },
      {
        id: 'composition',
        header: 'COMPOSITION 100%',
        body: data.certifiedComposition || 'Fibres certifiées',
      },
      {
        id: 'pef',
        header: 'EMPREINTE CARBONE',
        body: `${data.carbonFootprintKgCo2e} kg CO₂e (${data.waterScarcityM3} m³ eau)`,
      },
      {
        id: 'origin',
        header: 'CONFECTION',
        body: data.countryOfManufacture || 'UE',
      },
      {
        id: 'traceability',
        header: 'TRAÇABILITÉ SUPPLY CHAIN',
        body: data.supplyChainSummary || 'Nœuds certifiés GOTS/GRS auditables.',
      },
    ],
    linksModuleData: {
      uris: [
        {
          uri: data.dppUrl,
          description: 'Consulter le Passeport Numérique Officiel (DPP)',
        },
      ],
    },
  };

  const claims = {
    iss: options?.serviceAccountKeyJson ? JSON.parse(options.serviceAccountKeyJson).client_email : 'tracefab-wallet@demo.iam.gserviceaccount.com',
    aud: 'google',
    origins: ['https://tracefab.com'],
    typ: 'savetoandroidpay',
    iat: Math.floor(Date.now() / 1000),
    payload: {
      genericClasses: [genericClass],
      genericObjects: [genericObject],
    },
  };

  let token = '';
  let isSimulated = true;

  if (options?.serviceAccountKeyJson || process.env.GOOGLE_WALLET_PRIVATE_KEY) {
    try {
      const privateKey = process.env.GOOGLE_WALLET_PRIVATE_KEY || JSON.parse(options?.serviceAccountKeyJson || '{}').private_key;
      token = jwt.sign(claims, privateKey, { algorithm: 'RS256' });
      isSimulated = false;
    } catch (e) {
      console.warn('Google Wallet production signing failed, falling back to simulated pass:', e);
      token = jwt.sign(claims, 'tracefab_dev_secret_simulation', { algorithm: 'HS256' });
    }
  } else {
    token = jwt.sign(claims, 'tracefab_dev_secret_simulation', { algorithm: 'HS256' });
  }

  const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

  return {
    saveUrl,
    jwtToken: token,
    isSimulated,
    passObject: {
      genericClass,
      genericObject,
    },
  };
}
