import { createHash, createHmac, randomUUID } from 'node:crypto';

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const PRIVATE_STORAGE_BUCKET = 'tracefab-private';

type StorageConfig = {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  presignSeconds: number;
};

type SignedObject = { url: string; headers: Record<string, string> };

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('private_storage_not_configured');
  return value;
}

export function storageConfig(): StorageConfig {
  let endpoint: URL;
  try {
    endpoint = new URL(requiredEnv('PRIVATE_STORAGE_ENDPOINT'));
    if (endpoint.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('private_storage_https_required');
  } catch (error) {
    if (error instanceof Error && error.message === 'private_storage_https_required') throw error;
    throw new Error('private_storage_endpoint_invalid');
  }
  const configuredBucket = process.env.PRIVATE_STORAGE_BUCKET?.trim() || PRIVATE_STORAGE_BUCKET;
  if (configuredBucket !== PRIVATE_STORAGE_BUCKET) throw new Error('private_storage_bucket_invalid');
  const presignSeconds = Number(process.env.PRIVATE_STORAGE_PRESIGN_SECONDS || 600);
  if (!Number.isInteger(presignSeconds) || presignSeconds < 60 || presignSeconds > 3600) throw new Error('private_storage_presign_window_invalid');
  return {
    endpoint,
    bucket: PRIVATE_STORAGE_BUCKET,
    region: process.env.PRIVATE_STORAGE_REGION?.trim() || 'auto',
    accessKeyId: requiredEnv('PRIVATE_STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('PRIVATE_STORAGE_SECRET_ACCESS_KEY'),
    presignSeconds,
  };
}

export function safeObjectFilename(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 240 || value.includes('\0')) throw new Error('invalid_document_filename');
  const base = value.trim().split(/[\\/]/).pop() || '';
  const sanitized = base.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 180);
  if (!sanitized) throw new Error('invalid_document_filename');
  return sanitized;
}

export function storageObjectKey(ownerOrganizationId: string, originalFilename: string) {
  return `${ownerOrganizationId}/${randomUUID()}/${safeObjectFilename(originalFilename)}`;
}

export { MAX_DOCUMENT_BYTES };

function sha256(value: string | Buffer) { return createHash('sha256').update(value as unknown as Uint8Array<ArrayBuffer>).digest('hex'); }
function hmac(key: Buffer | string, value: string) { return createHmac('sha256', key as unknown as Uint8Array<ArrayBuffer>).update(value).digest(); }
function awsEncode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function canonicalPath(config: StorageConfig, key: string) { return `${config.endpoint.pathname.replace(/\/$/, '')}/${awsEncode(config.bucket)}/${key.split('/').map(awsEncode).join('/')}` || '/'; }
function objectUrl(config: StorageConfig, key: string) { const url = new URL(config.endpoint); url.pathname = canonicalPath(config, key); url.search = ''; return url; }
function signingKey(config: StorageConfig, date: string) {
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}
function amzDate(date: Date) { return date.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'; }
function scope(date: Date, config: StorageConfig) { return `${amzDate(date).slice(0, 8)}/${config.region}/s3/aws4_request`; }

function presigned(method: 'PUT' | 'GET', key: string, contentType?: string): SignedObject {
  const config = storageConfig();
  const now = new Date();
  const timestamp = amzDate(now);
  const credentialScope = scope(now, config);
  const url = objectUrl(config, key);
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(config.presignSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`).join('&');
  const canonicalHeaders = `host:${url.host}\n`;
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, timestamp.slice(0, 8)), stringToSign).toString('hex');
  query.set('X-Amz-Signature', signature);
  url.search = query.toString();
  return { url: url.toString(), headers: contentType ? { 'Content-Type': contentType } : {} };
}

export function presignedUpload(key: string, contentType: string) { return presigned('PUT', key, contentType); }
export function presignedDownload(key: string) { return presigned('GET', key); }

async function signedRequest(method: 'HEAD' | 'GET', key: string) {
  const config = storageConfig();
  const now = new Date();
  const timestamp = amzDate(now);
  const url = objectUrl(config, key);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = scope(now, config);
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, timestamp.slice(0, 8)), stringToSign).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url, { method, headers: { Host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': timestamp, Authorization: authorization } });
}

export async function headObject(key: string) {
  const response = await signedRequest('HEAD', key);
  if (!response.ok) throw new Error(response.status === 404 ? 'document_object_not_found' : 'private_storage_head_failed');
  const length = Number(response.headers.get('content-length') || 0);
  return { byteSize: length, contentType: response.headers.get('content-type') || null };
}

export async function downloadObject(key: string) {
  const response = await signedRequest('GET', key);
  if (!response.ok) throw new Error(response.status === 404 ? 'document_object_not_found' : 'private_storage_download_failed');
  return response.arrayBuffer();
}

export async function scanWithAntivirus(bytes: ArrayBuffer, filename: string, contentType: string) {
  const scannerUrl = process.env.PRIVATE_STORAGE_ANTIVIRUS_URL?.trim();
  const scannerToken = process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN?.trim();
  if (!scannerUrl || !scannerToken) throw new Error('private_storage_antivirus_not_configured');
  const response = await fetch(scannerUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${scannerToken}`, 'Content-Type': contentType, 'X-Tracefab-Filename': filename, 'X-Tracefab-Scan-Protocol': 'tracefab-v1' },
    body: Buffer.from(bytes) as unknown as BodyInit,
  });
  const payload = await response.json().catch(() => null) as { clean?: unknown; mimeType?: unknown } | null;
  if (!response.ok || !payload || typeof payload.clean !== 'boolean') throw new Error('private_storage_antivirus_invalid_response');
  return { clean: payload.clean, mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : null };
}
