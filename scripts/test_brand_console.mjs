import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pageSource } from './lib/page_source.mjs';

const [html, reminderRoute, reminderMigration, email, schemaBindingsRoute, configRoute] = await Promise.all([
  pageSource('brand-console/index.html'),
  readFile(new URL('../api/_routes/data-requests/[requestId]/remind.ts', import.meta.url), 'utf8'),
  readFile(new URL('../prisma/migrations/20261006130000_tracefab_manual_data_request_reminders/migration.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/_lib/email.ts', import.meta.url), 'utf8'),
  readFile(new URL('../api/_routes/schema-bindings.ts', import.meta.url), 'utf8'),
  readFile(new URL('../api/_routes/config.ts', import.meta.url), 'utf8'),
]);
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
  '/api/data-requests/',
  '/remind',
  '/api/questionnaires',
  '/api/quality/products/',
  '/api/data-responses/',
  'data-action="new-request"',
  'data-action="new-product"',
  'data-action="new-material"',
  'id="create-material-form"',
  "await api('/api/materials', { method: 'POST'",
  'ownerOrganizationId: state.activeOrganizationId',
  'data-action="invite-supplier"',
  'data-action="remind-request"',
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
assert(!html.includes(`<button class="btn btn-primary" data-demo-action="1">${'${bt(\'mtAdd\')}'}</button>`), 'Ajouter un matériau ne doit jamais être un placeholder de démonstration sur un tenant réel');
assert(html.includes('originCountryCode: String(data.originCountryCode || \'\').trim() || null'), 'Une origine inconnue doit rester null, jamais devenir une affirmation métier');
assert(html.includes('composition: {}'), 'La création de matière ne doit inventer aucune composition');
assert(html.includes("document.addEventListener('submit', async (event) =>"), 'Les formulaires dynamiques du graphe doivent intercepter durablement la soumission native');
assert(html.includes("['chain-node-form', 'chain-link-form'].includes(form.id)"), 'La garde de soumission doit couvrir nœuds et liens');
assert(html.includes("form.dataset.submitting === 'true'"), 'Les mutations du graphe doivent empêcher les doubles soumissions');
assert(html.includes('if (result.node && !nodes.some((node) => node.id === result.node.id)) nodes.push(result.node)'), 'Un nœud isolé créé doit rester visible jusqu’à sa première liaison');
assert(!html.includes('await loadSupplyChain(state.selectedSupplyChainProduct.id);\n        notify(bt(\'cnNNodeAdded\'))'), 'La création d’un nœud isolé ne doit pas recharger un graphe qui ne peut pas encore le relire');
assert(!html.includes("document.getElementById('chain-node-form')?.addEventListener"), 'Le binding éphémère du formulaire de nœud ne doit pas revenir');
assert(html.includes('Enrichissements non bloquants'), 'Les données secondaires ne doivent pas bloquer le premier rendu');
assert(html.includes("url.searchParams.set('view', view)"), 'La vue active doit survivre à un rechargement via l’URL');
assert(html.includes("url.searchParams.set('productId', productId)"), 'Le produit actif doit survivre à un rechargement via l’URL');
assert(html.includes("const fastDeepLink = state.view !== 'overview'"), 'Une vue profonde ne doit pas attendre toutes les données du tableau de bord');
assert(html.includes('state.activeOrganizationId !== backgroundOrganizationId'), 'Les chargements différés doivent rester bornés au tenant demandeur');
assert(html.includes('Authorization = `Bearer ${token}`'), 'Clerk session token must be sent through Authorization');
assert(html.includes('for (let attempt = 0; attempt < 3; attempt += 1)'), 'Le bootstrap public doit réessayer une panne transitoire de /api/config');
assert(html.includes("new AbortController()") && html.includes("config_fetch_timeout"), 'Le bootstrap config doit être borné par un timeout explicite');
assert(html.includes("cache: attempt === 0 ? 'default' : 'no-cache'"), 'Les nouvelles tentatives config doivent contourner une réponse d’erreur mise en cache');
assert(html.includes('sessionTokenPromise = state.clerk.session.getToken()'), 'Les appels initiaux doivent partager une seule résolution du jeton Clerk');
assert(html.includes('Date.now() - cachedSessionTokenAt < 30000'), 'Le jeton Clerk ne doit être réutilisé que sur une fenêtre courte');
assert(html.includes('const prefetchedTenantData = validStoredTenant'), 'Les données du tenant mémorisé doivent démarrer en parallèle de /api/me');
assert(html.includes('storedTenant === state.activeOrganizationId'), 'Une prélecture ne doit être utilisée qu’après confirmation du tenant actif');
assert(!html.includes("<code>?demo=1</code>"), 'Une panne de connexion réelle ne doit pas orienter vers des données de démonstration');
assert(configRoute.includes('stale-while-revalidate=86400'), 'La configuration publique doit rester servable pendant un redéploiement transitoire');
assert(!html.includes('localhost'), 'Brand Console must not call localhost from browser code');
assert(!/sk_live_|secret_key|ghp_[A-Za-z0-9]/i.test(html), 'Brand Console must not contain private credentials');
assert(html.toLowerCase().includes('tracefab'), 'Brand Console branding is missing');
assert(html.includes('rel="preconnect" href="https://cdn.jsdelivr.net"'), 'La négociation réseau Clerk doit démarrer pendant le parsing HTML');
assert(html.includes('rel="preload" href="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js"'), 'Le SDK Clerk doit être préchargé avant la réponse /api/config');
// La relance manuelle doit etre authentifiee ET bornee a UN locataire actif.
//
// L'assertion precedente exigeait la presence de `activeOrganizationIds`. Ce
// helper rend l'UNION de toutes les organisations du compte : il borne
// l'utilisateur, pas le locataire affiche. L'assertion verifiait donc la
// presence du defaut Production du 2026-10-17, et le protegeait.
//
// Elle exige desormais la resolution explicite du locataire actif, et refuse
// explicitement le repli multi-organisations.
assert(reminderRoute.includes("req.method !== 'POST'"), 'Manual reminder route must reject other HTTP methods');
assert(reminderRoute.includes('withTracefabUserContext'), 'Manual reminder route must run inside the RLS context');
assert(reminderRoute.includes('requireActiveTenant'), 'Manual reminder route must resolve the active tenant');
assert(!reminderRoute.includes('activeOrganizationIds'), 'Manual reminder route must not fall back to every organization of the account');

