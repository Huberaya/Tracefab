#!/usr/bin/env node
/**
 * TRACEFAB Evidence Center behaviour test.
 *
 * Executes the real `evidence/index.html` script in a DOM (demo mode). The
 * evidence layer existed server-side — five `documents/*` routes, all called by
 * nothing — so this proves the surface actually reaches them and renders only
 * what the data says.
 *
 *   npm run test:evidence
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

const html = await readFile(new URL('evidence/index.html', root), 'utf8');

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/evidence/?demo=1',
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
/** Texte du conteneur rendu uniquement : document.body inclut le source du <script>,
 *  ce qui faisait passer des assertions sur des chaînes présentes dans le code. */
const appText = () => (document.getElementById('app') || {}).textContent || '';

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 25));
const nav = async (view) => { click($(`[data-nav="${view}"]`)); await settle(); };

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
const center = window.tracefabEvidenceCenter;
assert(!!center, "l'application expose son état");
eq(center.state.demo, true, 'mode démonstration détecté depuis ?demo=1');
assert($('.tf-app') !== null, 'le shell applicatif est rendu');
assert($('.tf-demo-mark') !== null, 'les données de démo sont étiquetées');

console.log('\nB. Navigation');
eq($$('.tf-sidenav__link[data-nav]').length, 3, 'trois vues');
assert($$('.tf-sidenav__link[href]').length >= 3, 'liens vers les autres surfaces');

console.log('\nC. Vue d’ensemble — agrégats réels');
const d = center.state.data;
eq(d.documents.length, 6, 'six documents de démonstration');
eq(d.count, 6, 'le compteur correspond au jeu de données');
const tiles = $$('.tf-tile');
assert(tiles.length >= 6, `au moins six indicateurs (${tiles.length})`);
// Chaque indicateur doit être traçable au jeu de données, pas saisi en dur.
const verifiedExpected = (d.byVerification.passed || 0) + (d.byVerification.verified || 0);
assert(
  tiles.some((t) => t.textContent.includes(String(d.count)) && t.textContent.includes('Documents accessibles')),
  'indicateur « Documents accessibles » = count réel',
);
assert(
  tiles.some((t) => t.textContent.includes(String(verifiedExpected)) && t.textContent.includes('Vérifiés')),
  `indicateur « Vérifiés » = ${verifiedExpected} (calculé)`,
);
assert(
  tiles.some((t) => t.textContent.includes(String(d.expiringWithin90Days)) && t.textContent.includes('90 jours')),
  'indicateur d’échéance calculé sur expiresAt',
);
assert(
  !appText().includes('undefined') && !appText().includes('NaN'),
  'aucune valeur undefined/NaN affichée',
);

console.log('\nD. Échelle de confiance du design system');
for (const key of ['verified', 'declared', 'pending', 'failed']) {
  assert(html.includes(`.ev-trust--${key}`), `niveau « ${key} » stylé`);
}
assert(!html.includes('--tf-needs-review'), "aucun token inexistant (--tf-needs-review)");
assert(html.includes('var(--tf-verified)'), 'utilise le token verified du DS');
assert(html.includes('var(--tf-missing)'), 'utilise le token missing du DS');
assert(html.includes('var(--tf-declared)'), 'utilise le token declared du DS');

console.log('\nE. Documents — natures réelles, pas inventées');
await nav('documents');
const rows = $$('.tf-table tbody tr');
eq(rows.length, 6, 'les six documents sont listés');
// L'enum réel `document_kind` a six valeurs. Le brief en cite sept : afficher des
// catégories inexistantes produirait des filtres vides.
const kindOptions = $$('[data-filter="kind"] option').map((o) => o.value).filter(Boolean);
eq(kindOptions.length, 6, 'six natures — l’enum document_kind réel');
for (const kind of ['certificate', 'technical_spec', 'origin_proof', 'audit_report', 'invoice', 'other']) {
  assert(kindOptions.includes(kind), `nature réelle « ${kind} » proposée`, kindOptions.join(' | '));
}
const statusOptions = $$('[data-filter="status"] option').map((o) => o.value).filter(Boolean);
for (const status of ['uploaded', 'scanning', 'available', 'rejected']) {
  assert(statusOptions.includes(status), `statut réel « ${status} » proposé`, statusOptions.join(' | '));
}

