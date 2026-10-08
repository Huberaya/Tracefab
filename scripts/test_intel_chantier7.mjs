#!/usr/bin/env node
/* ==========================================================================
   Chantier 07 — Product Intelligence reelle : contrat statique.

   Verifie, sans base ni navigateur :
     1. la fiche produit de la Brand Console est structuree en 11 lentilles
        (overview, composition, materials, supply chain, manufacturing,
        suppliers, evidence, certifications, quality, dpp, history) ;
     2. les lentilles sont alimentees par des APIs reelles :
        /api/products/:id (detail), /supply-chain, /dpp et
        /api/quality/products/:id — aucune valeur simulee, etats vides
        explicites, faux chiffres de l ancienne fiche supprimes ;
     3. les actions produit existent : demande de donnees, graphe complet,
        centre qualite, vue DPP, revision, export JSON, historique ;
     4. aucune fonctionnalite existante supprimee : formulaires fiche
        technique, BOM (ajout/edition), identifiants (ajout/edition),
        liaison de schemas versionnes ;
     5. la lentille Preuves annonce honnetement l unification au chantier
        Evidence Center ; la lentille DPP reste sur le vocabulaire de
        preparation (jamais de promesse de conformite) ;
     6. le namespace i18n `intel` existe dans en.js et les six locales
        completes ; generateur idempotent, garde de consolidation respecee.
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
const detailBlock = consoleHtml.slice(
  consoleHtml.indexOf('function productDetailView()'),
  consoleHtml.indexOf('function supplierDetailView()')
);

/* --- 1. 11 lentilles -------------------------------------------------------- */
console.log('\n[1] structure 11 lentilles');
check(consoleHtml.includes('/assets/design-system/tracefab-intel.css'), 'css intel charge');
check(existsSync(join(ROOT, 'assets/design-system/tracefab-intel.css')), 'fichier tracefab-intel.css present');
const css = read('assets/design-system/tracefab-intel.css');
check(css.includes('.pil-tabs') && css.includes('.pil-lens'), 'styles onglets/lentilles defines');
check(/prefers-reduced-motion/.test(css), 'respect de prefers-reduced-motion');
check(/@media \(max-width: 720px\)/.test(css), 'adaptation mobile');
const lenses = ['overview', 'composition', 'materials', 'supplyChain', 'manufacturing', 'suppliers', 'evidence', 'certifications', 'quality', 'dpp', 'history'];
check(lenses.every((id) => detailBlock.includes(`'${id}'`)), 'les 11 lentilles referencees');
check(/LENSES\.map\(\(id\) => `<button type="button" class="pil-tab/.test(detailBlock), 'barre d onglets rendue');
check(/data-pi-lens="\$\{id\}"/.test(detailBlock), 'sections de lentilles rendues');
check(/document\.querySelectorAll\('\[data-pi-tab\]'\)/.test(consoleHtml), 'bascule des lentilles cablee dans bind()');

/* --- 2. donnees reelles, rien de simule ------------------------------------- */
console.log('\n[2] honnetete des donnees');
check(/function loadProductIntel\(/.test(consoleHtml), 'loader loadProductIntel present');
check(consoleHtml.includes('/api/products/${encodeURIComponent(id)}/supply-chain'), 'graphe de tracabilite charge depuis l API');
check(consoleHtml.includes('/api/products/${encodeURIComponent(id)}/dpp'), 'preparation DPP chargee depuis l API');
check(consoleHtml.includes('/api/quality/products/${encodeURIComponent(id)}'), 'score qualite charge depuis l API');
check(/Promise\.allSettled\(/.test(consoleHtml.slice(consoleHtml.indexOf('function loadProductIntel'), consoleHtml.indexOf('function exportProductIntel'))), 'chargement parallele tolerant aux erreurs');
check(/state\.productIntel = await loadProductIntel\(id\)/.test(consoleHtml), 'openProduct cable au loader');
check(detailBlock.includes("bit('supplyChain.noGraph'"), 'etat vide explicite pour le graphe');
check(detailBlock.includes("bit('quality.noQuality'"), 'etat vide explicite pour la qualite');
check(detailBlock.includes("bit('dpp.noDpp'"), 'etat vide explicite pour le DPP');
check(detailBlock.includes("bit('history.noHistory'"), 'etat vide explicite pour l historique');
for (const fake of ['98.4', 'Ferme GOTS', 'Guimarães PT', 'ZDHC Level 3', 'BOM 100%', 'Score A (PEF)', 'Combed Organic Cotton (GOTS)', 'Navy Deep']) {
  check(!detailBlock.includes(fake), 'faux element supprime de la fiche produit : ' + fake);
}

/* --- 3. actions produit -------------------------------------------------------- */
console.log('\n[3] actions produit');
check(detailBlock.includes('data-action="product-new-request"'), 'action : demande de donnees');
check(detailBlock.includes('data-action="product-supply-chain-from-detail"'), 'action : graphe complet (view lineage)');
check(detailBlock.includes('data-action="product-dpp-from-detail"'), 'action : vue DPP complete');
check(detailBlock.includes('data-action="product-quality-from-detail"'), 'action : centre qualite');
check(detailBlock.includes('data-action="product-revision"'), 'action : nouvelle revision');
check(detailBlock.includes('data-action="product-export-intel"'), 'action : export du produit');
check(/function exportProductIntel\(\)/.test(consoleHtml), 'exportProductIntel presente');
check(/downloadTextFile\(`tracefab-product-/.test(consoleHtml), 'export reel : telechargement JSON');
check(/historyEvents\.push/.test(detailBlock), 'historique derive d evenements horodates reels');

/* --- 4. fonctionnalites existantes conservees ---------------------------------- */
console.log('\n[4] non-suppression des fonctions existantes');
for (const id of ['product-detail-form', 'material-form', 'identifier-form', 'schema-binding-form', 'material-edit-form', 'identifier-edit-form']) {
  check(detailBlock.includes(id), 'formulaire conserve : ' + id);
}
check(detailBlock.includes('data-material-product-id'), 'edition des parts BOM conservee');
check(detailBlock.includes('data-identifier-id'), 'edition des identifiants conservee');
check(detailBlock.includes('name="schemaIdentity"'), 'liaison de schemas conservee');
check(consoleHtml.includes("action === 'product-revision'"), 'handler revision intact');

/* --- 5. honnetete Evidence / DPP -------------------------------------------------- */
console.log('\n[5] lentilles Evidence et DPP');
check(detailBlock.includes("bit('evidence.plannedNote'"), 'Evidence : annonce honnete (chantier Evidence Center)');
check(detailBlock.includes('data-view="documents"'), 'Evidence : lien vers les documents reels');
check(detailBlock.includes("bit('dpp.readinessNote'"), 'DPP : vocabulaire preparation, jamais conformite');
check(!/conformite legale garantie|legal compliance guaranteed/i.test(detailBlock), 'aucune promesse de conformite');

/* --- 6. i18n ------------------------------------------------------------------------ */
console.log('\n[6] namespace i18n intel');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const source = JSON.parse(read('scripts/_chantier07_intel_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length === 63, 'source : 63 cles intel (' + refKeys.length + ')');
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n\s*"?intel"?\s*:\s*\{/.test(enJs), 'en.js : bloc intel present');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'intel.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles intel.* presentes');
}
for (const lang of ['tr', 'zh']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  check(!('intel' in catalog), lang + '.json : namespace intel exclu (locales partielles, repli EN)');
}

/* --- 7. generateur --------------------------------------------------------------------- */
console.log('\n[7] generateur build_intel_i18n.mjs');
const generator = read('scripts/build_intel_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'),
  'garde de consolidation : aucun lookahead de suppression (?=\\n\\};)');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_intel_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(JSON.stringify(before) === JSON.stringify(after), 'generateur idempotent (seconde execution sans effet)');

/* --- resultat ------------------------------------------------------------------------------- */
console.log('');
if (failures) {
  console.error('Contrat Chantier 07 (Product Intelligence) : ' + failures + ' verification(s) en echec.');
  process.exit(1);
}
console.log('Contrat Chantier 07 (Product Intelligence) : toutes les verifications passent.');
