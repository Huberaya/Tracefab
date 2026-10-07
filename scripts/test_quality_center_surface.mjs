#!/usr/bin/env node
/**
 * TRACEFAB Quality Center behaviour test.
 *
 * Executes the real `quality-center/index.html` script in a DOM (demo mode) and
 * walks the corrective-action loop end to end: issue -> plan -> remediation ->
 * review -> message. This is the workflow the API has always exposed and the UI
 * never called.
 *
 *   npm run test:quality-center
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
  assert(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const html = await readFile(new URL('quality-center/index.html', root), 'utf8');

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/quality-center/?demo=1',
  virtualConsole,
});
const { window } = dom;
const { document } = window;

if (document.readyState !== 'complete') {
  await new Promise((r) => window.addEventListener('load', r, { once: true }));
}
// boot() -> loadQuality() -> demoData() -> render() is async.
await new Promise((r) => setTimeout(r, 30));

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const nav = (view) => click($(`[data-nav="${view}"]`));
// jsdom's submit Event carries no `submitter`; the review handler needs it to
// know which verdict button was pressed.
const submit = (form, submitterValue) => {
  const btn = submitterValue
    ? [...form.querySelectorAll('button[type="submit"]')].find((b) => b.value === submitterValue)
    : form.querySelector('button[type="submit"]');
  const ev = new window.Event('submit', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'submitter', { value: btn || null });
  form.dispatchEvent(ev);
};

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
assert(!!window.tracefabQualityCenter, 'l’app expose son état');
eq(window.tracefabQualityCenter.state.demo, true, 'mode démonstration détecté depuis ?demo=1');
assert($('.tf-app') !== null, 'le shell applicatif est rendu');
assert($('.tf-demo-mark') !== null, 'le mode démo est étiqueté dans l’interface');

console.log('\nB. Navigation applicative');
eq($$('.tf-sidenav__link[data-nav]').length, 4, 'quatre vues dans la nav');
eq(
  JSON.stringify($$('.tf-sidenav__link[data-nav]').map((e) => e.dataset.nav)),
  JSON.stringify(['overview', 'issues', 'caps', 'scores']),
  'vues : overview, issues, caps, scores',
);
assert($('.tf-sidenav__link.is-on').dataset.nav === 'overview', 'overview active au chargement');
eq($('.tf-sidenav__link.is-on').getAttribute('aria-current'), 'page', 'aria-current sur la vue active');

console.log('\nC. Vue d’ensemble (§15)');
eq($$('.tf-tile').length, 8, 'huit indicateurs de confiance');
const tileLabels = $$('.tf-tile .tf-label').map((e) => e.textContent);
for (const expected of ['Complétude des données', 'Couverture des preuves', 'Qualité produit', 'Qualité fournisseur']) {
  assert(tileLabels.includes(expected), `indicateur « ${expected} » présent`, tileLabels.join(' | '));
}
// Les valeurs doivent être dérivées des scores, pas inventées.
const demoScores = window.tracefabQualityCenter.state.data.scores;
const expectedCompleteness = Math.round(
  demoScores.reduce((a, s) => a + Number(s.completeness), 0) / demoScores.length,
);
const completenessTile = $$('.tf-tile').find((t) => t.textContent.includes('Complétude des données'));
assert(
  completenessTile.textContent.includes(String(expectedCompleteness)),
  `complétude agrégée depuis l’API (${expectedCompleteness}%)`,
  completenessTile.textContent.trim(),
);
assert(
  $('.qc-disclaimer').textContent.includes('certification') && $('.qc-disclaimer').textContent.includes('explicables'),
  'le bandeau distingue préparation et certification',
);
// Aucune métrique que l’API ne fournit pas.
assert(
  !document.body.textContent.toLowerCase().includes('taux de vérification'),
  'aucun « taux de vérification » inventé (l’API ne le fournit pas)',
);

console.log('\nD. Issues critiques depuis la vue d’ensemble');
const criticalRows = $$('.tf-panel .tf-table tbody tr');
assert(criticalRows.length >= 1, 'au moins une issue critique affichée');
assert(
  criticalRows.some((r) => r.textContent.includes('Organic Cotton T-Shirt')),
  'l’issue bloquante de démo remonte en priorité',
);
assert(
  $$('.tf-panel .tf-table tbody tr [data-issue="cap"]').length >= 1,
  'chaque issue critique mène à un plan d’action (§15)',
);

console.log('\nE. Vue Issues — regroupement et filtres');
nav('issues');
eq($('.tf-sidenav__link.is-on').dataset.nav, 'issues', 'navigation vers Issues');
const buckets = $$('.tf-panel .tf-panel__head .tf-badge').map((b) => b.textContent.trim());
assert(buckets.includes('Critique'), 'groupe Critique');
assert(buckets.includes('Avertissement'), 'groupe Avertissement');
assert(buckets.includes('À revoir'), 'groupe À revoir');
assert($$('[data-filter]').length === 2, 'deux filtres (gravité, statut)');
assert($$('[data-issue="ack"]').length >= 1, 'action Acquitter exposée');
assert($$('[data-issue="waive"]').length >= 1, 'action Waiver exposée');

console.log('\nF. Acquitter une issue');
const st = window.tracefabQualityCenter.state;
const ackTarget = st.data.issues.find((i) => i.status === 'open');
click($(`[data-issue="ack"][data-id="${ackTarget.id}"]`));
await new Promise((r) => setTimeout(r, 10));
eq(
  st.data.issues.find((i) => i.id === ackTarget.id).status,
  'acknowledged',
  'l’issue passe à « acquittée »',
);
assert(st.notice && st.notice.includes('acquittée'), 'confirmation affichée');

console.log('\nG. Plans d’action corrective — le workflow complet');
nav('caps');
eq($$('.tf-table tbody tr').length, 2, 'deux plans listés');
assert($('.tf-status--requested') !== null, 'statut « demandé » rendu');
assert($('.tf-status--submitted') !== null, 'statut « correction soumise » rendu');
assert($('[data-cap="remediate"]') !== null, 'action de correction exposée sur le plan demandé');
assert($('[data-cap="approve"]') !== null, 'action d’approbation exposée sur le plan soumis');

console.log('\nH. Ouvrir un plan');
click($('[data-cap="open"]'));
await new Promise((r) => setTimeout(r, 10));
assert(st.capDetail !== null, 'le détail du plan est chargé');
assert($('[data-capform="remediate"]') !== null, 'formulaire de correction présent');
assert($('[data-capform="message"]') !== null, 'fil de discussion présent');
assert($('.tf-panel').textContent.includes('Consignes'), 'les consignes sont affichées');

console.log('\nI. Soumettre la correction');
const remediateForm = $('[data-capform="remediate"]');
remediateForm.querySelector('[name="responseSummary"]').value = 'Certificat GOTS du lot A-118 téléversé.';
submit(remediateForm);
await new Promise((r) => setTimeout(r, 10));
const cap1 = st.caps.caps.find((c) => c.id === st.capDetail.id);
eq(cap1.status, 'submitted', 'le plan passe à « submitted »');
assert(cap1.supplier_response_summary.includes('GOTS'), 'la réponse du fournisseur est enregistrée');
assert(st.notice && st.notice.includes('Correction soumise'), 'confirmation affichée');

console.log('\nJ. Ajouter un message au fil');
const msgForm = $('[data-capform="message"]');
if (msgForm) {
  msgForm.querySelector('[name="message"]').value = 'Merci, nous revérifions la portée du certificat.';
  submit(msgForm);
  await new Promise((r) => setTimeout(r, 10));
  assert(
    (st.capMessages.messages || []).some((m) => (m.message || '').includes('portée du certificat')),
    'le message rejoint le fil de discussion',
  );
} else {
  bad('fil de discussion', 'formulaire de message absent après soumission');
}

console.log('\nK. Approuver la correction');
const reviewForm = $('[data-capform="review"]');
assert(!!reviewForm, 'formulaire de revue présent une fois la correction soumise');
if (reviewForm) {
  const approveBtn = [...reviewForm.querySelectorAll('button[type="submit"]')].find((b) => b.value === 'approved');
  assert(!!approveBtn, 'bouton Approuver présent');
  submit(reviewForm, 'approved');
  await new Promise((r) => setTimeout(r, 10));
  eq(cap1.status, 'approved', 'le plan passe à « approved »');
  eq(cap1.review_verdict, 'approved', 'le verdict est enregistré');
}

console.log('\nL. Vue Scores');
nav('scores');
eq($$('.qc-score').length, 4, 'quatre cartes de score');
eq($$('.qc-score .tf-bar').length, 16, 'quatre dimensions par score');
assert($$('.tf-bar__fill').every((f) => /width:\s*\d+%/.test(f.getAttribute('style'))), 'chaque barre a une largeur calculée');
assert($$('.tf-bar__fill.is-critical, .tf-bar__fill.is-low').length > 0, 'les scores faibles sont signalés visuellement');

console.log('\nM. Accessibilité (vérifiée sur une vue tabulaire)');
nav('caps');
assert($$('.tf-table').length > 0, 'une vue tabulaire est affichée');
eq(document.documentElement.getAttribute('lang'), 'fr', 'langue déclarée');
assert(!!document.title, 'titre de document présent');
eq(document.querySelectorAll('h1').length, 1, 'un seul h1');
assert(!!document.querySelector('meta[name="viewport"]'), 'viewport déclaré');
eq(document.querySelectorAll('th').length, document.querySelectorAll('th[scope="col"]').length, 'chaque th porte scope="col"');
const btns = $$('button');
assert(btns.length > 0, 'des boutons sont rendus');
eq(btns.filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).length, 0, 'chaque bouton a un nom accessible');
eq($$('.tf-table').length, $$('.tf-tablewrap').length, 'chaque tableau est dans un conteneur de défilement');

console.log('\nN. Responsive (point de rupture 1024 px de la couche applicative)');
const inlineCss = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
assert(/@media \(max-width: 1024px\)/.test(inlineCss), 'le point de rupture 1024 px est inliné');
const appBreak = (inlineCss.match(/@media \(max-width: 1024px\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
assert(/\.tf-app \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(appBreak), 'la sidebar passe en colonne unique sous 1024 px');
assert(/\.tf-sidenav \{ flex-direction: row/.test(appBreak), 'la nav devient un bandeau horizontal');
assert(/\.tf-tablewrap \{[^}]*overflow-x: auto/.test(inlineCss), 'les tableaux denses défilent horizontalement sur mobile');
assert(/\.tf-tilegrid \{[\s\S]*?repeat\(auto-fit, minmax\(158px, 1fr\)\)/.test(inlineCss), 'la grille d’indicateurs se replie sans règle supplémentaire');
assert(/@media \(prefers-reduced-motion: reduce\)/.test(inlineCss), 'prefers-reduced-motion respecté');

console.log('\nO. Contrôles de formulaire étiquetés (vue Issues)');
nav('issues');
const controls = [...document.querySelectorAll('select, input, textarea')];
assert(controls.length >= 2, 'des contrôles de filtrage existent');
eq(
  controls.filter(
    (c) => !c.getAttribute('aria-label') && !c.getAttribute('aria-labelledby') && !document.querySelector(`label[for="${c.id}"]`),
  ).length,
  0,
  'chaque contrôle est étiqueté',
);

console.log('\nP. Design system');
assert(html.includes('/* TF:DS:BEGIN */'), 'la surface porte les marqueurs du design system');
assert($('.tf-surface--light') !== null, 'contexte de surface déclaré');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:quality-center FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:quality-center passed — ${checks} contrôles, 0 échec.`);
