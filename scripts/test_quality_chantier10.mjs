#!/usr/bin/env node
/* ==========================================================================
   Chantier 10 — Quality Center premium : contrat statique.

   Verifie, sans base ni navigateur :
     1. l'historique des scores produit est expose (GET
        /api/quality/products/:id/history) avec la meme garde que le score ;
     2. la vue Qualite de la Brand Console est reelle : score decompose en
        4 composantes cliquables, drill-down (champs manquants, anomalies
        bloquantes, anomalies liees), actions « resoudre » vers les vues
        reelles, filtres de severite a compteurs reels, tendances ;
     3. tout le contenu simule de l ancienne vue est supprime (grade
        98.4 %, piliers fixes, carte « ESPR Conformity », fausses
        anomalies, onglets filterIssues) ;
     4. le namespace i18n `qualityPremium` existe dans en.js et les six
        locales completes ; generateur idempotent ;
     5. non-regression : les routes qualite existantes, le SPA
        Quality Center et les chantiers precedents.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const check = (cond, m) => (cond ? ok(m) : fail(m));

const consoleHtml = read('brand-console/index.html');
const qView = consoleHtml.slice(
  consoleHtml.indexOf('function qualityView()'),
  consoleHtml.indexOf('function scoreCard(')
);
const qHelpers = consoleHtml.slice(
  consoleHtml.indexOf('/* Chantier 10'),
  consoleHtml.indexOf('function qualityView()')
);
const indexTs = read('api/index.ts');

/* --- 1. API historique ------------------------------------------------------ */
console.log('\n[1] API : historique des scores');
const historyRoute = read('api/_routes/quality/products/[productId]/history.ts');
check(/accessibleProduct/.test(historyRoute), 'historique : garde par produit accessible (tracefab_can_access_org)');
check(/computed_at: 'desc'/.test(historyRoute) && /HISTORY_LIMIT/.test(historyRoute), 'historique : instantanes bornes et tries');
check(/history\.reverse\(\)/.test(historyRoute), 'historique : retourne en ordre chronologique croissant');
check(/serializeQualityScore/.test(historyRoute), 'historique : serialisation commune des scores');
const historyPos = indexTs.indexOf("quality\\/products\\/([^\\/]+)\\/history");
check(historyPos !== -1, 'routeur : historique enregistre');
check(indexTs.includes("{ pattern: /^quality\\/products\\/([^\\/]+)\\/history$/, params: ['productId'], load: () => import('./_routes/quality/products/[productId]/history.js') }"), 'routeur : entree historique au format litteral');
check(historyPos < indexTs.indexOf("{ pattern: /^quality\\/products\\/([^\\/]+)$/, params: ['productId']"), 'routeur : historique avant la route produit (specificite)');

