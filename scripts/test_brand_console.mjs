import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const html = await readFile(new URL('../brand-console/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script, 'Brand Console inline application script is missing');

const temporaryScript = '/tmp/tracefab-brand-console-check.mjs';
await writeFile(temporaryScript, script);
const syntax = spawnSync(process.execPath, ['--check', temporaryScript], { encoding: 'utf8' });
await unlink(temporaryScript).catch(() => {});
assert(syntax.status === 0, syntax.stderr || 'Brand Console script syntax is invalid');

for (const contract of [
  '/api/config',
  '/api/me',
  '/api/suppliers',
  '/api/materials',
  '/api/products',
  '/materials',
  '/identifiers',
  '/api/data-requests',
  '/api/questionnaires',
  '/api/quality/products/',
  '/api/data-responses/',
  'data-action="new-request"',
  'data-action="new-product"',
  'data-action="invite-supplier"',
]) {
  assert(html.includes(contract), `Brand Console contract missing: ${contract}`);
}
for (const formContract of [
  'id="product-detail-form"',
  'id="material-form"',
  'material-edit-form',
  'id="identifier-form"',
  'identifier-edit-form',
  'const method = isUpdate ? \'PATCH\' : \'POST\';',
  "method: identifierId ? 'PATCH' : 'POST'",
]) {
  assert(html.includes(formContract), `Brand Console form contract missing: ${formContract}`);
}
assert(html.includes('Authorization = `Bearer ${token}`'), 'Clerk session token must be sent through Authorization');
assert(!html.includes('localhost'), 'Brand Console must not call localhost from browser code');
assert(!/sk_live_|secret_key|ghp_[A-Za-z0-9]/i.test(html), 'Brand Console must not contain private credentials');
assert(html.toLowerCase().includes('tracefab'), 'Brand Console branding is missing');
console.log('Brand Console contract passed: static shell, Clerk bootstrap, API actions and browser-safe URLs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
