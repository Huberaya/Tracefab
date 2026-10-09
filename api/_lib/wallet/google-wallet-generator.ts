import jwt from 'jsonwebtoken';
import type { DppPassData, GoogleWalletOptions } from './types.js';

/** Rend le module, ou null quand la donnee n'est pas renseignee. */
function module(
  id: string,
  header: string,
  body: string | undefined | null,
): Record<string, string> | null {
  const v = typeof body === 'string' ? body.trim() : '';
  return v ? { id, header, body: v } : null;
}

/** N'assemble que les mesures disponibles. */
function empreinte(data: DppPassData): string | undefined {
  const bouts: string[] = [];
  if (typeof data.carbonFootprintKgCo2e === 'number') bouts.push(`${data.carbonFootprintKgCo2e} kg CO₂e`);
  if (typeof data.waterScarcityM3 === 'number') bouts.push(`${data.waterScarcityM3} m³ eau`);
  if (!bouts.length) return undefined;
  return bouts.length === 2 ? `${bouts[0]} (${bouts[1]})` : bouts[0];
}

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
    // Le sous-titre annoncait « Eco-Score PEF Grade undefined » pour tout
    // produit sans analyse. A defaut de grade, on affiche la reference.
    subheader: {
      defaultValue: {
        language: 'fr',
        value: data.pefGrade ? `Éco-Score PEF Grade ${data.pefGrade}` : data.productReference,
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
    // Memes regles que sur le laissez-passer Apple : aucune rubrique n'est
    // comblee. En particulier, le bloc « CONFORMITE : ESPR UE 2024 / Loi AGEC
    // Art. 13 » etait affiche sur chaque passeport sans qu'aucune verification
    // de conformite n'ait lieu, et « Noeuds certifies GOTS/GRS auditables »
    // decrivait une chaine inconnue comme certifiee.
    textModulesData: [
      {
        id: 'portee',
        header: 'PORTÉE',
        body: 'Données transmises par la marque. Ne constitue pas une attestation '
          + 'de conformité réglementaire ni une certification par un tiers.',
      },
      module('composition', 'COMPOSITION', data.certifiedComposition),
      module('pef', 'EMPREINTE CARBONE', empreinte(data)),
      module('origin', 'CONFECTION', data.countryOfManufacture),
      module('traceability', "TRAÇABILITÉ CHAÎNE D'APPROVISIONNEMENT", data.supplyChainSummary),
    ].filter(Boolean),
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