/* --- 2. vue reelle, contenu simule supprime ---------------------------------- */
console.log('\n[2] vue Qualite de la Brand Console');
check(qView.length > 2000, 'qualityView presente et substantielle');
for (const fake of ['OVERALL GRADE', 'eq-score-num', 'qcEsprConformity', 'filterIssues', 'ZDHC_EFFLUENT_TEST_REPORT', 'CERTIFICATE_EXPIRATION_GATE', 'POLYGON_FACILITY_REGISTRY', '96.8', '92.0', '88.5', '94.2', 'dye lot']) {
  check(!qView.includes(fake), `contenu simule supprime : ${fake}`);
}
check(!/98\.4/.test(qView), 'contenu simule supprime : grade 98.4');
check(/data-action="quality-component"/.test(qView), 'composantes cliquables (drill-down)');
check(/QUALITY_COMPONENTS = \['completeness', 'freshness', 'documentationCoverage', 'consistency'\]/.test(qHelpers), 'les 4 composantes reelles du moteur');
check(/score\.missingFields/.test(qView), 'drill-down : champs manquants du score reel');
check(/score\.blockingIssues/.test(qView), 'drill-down : anomalies bloquantes du score reel');
check(/qualityRelatedIssues\(issues, activeComponent\)/.test(qView), 'drill-down : anomalies liees par composante');
check(/filteredIssues\.map\(issueCard\)/.test(qView), 'problemes rendus par le vrai renderer issueCard (acquitter/deroger)');
check(/sevCounts/.test(qView), 'filtres de severite : compteurs calcules depuis les donnees');
check(/qualityResolveTarget/.test(qView), 'actions « resoudre » vers les vues reelles');
check(/data-action="quality-resolve"/.test(qView), 'boutons resoudre cablés');
check(/qualityHistory/.test(qView), 'panneau tendances consomme l historique');
check(/qp\('trend\.empty'/.test(qView), 'tendances : etat vide explicite (< 2 instantanes)');
check(/qp\('panel\.empty'/.test(qView), 'score : etat vide explicite + CTA calcul');
check(/computedAt/.test(qView) && /calculationVersion/.test(qView), 'metadonnees de calcul affichees (date + version)');

/* --- 3. cablage --------------------------------------------------------------- */
console.log('\n[3] chargement et actions');
check(/\/history`\)/.test(consoleHtml) && /Promise\.allSettled\(\[\s*api\(`\/api\/quality\/products\/\$\{encodeURIComponent\(id\)\}`\),\s*api\(`\/api\/quality\/products\/\$\{encodeURIComponent\(id\)\}\/history`\)/.test(consoleHtml), 'loadQuality : score + historique en allSettled');
check(/state\.qualityHistory = history\.status === 'fulfilled'/.test(consoleHtml), 'historique non bloquant pour la vue');
check(/state\.qualityHistory\.push/.test(consoleHtml), 'recalcul demo : instantane ajoute a la tendance');
check(/qualityHistory: \[\]/.test(consoleHtml) && /qualityComponent: null/.test(consoleHtml) && /qualitySeverityFilter: 'all'/.test(consoleHtml), 'etat initialise');
check(/'quality-component'\) \{ const comp = el\.dataset\.qualityComponent/.test(consoleHtml), 'dispatcher : bascule du drill-down');
check(/'quality-severity'\) \{ state\.qualitySeverityFilter/.test(consoleHtml), 'dispatcher : filtre de severite');
check(/'quality-resolve'\) \{ state\.view = el\.dataset\.target/.test(consoleHtml), 'dispatcher : navigation vers la vue de resolution');
check(/missingFields: \['product_material_composition'\]/.test(consoleHtml), 'demo : champs manquants et anomalies bloquantes fournis');

/* --- 4. namespace i18n qualityPremium ------------------------------------------- */
console.log('\n[4] namespace i18n qualityPremium');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const source = JSON.parse(read('scripts/_chantier10_quality_premium_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length >= 30, `source : au moins 30 cles qualityPremium (${refKeys.length})`);
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n  "?qualityPremium"?\s*:\s*\{/.test(enJs), 'en.js : bloc qualityPremium present (niveau racine)');
check(!/\},,\n/.test(enJs), 'en.js : aucune double virgule');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'qualityPremium.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles qualityPremium.* presentes');
}
for (const lang of ['tr', 'zh']) {
  check(!existsSync(join(ROOT, `assets/i18n/${lang}.json`)), lang + '.json : locale partielle retiree du produit (chantier 15)');
}

/* --- 5. generateur ---------------------------------------------------------------- */
console.log('\n[5] generateur build_quality_premium_i18n.mjs');
const generator = read('scripts/build_quality_premium_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'), 'garde de consolidation : aucun lookahead de suppression');
check(/\\n  "qualityPremium"|\\n  qualityPremium/.test(generator), 'test d idempotence ancre au niveau racine');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_quality_premium_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(before.every((b, i) => b === after[i]), 'generateur idempotent : aucun fichier modifie au second passage');

/* --- 6. non-regression ----------------------------------------------------------------- */
console.log('\n[6] non-regression');
for (const route of [
  'quality/overview.js',
  'quality/calculate-index.js',
  'quality/audit-pack.js',
  'quality/products/[productId].js',
  'quality/suppliers/[supplierId].js',
  'quality-issues/[issueId]/acknowledge.js',
  'quality-issues/[issueId]/waive.js',
  'quality/caps.js',
  'certifications.js',
  'documents.js',
]) {
  check(indexTs.includes(route), `route toujours enregistree : ${route}`);
}
const spa = read('quality-center/index.html');
check(/\/api\/quality\/overview/.test(spa), 'SPA Quality Center : branchement /api/quality/overview intact');
check(/data-issue-action/.test(spa), 'SPA Quality Center : actions acquitter/deroger intactes');
check(/data-action="acknowledge-issue"/.test(consoleHtml) && /data-action="open-waive-modal"/.test(consoleHtml), 'console : actions acquitter/deroger toujours cablees');
check(/function computeQuality\(/.test(consoleHtml) && /tracefab|product_quality_v1/.test(consoleHtml), 'console : recalcul reel conserve');
check(read('README.md').includes('Notification Observability'), 'README : libelle Notification Observability preserve');

console.log(failures ? `\n${failures} verification(s) en echec.` : '\nContrat Quality Center premium (chantier 10) : OK.');
if (failures) process.exit(1);
