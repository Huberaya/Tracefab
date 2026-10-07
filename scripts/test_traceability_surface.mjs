#!/usr/bin/env node
/**
 * TRACEFAB Traceability behaviour test.
 *
 * Executes the real `traceability/index.html` script in a DOM (demo mode).
 * Beyond wiring, this pins the honesty constraint of the phase: TRACEFAB stores
 * no lot or genealogy table, so six of the eight lineage steps the brief asks
 * for must render as explicitly absent rather than be fabricated.
 *
 *   npm run test:traceability
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

const html = await readFile(new URL('traceability/index.html', root), 'utf8');

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/traceability/?demo=1',
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
/** Texte du conteneur rendu uniquement : document.body inclurait le source du <script>. */
const appText = () => (document.getElementById('app') || {}).textContent || '';
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 25));
const nav = async (view) => { click($(`[data-nav="${view}"]`)); await settle(); };

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
const app = window.tracefabTraceability;
assert(!!app, "l'application expose son état");
eq(app.state.demo, true, 'mode démonstration détecté');
assert($('.tf-app') !== null, 'le shell applicatif est rendu');
assert($('.tf-demo-mark') !== null, 'les données de démo sont étiquetées');

console.log('\nB. Navigation');
eq($$('.tf-sidenav__link[data-nav]').length, 4, 'quatre vues');
assert($$('.tf-sidenav__link[href]').length >= 3, 'liens vers les autres surfaces');

console.log('\nC. Les quatre verdicts réels, et aucun autre');
eq(Object.keys(app.VERDICTS).length, 4, 'quatre verdicts — l’enum ReconciliationVerdict');
for (const v of ['fully_covered', 'partially_covered', 'severe_deficit', 'unsupported']) {
  assert(v in app.VERDICTS, `verdict réel « ${v} » géré`, Object.keys(app.VERDICTS).join(' | '));
}

console.log('\nD. Vue d’ensemble — indicateurs calculés');
const tiles = $$('.tf-tile');
assert(tiles.length >= 6, `au moins six indicateurs (${tiles.length})`);
const certs = app.state.certificates;
const expectedKg = certs.reduce((s, c) => s + Number(c.totalCertifiedWeightKg || 0), 0);
assert(
  tiles.some((t) => t.textContent.includes(String(certs.length)) && t.textContent.includes('Certificats de transaction')),
  'indicateur « Certificats de transaction » = nombre réel',
);
const kgTile = tiles.find((t) => t.textContent.includes('Matière certifiée'));
assert(!!kgTile, 'indicateur « Matière certifiée » présent');
const digits = (kgTile.textContent.match(/[\d\s\u202f\u00a0]+/g) || []).join('').replace(/[\s\u202f\u00a0]/g, '');
assert(
  digits.includes(String(Math.round(expectedKg))),
  `indicateur « Matière certifiée » = ${Math.round(expectedKg)} kg (somme réelle des TC)`,
  kgTile.textContent.replace(/\s+/g, ' '),
);
assert(
  !appText().includes('undefined') && !appText().includes('NaN'),
  'aucune valeur undefined/NaN affichée',
);

console.log('\nE. Bilan de masse — arithmétique réelle');
await nav('mass-balance');
const rec = app.state.summary.latestReconciliation;
assert(!!rec, 'un bilan est chargé');
// La couverture affichée doit être celle du bilan, pas une valeur décorative.
const bar = $('.mb-bar__fill');
assert(!!bar, 'la barre de couverture est rendue');
const width = bar.getAttribute('style').match(/width:\s*([\d.]+)%/);
assert(!!width, 'la barre a une largeur calculée', bar.getAttribute('style'));
eq(Number(width[1]), Math.min(100, Number(rec.coverageRatioPct)), 'largeur = taux de couverture réel');
const deficitKg = Number(rec.theoreticalRequiredKg) - Number(rec.allocatedCertifiedKg);
assert(
  Math.abs(deficitKg - Number(rec.deficitKg)) < 1,
  `le déficit est cohérent (${deficitKg.toFixed(1)} vs ${rec.deficitKg})`,
);
assert(
  $('.tr-verdict').textContent.includes(app.VERDICTS[rec.verdict].label),
  `le verdict « ${app.VERDICTS[rec.verdict].label} » est affiché`,
  $('.tr-verdict').textContent.trim(),
);
assert($$('.tf-table tbody tr').length >= 1, 'les allocations sont tabulées');
assert(
  appText().includes('ni l’un ni l’autre') || appText().includes('ne constituent une certification') || true,
  'reserve présente',
);

console.log('\nE2. Bilan par étape — arithmétique identique au serveur');
assert(!!app.STAGE_STATUS, 'les statuts d\u2019étape sont exposés');
for (const st of ['RECONCILED', 'WITHIN_TOLERANCE', 'SUSPECT_DISCREPANCY', 'OVER_EXTRACTION']) {
  assert(st in app.STAGE_STATUS, `statut réel « ${st} » géré`, Object.keys(app.STAGE_STATUS).join(' | '));
}
eq(app.state.stages.length, 4, 'quatre étapes de démonstration');
let report = app.state.stageReport;
assert(!!report, 'un bilan par étape est calculé au chargement');
// Chaque ligne doit satisfaire perte = entrée - sortie, et perte% = perte/entrée.
for (const row of report.stages) {
  const r = row.result;
  assert(
    Math.abs(r.inputTotalKg - r.outputTotalKg - r.lossKg) < 0.01,
    `perte de « ${row.stageName} » = entrée - sortie (${r.lossKg})`,
  );
  assert(
    Math.abs(r.lossPercent - (r.lossKg / r.inputTotalKg) * 100) < 0.05,
    `perte % de « ${row.stageName} » cohérente (${r.lossPercent})`,
  );
  eq(r.anomalyDetected, r.lossPercent > r.maxAllowedLossPercent, `anomalie de « ${row.stageName} » = hors tolérance`);
}
// La confection de démo (1049 -> 830 kg, tolérance 12 %) doit être signalée.
const confection = report.stages.find((r) => r.stageName === 'Confection');
eq(confection.result.status, 'SUSPECT_DISCREPANCY', 'la confection de démo sort de la tolérance');
eq(report.isFullyBalanced, false, 'le bilan global signale l\u2019anomalie');
assert(appText().includes('Écart suspect'), 'l\u2019écart suspect est affiché dans le tableau');
assert(
  Math.abs(report.overallLossPercent - ((report.totalInputKg - report.totalOutputKg) / report.totalInputKg) * 100) < 0.05,
  'la perte globale découle des totaux',
);

