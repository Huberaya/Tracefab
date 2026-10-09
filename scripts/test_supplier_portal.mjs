import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const html = await readFile(new URL('../supplier-portal/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script, 'Supplier Portal inline application script is missing');

const temporaryScript = '/tmp/tracefab-supplier-portal-check.mjs';
await writeFile(temporaryScript, script);
const syntax = spawnSync(process.execPath, ['--check', temporaryScript], { encoding: 'utf8' });
await unlink(temporaryScript).catch(() => {});
assert(syntax.status === 0, syntax.stderr || 'Supplier Portal script syntax is invalid');

for (const contract of [
  '/api/config',
  '/api/me',
  '/api/supplier/profile',
  '/api/supplier/profile/submit',
  '/api/supplier/sites',
  '/api/supplier/certifications',
  '/api/catalog/certification-standards',
  'certification-standard-catalog',
  '/api/supplier/quality',
  '/api/supplier/documents',
  '/api/supplier/documents/upload-intent',
  '/api/supplier/shares',
  /*
   * Ce contrat portait sur le littéral français « Partages actifs ». Le libellé
   * a été migré dans locales/<lang>/supplier.json : vérifier le texte ici
   * figerait le français dans la page, ce que l'i18n interdit. On vérifie donc
   * le CÂBLAGE, et la valeur réelle dans les neuf langues juste après.
   */
  "t('ui_partages_actifs')",
  '/api/supplier/documents/',
  '/api/supplier/organizations',
  '/api/supplier/members',
  '/api/supplier/data-points',
  '/api/materials?organizationId=',
  '/api/data-requests?scope=supplier',
  '/api/data-request-items/',
  'sourceDocumentId',
  '/submit',
  'id="profile-form"',
  'id="site-form"',
  'id="certification-form"',
  'id="material-form"',
  'id="document-form"',
  'id="data-point-form"',
  'id="member-invite-form"',
  'organization-switcher',
  'response-form',
  'data-item-id=',
  'data-action="submit-request"',
]) {
  assert(html.includes(contract), `Supplier Portal contract missing: ${contract}`);
}
/*
 * Le libellé des partages actifs doit exister, non vide, dans les neuf langues
 * du portail — sinon `t()` renverrait la clé brute à l'écran.
 */
const PORTAL_LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh'];
for (const lang of PORTAL_LANGS) {
  const dict = JSON.parse(await readFile(new URL(`../locales/${lang}/supplier.json`, import.meta.url), 'utf8'));
  assert(String(dict.ui_partages_actifs || '').trim().length > 0,
    `ui_partages_actifs must have a non-empty value in ${lang}`);
}

assert(html.includes('Authorization = `Bearer ${token}`'), 'Clerk session token must be sent through Authorization');
assert(!html.includes('localhost'), 'Supplier Portal must not call localhost from browser code');
assert(!/sk_live_|secret_key|ghp_[A-Za-z0-9]/i.test(html), 'Supplier Portal must not contain private credentials');
assert(html.toLowerCase().includes('tracefab'), 'Supplier Portal branding is missing');
console.log('Supplier Portal contract passed: static shell, Clerk bootstrap, response actions and browser-safe URLs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
