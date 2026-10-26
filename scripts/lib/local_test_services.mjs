/**
 * Services de TEST locaux pour les parcours HTTP authentifies.
 *
 * CE QUE CE MODULE EST — et n'est PAS
 *
 * Il ne remplace AUCUN code applicatif. Le routeur, l'authentification
 * (`requireClerkUser` -> `verifyToken` de @clerk/backend), le client Prisma,
 * les fonctions SQL/RLS, la signature SigV4 et le protocole antivirus sont
 * ceux du depot. Ce module fournit uniquement les SERVICES EXTERNES auxquels
 * ces codes parlent, sur 127.0.0.1, avec des identites et des cles
 * EPHEMERES creees a chaque execution :
 *
 *   - un fournisseur d'identite compatible Clerk (JWKS + BAPI /v1/users),
 *     avec de VRAIS jetons RS256 verifies par le vrai `verifyToken` ;
 *   - un stockage objet compatible S3 qui VERIFIE la signature AWS SigV4
 *     (une requete non signee, expiree ou au mauvais moyen HTTP est refusee) ;
 *   - un service d'analyse antivirus appliquant le protocole `tracefab-v1`,
 *     avec la signature de test EICAR (chaine inoffensive, jamais un virus).
 *
 * Ce ne sont PAS les services manages de preproduction. Leur execution
 * valide le parcours applicatif de bout en bout, PAS la configuration
 * Clerk ni le bucket R2/S3 de staging, qui restent a valider separement.
 *
 * Aucune valeur sensible n'est lue, ecrite ou journalisee ici. Les secrets
 * sont generes dans le processus et meurent avec lui.
 */
import http from 'node:http';
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';

const BUCKET = 'tracefab-private';
// Chaine de test EICAR reconstruite : aucun fichier du depot ne contient la
// signature antivirale complete (elle est inoffensive, mais les scanners la
// detectent).
const EICAR = ['EICAR', '-STANDARD', '-ANTIVIRUS', '-TEST', '-FILE'].join('');

/* ---------------------------------------------------------------------------
 * Fournisseur d'identite compatible Clerk — INSTANCE DE TEST LOCALE
 * ------------------------------------------------------------------------- */

/**
 * Cree une instance Clerk de test en memoire.
 *
 * `verifyToken` du code applicatif recupere la JWKS aupres de
 * `https://api.clerk.com/v1/jwks` ; `createClerkClient().users.getUser`
 * appelle `/v1/users/:id`. Sous NODE_ENV=test, @clerk/backend resout
 * `fetch` dynamiquement : l'interception ne modifie AUCUN module du depot,
 * elle sert ces deux routes depuis des cles ephemeres.
 *
 * @param {Array<{id: string, email: string, firstName: string, lastName: string}>} users
 */