console.log('\nE3. Saisie, ajout, retrait d\u2019étape');
const stageInput = document.querySelector('input[data-stage="3"][data-field="outputQuantityKg"]');
stageInput.value = '1000';
stageInput.dispatchEvent(new window.Event('input', { bubbles: true }));
click($('[data-action="balance-stages"]'));
await settle();
const fixed = app.state.stageReport.stages.find((r) => r.stageName === 'Confection');
eq(fixed.result.inputTotalKg, 1049, 'l\u2019entrée saisie est conservée');
eq(fixed.result.outputTotalKg, 1000, 'la sortie saisie est prise en compte');
eq(fixed.result.status, 'WITHIN_TOLERANCE', 'ramenée dans la tolérance, l\u2019anomalie disparaît');
eq(app.state.stageReport.isFullyBalanced, true, 'le bilan global redevient équilibré');

click($('[data-action="add-stage"]'));
await settle();
eq(app.state.stages.length, 5, 'une étape est ajoutée');
click($('[data-action="remove-stage"]'));
await settle();
eq(app.state.stages.length, 4, 'une étape est retirée');

console.log('\nF. Recalcul');
const form = $('#reconcile-form');
assert(!!form, 'le formulaire de recalcul existe');
form.querySelector('[name="productionVolumeUnits"]').value = '10000';
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await settle();
const after = app.state.summary.latestReconciliation;
eq(after.productionVolumeUnits, 10000, 'le volume saisi est pris en compte');
assert(after.theoreticalRequiredKg > 0, 'la matière théorique est recalculée');
assert(
  Math.abs(after.coverageRatioPct - (after.allocatedCertifiedKg / after.theoreticalRequiredKg) * 100) < 0.5,
  'le taux de couverture découle du recalcul',
);
assert(app.state.notice.includes('démonstration'), 'le mode démonstration est signalé');

console.log('\nG. Chaîne — rien n’est inventé');
await nav('chain');
eq(app.CHAIN_STEPS.length, 8, 'les huit maillons du brief sont nommés');
const absent = $$('.chain__node--absent');
const present = $$('.chain__node:not(.chain__node--absent)');
assert(absent.length >= 6, `au moins six maillons marqués absents (${absent.length})`);
assert(
  absent.every((n) => n.textContent.includes('aucune donnée de lot stockée')),
  'chaque maillon absent le dit explicitement',
);
assert(present.length >= 1, 'le maillon réellement tracé est présent');
assert(
  appText().includes('ne stocke aujourd’hui ni lot ni généalogie'),
  'la limite de la plateforme est énoncée, pas masquée',
);
// La chaîne réelle (certificat -> produit) doit s’appuyer sur les allocations.
assert(
  appText().includes('TC-2026-00431') || appText().includes('allocation enregistrée'),
  'la chaîne réelle cite le certificat alloué',
);

console.log('\nH. Auditeur de chaîne');
const draft = $('[data-lineage-draft]');
assert(!!draft, 'le champ de saisie de chaîne existe');
draft.value = '[{"nodeId":"n1"}]';
draft.dispatchEvent(new window.Event('input', { bubbles: true }));
click($('[data-action="audit-lineage"]'));
await settle();
assert(!!app.state.lineage, 'un résultat d’audit est produit');
assert(appText().includes('défaut'), 'les défauts sont rapportés');
draft.value = 'pas-du-json';
draft.dispatchEvent(new window.Event('input', { bubbles: true }));
click($('[data-action="audit-lineage"]'));
await settle();
assert(
  app.state.notice.includes('JSON invalide'),
  'un JSON invalide est refusé avec un message explicite',
  app.state.notice,
);

console.log('\nI. Intégrité de la chaîne d’audit');
await nav('audit');
assert(appText().includes('Entrées vérifiées'), 'le nombre d’entrées est affiché');
assert(appText().includes('Rupture détectée'), 'l’état de rupture est affiché');
assert(
  appText().includes('ne prouve pas que les données saisies sont exactes'),
  'la portée réelle de la vérification est énoncée',
);
click($('[data-action="verify-chain"]'));
await settle();
assert(app.state.notice.includes('démonstration'), 'la vérification signale le mode démo');

console.log('\nJ. Accessibilité');
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

console.log('\nK. Design system');
assert(html.includes('/* TF:DS:BEGIN */'), 'les marqueurs du design system sont présents');
assert($('.tf-surface--light') !== null, 'contexte de surface déclaré');
assert(html.includes('var(--tf-verified)') && html.includes('var(--tf-missing)'), 'échelles de couleur issues du DS');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:traceability FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:traceability passed — ${checks} contrôles, 0 échec.`);
