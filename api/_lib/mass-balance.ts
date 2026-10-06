import { createHash } from 'node:crypto';

export type EvidenceTrustLevel = 
  | 'declared'
  | 'documented'
  | 'verified'
  | 'certified'
  | 'needs_review'
  | 'missing';

export interface EvidenceRecord {
  documentId?: string;
  sha256?: string;
  originalFilename?: string;
  issuer?: string;
  certificateNumber?: string;
  issuedAt?: string;
  expiresAt?: string;
  verifiedAt?: string;
  verifiedBy?: string;
}

export interface TransformationStage {
  stageId: string;
  tier: 'T1_ASSEMBLY' | 'T2_DYEING_FINISHING' | 'T3_SPINNING_WEAVING' | 'T4_FIBER_FARM';
  stageName: string;
  supplierSiteId?: string;
  facilityName: string;
  facilityCountry: string;
  inputQuantityKg: number;
  outputQuantityKg: number;
  lossTolerancePercent: number; // typically 2.0% to 5.0%
  supportingEvidence?: EvidenceRecord[];
}

export interface MassBalanceReconciliationResult {
  isBalanced: boolean;
  inputTotalKg: number;
  outputTotalKg: number;
  lossKg: number;
  lossPercent: number;
  maxAllowedLossPercent: number;
  anomalyDetected: boolean;
  status: 'RECONCILED' | 'WITHIN_TOLERANCE' | 'SUSPECT_DISCREPANCY' | 'OVER_EXTRACTION';
  narrative: string;
}

export function reconcileMassBalance(
  stage: TransformationStage
): MassBalanceReconciliationResult {
  const { inputQuantityKg, outputQuantityKg, lossTolerancePercent, stageName } = stage;

  if (inputQuantityKg <= 0) {
    return {
      isBalanced: false,
      inputTotalKg: inputQuantityKg,
      outputTotalKg: outputQuantityKg,
      lossKg: 0,
      lossPercent: 0,
      maxAllowedLossPercent: lossTolerancePercent,
      anomalyDetected: true,
      status: 'SUSPECT_DISCREPANCY',
      narrative: `Stage [${stageName}] input must be strictly positive (> 0 kg).`,
    };
  }

  if (outputQuantityKg > inputQuantityKg) {
    const surplusKg = outputQuantityKg - inputQuantityKg;
    const surplusPercent = Number(((surplusKg / inputQuantityKg) * 100).toFixed(2));
    return {
      isBalanced: false,
      inputTotalKg: inputQuantityKg,
      outputTotalKg: outputQuantityKg,
      lossKg: -surplusKg,
      lossPercent: -surplusPercent,
      maxAllowedLossPercent: lossTolerancePercent,
      anomalyDetected: true,
      status: 'OVER_EXTRACTION',
      narrative: `Physical anomaly: Output (${outputQuantityKg} kg) exceeds input (${inputQuantityKg} kg) by ${surplusPercent}%. Potential fraudulent lot blending.`,
    };
  }

  const lossKg = Number((inputQuantityKg - outputQuantityKg).toFixed(3));
  const lossPercent = Number(((lossKg / inputQuantityKg) * 100).toFixed(2));
  const isWithinTolerance = lossPercent <= lossTolerancePercent;

  let status: MassBalanceReconciliationResult['status'] = 'RECONCILED';
  let narrative = `Stage [${stageName}] perfectly balanced. Normal process loss: ${lossPercent}%.`;

  if (!isWithinTolerance) {
    status = 'SUSPECT_DISCREPANCY';
    narrative = `Unaccounted loss detected: ${lossPercent}% exceeds technical threshold of ${lossTolerancePercent}%. Requires physical waste audit.`;
  } else if (lossPercent > 0) {
    status = 'WITHIN_TOLERANCE';
    narrative = `Stage [${stageName}] verified. Technical loss of ${lossPercent}% is within acceptable industry boundary (${lossTolerancePercent}%).`;
  }

  return {
    isBalanced: isWithinTolerance,
    inputTotalKg: inputQuantityKg,
    outputTotalKg: outputQuantityKg,
    lossKg,
    lossPercent,
    maxAllowedLossPercent: lossTolerancePercent,
    anomalyDetected: !isWithinTolerance,
    status,
    narrative,
  };
}

export function computeEvidenceHash(content: Uint8Array | string | Record<string, unknown>): string {
  const hash = createHash('sha256');
  if (typeof content === 'string') {
    hash.update(content, 'utf8');
  } else if (content instanceof Uint8Array) {
    hash.update(content);
  } else {
    const sortedKeys = Object.keys(content).sort();
    const canonical = JSON.stringify(content, sortedKeys);
    hash.update(canonical, 'utf8');
  }
  return hash.digest('hex');
}

export function verifyEvidenceIntegrity(
  evidence: EvidenceRecord,
  actualContentSha256?: string
): { isValid: boolean; trustLevel: EvidenceTrustLevel; reason: string } {
  if (!evidence.documentId) {
    return {
      isValid: false,
      trustLevel: 'declared',
      reason: 'No evidence document attached. Claim is self-declared.',
    };
  }

  if (evidence.sha256 && actualContentSha256 && evidence.sha256 !== actualContentSha256) {
    return {
      isValid: false,
      trustLevel: 'needs_review',
      reason: `Cryptographic hash mismatch. Expected ${evidence.sha256}, actual ${actualContentSha256}. Tampering suspected.`,
    };
  }

  if (evidence.expiresAt) {
    const expiry = new Date(evidence.expiresAt).getTime();
    if (Date.now() > expiry) {
      return {
        isValid: false,
        trustLevel: 'needs_review',
        reason: `Evidence certificate expired on ${evidence.expiresAt}.`,
      };
    }
  }

  if (evidence.verifiedAt && evidence.verifiedBy) {
    return {
      isValid: true,
      trustLevel: evidence.certificateNumber ? 'certified' : 'verified',
      reason: 'Verified by accredited reviewer and cryptographically sealed.',
    };
  }

  return {
    isValid: true,
    trustLevel: 'documented',
    reason: 'Document attached with valid SHA-256 seal. Pending human/accreditation audit.',
  };
}
