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
assert.match(sql, /granularity IN \\('model','variant','batch','unit'\\)/);
assert.match(sql, /status IN \\('active','replaced','retired'\\)/);
assert.match(sql, /replaced_by_id/);
assert.match(sql, /idx_dpp_resolvable_scope_unique/);
assert.match(sql, /tracefab_product_is_public\\(product_id\\)/);
assert.ok(!/GRANT EXECUTE[^;]+ TO PUBLIC/.test(sql));

// Route registration, canonical resolution, replacement and retirement.
assert.match(router, /resolve\\\\\\/\\(\\[\\^\\\\\\/\\]\\+\\)\\\\\\/qr/);
assert.match(resolverRoute, /status==='replaced'/);
assert.match(resolverRoute, /308/);
assert.match(resolverRoute, /row.status==='retired'/);
assert.match(resolverRoute, /410/);
assert.match(resolverRoute, /Cache-Control','no-store'/);

// All public URLs must use the configured canonical origin, never a production fallback.
assert.match(dataResolver, /baseUrl: string = process\\.env\\.TRACEFAB_PUBLIC_BASE_URL\\?\\.trim\\(\\) \\|\\| ''/);
assert.doesNotMatch(dataResolver, /baseUrl: string = ['"]https:\\/\\/tracefab\\.com/);
assert.match(qrRoute, /TRACEFAB_PUBLIC_BASE_URL/);
assert.match(qrRoute, /exists\\.status==='retired'/);
assert.match(qrRoute, /passport_identifier_retired/);
assert.match(qrRoute, /base\\.pathname!==['"]\\/['"]/);
assert.match(qrRoute, /base\\.search!==['"]['"]/);
assert.match(qrRoute, /base\\.hash!==['"]['"]/);
assert.match(qrRoute, /base\\.username!==['"]['"]/);
assert.match(qrRoute, /base\\.origin}\\/api\\/resolve/);
assert.match(gtinRoute, /public_base_url_not_configured/);
assert.match(gtinRoute, /resolveDppPassData\\(tx, gtinOrRef, publicBaseUrl\\.origin\\)/);
assert.match(appleWallet, /resolveDppPassDataByGtin/);
assert.match(googleWallet, /resolveDppPassDataByGtin/);

// Deterministic QR rendering against an explicitly non-production test origin.
const previewTarget = 'https://tracefab-preview.invalid/api/resolve/dpp-fixture-0001';
const svg = await QRCode.toString(previewTarget, { type: 'svg', errorCorrectionLevel: 'M' });
assert.match(svg, /^<svg/);
assert.match(svg, /viewBox/);
assert.ok(svg.length > 500);
assert.ok(!previewTarget.includes('tracefab.com'));

console.log('Identité DPP résolvable : 25 contrôles statiques et génération QR de fixture réussis.');
