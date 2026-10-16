import { createHash, createHmac, randomUUID } from 'node:crypto';

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const PRIVATE_STORAGE_BUCKET = 'tracefab-private';
const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_ANTIVIRUS_TIMEOUT_MS = 15_000;

function requestSignal(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

type StorageConfig = {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  presignSeconds: number;
  requestTimeoutMs: number;
};

type AntivirusConfig = {
  url: URL;
  token: string;
  timeoutMs: number;
};

type SignedObject = { url: string; headers: Record<string, string>; expiresInSeconds: number };

type StorageLogEvent = 'upload_intent' | 'scan' | 'download' | 'security_report' | 'supplier_documents' | 'verification_report' | 'verify_ai';

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('private_storage_not_configured');
  return value;
}

function timeoutSetting(name: string, fallback: number, maximum: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > maximum) {
    throw new Error(name === 'PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS'
      ? 'private_storage_antivirus_timeout_invalid'
      : 'private_storage_timeout_invalid');
  }
  return value;
}

function validatedServiceUrl(value: string, errorCode: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(errorCode);
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error(errorCode === 'private_storage_endpoint_invalid'
      ? 'private_storage_https_required'
      : 'private_storage_antivirus_https_required');
  }
  return url;
}

export function storageConfig(): StorageConfig {
  const endpoint = validatedServiceUrl(requiredEnv('PRIVATE_STORAGE_ENDPOINT'), 'private_storage_endpoint_invalid');
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
    requestTimeoutMs: timeoutSetting('PRIVATE_STORAGE_REQUEST_TIMEOUT_MS', DEFAULT_STORAGE_REQUEST_TIMEOUT_MS, 60_000),
  };
}

export function antivirusConfig(): AntivirusConfig {
  const url = validatedServiceUrl(requiredEnv('PRIVATE_STORAGE_ANTIVIRUS_URL'), 'private_storage_antivirus_url_invalid');
  return {
    url,
    token: requiredEnv('PRIVATE_STORAGE_ANTIVIRUS_TOKEN'),
    timeoutMs: timeoutSetting('PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS', DEFAULT_ANTIVIRUS_TIMEOUT_MS, 60_000),
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
  const signedHeaders = method === 'PUT' ? 'content-type;host;if-none-match' : 'host';
  const canonicalHeaders = method === 'PUT'
    ? `content-type:${contentType}\nhost:${url.host}\nif-none-match:*\n`
    : `host:${url.host}\n`;
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(config.presignSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`).join('&');
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, timestamp.slice(0, 8)), stringToSign).toString('hex');
  query.set('X-Amz-Signature', signature);
  url.search = query.toString();
  const headers = method === 'PUT'
    ? { 'Content-Type': contentType!, 'If-None-Match': '*' }
    : {};
  return { url: url.toString(), headers, expiresInSeconds: config.presignSeconds };
}

export function presignedUpload(key: string, contentType: string) { return presigned('PUT', key, contentType); }
export function presignedDownload(key: string) { return presigned('GET', key); }

async function signedRequest<T>(method: 'HEAD' | 'GET', key: string, consume: (response: Response) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
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
  const request = requestSignal(config.requestTimeoutMs, parentSignal);
  try {
    const response = await fetch(url, {
      method,
      headers: { Host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': timestamp, Authorization: authorization },
      signal: request.signal,
      redirect: 'error',
    });
    if (response.status === 404) throw new Error('document_object_not_found');
    if (!response.ok) throw new Error(method === 'HEAD' ? 'private_storage_head_failed' : 'private_storage_download_failed');
    return await consume(response);
  } catch (error) {
    if (error instanceof Error && /^(document_|private_storage_)/.test(error.message)) throw error;
    if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new Error('private_storage_timeout');
    throw new Error('private_storage_unreachable');
  } finally {
    request.dispose();
  }
}

export async function headObject(key: string, signal?: AbortSignal) {
  return signedRequest('HEAD', key, async (response) => {
    const rawLength = response.headers.get('content-length');
    const byteSize = rawLength === null ? Number.NaN : Number(rawLength);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new Error('private_storage_invalid_object_metadata');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || null;
    return { byteSize, contentType };
  }, signal);
}

export async function downloadObject(key: string, signal?: AbortSignal) {
  return signedRequest('GET', key, (response) => response.arrayBuffer(), signal);
}

export async function scanWithAntivirus(bytes: ArrayBuffer, filename: string, contentType: string, parentSignal?: AbortSignal) {
  const config = antivirusConfig();
  const request = requestSignal(config.timeoutMs, parentSignal);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': contentType,
        'X-Tracefab-Filename': safeObjectFilename(filename),
        'X-Tracefab-Scan-Protocol': 'tracefab-v1',
      },
      body: Buffer.from(bytes) as unknown as BodyInit,
      signal: request.signal,
      redirect: 'error',
    });
    if (response.status !== 200) throw new Error('private_storage_antivirus_unavailable');
    const payload = await response.json().catch(() => null) as { clean?: unknown; mimeType?: unknown; threat?: unknown } | null;
    if (!payload || typeof payload.clean !== 'boolean') throw new Error('private_storage_antivirus_invalid_response');
    const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.split(';', 1)[0].trim().toLowerCase() : null;
    if (payload.clean === true && !mimeType) throw new Error('private_storage_antivirus_invalid_response');
    return {
      clean: payload.clean,
      mimeType,
      threat: typeof payload.threat === 'string' ? payload.threat.slice(0, 120) : null,
    };
  } catch (error) {
    if (error instanceof Error && /^private_storage_antivirus_/.test(error.message)) throw error;
    if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new Error('private_storage_antivirus_timeout');
    throw new Error('private_storage_antivirus_unreachable');
  } finally {
    request.dispose();
  }
}

export function storageErrorCode(error: unknown) {
  const candidate = error instanceof Error ? error.message : '';
  return /^(?:private_storage|document)_[a-z0-9_]+$/.test(candidate)
    ? candidate
    : 'private_storage_operation_failed';
}

/** Log only a fixed event name and a safe, allow-listed error code; never the exception, URL or request body. */
export function logStorageFailure(event: StorageLogEvent, error: unknown) {
  console.error(JSON.stringify({
    schema: 'tracefab-private-storage-error-v1',
    event,
    code: storageErrorCode(error),
  }));
}
