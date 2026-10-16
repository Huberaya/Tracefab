import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  antivirusConfig,
  downloadObject,
  headObject,
  logStorageFailure,
  presignedUpload,
  scanWithAntivirus,
  storageConfig,
  storageErrorCode,
  storageObjectKey,
} from '../api/_lib/storage.ts';
import {
  documentAntivirusSummary,
  documentMetadata,
  finalizeDocumentUpload,
  presignedDownloadForDocument,
  scanDocumentStorage,
  serializeDocument,
  type DocumentRecord,
} from '../api/_lib/documents.ts';
import { analyzeDocumentBytes, runAntivirusPipeline } from '../api/_lib/cloud-storage/antivirus-scanner.ts';
import { probeAntivirus, probeStorage } from '../api/_lib/readiness-probes.ts';

const scannerToken = 'unit-only-scanner-token-do-not-log';
const accessKeyId = 'unit-only-access-key';
const secretAccessKey = 'unit-only-secret-key-do-not-log';
const documentBytes = Buffer.from('%PDF-1.7\n% test-only storage double\n%%EOF', 'utf8');

type StoredObject = { bytes: Buffer; contentType: string };
type ServerMode = 'normal' | 'unavailable' | 'delay';
type ScannerMode = 'clean' | 'infected' | 'unavailable' | 'invalid' | 'missing-mime' | 'delay' | 'long-delay';

const objects = new Map<string, StoredObject>();
let s3Mode: ServerMode = 'normal';
let scannerMode: ScannerMode = 'clean';
let s3HeadCount = 0;
let s3PutCount = 0;
let scannerPostCount = 0;
let scannerHeadCount = 0;
let signatureCheckCount = 0;
let signatureFailureCount = 0;
let headerSignatureCheckCount = 0;
let headerSignatureFailureCount = 0;
let lastScannerRequest: { method: string; authorization?: string; protocol?: string; contentType?: string; body: Buffer } | null = null;

function awsEncode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer | string, value: string) { return createHmac('sha256', key).update(value).digest(); }
function normalizedHeader(value: string | string[] | undefined) { return String(Array.isArray(value) ? value.join(',') : value || '').trim().replace(/\s+/g, ' '); }

