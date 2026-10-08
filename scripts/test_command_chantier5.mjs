#!/usr/bin/env node
/* ==========================================================================
   Chantier 05 — Brand Command Center : contrat statique.

   Verifie, sans base ni navigateur :
     1. le moteur de tables assets/js/tf-tables.js existe et reste
        strictement DOM : aucun appel reseau (fetch/XHR/axios/import),
        API publique TFTables (setT/register/mount), export CSV via Blob,
        vues sauvegardees en localStorage ;
     2. la feuille de style tracefab-command.css porte les classes cc-… et tft-…
        et respecte prefers-reduced-motion ;
     3. l'overview de la Brand Console est bien un Command Center
        WHERE / MISSING / RISKY / NEXT : toutes les metriques derivees de
        l'etat (aucun faux chiffre en dur), KPI cliquables ;
     4. les tables produits/fournisseurs/demandes sont marquees pour le
        moteur (data-tftable/data-tfsort/data-tf-id) et les actions de
        groupe appellent des fonctions reelles (remindRequest) ;
     5. le namespace i18n `command` existe dans en.js et les six locales
        completes, paritaire avec la source du chantier ;
     6. le generateur build_command_i18n.mjs est idempotent et respecte la
        garde de consolidation.
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

/* --- 1. moteur de tables -------------------------------------------------- */
console.log('\n[1] assets/js/tf-tables.js');
check(existsSync(join(ROOT, 'assets/js/tf-tables.js')), 'fichier present');
const tables = read('assets/js/tf-tables.js');
check(/window\.TFTables/.test(tables), 'expose window.TFTables');
check(/setT: setT, register: register, mount: mount/.test(tables), 'API publique setT/register/mount');
check(!/fetch\s*\(|XMLHttpRequest|axios/.test(tables), 'aucun appel reseau');
check(!/import\s*\(/.test(tables), 'aucun import dynamique');
check(tables.includes('Blob') && tables.includes('text/csv'), 'export CSV via Blob');
check(tables.includes('tracefab.tableViews.'), 'vues sauvegardees sous tracefab.tableViews.<id>');
check(tables.includes('aria-sort'), 'tri accessible (aria-sort)');
check(tables.includes('data-tf-row-check') && tables.includes('data-tf-check-all'), 'selection massive (case par ligne + tout selectionner)');

/* --- 2. feuille de style --------------------------------------------------- */
console.log('\n[2] assets/design-system/tracefab-command.css');
check(existsSync(join(ROOT, 'assets/design-system/tracefab-command.css')), 'fichier present');
const css = read('assets/design-system/tracefab-command.css');
for (const cls of ['.cc-section', '.cc-kpi', '.cc-pill', '.cc-next-item', '.cc-chip', '.tft-toolbar', '.tft-bulkbar', '.tft-sortable']) {
  check(css.includes(cls), 'classe ' + cls + ' definie');
}
check(/prefers-reduced-motion/.test(css), 'respect de prefers-reduced-motion');

/* --- 3. overview = Command Center ------------------------------------------ */
console.log('\n[3] overview Brand Console');
const consoleHtml = read('brand-console/index.html');
check(consoleHtml.includes('/assets/design-system/tracefab-command.css'), 'css command charge');
check(consoleHtml.includes('/assets/js/tf-tables.js'), 'js tables charge');
check(consoleHtml.includes("tcc('command.section.where'"), 'section WHERE presente');
check(consoleHtml.includes("tcc('command.section.missing'"), 'section MISSING presente');
check(consoleHtml.includes("tcc('command.section.risky'"), 'section RISKY presente');
check(consoleHtml.includes("tcc('command.section.next'"), 'section NEXT presente');
check(/data-view="\$\{view\}"/.test(consoleHtml), 'KPI cliquables (data-view)');
check(consoleHtml.includes("const overdueRequests = openRequests.filter"), 'retards calcules depuis state.requests');
check(consoleHtml.includes("const certsExpiring ="), 'certifications expirantes calculees depuis state.certifications');
for (const fake of ['214 sites', '97.6%', '1 098 styles', 'GRADE A', 'CIRPASS 1.2', 'mc-attention-num">${']) {
  check(!consoleHtml.includes(fake), 'faux chiffre/affirmation supprime : ' + fake);
}

/* --- 4. tables modernes ------------------------------------------------------ */
console.log('\n[4] tables modernes');
check(consoleHtml.includes('data-tftable="products"'), 'table produits marquee');
check(consoleHtml.includes('data-tftable="suppliers"'), 'table fournisseurs marquee');
check(consoleHtml.includes('data-tftable="requests"'), 'table demandes marquee');
check((consoleHtml.match(/data-tfsort/g) || []).length >= 13, 'colonnes triables (>= 13 th[data-tfsort])');
check(consoleHtml.includes('data-tf-id="${esc(p.id)}"'), 'lignes produits porteuses d identifiant');
check(consoleHtml.includes('data-tf-id="${esc(r.id)}"'), 'lignes demandes porteuses d identifiant');
check(consoleHtml.includes("window.TFTables.register('products'"), 'produits enregistres aupres du moteur');
check(consoleHtml.includes("window.TFTables.register('suppliers'"), 'fournisseurs enregistres aupres du moteur');
check(consoleHtml.includes("window.TFTables.register('requests'"), 'demandes enregistrees aupres du moteur');
check(/bulk:\s*\[\s*\{\s*id:\s*'remind'[\s\S]*remindRequest\(id\)/.test(consoleHtml), 'action de groupe rappel = appel reel a remindRequest');
check(/window\.tracefabBrandConsole\s*=\s*\{[^}]*remindRequest[^}]*\}/.test(consoleHtml), 'remindRequest exposee sur le pont public');

/* --- 5. i18n ------------------------------------------------------------------ */
console.log('\n[5] namespace i18n command');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);

const source = JSON.parse(read('scripts/_chantier05_command_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length === 45, 'source : 45 cles command (' + refKeys.length + ')');
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n\s*"?command"?\s*:\s*\{/.test(enJs), 'en.js : bloc command present');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'command.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles command.* presentes');
}
for (const lang of ['tr', 'zh']) {
  check(!existsSync(join(ROOT, `assets/i18n/${lang}.json`)),
    lang + '.json : locale partielle retiree du produit (chantier 15)');
}

/* --- 6. generateur -------------------------------------------------------------- */
console.log('\n[6] generateur build_command_i18n.mjs');
const generator = read('scripts/build_command_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'),
  'garde de consolidation : aucun lookahead de suppression (?=\\n\\};)');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_command_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(JSON.stringify(before) === JSON.stringify(after), 'generateur idempotent (seconde execution sans effet)');

/* --- resultat --------------------------------------------------------------------- */
console.log('');
if (failures) {
  console.error('Contrat Chantier 05 (Brand Command Center) : ' + failures + ' verification(s) en echec.');
  process.exit(1);
}
console.log('Contrat Chantier 05 (Brand Command Center) : toutes les verifications passent.');
