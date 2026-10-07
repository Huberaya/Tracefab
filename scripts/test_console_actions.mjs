#!/usr/bin/env node
/**
 * Console action integrity test.
 *
 * Twenty-two buttons used to announce a success they never produced — "Exportation CSV
 * générée.", "Certificat vérifié.", "Paramètres sauvegardés.", "Rappel email envoyé à Rui
 * Silva" — via native dialogs. Those dialogs worked by accident: they are browser globals,
 * so they resolved from an inline onclick handler even though everything else in the page
 * lives inside an IIFE. Every other inline handler that referenced an IIFE identifier
 * threw a ReferenceError on click, silently.
 *
 *   npm run test:console:actions
 */
import { readFile } from 'node:fs/promises';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;
const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

const html = await readFile(new URL('brand-console/index.html', root), 'utf8');
const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/brand-console/?demo=1',
  virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 180));
await settle();

/* jsdom n'implémente pas la création d'URL d'objet : on capture le blob produit pour
   vérifier le contenu réel du téléchargement plutôt que sa simple annonce. */
let captured = null;
window.URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { if (captured) captured.filename = this.download; };

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const go = (view) => click($(`[data-view="${view}"]`));
const buttonByText = (label) => $$('button').find((b) => b.textContent.trim() === label);
const toast = () => ($('.toast') || {}).textContent?.trim() || '';
const state = () => window.tracefabBrandConsole?.state || {};

