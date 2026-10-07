#!/usr/bin/env node
/**
 * TRACEFAB Supplier Portal behaviour test.
 *
 * Executes the real `supplier-portal/index.html` script in a DOM (demo mode) and
 * exercises what Chantier 6 added: the eight-action home driven by real counts,
 * the readiness bar computed instead of hardcoded, and the five supplier routes
 * that used to be unreachable from the interface (passport settings, passport
 * access requests, storage usage, certification auto-verify, document scan).
 *
 *   npm run test:supplier-portal:surface
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

const html = await readFile(new URL('supplier-portal/index.html', root), 'utf8');

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/supplier-portal/?demo=1',
  virtualConsole,
});
const { window } = dom;
const { document } = window;

if (document.readyState !== 'complete') {
  await new Promise((r) => window.addEventListener('load', r, { once: true }));
}
await new Promise((r) => setTimeout(r, 60));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 20));
const nav = async (view) => { click($(`[data-view="${view}"]`)); await settle(); };
const action = async (selector) => { click($(selector)); await settle(); };

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
assert($('.app') !== null, 'le shell applicatif est rendu');
assert($('.demo-banner') !== null, 'le mode démonstration est étiqueté');

console.log('\nB. Paramètre demo');
const flagOf = (q) => {
  const flag = new window.URLSearchParams(q).get('demo');
  return flag === null ? false : !['0', 'false', 'off'].includes(String(flag).toLowerCase());
};
eq(flagOf('?demo=1'), true, '?demo=1 active la démonstration');
eq(flagOf('?demo=0'), false, '?demo=0 la désactive (l’interface l’annonçait, le code ne le faisait pas)');
eq(flagOf(''), false, 'sans paramètre : mode réel');

console.log('\nC. Navigation');
const views = $$('.nav [data-view]').map((e) => e.dataset.view);
assert(views.length >= 10, `au moins 10 vues (${views.length})`, views.join(' | '));
for (const expected of ['overview', 'requests', 'sites', 'certifications', 'materials', 'documents', 'passport']) {
  assert(views.includes(expected), `vue « ${expected} » présente`, views.join(' | '));
}

console.log('\nD. Préparation calculée, jamais codée en dur');
const portal = window.tracefabSupplierPortal;
assert(!!portal, "l'application expose son état");
const state = portal.state;
assert(!!state, 'l’état de l’application est accessible');
assert(!html.includes('profileCompletion || 82'), 'plus aucun repli codé en dur à 82 %');
const ready = portal.readiness();
assert(!!ready, 'readiness() est exposée');
eq(ready.checks.length, 7, 'sept étapes vérifiables');
eq(ready.total, 7, 'le total correspond au nombre d’étapes');
const doneCount = ready.checks.filter((c) => c.done).length;
eq(ready.done, doneCount, 'le compte d’étapes franchies est cohérent');
assert(
  ready.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0),
  'chaque étape expose son état réel',
);
// Chaque étape doit refléter les données, pas un texte fixe.
const sitesCheck = ready.checks.find((c) => c.key === 'sites');
assert(
  sitesCheck.detail.includes(String(state.sites.length)),
  `l’étape « sites » cite le vrai nombre (${state.sites.length})`,
  sitesCheck.detail,
);

console.log('\nE. Les huit actions, avec des compteurs réels');
await nav('overview');
const cards = $$('.sp-action-card');
eq(cards.length, 8, 'huit cartes d’action');
const titles = cards.map((c) => c.querySelector('.sp-card-title').textContent.trim());
for (const expected of [
  'Compléter le profil', 'Ajouter des sites', 'Ajouter des matériaux', 'Ajouter des produits',
  'Téléverser des preuves', 'Gérer les certificats', 'Répondre aux demandes', 'Soumettre les données',
]) {
  assert(titles.includes(expected), `action « ${expected} » présente`, titles.join(' | '));
}
assert(cards.every((c) => c.querySelector('.sp-card-count')), 'chaque carte affiche un compteur');
assert(
  cards.every((c) => c.dataset.view || c.dataset.action),
  'chaque carte mène à un écran ou déclenche une action',
);
// Les pills ne doivent plus afficher de « 100% » inventé.
const pills = $$('.sp-check-pill');
eq(pills.length, 7, 'sept pills, une par étape');
assert(
  !pills.some((p) => /\(100%\)/.test(p.textContent)),
  'aucun « (100%) » inventé dans la liste de contrôle',
);
assert(pills.every((p) => p.dataset.view), 'chaque pill mène à l’écran qui la résout');

console.log('\nF. Passeport fournisseur');
await nav('passport');
assert($('#passport-settings-form') !== null, 'formulaire de réglages présent');
assert($('[name="tradeSecretMode"]') !== null, 'le régime de secret d’affaires est réglable');
eq($$('[name="tradeSecretMode"] option').length, 3, 'trois régimes : full_disclosure, redacted, strict_nda');
eq($$('input[type="checkbox"][data-section]').length, 6, 'six sections divulguables');
const sectionKeys = $$('input[type="checkbox"][data-section]').map((e) => e.dataset.section).sort();
eq(
  JSON.stringify(sectionKeys),
  JSON.stringify(['certifications', 'contact', 'exact_addresses', 'materials', 'quality_score', 'sites']),
  'les six clés attendues par l’API',
);
assert($('[data-action="save-passport"]') !== null, 'bouton d’enregistrement présent');

console.log('\nG. Enregistrer les réglages du passeport');
const headlineInput = $('[name="headline"]');
headlineInput.value = 'Manufacture lin et chanvre, Portugal';
const publicBox = $('[name="isPublic"]');
const wasPublic = publicBox.checked;
publicBox.checked = !wasPublic;
await action('[data-action="save-passport"]');
eq(state.passport.headline, 'Manufacture lin et chanvre, Portugal', 'le titre est enregistré dans l’état');
eq(state.passport.isPublic, !wasPublic, 'la visibilité est basculée');

console.log('\nH. Demandes d’accès au passeport');
const before = state.passportRequests.length;
eq(before, 2, 'deux demandes en attente au chargement');
assert($$('[data-action="review-passport-request"]').length >= 2, 'boutons Accorder / Refuser présents');
assert(
  $$('[data-action="review-passport-request"]').every((b) => b.dataset.verdict),
  'chaque bouton porte un verdict',
);
assert(
  $$('[data-action="review-passport-request"]').every((b) => b.dataset.passportRequestId),
  'identifiant dédié : pas de collision avec data-request-id (demandes de données)',
);
const target = $('[data-action="review-passport-request"][data-verdict="approved"]');
const targetId = target.dataset.passportRequestId;
click(target);
await settle();
eq(state.passportRequests.length, before - 1, 'la demande accordée sort de la liste');
assert(
  !state.passportRequests.some((r) => r.id === targetId),
  'c’est bien la demande visée qui a été traitée',
);

console.log('\nI. Vérification automatique d’un certificat');
await nav('certifications');
const verifyBtn = $('[data-action="auto-verify-certification"]');
assert(!!verifyBtn, 'bouton « Vérifier automatiquement » présent');
eq(verifyBtn.getAttribute('type'), 'button', 'type=button : il ne soumet pas le formulaire parent');
const certId = verifyBtn.dataset.certificationId;
click(verifyBtn);
await settle();
eq(state.certifications.find((c) => c.id === certId).status, 'verified', 'le certificat passe à « verified »');

console.log('\nJ. Analyse antivirus d’un document');
await nav('documents');
const scanBtn = $('[data-action="scan-document"]');
assert(!!scanBtn, 'bouton « Analyser » présent');
assert(!!scanBtn.dataset.scanId, 'identifiant dédié : pas de collision avec le téléchargement');
assert(!scanBtn.dataset.documentId, 'aucun data-document-id : le téléchargement n’est pas déclenché');

console.log('\nK. Stockage');
assert(!!state.storage, 'les données de stockage sont chargées');
assert($('.progress') !== null, 'la jauge de stockage est rendue');
assert(
  document.body.textContent.includes(String(state.storage.documentCount)),
  'le nombre réel de documents est affiché',
);

console.log('\nL. Design system');
assert(html.includes('/* TF:DS:BEGIN */'), 'les marqueurs du design system sont présents');
assert(!html.includes('--muted:#71807a'), 'le gris 3.88:1 (échec AA) a disparu');
assert(html.includes('--muted:var(--tf-ink-300)'), '--muted mappé sur le token du DS');
assert(!html.includes('color:#3970b3'), 'le bleu 4.46:1 (échec AA) a disparu');
assert(!html.includes('color:#9a680e'), 'l’ambre 4.37:1 (échec AA) a disparu');

console.log('\nM. Accessibilité');
const controls = [...document.querySelectorAll('input, select, textarea')];
assert(controls.length > 0, 'des contrôles sont rendus');
const unlabelled = controls.filter(
  (c) => c.type === 'hidden'
    ? false
    : !c.getAttribute('aria-label')
      && !c.getAttribute('aria-labelledby')
      && !(c.closest('label'))
      && !document.querySelector(`label[for="${c.id}"]`),
);
eq(unlabelled.length, 0, 'chaque contrôle est étiqueté', unlabelled.map((c) => c.name || c.type).join(', '));
assert(!!document.querySelector('meta[name="viewport"]'), 'viewport déclaré');
eq(document.documentElement.getAttribute('lang'), 'fr', 'langue déclarée');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:supplier-portal:surface FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:supplier-portal:surface passed — ${checks} contrôles, 0 échec.`);