console.log('\nF. Filtrage');
const kindSelect = $('[data-filter="kind"]');
kindSelect.value = 'certificate';
kindSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle();
eq($$('.tf-table tbody tr').length, 2, 'le filtre « Certificat » ne garde que 2 lignes');
assert(
  $$('.tf-table tbody tr').every((r) => r.textContent.includes('Certificat')),
  'toutes les lignes filtrées sont des certificats',
);
kindSelect.value = '';
kindSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle();
eq($$('.tf-table tbody tr').length, 6, 'le filtre réinitialisé rétablit les 6 lignes');

console.log('\nG. Fiche document — les huit attributs du brief');
click($('[data-open]'));
await settle();
const detailText = $('.ev-detail') ? $('.ev-detail').textContent : '';
for (const label of ['Source', 'Nature', 'Statut', 'Ajouté le', 'Échéance', 'Taille', 'Empreinte', 'Visibilité']) {
  assert(detailText.includes(label), `attribut « ${label} » affiché`, detailText.slice(0, 120));
}
assert($('.ev-trust') !== null, 'le niveau de confiance est affiché');
assert($$('[data-verify]').length === 1, 'action de vérification automatique');
assert($$('[data-security]').length === 1, 'action de rapport de sécurité');
assert($$('[data-download]').length === 1, 'action de téléchargement');
assert(
  detailText.includes('ne constitue ni une certification'),
  'la vérification automatique n’est pas présentée comme une certification',
);

console.log('\nH. Vérification automatique');
const targetId = center.state.selectedId;
const before = center.state.data.documents.find((x) => x.id === targetId).verificationCount;
click($('[data-verify]'));
await settle();
const after = center.state.data.documents.find((x) => x.id === targetId);
eq(after.verificationCount, before + 1, 'le compteur de vérifications augmente');
eq(after.latestVerificationStatus, 'passed', 'le document passe à « vérifié »');
assert(center.state.notice.includes('démonstration'), 'le mode démonstration est signalé');

console.log('\nI. Rapport de sécurité');
click($('[data-security]'));
await settle();
assert($('.tf-notice') !== null, 'le rapport de sécurité est rendu');
assert(
  /Analyse antivirus/.test($('.tf-notice').textContent),
  'le verdict est lisible',
  $('.tf-notice').textContent.trim(),
);

console.log('\nJ. Échéances');
await nav('expiring');
assert(appText().includes('Expirent sous 90 jours'), 'section des échéances proches');
assert(appText().includes('Déjà périmés'), 'section des documents périmés');

console.log('\nK. Accessibilité');
eq($$('th').length, $$('th[scope="col"]').length, 'chaque th porte scope="col"');
eq($$('.tf-table').length, $$('.tf-tablewrap').length, 'chaque tableau est dans un conteneur de défilement');
const controls = [...document.querySelectorAll('select, input, textarea')];
eq(
  controls.filter((c) => !c.getAttribute('aria-label') && !c.closest('label') && !document.querySelector(`label[for="${c.id}"]`)).length,
  0,
  'chaque contrôle est étiqueté',
);
const btns = $$('button');
eq(btns.filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).length, 0, 'chaque bouton a un nom accessible');
eq(document.documentElement.getAttribute('lang'), 'fr', 'langue déclarée');
assert(!!document.querySelector('meta[name="viewport"]'), 'viewport déclaré');

console.log('\nL. Design system');
assert(html.includes('/* TF:DS:BEGIN */'), 'les marqueurs du design system sont présents');
assert($('.tf-surface--light') !== null, 'contexte de surface déclaré');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:evidence FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:evidence passed — ${checks} contrôles, 0 échec.`);
