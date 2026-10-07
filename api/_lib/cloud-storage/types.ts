export type StorageProvider = 'aws_s3' | 'cloudflare_r2' | 'minio' | 'local_simulated';

export type StorageQuotaInfo = {
  organizationId: string;
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
  percentageUsed: number;
  documentCount: number;
  isQuotaExceeded: boolean;
};

export type AntivirusScanResult = {
  clean: boolean;
  status: 'clean' | 'infected' | 'suspicious' | 'error';
  engine: string;
  threatName?: string;
  mimeType?: string | null;
  sha256: string;
  scannedAt: string;
  details: {
    fileHeaderValid: boolean;
    suspiciousKeywordsFound: string[];
    embeddedScriptsFound: boolean;
    eicarDetected: boolean;
  };
};

export type CloudStorageConfig = {
  provider: StorageProvider;
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  presignSeconds: number;
  isSimulated: boolean;
};
