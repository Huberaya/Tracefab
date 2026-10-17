import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { VercelRequest, VercelResponse } from '../api/_lib/vercel-types.js';
import apiHandler from '../api/index.js';
import configHandler from '../api/_routes/config.js';
import {
  CLERK_FRONTEND_API_ORIGIN,
  CLERK_PROXY_PATH_QUERY,
  CLERK_PROXY_URL,
} from '../api/_lib/clerk-proxy.js';
import {
  resetDatabaseBackoff,
  resetMemory,
  setCredentialVerifier,
  setDatabaseCounter,
} from '../api/_lib/rate-limit.js';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const proxySource = readFileSync(new URL('../api/_routes/clerk-proxy.ts', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api/index.ts', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('../api/_routes/config.ts', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const secret = 'sk_live_unit-test-only-not-a-real-key';
const publishableKey = `pk_live_${Buffer.from('clerk.tracefab.example$').toString('base64')}`;
const savedEnvironment = new Map<string, string | undefined>([
  'NODE_ENV',
  'CLERK_SECRET_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'TRACEFAB_RATE_LIMIT_SALT',
].map((name): [string, string | undefined] => [name, process.env[name]]));

function assertCondition(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
}

function response(): VercelResponse & {
  statusCode: number;
  payload?: unknown;
  headers: Map<string, string | string[] | number>;
} {
  const result = {
    statusCode: 200,
    payload: undefined as unknown,
    headers: new Map<string, string | string[] | number>(),
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string | string[] | number) {
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return this.headers.get(name.toLowerCase());
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.payload = value;
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
    send(value: unknown) {
      this.payload = value;
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
    end(value?: unknown) {
      if (value !== undefined) this.payload = value;
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
  };
  return result as unknown as VercelResponse & typeof result;
}

function request(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
} = {}): VercelRequest {
  return {
    method: options.method || 'GET',
    url: options.url || '/api/index.ts',
    headers: options.headers || {},
    query: options.query || {},
    body: options.body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;
}

function cspDirective(csp: string, name: string): string[] {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  return directive ? directive.slice(name.length).trim().split(/\s+/) : [];
}

try {
  process.env.NODE_ENV = 'test';
  process.env.TRACEFAB_RATE_LIMIT_SALT = 'clerk-proxy-test-salt';
  setDatabaseCounter(async () => 1);
  setCredentialVerifier(null);
  resetMemory();
  resetDatabaseBackoff();

  // Vercel uses the repository's existing legacy routes and single API
  // function; the proxy path must precede the generic /api route.
  const proxyRouteIndex = vercel.routes.findIndex((route: { src: string }) => route.src.startsWith('/__clerk'));
  const apiRouteIndex = vercel.routes.findIndex((route: { src: string }) => route.src === '/api/(.*)');
  assertCondition(proxyRouteIndex >= 0, 'Vercel route /__clerk/:path* is missing');
  assertCondition(proxyRouteIndex < apiRouteIndex, 'Clerk proxy route must precede the generic API route');
  assert.equal(vercel.routes[proxyRouteIndex].dest, `/api/index.ts?${CLERK_PROXY_PATH_QUERY}=$1`);
  assertCondition(vercel.builds.some((build: { src: string }) => build.src === 'api/index.ts'), 'Proxy must use the existing Vercel API function');
  assertCondition(/pattern:\s*\/\^__clerk/.test(apiSource) && apiSource.includes("params: ['clerkPath']") && apiSource.includes("import('./_routes/clerk-proxy.js')"), 'The shared API router does not dispatch /__clerk paths');

  // CSP allows same-origin FAPI requests via the proxy and the ClerkJS bundle
  // host, without weakening script execution with unsafe-inline/eval.
  const csp = vercel.headers.flatMap((entry: { headers?: Array<{ key: string; value: string }> }) => entry.headers || [])
    .find((header: { key: string }) => header.key.toLowerCase() === 'content-security-policy')?.value || '';
  const scriptSrc = cspDirective(csp, 'script-src');
  const connectSrc = cspDirective(csp, 'connect-src');
  const frameSrc = cspDirective(csp, 'frame-src');
  assertCondition(connectSrc.includes("'self'"), 'CSP connect-src must permit the same-origin Clerk proxy');
  assertCondition(frameSrc.includes("'self'"), 'CSP frame-src must permit same-origin Clerk proxy flows');
  assertCondition(scriptSrc.includes('https://cdn.jsdelivr.net'), 'CSP must allow the ClerkJS CDN used by the invitation flow');
  for (const host of ['https://*.clerk.com', 'https://*.clerk.accounts.dev', 'https://*.clerk.dev']) {
    assertCondition(scriptSrc.includes(host), `CSP script-src must allow ClerkJS host ${host}`);
  }
  assertCondition(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), 'Clerk CSP must not enable unsafe inline/eval scripts');
  assert.equal(new URL(CLERK_PROXY_URL).origin, 'https://tracefab.vercel.app');

  // Exercise the public API route through api/index.ts (not only its module).
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  const missingConfigResponse = response();
  await apiHandler(request({ url: '/api/index.ts?path=config', query: { path: 'config' } }), missingConfigResponse);
  assert.equal(missingConfigResponse.statusCode, 503);
  assert.deepEqual(missingConfigResponse.payload, { error: 'clerk_not_configured' });

  // Test/development keys do not use the production-only proxy.
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_local-development-key';
  process.env.CLERK_SECRET_KEY = 'sk_test_local-development-secret';
  const developmentConfigResponse = response();
  configHandler(request(), developmentConfigResponse);
  assert.equal(developmentConfigResponse.statusCode, 200);
  assert.deepEqual(developmentConfigResponse.payload, { publishableKey: 'pk_test_local-development-key' });
  assert.equal(JSON.stringify(developmentConfigResponse.payload).includes('sk_test_'), false);

  // Production config requires a live server key, then exposes only the public
  // publishable key and the requested proxy URL.
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = publishableKey;
  delete process.env.CLERK_SECRET_KEY;
  const missingProductionSecretResponse = response();
  configHandler(request(), missingProductionSecretResponse);
  assert.equal(missingProductionSecretResponse.statusCode, 503);
  assert.deepEqual(missingProductionSecretResponse.payload, { error: 'clerk_not_configured' });

  process.env.CLERK_SECRET_KEY = secret;
  const productionConfigResponse = response();
  configHandler(request(), productionConfigResponse);
  assert.equal(productionConfigResponse.statusCode, 200);
  assert.deepEqual(productionConfigResponse.payload, { publishableKey, proxyUrl: CLERK_PROXY_URL });
  assert.equal(JSON.stringify(productionConfigResponse.payload).includes(secret), false);
  assert.equal(JSON.stringify(productionConfigResponse.headers).includes(secret), false);

  // Exercise a real router-dispatched proxy request with mocked upstream I/O.
  // The assertions cover Clerk's required headers, original path/query/body,
  // response cookies, and the absence of server secrets in the browser reply.
  let upstreamUrl: URL | null = null;
  let upstreamInit: RequestInit | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstreamUrl = new URL(String(input));
    upstreamInit = init || null;
    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'clerk-secret-key': secret,
        'set-cookie': '__client=clerk-cookie; Path=/; Secure; HttpOnly; SameSite=Lax',
      },
    });
  }) as typeof fetch;

  const proxyRequest = request({
    method: 'POST',
    url: `/api/index.ts?${CLERK_PROXY_PATH_QUERY}=v1%2Fclient%2Fsign_ins&__clerk_api_version=2026-08-01&path=clerk-owned-query&duplicate=one&duplicate=two`,
    query: {
      [CLERK_PROXY_PATH_QUERY]: 'v1/client/sign_ins',
      __clerk_api_version: '2026-08-01',
      path: 'clerk-owned-query',
    },
    headers: {
      host: 'untrusted.example',
      connection: 'x-remove-me, keep-alive',
      'x-remove-me': 'must-not-forward',
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer browser-session-test-token',
      'x-vercel-forwarded-for': '198.51.100.27, 10.0.0.5',
      'x-forwarded-for': '203.0.113.99',
      'x-real-ip': '203.0.113.99',
      'clerk-proxy-url': 'https://attacker.example/__clerk',
      'clerk-secret-key': 'sk_live_attacker-controlled',
    },
    body: '{"strategy":"email_code"}',
  });
  const proxyResponse = response();
  await apiHandler(proxyRequest, proxyResponse);
  globalThis.fetch = originalFetch;

  assert.equal(proxyResponse.statusCode, 200);
  assert.ok(proxyResponse.payload instanceof Buffer);
  assert.equal((proxyResponse.payload as Buffer).toString('utf8'), '{"ok":true}');
  assertCondition(upstreamUrl instanceof URL, 'Proxy did not call Clerk Frontend API');
  assert.equal(upstreamUrl!.origin, CLERK_FRONTEND_API_ORIGIN);
  assert.equal(upstreamUrl!.pathname, '/v1/client/sign_ins');
  assert.equal(upstreamUrl!.searchParams.get('__clerk_api_version'), '2026-08-01');
  assert.equal(upstreamUrl!.searchParams.get('path'), 'clerk-owned-query', 'Clerk query parameters must not collide with router dispatch');
  assert.deepEqual(upstreamUrl!.searchParams.getAll('duplicate'), ['one', 'two']);
  assert.equal(upstreamUrl!.searchParams.has(CLERK_PROXY_PATH_QUERY), false, 'Internal route marker must not reach Clerk');
  assert.equal(upstreamInit?.method, 'POST');
  assert.equal(upstreamInit?.body, '{"strategy":"email_code"}');
  const outboundHeaders = new Headers(upstreamInit?.headers);
  assert.equal(outboundHeaders.get('clerk-proxy-url'), CLERK_PROXY_URL);
  assert.equal(outboundHeaders.get('clerk-secret-key'), secret);
  assert.equal(outboundHeaders.get('x-forwarded-for'), '198.51.100.27');
  assert.equal(outboundHeaders.get('authorization'), 'Bearer browser-session-test-token');
  assert.equal(outboundHeaders.get('host'), null);
  assert.equal(outboundHeaders.get('x-remove-me'), null);
  assert.equal(proxyResponse.headers.get('set-cookie')?.toString().includes('__client=clerk-cookie'), true);
  assert.equal(proxyResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(proxyResponse.headers.get('clerk-secret-key'), undefined);
  assert.equal(JSON.stringify(proxyResponse.payload).includes(secret), false);
  assert.equal(JSON.stringify([...proxyResponse.headers]).includes(secret), false);

  // The route fails closed if the secret is missing/test-only, the client IP
  // is unavailable, or a path attempts traversal; none reaches Clerk.
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    return new Response('unexpected', { status: 200 });
  }) as typeof fetch;
  delete process.env.CLERK_SECRET_KEY;
  const noSecretResponse = response();
  await apiHandler(request({
    url: `/api/index.ts?${CLERK_PROXY_PATH_QUERY}=v1%2Fclient`,
    query: { [CLERK_PROXY_PATH_QUERY]: 'v1/client' },
    headers: { 'x-vercel-forwarded-for': '198.51.100.10' },
  }), noSecretResponse);
  assert.equal(noSecretResponse.statusCode, 503);

  process.env.CLERK_SECRET_KEY = 'sk_test_not-allowed-for-production-proxy';
  const testSecretResponse = response();
  await apiHandler(request({
    url: `/api/index.ts?${CLERK_PROXY_PATH_QUERY}=v1%2Fclient`,
    query: { [CLERK_PROXY_PATH_QUERY]: 'v1/client' },
    headers: { 'x-vercel-forwarded-for': '198.51.100.10' },
  }), testSecretResponse);
  assert.equal(testSecretResponse.statusCode, 503);

  process.env.CLERK_SECRET_KEY = secret;
  const noIpResponse = response();
  await apiHandler(request({
    url: `/api/index.ts?${CLERK_PROXY_PATH_QUERY}=v1%2Fclient`,
    query: { [CLERK_PROXY_PATH_QUERY]: 'v1/client' },
  }), noIpResponse);
  assert.equal(noIpResponse.statusCode, 503);

  const traversalResponse = response();
  await apiHandler(request({
    url: `/api/index.ts?${CLERK_PROXY_PATH_QUERY}=..%2Fprivate`,
    query: { [CLERK_PROXY_PATH_QUERY]: '../private' },
    headers: { 'x-vercel-forwarded-for': '198.51.100.10' },
  }), traversalResponse);
  assert.equal(traversalResponse.statusCode, 400);
  assert.equal(upstreamCalls, 0, 'Invalid requests must not reach Clerk');
  globalThis.fetch = originalFetch;

  // Every production ClerkJS entry point consumes /api/config and passes the
  // proxy URL using the supported ClerkJS configuration surface.
  const clerkBundleUrl = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
  const frontendContracts = [
    ['assets/js/brand-console.1.js', "data-clerk-proxy-url", "state.demo = true"],
    ['assets/js/supplier-portal.1.js', "data-clerk-proxy-url", "state.demo = true"],
    ['assets/js/quality-center.1.js', "data-clerk-proxy-url", ''],
    ['assets/js/operations.1.js', "data-clerk-proxy-url", ''],
    ['assets/js/invitations-accept.1.js', 'config.proxyUrl ? { proxyUrl: config.proxyUrl }', ''],
  ] as const;
  for (const [file, required, forbidden] of frontendContracts) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assertCondition(source.includes(clerkBundleUrl), `${file} must load ClerkJS from the CSP-approved CDN`);
    assertCondition(source.includes(required), `${file} does not configure Clerk's proxy URL`);
    if (forbidden) assertCondition(!source.includes(forbidden), `${file} can silently switch into demo mode after Clerk failure`);
  }
  assertCondition(!proxySource.includes('console.') && !configSource.includes('CLERK_SECRET_KEY:'), 'Proxy/config must not log or serialize the secret');
  assertCondition(!packageJson.scripts['smoke:clerk-production'].includes('CLERK_SECRET_KEY'), 'Live smoke test must not require or expose the secret key');

  console.log('Clerk proxy checks passed: Vercel route, CSP, /api/config, secret isolation, request/response forwarding and browser bootstrap contracts.');
} finally {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setDatabaseCounter(null);
  setCredentialVerifier(null);
  resetMemory();
  resetDatabaseBackoff();
}