export function startClerkTestIdp(users) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('clerk_test_idp_requires_node_env_test');
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `ins_test_${randomUUID().slice(0, 8)}`;
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] };
  const secretKey = `sk_test_tracefab_local_${randomBytes(12).toString('hex')}`;
  const byId = new Map(users.map((user) => [user.id, user]));
  const jetonsEmis = [];

  const originalFetch = globalThis.fetch;
  let interceptions = 0;
  let jetonsInvalidesServis = 0;

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url;
    let url;
    try { url = new URL(raw); } catch { return originalFetch(input, init); }
    if (url.host !== 'api.clerk.com') return originalFetch(input, init);
    interceptions += 1;
    if (url.pathname === '/v1/jwks') return json(jwks);
    const match = /^\/v1\/users\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const user = byId.get(decodeURIComponent(match[1]));
      if (!user) return json({ errors: [{ code: 'resource_not_found' }] }, 404);
      return json({
        object: 'user',
        id: user.id,
        primary_email_address_id: `idn_${user.id}`,
        email_addresses: [{
          id: `idn_${user.id}`,
          email_address: user.email,
          object: 'email_address',
          linked_to: [],
        }],
        first_name: user.firstName,
        last_name: user.lastName,
      });
    }
    return json({ errors: [{ code: 'resource_not_found' }] }, 404);
  };

  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

  /** Jeton de session RS256 signe par la cle privee de l'instance de test. */
  const issueToken = (userId, { expiresInSeconds = 900 } = {}) => {
    if (!byId.has(userId)) throw new Error('unknown_test_user');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64({
      sub: userId,
      sid: `sess_test_${randomUUID().slice(0, 8)}`,
      iss: 'https://instance-test.clerk.accounts.dev',
      iat: now,
      exp: now + expiresInSeconds,
      nbf: now - 5,
      azp: 'http://127.0.0.1:3000',
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const jwt = `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
    jetonsEmis.push(userId);
    return jwt;
  };

  /** Jeton correctement signe mais EXPIRE : doit etre refuse par verifyToken. */
  const issueExpiredToken = (userId) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64({
      sub: userId,
      sid: `sess_test_expired_${randomUUID().slice(0, 8)}`,
      iss: 'https://instance-test.clerk.accounts.dev',
      iat: now - 3600,
      exp: now - 600,
      nbf: now - 3600,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    jetonsInvalidesServis += 1;
    return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
  };

  /** Jeton signe par une cle etrangere : doit etre refuse par verifyToken. */
  const issueForgedToken = (userId) => {
    const autre = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64({
      sub: userId, iat: now, exp: now + 900, nbf: now - 5,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    jetonsInvalidesServis += 1;
    return `${unsigned}.${signer.sign(autre.privateKey).toString('base64url')}`;
  };

  /** Trois formes malformees : structure, base64 et algorithme. */
  const issueMalformedTokens = () => {
    jetonsInvalidesServis += 3;
    return [
      'not-a-jwt',
      'aaa.bbb.ccc',
      `${b64({ alg: 'none', typ: 'JWT', kid })}.${b64({ sub: 'user_test_malformed' })}.`,
    ];
  };

  return {
    secretKey,
    issueToken,
    issueExpiredToken,
    issueForgedToken,
    issueMalformedTokens,
    stats: () => ({ interceptions, jetonsEmis: jetonsEmis.length, jetonsInvalidesServis }),
    stop() { globalThis.fetch = originalFetch; },
  };
}

/* ---------------------------------------------------------------------------
 * Stockage objet compatible S3 — VERIFICATION SIGV4 REELLE
 * ------------------------------------------------------------------------- */

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const awsEncode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function expectedSignature(secretAccessKey, region, timestamp, scope, canonicalRequest) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, timestamp.slice(0, 8));
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n');
  return hmac(signingKey, stringToSign).toString('hex');
}

function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value || '');
  if (!match) return null;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
}

/**
 * Verifie une requete SigV4 (presigned query ou en-tete Authorization).
 * Refuse : signature absente, invalide, expiree, ou mauvais access key.
 */
function verifySigV4(method, url, headers, config) {
  const query = new URLSearchParams(url.search);
  const presigned = query.get('X-Amz-Signature');
  if (presigned) {
    const timestamp = query.get('X-Amz-Date') || '';
    const credential = query.get('X-Amz-Credential') || '';
    const accessKeyId = credential.split('/')[0];
    const scope = credential.slice(accessKeyId.length + 1);
    const created = parseAmzDate(timestamp);
    const expires = Number(query.get('X-Amz-Expires') || 0);
    if (accessKeyId !== config.accessKeyId || query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
      return { ok: false, reason: 'credential' };
    }
    if (created === null || !Number.isInteger(expires) || expires < 1 || Date.now() > created + expires * 1000) {
      return { ok: false, reason: 'expired' };
    }
    query.delete('X-Amz-Signature');
    const canonicalQuery = [...query.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
      .join('&');
    const canonicalRequest = [
      method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD',
    ].join('\n');
    const expected = expectedSignature(config.secretAccessKey, config.region, timestamp, scope, canonicalRequest);
    return expected === presigned ? { ok: true, kind: 'presigned' } : { ok: false, reason: 'signature' };
  }

  const authorization = headers.authorization || '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)$/.exec(authorization);
  if (!match) return { ok: false, reason: 'unsigned' };
  const [, credential, signedHeaders, signature] = match;
  const accessKeyId = credential.split('/')[0];
  const scope = credential.slice(accessKeyId.length + 1);
  const timestamp = headers['x-amz-date'] || '';
  const created = parseAmzDate(timestamp);
  if (accessKeyId !== config.accessKeyId || signedHeaders !== 'host;x-amz-content-sha256;x-amz-date') {
    return { ok: false, reason: 'credential' };
  }
  if (created === null || Math.abs(Date.now() - created) > 15 * 60 * 1000) {
    return { ok: false, reason: 'expired' };
  }
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${timestamp}\n`;
  const canonicalRequest = [
    method, url.pathname, '', canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const expected = expectedSignature(config.secretAccessKey, config.region, timestamp, scope, canonicalRequest);
  return expected === signature ? { ok: true, kind: 'header' } : { ok: false, reason: 'signature' };
}

/** Demarre le bucket de test et le service antivirus (deux ports distincts). */
export async function startPrivateStorageServices() {
  const accessKeyId = `AKIATEST${randomBytes(5).toString('hex').toUpperCase()}`;
  const secretAccessKey = randomBytes(24).toString('hex');
  const antivirusToken = randomBytes(24).toString('hex');
  const region = 'eu-west-1';
  const config = { accessKeyId, secretAccessKey, region };
  const objects = new Map();
  const refus = [];
  const lectures = [];
  const scans = [];

  const storageServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const prefix = `/${BUCKET}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const verdict = verifySigV4(req.method, url, req.headers, config);
    if (!verdict.ok) {
      refus.push({ method: req.method, path: url.pathname, reason: verdict.reason });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'access_denied', reason: verdict.reason }));
      return;
    }
    const key = url.pathname.slice(prefix.length);
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, {
        bytes: Buffer.concat(chunks),
        contentType: req.headers['content-type'] || 'application/octet-stream',
      });
      res.writeHead(200, { ETag: `"${sha256(Buffer.concat(chunks))}"` });
      res.end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_such_key' }));
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      lectures.push({ method: req.method, key, kind: verdict.kind });
      res.writeHead(200, {
        'Content-Type': object.contentType,
        'Content-Length': String(object.bytes.byteLength),
      });
      res.end(req.method === 'HEAD' ? undefined : object.bytes);
      return;
    }
    res.writeHead(405, { Allow: 'GET, HEAD, PUT' });
    res.end();
  });

  // Service d'analyse : protocole tracefab-v1, jeton bearer obligatoire.
  const antivirusServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/scan' || req.method !== 'POST'
        || req.headers.authorization !== `Bearer ${antivirusToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const filename = String(req.headers['x-tracefab-filename'] || '');
    const contentType = String(req.headers['content-type'] || 'application/octet-stream');
    const clean = !bytes.includes(EICAR);
    scans.push({ filename, contentType, bytes: bytes.byteLength, clean, protocol: req.headers['x-tracefab-scan-protocol'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clean, mimeType: contentType }));
  });

  const listen = (server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const [storagePort, antivirusPort] = await Promise.all([listen(storageServer), listen(antivirusServer)]);

  const close = (server) => new Promise((resolve) => server.close(() => resolve()));
  return {
    endpoint: `http://127.0.0.1:${storagePort}`,
    antivirusUrl: `http://127.0.0.1:${antivirusPort}/scan`,
    antivirusToken,
    accessKeyId,
    secretAccessKey,
    region,
    bucket: BUCKET,
    objects,
    stats: () => ({ stored: objects.size, refus: [...refus], lectures: [...lectures], scans: [...scans] }),
    async stop() { await Promise.all([close(storageServer), close(antivirusServer)]); },
  };
}

/** Pose UNIQUEMENT les variables du processus de test, jamais un fichier .env. */
export function applyLocalServiceEnv({ clerk, storage }) {
  process.env.CLERK_SECRET_KEY = clerk.secretKey;
  process.env.PRIVATE_STORAGE_ENDPOINT = storage.endpoint;
  process.env.PRIVATE_STORAGE_BUCKET = storage.bucket;
  process.env.PRIVATE_STORAGE_REGION = storage.region;
  process.env.PRIVATE_STORAGE_ACCESS_KEY_ID = storage.accessKeyId;
  process.env.PRIVATE_STORAGE_SECRET_ACCESS_KEY = storage.secretAccessKey;
  process.env.PRIVATE_STORAGE_PRESIGN_SECONDS = '600';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = storage.antivirusUrl;
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN = storage.antivirusToken;
}

/* ---------------------------------------------------------------------------
 * Adaptateur HTTP du VRAI routeur Vercel du depot
 * ------------------------------------------------------------------------- */

/**
 * Expose `api/index.ts` sur un vrai socket TCP. Les requetes du test sont
 * donc de vraies requetes HTTP : en-tetes, corps, codes de statut et
 * en-tetes de reponse sont ceux du serveur, pas un objet simule.
 */
export async function startApiHttpServer(handler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body_read_failed' }));
      return;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const query = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (Object.prototype.hasOwnProperty.call(query, key)) {
        query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
      } else query[key] = value;
    }
    req.query = query;
    req.url = url.pathname + url.search;
    if (raw) req.body = raw;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
      return res;
    };
    res.send = (body) => {
      if (typeof body === 'string' || Buffer.isBuffer(body)) res.end(body);
      else res.json(body);
      return res;
    };
    try {
      await handler(req, res);
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ error: 'internal_server_error', detail: String(error?.message || error) }));
    }
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() { await new Promise((resolve) => server.close(() => resolve())); },
  };
}