function expectedSigV4Signature(canonicalRequest: string, timestamp: string, scope: string) {
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, digest(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${secretAccessKey}`, timestamp.slice(0, 8));
  const regionKey = hmac(dateKey, scope.split('/')[1]);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

function canonicalHeaderBlock(url: URL, headers: IncomingMessage['headers'], signedHeaders: string) {
  return signedHeaders.split(';').map((name) => {
    const value = name === 'host' ? url.host : normalizedHeader(headers[name]);
    return `${name}:${value}\n`;
  }).join('');
}

function verifiesPresignedRequest(url: URL, method: string, headers: IncomingMessage['headers']) {
  const suppliedSignature = url.searchParams.get('X-Amz-Signature');
  const timestamp = url.searchParams.get('X-Amz-Date');
  const credential = url.searchParams.get('X-Amz-Credential');
  const scope = credential?.split('/').slice(1).join('/');
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
  if (!suppliedSignature || !timestamp || !scope || !signedHeaders || url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return false;
  if (credential?.split('/')[0] !== accessKeyId) return false;
  const query = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join('&');
  const canonicalRequest = [method, url.pathname, query, canonicalHeaderBlock(url, headers, signedHeaders), signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  return expectedSigV4Signature(canonicalRequest, timestamp, scope) === suppliedSignature;
}

function verifiesAuthorizationRequest(url: URL, method: string, headers: IncomingMessage['headers']) {
  const authorization = normalizedHeader(headers.authorization);
  const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(authorization);
  const timestamp = normalizedHeader(headers['x-amz-date']);
  if (!match || !timestamp) return false;
  const [, credential, signedHeaders, suppliedSignature] = match;
  const scope = credential.split('/').slice(1).join('/');
  if (credential.split('/')[0] !== accessKeyId) return false;
  const query = [...url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join('&');
  const payloadHash = normalizedHeader(headers['x-amz-content-sha256']);
  const canonicalRequest = [method, url.pathname, query, canonicalHeaderBlock(url, headers, signedHeaders), signedHeaders, payloadHash].join('\n');
  return expectedSigV4Signature(canonicalRequest, timestamp, scope) === suppliedSignature;
}
function readRequestBody(req: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function replyAfter(res: ServerResponse, delayMs: number, status: number, body = '') {
  setTimeout(() => {
    if (res.destroyed) return;
    res.statusCode = status;
    if (body) res.end(body);
    else res.end();
  }, delayMs);
}

const server: Server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (requestUrl.pathname === '/scan') {
    if (req.method === 'HEAD') {
      scannerHeadCount += 1;
      res.statusCode = 405;
      res.end();
      return;
    }
    const body = await readRequestBody(req);
    scannerPostCount += 1;
    lastScannerRequest = {
      method: req.method || '',
      authorization: req.headers.authorization,
      protocol: req.headers['x-tracefab-scan-protocol'] as string | undefined,
      contentType: req.headers['content-type'],
      body,
    };
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (scannerMode === 'delay' || scannerMode === 'long-delay') {
      replyAfter(res, scannerMode === 'long-delay' ? 1_500 : 300, 200, JSON.stringify({ clean: true, mimeType: 'application/pdf' }));
      return;
    }
    if (scannerMode === 'unavailable') {
      res.statusCode = 503;
      res.end('test-double-unavailable');
      return;
    }
    if (scannerMode === 'invalid') {
      res.statusCode = 200;
      res.end('not-json');
      return;
    }
    if (scannerMode === 'missing-mime') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ clean: true }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(scannerMode === 'infected'
      ? { clean: false, mimeType: 'application/pdf', threat: 'TEST_FIXTURE_SIGNATURE' }
      : { clean: true, mimeType: 'application/pdf' }));
    return;
  }

  const prefix = '/s3/tracefab-private/';
  if (!requestUrl.pathname.startsWith(prefix)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const key = requestUrl.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
  if (requestUrl.searchParams.has('X-Amz-Signature')) {
    signatureCheckCount += 1;
    if (!verifiesPresignedRequest(requestUrl, req.method || '', req.headers)) {
      signatureFailureCount += 1;
      res.statusCode = 403;
      res.end('signature-mismatch');
      return;
    }
  } else if ((req.method === 'HEAD' || req.method === 'GET') && req.headers.authorization) {
    headerSignatureCheckCount += 1;
    if (!verifiesAuthorizationRequest(requestUrl, req.method, req.headers)) {
      headerSignatureFailureCount += 1;
      res.statusCode = 403;
      res.end('authorization-signature-mismatch');
      return;
    }
  }
  if (s3Mode === 'delay') {
    if (req.method === 'HEAD') s3HeadCount += 1;
    replyAfter(res, 300, 200, req.method === 'GET' ? '' : '');
    return;
  }
  if (s3Mode === 'unavailable') {
    res.statusCode = 503;
    res.end('test-double-unavailable');
    return;
  }

  if (req.method === 'PUT') {
    s3PutCount += 1;
    if (req.headers['if-none-match'] !== '*') {
      res.statusCode = 400;
      res.end('conditional-write-required');
      return;
    }
    if (objects.has(key)) {
      res.statusCode = 412;
      res.end('precondition-failed');
      return;
    }
    const bytes = await readRequestBody(req);
    objects.set(key, { bytes, contentType: String(req.headers['content-type'] || '') });
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    s3HeadCount += 1;
    const object = objects.get(key);
    if (!object) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Length', String(object.bytes.byteLength));
    res.setHeader('Content-Type', object.contentType);
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method === 'GET') {
    const object = objects.get(key);
    if (!object) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Length', String(object.bytes.byteLength));
    res.setHeader('Content-Type', object.contentType);
    res.statusCode = 200;
    res.end(object.bytes);
    return;
  }

  res.statusCode = 405;
  res.end();
});

function baseDocument(key: string, byteSize: number, contentType = 'application/pdf', status = 'uploaded'): DocumentRecord {
  const now = new Date();
  return {
    id: '7f3d6339-4b47-4d3d-9f1d-3aee6f788008',
    owner_organization_id: '30ca1d2a-b1d1-4b7a-8ef0-38d7a5a8f002',
    storage_bucket: 'tracefab-private',
    storage_path: key,
    original_filename: 'fixture.pdf',
    content_type: contentType,
    byte_size: BigInt(byteSize),
    sha256: null,
    kind: 'certificate',
    status,
    visibility: 'private',
    expires_at: null,
    uploaded_by: '2fb8d7cc-7de7-41a1-9454-3a74c3e0bc47',
    created_at: now,
    metadata: { source: 'local-test-double', security_scan: { clean: true, forged: true } },
    available_at: status === 'available' ? now : null,
    deleted_at: null,
    updated_at: now,
  } as unknown as DocumentRecord;
}

function fakeTransaction(document: DocumentRecord) {
  const finalizations: Array<{ sha256: string; scanPassed: boolean; byteSize: number }> = [];
  const tx = {
    async $executeRaw() { return 1; },
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const query = strings.join('?');
      if (!query.includes('tracefab_finalize_document_upload')) throw new Error('unexpected_test_query');
      const [id, sha256, scanPassed, byteSize] = values;
      finalizations.push({ sha256: String(sha256), scanPassed: Boolean(scanPassed), byteSize: Number(byteSize) });
      return [{ ...document, id: String(id), sha256: String(sha256), byte_size: BigInt(Number(byteSize)), status: scanPassed ? 'available' : 'rejected', available_at: scanPassed ? new Date() : null }];
    },
  };
  return { tx: tx as never, finalizations };
}

async function closeServer(serverToClose: Server) {
  serverToClose.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => serverToClose.close((error) => error ? reject(error) : resolve()));
}

const listener = await new Promise<AddressInfo>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address() as AddressInfo));
});
const origin = `http://127.0.0.1:${listener.port}`;
Object.assign(process.env, {
  NODE_ENV: 'test',
  PRIVATE_STORAGE_ENDPOINT: `${origin}/s3`,
  PRIVATE_STORAGE_BUCKET: 'tracefab-private',
  PRIVATE_STORAGE_REGION: 'test-region-1',
  PRIVATE_STORAGE_ACCESS_KEY_ID: accessKeyId,
  PRIVATE_STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
  PRIVATE_STORAGE_PRESIGN_SECONDS: '600',
  PRIVATE_STORAGE_REQUEST_TIMEOUT_MS: '1000',
  PRIVATE_STORAGE_ANTIVIRUS_URL: `${origin}/scan`,
  PRIVATE_STORAGE_ANTIVIRUS_TOKEN: scannerToken,
  PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS: '1000',
});

try {
  assert.equal(storageConfig().bucket, 'tracefab-private');
  assert.equal(antivirusConfig().url.toString(), `${origin}/scan`);

  console.log('[1/10] S3 PUT capability is signed, short-lived and one-write only');
  const key = storageObjectKey('30ca1d2a-b1d1-4b7a-8ef0-38d7a5a8f002', 'fixture.pdf');
  const uploadIntent = presignedUpload(key, 'application/pdf');
  const signedUploadUrl = new URL(uploadIntent.url);
  assert.equal(signedUploadUrl.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host;if-none-match');
  assert.equal(signedUploadUrl.searchParams.get('X-Amz-Expires'), '600');
  assert.deepEqual(uploadIntent.headers, { 'Content-Type': 'application/pdf', 'If-None-Match': '*' });
  const putResponse = await fetch(uploadIntent.url, { method: 'PUT', headers: uploadIntent.headers, body: documentBytes });
  assert.equal(putResponse.status, 200);
  const replayResponse = await fetch(uploadIntent.url, { method: 'PUT', headers: uploadIntent.headers, body: documentBytes });
  assert.equal(replayResponse.status, 412, 'the storage double must reject replay of the same PUT capability');
  const alteredType = await fetch(uploadIntent.url, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-None-Match': '*' }, body: documentBytes });
  const omittedCondition = await fetch(uploadIntent.url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: documentBytes });
  assert.equal(alteredType.status, 403, 'signed Content-Type must not be alterable');
  assert.equal(omittedCondition.status, 403, 'signed If-None-Match condition must not be omittable');
  assert.equal(s3PutCount, 2);

  console.log('[2/10] HEAD/GET metadata and private temporary download signing');
  const objectHead = await headObject(key);
  assert.deepEqual(objectHead, { byteSize: documentBytes.byteLength, contentType: 'application/pdf' });
  assert.deepEqual(Buffer.from(await downloadObject(key)), documentBytes);
  const uploadedDocument = baseDocument(key, documentBytes.byteLength, 'application/pdf', 'available');
  const download = await presignedDownloadForDocument(uploadedDocument);
  assert.equal(new URL(download.url).searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(new URL(download.url).searchParams.get('X-Amz-Expires'), '600');
  assert.equal(download.expiresInSeconds, 600);
  const signedDownload = await fetch(download.url);
  assert.equal(signedDownload.status, 200);
  assert.deepEqual(Buffer.from(await signedDownload.arrayBuffer()), documentBytes);
  await assert.rejects(() => presignedDownloadForDocument({ ...uploadedDocument, status: 'rejected' }), /document_not_available/);
  await assert.rejects(() => presignedDownloadForDocument({ ...uploadedDocument, byte_size: BigInt(documentBytes.byteLength + 1) }), /document_storage_integrity_mismatch/);

  console.log('[3/10] MIME, size, kind and server-owned metadata validation');
  const validInput = { originalFilename: 'fixture.pdf', contentType: 'application/pdf', byteSize: documentBytes.byteLength, kind: 'certificate', metadata: { source: 'local-test-double' } };
  assert.equal(documentMetadata(validInput).contentType, 'application/pdf');
  assert.throws(() => documentMetadata({ ...validInput, contentType: 'application/x-msdownload' }), /document_content_type_not_allowed/);
  assert.throws(() => documentMetadata({ ...validInput, byteSize: 50 * 1024 * 1024 + 1 }), /document_size_limit_exceeded/);
  assert.equal(documentMetadata({ ...validInput, byteSize: 50 * 1024 * 1024 }).byteSize, 50 * 1024 * 1024);
  assert.throws(() => documentMetadata({ ...validInput, metadata: { security_scan: { clean: true } } }), /invalid_document_metadata_reserved_key/);
  assert.throws(() => documentMetadata({ ...validInput, metadata: { scan_passed: true } }), /invalid_document_metadata_reserved_key/);
  assert.equal('security_scan' in (serializeDocument(uploadedDocument).metadata as Record<string, unknown>), false);
  assert.equal(documentAntivirusSummary({ status: 'rejected', available_at: null }).clean, false);
  assert.equal(documentAntivirusSummary({ status: 'rejected', available_at: null }).status, 'quarantined');
  assert.equal(documentAntivirusSummary({ status: 'available', available_at: new Date() }).engine, null);

  console.log('[4/10] S3/scanner I/O is transaction-free; the short SQL finalizer gets only actual bytes and scanner verdict (transaction double)');
  scannerMode = 'clean';
  const cleanSourceDocument = baseDocument(key, documentBytes.byteLength);
  const cleanOutcome = await scanDocumentStorage(cleanSourceDocument);
  const cleanTx = fakeTransaction(cleanSourceDocument);
  const cleanDocument = await finalizeDocumentUpload(cleanTx.tx, cleanSourceDocument.id, cleanOutcome);
  assert.equal(cleanDocument.status, 'available');
  assert.equal(cleanTx.finalizations.length, 1);
  assert.equal(cleanTx.finalizations[0].scanPassed, true);
  assert.equal(cleanTx.finalizations[0].byteSize, documentBytes.byteLength);
  assert.match(cleanTx.finalizations[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(lastScannerRequest?.method, 'POST');
  assert.equal(lastScannerRequest?.authorization, `Bearer ${scannerToken}`);
  assert.equal(lastScannerRequest?.protocol, 'tracefab-v1');
  assert.deepEqual(lastScannerRequest?.body, documentBytes);

  console.log('[5/10] Infected result is rejected; scanner errors never finalize clean');
  scannerMode = 'infected';
  const infectedSourceDocument = baseDocument(key, documentBytes.byteLength);
  const infectedOutcome = await scanDocumentStorage(infectedSourceDocument);
  const infectedTx = fakeTransaction(infectedSourceDocument);
  const rejected = await finalizeDocumentUpload(infectedTx.tx, infectedSourceDocument.id, infectedOutcome);
  assert.equal(rejected.status, 'rejected');
  assert.equal(infectedTx.finalizations[0].scanPassed, false);
  scannerMode = 'unavailable';
  const unavailableSourceDocument = baseDocument(key, documentBytes.byteLength);
  const unavailableTx = fakeTransaction(unavailableSourceDocument);
  let unavailableFinalized = false;
  await assert.rejects(async () => {
    const outcome = await scanDocumentStorage(unavailableSourceDocument);
    unavailableFinalized = true;
    return finalizeDocumentUpload(unavailableTx.tx, unavailableSourceDocument.id, outcome);
  }, /private_storage_antivirus_unavailable/);
  assert.equal(unavailableFinalized, false, 'no finalization transaction is entered when the scanner is unavailable');
  assert.equal(unavailableTx.finalizations.length, 0);
  scannerMode = 'invalid';
  await assert.rejects(() => scanWithAntivirus(documentBytes.buffer.slice(documentBytes.byteOffset, documentBytes.byteOffset + documentBytes.byteLength) as ArrayBuffer, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_invalid_response/);
  scannerMode = 'missing-mime';
  await assert.rejects(() => scanWithAntivirus(documentBytes.buffer.slice(documentBytes.byteOffset, documentBytes.byteOffset + documentBytes.byteLength) as ArrayBuffer, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_invalid_response/);
  scannerMode = 'clean';
  assert.equal(scannerHeadCount, 0);
  assert.ok(scannerPostCount >= 5);

  console.log('[6/10] Missing objects fail; MIME/size mismatches are rejected and actual bytes are accounted');
  await assert.rejects(() => headObject('tenant/missing/not-found.pdf'), /document_object_not_found/);
  const wrongTypeKey = storageObjectKey('30ca1d2a-b1d1-4b7a-8ef0-38d7a5a8f002', 'wrong-type.pdf');
  const wrongTypePut = presignedUpload(wrongTypeKey, 'application/octet-stream');
  assert.equal((await fetch(wrongTypePut.url, { method: 'PUT', headers: wrongTypePut.headers, body: documentBytes })).status, 200);
  const wrongTypeDocument = baseDocument(wrongTypeKey, documentBytes.byteLength, 'application/pdf');
  const wrongTypeOutcome = await scanDocumentStorage(wrongTypeDocument);
  const wrongTypeTx = fakeTransaction(wrongTypeDocument);
  const wrongTypeRejected = await finalizeDocumentUpload(wrongTypeTx.tx, wrongTypeDocument.id, wrongTypeOutcome);
  assert.equal(wrongTypeRejected.status, 'rejected');
  assert.equal(wrongTypeTx.finalizations[0].scanPassed, false);
  const sizeMismatchDocument = baseDocument(key, documentBytes.byteLength + 1);
  const sizeMismatchOutcome = await scanDocumentStorage(sizeMismatchDocument);
  const sizeMismatchTx = fakeTransaction(sizeMismatchDocument);
  const sizeMismatchRejected = await finalizeDocumentUpload(sizeMismatchTx.tx, sizeMismatchDocument.id, sizeMismatchOutcome);
  assert.equal(sizeMismatchRejected.status, 'rejected');
  assert.equal(sizeMismatchTx.finalizations[0].scanPassed, false);
  assert.equal(sizeMismatchTx.finalizations[0].byteSize, documentBytes.byteLength);

  console.log('[7/10] Storage unavailable and request timeout are bounded failures');
  s3Mode = 'unavailable';
  const failedUpload = await fetch(presignedUpload(storageObjectKey('tenant', 'unavailable.pdf'), 'application/pdf').url, {
    method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'If-None-Match': '*' }, body: documentBytes,
  });
  assert.equal(failedUpload.status, 503);
  await assert.rejects(() => headObject(key), /private_storage_head_failed/);
  s3Mode = 'delay';
  process.env.PRIVATE_STORAGE_REQUEST_TIMEOUT_MS = '100';
  await assert.rejects(() => headObject(key), /private_storage_timeout/);
  s3Mode = 'normal';
  process.env.PRIVATE_STORAGE_REQUEST_TIMEOUT_MS = '1000';

  console.log('[8/10] Readiness exercises POST scan contract, not HEAD reachability');
  scannerMode = 'clean';
  const liveScannerProbe = await probeAntivirus();
  assert.equal(liveScannerProbe.reachable, true);
  assert.equal(lastScannerRequest?.method, 'POST');
  assert.equal(lastScannerRequest?.protocol, 'tracefab-v1');
  assert.equal(scannerHeadCount, 0);
  objects.set('tracefab-readiness-probe/.keep', { bytes: Buffer.alloc(0), contentType: 'application/octet-stream' });
  const liveStorageProbe = await probeStorage();
  assert.equal(liveStorageProbe.reachable, true, 'a signed HEAD 200 for the private zero-byte sentinel proves object access without ListBucket');
  objects.delete('tracefab-readiness-probe/.keep');
  assert.equal((await probeStorage()).reachable, false, 'a missing readiness sentinel must not be reported as ready');
  objects.set('tracefab-readiness-probe/.keep', { bytes: Buffer.alloc(0), contentType: 'application/octet-stream' });
  s3Mode = 'unavailable';
  assert.equal((await probeStorage()).reachable, false);
  s3Mode = 'normal';
  scannerMode = 'unavailable';
  assert.equal((await probeAntivirus()).reachable, false);

  console.log('[9/10] Scanner timeout, readiness deadline, missing config and diagnostic heuristics are not antivirus proof');
  const priorReadinessTimeout = process.env.TRACEFAB_READINESS_PROBE_TIMEOUT_MS;
  process.env.TRACEFAB_READINESS_PROBE_TIMEOUT_MS = '1000';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS = '5000';
  scannerMode = 'long-delay';
  const boundedReadiness = await probeAntivirus();
  assert.equal(boundedReadiness.reachable, false, 'the readiness-wide deadline must bound the slower scanner probe');
  assert.match(boundedReadiness.detail, /readiness_probe_timeout|private_storage_antivirus_timeout/);
  if (priorReadinessTimeout === undefined) delete process.env.TRACEFAB_READINESS_PROBE_TIMEOUT_MS;
  else process.env.TRACEFAB_READINESS_PROBE_TIMEOUT_MS = priorReadinessTimeout;

  scannerMode = 'delay';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS = '100';
  await assert.rejects(() => scanWithAntivirus(documentBytes.buffer.slice(documentBytes.byteOffset, documentBytes.byteOffset + documentBytes.byteLength) as ArrayBuffer, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_timeout/);
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS = '1000';
  scannerMode = 'clean';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = 'http://127.0.0.1:1/scan';
  await assert.rejects(() => scanWithAntivirus(documentBytes.buffer.slice(documentBytes.byteOffset, documentBytes.byteOffset + documentBytes.byteLength) as ArrayBuffer, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_unreachable/);
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = '';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN = '';
  const postCountBeforeMissingConfig = scannerPostCount;
  await assert.rejects(() => runAntivirusPipeline(documentBytes.buffer.slice(documentBytes.byteOffset, documentBytes.byteOffset + documentBytes.byteLength) as ArrayBuffer, 'fixture.pdf', 'application/pdf'), /private_storage_not_configured/);
  assert.equal(scannerPostCount, postCountBeforeMissingConfig, 'no heuristic fallback or network call is permitted when unconfigured');
  assert.equal((await probeAntivirus()).reachable, false);
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = `${origin}/scan`;
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN = scannerToken;
  const heuristic = analyzeDocumentBytes(documentBytes, 'fixture.pdf', 'application/pdf');
  assert.equal(heuristic.clean, true, 'diagnostic heuristic result is deliberately not used for finalization');
  assert.match(heuristic.engine, /heuristic/i);

  console.log('[10/10] Storage error logs contain neither credentials nor exception text');
  const originalError = console.error;
  let logOutput = '';
  console.error = (...args: unknown[]) => { logOutput += args.map(String).join(' '); };
  try {
    logStorageFailure('scan', new Error(`request ${origin}/scan?token=${scannerToken} Authorization Bearer ${secretAccessKey}`));
  } finally {
    console.error = originalError;
  }
  assert.equal(logOutput.includes(scannerToken), false);
  assert.equal(logOutput.includes(secretAccessKey), false);
  assert.equal(logOutput.includes('/scan'), false);
  assert.equal(storageErrorCode(new Error('private_storage_antivirus_timeout')), 'private_storage_antivirus_timeout');
  assert.equal(storageErrorCode(new Error(`unexpected ${secretAccessKey}`)), 'private_storage_operation_failed');
  assert.ok(signatureCheckCount >= 6, 'the local storage double must independently verify presigned SigV4 requests');
  assert.equal(signatureFailureCount, 2, 'only the two deliberately altered presigned requests should fail signature verification');
  assert.ok(headerSignatureCheckCount >= 8, 'the local storage double must independently verify signed HEAD/GET requests');
  assert.equal(headerSignatureFailureCount, 0, 'all server-signed S3 HEAD/GET requests must validate');

  console.log('PASS — 10 behavioral groups passed against explicitly local in-memory S3/scanner HTTP doubles; no external service was contacted.');
} finally {
  await closeServer(server);
}
