import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [sql, router, resolverRoute, qrRoute, dataResolver, gtinRoute, appleWallet, googleWallet] = await Promise.all([
  read('prisma/migrations/20261016170000_dpp_resolvable_identity/migration.sql'),
  read('api/index.ts'),
  read('api/_routes/resolve/[publicId].ts'),
  read('api/_routes/resolve/[publicId]/qr.ts'),
  read('api/_lib/wallet/dpp-data-resolver.ts'),
  read('api/_routes/dpp/[gtin].ts'),
  read('api/_routes/dpp/[gtin]/apple-wallet.ts'),
  read('api/_routes/dpp/[gtin]/google-wallet.ts'),
]);

// Schema and database-level publication boundary.
assert.ok(sql.includes("granularity IN ('model','variant','batch','unit')"));
assert.ok(sql.includes("status IN ('active','replaced','retired')"));
assert.ok(sql.includes('replaced_by_id'));
assert.ok(sql.includes('idx_dpp_resolvable_scope_unique'));
assert.ok(sql.includes('tracefab_product_is_public(product_id)'));
assert.ok(!/GRANT EXECUTE[^;]+ TO PUBLIC/.test(sql));

// Route registration, canonical resolution, replacement and retirement.
assert.ok(router.includes('resolve') && router.includes('qr'));
assert.match(resolverRoute, /status==='replaced'/);
assert.match(resolverRoute, /308/);
assert.match(resolverRoute, /row.status==='retired'/);
assert.match(resolverRoute, /410/);
assert.ok(resolverRoute.includes("Cache-Control','no-store"));

// All public URLs must use the configured canonical origin, never a production fallback.
assert.ok(dataResolver.includes("baseUrl: string = process.env.TRACEFAB_PUBLIC_BASE_URL?.trim() || ''"));
assert.ok(!dataResolver.includes("baseUrl: string = 'https://tracefab.com'"));
assert.ok(qrRoute.includes('TRACEFAB_PUBLIC_BASE_URL'));
assert.ok(qrRoute.includes("exists.status==='retired'"));
assert.ok(qrRoute.includes('passport_identifier_retired'));
assert.ok(dataResolver.includes('export function getConfiguredPublicBaseUrl(): URL | null'));
assert.ok(dataResolver.includes("url.pathname !== '/'"));
assert.ok(dataResolver.includes("url.search !== ''"));
assert.ok(dataResolver.includes("url.hash !== ''"));
assert.ok(dataResolver.includes("url.username !== ''"));
assert.ok(dataResolver.includes("url.password !== ''"));
assert.ok(qrRoute.includes('base.origin}/api/resolve/'));
assert.ok(qrRoute.includes('getConfiguredPublicBaseUrl'));
assert.ok(gtinRoute.includes('getConfiguredPublicBaseUrl'));
assert.ok(gtinRoute.includes('public_base_url_not_configured'));
assert.ok(appleWallet.includes('getConfiguredPublicBaseUrl'));
assert.ok(googleWallet.includes('getConfiguredPublicBaseUrl'));
assert.ok(gtinRoute.includes('resolveDppPassData(tx, gtinOrRef, publicBaseUrl.origin)'));
assert.ok(appleWallet.includes('resolveDppPassDataByGtin'));
assert.ok(googleWallet.includes('resolveDppPassDataByGtin'));

// Deterministic QR rendering against an explicitly non-production test origin.
const previewTarget = 'https://tracefab-preview.invalid/api/resolve/dpp-fixture-0001';
const svg = await QRCode.toString(previewTarget, { type: 'svg', errorCorrectionLevel: 'M' });
assert.match(svg, /^<svg/);
assert.match(svg, /viewBox/);
assert.ok(svg.length > 500);
assert.ok(!previewTarget.includes('tracefab.com'));

console.log('Identité DPP résolvable : contrôles statiques de sécurité et génération QR de fixture réussis.');