// --- Contrat schema-bindings (blocage Production du 2026-10-17) -----------
// La cause racine du 504 : la branche GET renvoyait un tableau nu que le
// routeur central ignore — aucune reponse n'etait ecrite, la passerelle
// timeout-ait sur chaque appel et openProduct() rejetait toute la fiche.
assert(schemaBindingsRoute.includes("return json(res, 200, { bindings: bindings.map(serializeBinding) })"), 'GET /api/schema-bindings doit ecrire la reponse via json(res, 200, { bindings }) — un return nu vaut 504 passerelle');
assert(schemaBindingsRoute.includes('withTracefabUserContext'), 'GET /api/schema-bindings doit rester sous contexte utilisateur RLS — aucune desactivation de RLS');
assert(!/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i.test(schemaBindingsRoute), 'La route ne doit pas toucher a la RLS');
// La fiche produit doit rester consultable si ce chargement auxiliaire echoue :
// etat degrade explicite + reessai, et jamais un await en serie qui masque la fiche.
assert(html.includes('retry-schema-bindings'), 'Brand Console doit proposer un reessai du chargement schema-bindings degrade');
assert(html.includes('data-schema-panel="degraded"') && html.includes('data-schema-panel="loaded"'), 'Brand Console doit distinguer explicitement panneau degrade et panneau charge');
assert(html.includes('await loadSchemaBindings(id);'), 'openProduct doit deleguer le chargement auxiliaire a une fonction qui ne jette jamais');
assert(html.includes("if (view === 'products' && cible) { await openProduct(cible); return; }"), 'Corriger dans Produits doit ouvrir la fiche visee, pas revenir au catalogue');
assert(reminderMigration.includes("request_manual_reminder") && reminderMigration.includes('ON CONFLICT (event_key) DO NOTHING') && reminderMigration.includes('REVOKE EXECUTE'), 'Manual reminder migration must be typed, idempotent and non-public');
assert(email.includes('request_manual_reminder'), 'Manual reminder email copy is missing');
console.log('Brand Console contract passed: static shell, Clerk bootstrap, API actions, reminder workflow and browser-safe URLs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
