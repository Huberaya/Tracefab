import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import {
  CLERK_FRONTEND_API_ORIGIN,
  CLERK_PROXY_PATH_QUERY,
  CLERK_PROXY_URL,
} from '../_lib/clerk-proxy.js';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
const PLATFORM_IP_HEADERS = new Set([
  'x-forwarded-for',
  'x-real-ip',
  'x-vercel-forwarded-for',
]);
const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'clerk-secret-key',
]);

type NodeRequestInit = RequestInit & { duplex?: 'half' };
type ProxyBody = { body?: BodyInit; duplex?: 'half'; jsonEncoded?: boolean } | { error: true };
type Fetcher = typeof fetch;

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Vercel overwrites x-forwarded-for and also provides x-vercel-forwarded-for.
 * Clerk requires the original client IP as the first value, so forward only
 * the first trusted Vercel IP rather than a client-supplied chain.
 */
function clientIp(req: VercelRequest): string | null {
  const candidates = [
    req.headers['x-vercel-forwarded-for'] as string | string[] | undefined,
    req.headers['x-forwarded-for'] as string | string[] | undefined,
    req.headers['x-real-ip'] as string | string[] | undefined,
  ];
  for (const candidate of candidates) {
    const value = firstHeader(candidate)?.split(',')[0]?.trim();
    if (value && !/[\r\n\s]/.test(value)) return value;
  }
  return null;
}

function connectionTokens(req: VercelRequest): Set<string> {
  const connection = firstHeader(req.headers.connection as string | string[] | undefined) || '';
  return new Set(connection.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function requestHeaders(req: VercelRequest, secretKey: string, ip: string): Headers {
  const headers = new Headers();
  const connection = connectionTokens(req);

  for (const [rawName, rawValue] of Object.entries(req.headers)) {
    const name = rawName.toLowerCase();
    if (
      rawValue === undefined
      || rawValue === null
      || HOP_BY_HOP_HEADERS.has(name)
      || PLATFORM_IP_HEADERS.has(name)
      || connection.has(name)
      || name === 'clerk-proxy-url'
      || name === 'clerk-secret-key'
    ) continue;

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const value = values.join(name === 'cookie' ? '; ' : ', ');
    try {
      headers.set(rawName, value);
    } catch {
      // Invalid optional browser headers must not prevent the auth request.
    }
  }

  // These values are always overwritten server-side. Never trust similarly
  // named headers supplied by the browser.
  headers.set('Clerk-Proxy-Url', CLERK_PROXY_URL);
  headers.set('Clerk-Secret-Key', secretKey);
  headers.set('X-Forwarded-For', ip);
  return headers;
}

function forwardedQuery(req: VercelRequest): string {
  const requestUrl = req.url || '/';
  try {
    const params = new URL(requestUrl, 'https://tracefab.vercel.app').searchParams;
    params.delete(CLERK_PROXY_PATH_QUERY);
    return params.toString();
  } catch {
    // Vercel always supplies req.url. This fallback keeps direct handler tests
    // and non-Vercel adapters usable without forwarding the router's internals.
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(req.query || {})) {
      if (name === CLERK_PROXY_PATH_QUERY || name === 'clerkPath' || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
    }
    return params.toString();
  }
}

function safePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (value.startsWith('/') || /[\\?#\u0000-\u001f\u007f]/.test(value)) return null;

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0)) return null;
  for (const segment of segments) {
    let decoded = segment;
    // Decode twice to reject encoded and double-encoded path traversal.
    for (let depth = 0; depth < 2; depth += 1) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        return null;
      }
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return null;
    }
  }
  return value;
}

function requestBody(req: VercelRequest, method: string): ProxyBody {
  if (method === 'GET' || method === 'HEAD') return {};

  const body = req.body;
  if (body === undefined || body === null) {
    if (req.readable && !req.readableEnded) {
      return { body: req as unknown as BodyInit, duplex: 'half' };
    }
    return {};
  }
  if (typeof body === 'string') return { body };
  if (Buffer.isBuffer(body)) return { body: body as unknown as BodyInit };
  if (body instanceof ArrayBuffer) return { body };
  if (ArrayBuffer.isView(body)) {
    return {
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit,
    };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return { body };
  if (typeof Blob !== 'undefined' && body instanceof Blob) return { body };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { body };
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return { body: body as unknown as BodyInit, duplex: 'half' };
  }

  if (typeof body === 'object') {
    const contentType = firstHeader(req.headers['content-type'] as string | string[] | undefined) || '';
    if (/multipart\/form-data/i.test(contentType)) {
      // Re-serializing parsed multipart data would discard its original boundary.
      // Vercel's raw IncomingMessage stream is the only lossless representation.
      return { error: true };
    }
    if (/application\/x-www-form-urlencoded/i.test(contentType)) {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined && item !== null) form.append(name, String(item));
        }
      }
      return { body: form };
    }
    return { body: JSON.stringify(body), jsonEncoded: true };
  }

  return { body: String(body) };
}

function copyResponseHeaders(upstream: Response, res: VercelResponse): void {
  const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === 'function' ? getSetCookie.call(upstream.headers) : [];

  upstream.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (lowerName === 'set-cookie' || RESPONSE_HOP_BY_HOP_HEADERS.has(lowerName)) return;
    try {
      res.setHeader(name, value);
    } catch {
      // Ignore a malformed optional upstream header, but keep the FAPI body.
    }
  });

  if (cookies.length > 0) {
    res.setHeader('Set-Cookie', cookies);
  } else {
    const cookie = upstream.headers.get('set-cookie');
    if (cookie) res.setHeader('Set-Cookie', cookie);
  }
  // Clerk responses can carry session state. Never let a CDN cache them.
  res.setHeader('Cache-Control', 'private, no-store');
}

export async function proxyClerkFrontendApi(
  req: VercelRequest,
  res: VercelResponse,
  fetcher: Fetcher = fetch,
) {
  const method = (req.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) return methodNotAllowed(res, METHODS);

  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  // This endpoint is specifically for the production proxy. Development
  // Clerk instances do not support Frontend API proxying.
  if (!secretKey || !secretKey.startsWith('sk_live_')) {
    return json(res, 503, { error: 'clerk_proxy_not_configured' });
  }

  const path = safePath(req.query.clerkPath);
  if (!path) return json(res, 400, { error: 'invalid_clerk_proxy_path' });

  const ip = clientIp(req);
  if (!ip) return json(res, 503, { error: 'clerk_proxy_client_ip_unavailable' });

  const target = new URL(`/${path}`, CLERK_FRONTEND_API_ORIGIN);
  if (target.origin !== CLERK_FRONTEND_API_ORIGIN) {
    return json(res, 400, { error: 'invalid_clerk_proxy_path' });
  }
  const query = forwardedQuery(req);
  if (query) target.search = query;

  const headers = requestHeaders(req, secretKey, ip);
  const body = requestBody(req, method);
  if ('error' in body) return json(res, 400, { error: 'invalid_clerk_proxy_body' });
  if (body.jsonEncoded && !headers.has('content-type')) headers.set('Content-Type', 'application/json');

  const init: NodeRequestInit = {
    method,
    headers,
    body: body.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  };
  if (body.duplex) init.duplex = body.duplex;

  try {
    const upstream = await fetcher(target, init);
    copyResponseHeaders(upstream, res);
    const responseBody = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(responseBody);
  } catch {
    // Do not expose upstream URLs, Clerk credentials, or transport details.
    return json(res, 502, { error: 'clerk_proxy_unavailable' });
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  return proxyClerkFrontendApi(req, res);
}
