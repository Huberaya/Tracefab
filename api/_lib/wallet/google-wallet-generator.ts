import jwt from 'jsonwebtoken';
import type { DppPassData, SourcedField, GoogleWalletOptions } from './types.js';
import { fieldDisplay, PROVENANCE_LABELS_FR } from './types.js';

export interface GoogleWalletResult {
  saveUrl: string;
  jwtToken: string;
  isSimulated: boolean;
  passObject: Record<string, any>;
}

/** Champ rendu pour la carte : valeur sourcee ou etat explicite. */
function champ<T>(field: SourcedField<T> | undefined): string {
  if (!field) return PROVENANCE_LABELS_FR.unavailable;
  return fieldDisplay(field);
}

/**
 * Builds and signs a Google Wallet Pass object for Digital Product Passports.
 *
 * Regle chantier 1A-C : aucune valeur substituee, aucune affirmation sans
 * source (l'ancien « ESPR UE 2024 / Loi AGEC Art. 13 », « Fibres certifiees »,
 * « Noeuds certifies GOTS/GRS auditables » etaient presents meme sans donnee).
 */
export function generateGoogleWalletPass(data: DppPassData, options?: GoogleWalletOptions): GoogleWalletResult {
  const issuerId = options?.issuerId || process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000022314567';
  const classId = options?.classId || `${issuerId}.dpp_textile_v1`;
  const objectId = `${issuerId}.dpp_${(data.gtin.value || data.productReference.value || data.productId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const genericClass = {
    id: classId,
    issuerName: champ(data.brandName),
    reviewStatus: 'UNDER_REVIEW',
  };

  const genericObject = {
    id: objectId,
    classId: classId,
    cardTitle: {
      defaultValue: {
        language: 'fr',
        value: champ(data.brandName),
      },
    },
    header: {
      defaultValue: {
        language: 'fr',
        value: champ(data.productName),
      },
    },
    subheader: {
      defaultValue: {
        language: 'fr',
        value: data.pefGrade.status === 'sourced' || data.pefGrade.status === 'unverified'
          ? `Eco-Score PEF ${champ(data.pefGrade)}`
          : `Eco-Score PEF : ${champ(data.pefGrade)}`,
      },
    },
    barcode: {
      type: 'QR_CODE',
      value: data.digitalLinkUri.value || data.dppUrl,
      alternateText: data.gtin.value || data.productReference.value || data.productId,
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
        id: 'provenance',
        header: 'PROVENANCE DES DONNEES',
        body: data.presentation.source === 'live'
          ? 'Donnees sourcees (voir le passeport pour le detail)'
          : data.presentation.source === 'partial'
            ? `Donnees partielles : ${data.presentation.missingFieldCount} champ(s) sans source`
            : 'Aucune donnee sourcee a presenter',
      },
      {
        id: 'composition',
        header: 'COMPOSITION',
        body: champ(data.composition),
      },
      {
        id: 'pef',
        header: 'EMPREINTE CARBONE',
        body: data.carbonFootprintKgCo2e.status === 'sourced' || data.carbonFootprintKgCo2e.status === 'unverified'
          ? `${champ(data.carbonFootprintKgCo2e)} kg CO2e (${champ(data.waterScarcityM3)} m3 eau)`
          : champ(data.carbonFootprintKgCo2e),
      },
      {
        id: 'origin',
        header: 'CONFECTION',
        body: champ(data.countryOfManufacture),
      },
      {
        id: 'traceability',
        header: 'TRACABILITE SUPPLY CHAIN',
        body: champ(data.supplyChainSummary),
      },
    ],
    linksModuleData: {
      uris: [
        {
          uri: data.dppUrl,
          description: 'Consulter le Passeport Numerique de Produit (DPP)',
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