console.log('\nA. Aucune fausse annonce de succès');
eq((html.match(/alert\(/g) || []).length, 0, 'plus aucune boîte de dialogue native dans le source');
for (const lie of ['Exportation CSV générée', 'Certificat vérifié', 'Paramètres sauvegardés', 'Rappel email envoyé', 'Nouveau matériau enregistré', 'Rapport CSRD exporté', 'Preuve inspectée avec succès', 'Fiche AGEC générée']) {
  assert(!html.includes(lie), `annonce de succès supprimée : ${lie}`);
}

console.log('\nB. Les gestionnaires inline résolvent réellement');
/* Tout identifiant référencé par un onclick inline doit être exposé, sinon le clic lève
   une ReferenceError. C'était le cas de 54 gestionnaires sur 59. */
const exposed = ['state', 'render', 'notify', 'pendingAction', 'filterIssues', 'filterRequestsByStatus', 'exportAudit', 'exportMaterialsCsv', 'exportQuestionnaireTemplates', 'exportRequestSummary'];
for (const name of exposed) {
  assert(typeof window[name] !== 'undefined', `« ${name} » est accessible depuis un onclick inline`);
}
const inlineHandlers = [...html.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
/* `${go('x')}` se développe en `state.view='x';render();` : on le résout avant de juger. */
const onlyGlobals = inlineHandlers
  .map((h) => h.replace(/\$\{go\('[a-zA-Z]+'\)\}/g, "state.view='x';render();"))
  .filter((h) => !/^(window\.|pendingAction|verifyDocument|filterIssues|filterRequestsByStatus|export[A-Za-z]+\(|state\.)/.test(h.trim()));
eq(onlyGlobals.length, 0, 'aucun onclick inline ne référence un identifiant non exposé', onlyGlobals.join(' | '));

console.log('\nC. Les exports produisent un fichier réel');
go('questionnaires');
await settle();
captured = null;
click(buttonByText('Exporter Gabarits (JSON)'));
await settle();
assert(!!captured, 'un fichier est réellement produit');
eq(captured.filename, 'tracefab-questionnaire-templates.json', 'nom de fichier');
const templates = JSON.parse(await captured.text());
eq(templates.length, state().questionnaires.length, 'le JSON contient les gabarits réels');

go('materials');
await settle();
captured = null;
click(buttonByText('Exporter CSV'));
await settle();
assert(!!captured, 'un CSV est réellement produit');
eq(captured.filename, 'tracefab-materials.csv', 'nom de fichier');
const csvLines = (await captured.text()).replace(/^\uFEFF/, '').trim().split('\r\n');
eq(csvLines.length - 1, state().materials.length, 'une ligne par matière réelle');
eq(csvLines[0], 'id,name,normalized_name,materialType,originCountryCode', 'en-tête CSV');
assert(csvLines[1].startsWith(state().materials[0].id), 'la première ligne porte la première matière réelle');

console.log('\nD. Une action non reliée le dit, et ne produit rien');
go('reports');
await settle();
captured = null;
click(buttonByText('Générer le rapport CSRD'));
await settle();
assert(captured === null, 'aucun fichier n’est fabriqué');
assert(/non reliée au serveur/.test(toast()), 'le message dit que rien n’a été effectué');
assert(!/exporté|généré|succès/i.test(toast()), 'aucun mot de réussite');

go('settings');
await settle();
captured = null;
click(buttonByText('Enregistrer'));
await settle();
assert(captured === null, 'aucun fichier n’est fabriqué');
assert(/non reliée au serveur/.test(toast()), 'l’enregistrement fantôme est annoncé comme tel');

console.log('\nE. Les filtres de sévérité existent et filtrent');
/* Les cinq onglets appelaient filterIssues(), qui n'était définie nulle part. */
go('products');
await settle();
click($('[data-product-id]'));
await settle();
click($('[data-action="product-quality-from-detail"]'));
await settle();
const issues = state().quality?.issues || [];
const counts = $$('.sev-pill-count').map((e) => Number(e.textContent));
eq(counts[0], issues.length, 'le compteur « toutes » est le nombre réel d’anomalies');
eq(
  counts.slice(1, 4).reduce((a, b) => a + b, 0),
  issues.length,
  'les compteurs par sévérité somment au total réel',
);
/* Les onglets portent les valeurs de l'enum Prisma quality_issue_severity. */
for (const severity of ['blocking', 'warning', 'info']) {
  assert(html.includes(`filterIssues('${severity}')`), `un onglet filtre sur « ${severity} »`);
}
for (const invented of ["filterIssues('critical')", "filterIssues('review')"]) {
  assert(!html.includes(invented), `aucun filtre sur une valeur hors enum : ${invented}`);
}
const tabs = () => $$('.eq-sev-tab');
const blockingTab = tabs().find((t) => /Bloquant/.test(t.textContent));
click(blockingTab);
await settle();
eq(state().issueFilter, 'blocking', 'le clic pose le filtre');
eq(
  $$('#quality-issue-container .issue').length,
  issues.filter((i) => i.severity === 'blocking').length,
  'seules les anomalies bloquantes sont affichées',
);
click(tabs()[0]);
await settle();
eq(state().issueFilter, 'all', 'le retour à « toutes » rétablit le filtre');
eq($$('#quality-issue-container .issue').length, issues.length, 'toutes les anomalies réapparaissent');

console.log('\nF. Le centre de qualité n’affiche plus de simulation');
for (const simulated of ['Simulated High-Impact', 'ZDHC_EFFLUENT_TEST_REPORT', 'lot de teinture #089', 'Document AI']) {
  assert(!html.includes(simulated), `contenu simulé retiré : ${simulated}`);
}
assert(!html.includes('${q ? q.issues.length : 3}'), 'le repli sur « 3 anomalies » a disparu');
assert(html.includes('filteredIssues.map(issueCard)'), 'le renderer réel issueCard est utilisé');

console.log('\nG. Le centre de preuves rend le contrat réel');
go('documents');
await settle();
const docs = state().documents || [];
assert(Array.isArray(docs), 'state.documents est alimenté depuis GET /api/documents');
const docText = ($('#app').textContent || '').replace(/\s+/g, ' ');
assert(docText.includes(`Preuves documentaires actives & scellées (${docs.length})`), 'le titre porte le nombre réel');
for (const fabricated of ['SGS Textile Testing Services', 'Control Union Certifications', 'Intertek Ethical Services', 'CITEVE Portugal', 'Filature de Haute-Vienne', 'EcoDye Aquitaine', 'Portugal Textile Mill']) {
  assert(!docText.includes(fabricated), `preuve inventée retirée : ${fabricated}`);
}
assert(!docText.includes("Contrôle d'intégrité Neon"), 'la validation d’intégrité jamais effectuée a disparu');
if (!docs.length) {
  assert(docText.includes('Aucune preuve documentaire'), 'sans document, la vue le dit');
  assert(docText.includes('Aucune ligne n’est simulée') || docText.includes("Aucune ligne n'est simulée"), 'et précise qu’aucune ligne n’est simulée');
}
assert(html.includes("verifyDocument('${esc(d.id)}')"), '« Vérifier » appelle le rapport de vérification réel');
assert(html.includes('/verification-report'), 'le rapport vient de l’endpoint réel');


if (failures) {
  console.error(`test:console:actions FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:console:actions passed — ${checks} contrôles, 0 échec.`);
