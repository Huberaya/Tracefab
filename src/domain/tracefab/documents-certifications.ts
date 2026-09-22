import type {
  Certification,
  Document,
  DocumentKind,
  ISODate,
  UUID,
  VerificationStatus,
} from './types';

export interface RegisterDocumentCommand {
  ownerOrganizationId: UUID;
  storagePath: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string | null;
  kind: DocumentKind;
  expiresAt?: ISODate | null;
  metadata?: Record<string, unknown>;
}

export interface RegisterDocumentResult extends Document {
  uploadBucket: 'tracefab-private';
}

export interface FinalizeDocumentUploadCommand {
  documentId: UUID;
  sha256: string;
  scanPassed: boolean;
  actualByteSize: number;
}

export interface CertificationInput {
  ownerOrganizationId: UUID;
  supplierId: UUID | null;
  supplierSiteId: UUID | null;
  productId: UUID | null;
  standardName: string;
  standardCode: string | null;
  issuerName: string | null;
  certificateNumber: string | null;
  issuedAt: ISODate | null;
  expiresAt: ISODate | null;
  documentId: UUID | null;
}

export interface ReviewCertificationCommand {
  certificationId: UUID;
  verificationStatus: VerificationStatus;
  method: string;
  notes: string | null;
  verifierOrganizationId?: UUID | null;
}

export interface CertificationEvidence {
  certification: Certification;
  document: Document | null;
}
