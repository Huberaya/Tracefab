#!/usr/bin/env node
/* ==========================================================================
   Chantier 04 — Application Shell : contrat statique.

   Verifie, sans base ni navigateur :
     1. la bibliotheque assets/js/tf-shell.js existe et reste STRICTEMENT
        hote-dependante : aucun appel reseau (fetch/XHR/axios/import),
        API publique TFShell (init/refresh), declencheurs delegues
        [data-shell-open], raccourci Ctrl/Cmd+K, badges ;
     2. la feuille de style assets/design-system/tracefab-shell.css porte
        les classes .tfsh-* (palette, notifications, declencheurs, badges) ;
     3. la Brand Console et le Supplier Portal chargent le shell, exposent
        les hooks necessaires (render/openProduct/openSupplier/openRequest
        cote console ; goView/openRequest cote portail), placent les
        declencheurs dans la topbar et cablent les providers ;
     4. les providers n'inventent aucune donnee : ils ne lisent que l'etat
       deja charge par chaque SPA (state.*) — aucun fetch dans les blocs
       de cablage ;
     5. le namespace i18n `shell` existe dans en.js et dans les six
       locales completes, avec les memes cles que la source du chantier ;
     6. le generateur build_shell_i18n.mjs est idempotent et respecte la
       garde de consolidation (aucun motif de suppression globale).
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

/* --- 1. bibliotheque tf-shell.js ----------------------------------------- */
console.log('\n[1] bibliotheque assets/js/tf-shell.js');
check(existsSync(join(ROOT, 'assets/js/tf-shell.js')), 'fichier present');
const shellJs = read('assets/js/tf-shell.js');
check(/window\.TFShell/.test(shellJs), 'expose window.TFShell');
check(/init\s*\(/.test(shellJs) && /refresh\s*[:=(]/.test(shellJs), 'API publique init/refresh');
check(shellJs.includes('data-shell-open'), 'declencheurs delegues [data-shell-open]');
check(/(metaKey|ctrlKey)/.test(shellJs) && /['"`]k['"`]/i.test(shellJs), 'raccourci Ctrl/Cmd+K');
check(shellJs.includes('data-shell-badge'), 'badges [data-shell-badge]');
check(!/fetch\s*\(/.test(shellJs), 'aucun appel fetch()');
check(!/XMLHttpRequest|axios|\.sendBeacon/.test(shellJs), 'aucun XHR/axios/beacon');
check(!/import\s*\(/.test(shellJs), 'aucun import dynamique');
check(shellJs.includes('Escape'), 'fermeture au clavier (Escape)');

/* --- 2. feuille de style -------------------------------------------------- */
console.log('\n[2] assets/design-system/tracefab-shell.css');
check(existsSync(join(ROOT, 'assets/design-system/tracefab-shell.css')), 'fichier present');
const shellCss = read('assets/design-system/tracefab-shell.css');
for (const cls of ['.tfsh-', '.tfsh-trigger', '.tfsh-badge']) {
  check(shellCss.includes(cls), 'classe ' + cls + ' definie');
}
check(/prefers-reduced-motion/.test(shellCss), 'respect de prefers-reduced-motion');

/* --- 3 & 4. integration SPAs ---------------------------------------------- */
const consoleHtml = read('brand-console/index.html');
const portalHtml = read('supplier-portal/index.html');

console.log('\n[3] integration Brand Console');
check(consoleHtml.includes('/assets/design-system/tracefab-shell.css'), 'css charge');
check(consoleHtml.includes('/assets/js/tf-shell.js'), 'js charge');
check(consoleHtml.includes('data-shell-open="palette"'), 'declencheur palette dans la topbar');
check(consoleHtml.includes('data-shell-open="notifications"'), 'declencheur notifications dans la topbar');
check(consoleHtml.includes('data-shell-badge'), 'badge de notifications present');
check(/window\.tracefabBrandConsole\s*=\s*\{\s*state,\s*sync,\s*render,\s*openProduct,\s*openSupplier,\s*openRequest,\s*remindRequest\s*\}/.test(consoleHtml),
  'hooks exposes (render/openProduct/openSupplier/openRequest/remindRequest)');
check(/window\.TFShell\.init\(\{/.test(consoleHtml), 'TFShell.init cable');

console.log('\n[4] integration Supplier Portal');
check(portalHtml.includes('/assets/design-system/tracefab-shell.css'), 'css charge');
check(portalHtml.includes('/assets/js/tf-shell.js'), 'js charge');
check(portalHtml.includes('data-shell-open="palette"'), 'declencheur palette dans la topbar');
check(portalHtml.includes('data-shell-open="notifications"'), 'declencheur notifications dans la topbar');
check(portalHtml.includes('data-shell-badge'), 'badge de notifications present');
check(/window\.tracefabSupplierPortal\s*=\s*\{\s*state,\s*sync,\s*render,\s*goView,\s*openRequest\s*\}/.test(portalHtml),
  'hooks exposes (goView/openRequest)');
check(/window\.TFShell\.init\(\{/.test(portalHtml), 'TFShell.init cable');
check(portalHtml.trimEnd().endsWith('</html>') && !/^body>/m.test(portalHtml), 'fin de fichier propre (fragments parasites supprimes)');

console.log('\n[4b] honnetete des providers (aucune donnee inventee)');
const wireConsole = consoleHtml.split('wireShell').slice(1).join('wireShell');
const wirePortal = portalHtml.split('wireShell').slice(1).join('wireShell');
check(!/fetch\s*\(|XMLHttpRequest/.test(wireConsole), 'cablage console : aucun appel reseau');
check(!/fetch\s*\(|XMLHttpRequest/.test(wirePortal), 'cablage portail : aucun appel reseau');
check(/host\.state|st\(\)/.test(wireConsole) && /s\.products/.test(wireConsole) && /s\.suppliers/.test(wireConsole) && /s\.requests/.test(wireConsole),
  'providers console : lecture exclusive de state.products/suppliers/requests');
check(/s\.requests/.test(wirePortal) && /s\.materials/.test(wirePortal) && /s\.certifications/.test(wirePortal) && /s\.caps/.test(wirePortal),
  'providers portail : lecture exclusive de state.requests/materials/certifications/caps');

/* --- 5. i18n --------------------------------------------------------------- */
console.log('\n[5] namespace i18n shell');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);

const source = JSON.parse(read('scripts/_chantier04_shell_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length === 29, 'source : 29 cles shell (' + refKeys.length + ')');
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}

const enJs = read('assets/i18n/en.js');
check(/\n\s*"?shell"?\s*:\s*\{/.test(enJs), 'en.js : bloc shell present');

for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'shell.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles shell.* presentes (imbriquees, aplaties par tf-i18n)');
}
for (const lang of ['tr', 'zh']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  check(!Object.keys(catalog).some((k) => k.startsWith('shell.')),
    lang + '.json : namespace shell exclu (locales partielles)');
}

/* --- 6. generateur ---------------------------------------------------------- */
console.log('\n[6] generateur build_shell_i18n.mjs');
const generator = read('scripts/build_shell_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'),
  'garde de consolidation : aucun lookahead de suppression (?=\\n\\};)');
check(!/keys?\s*=\s*keys?\s*\.filter/.test(stripped), 'aucun effacement de cles hors namespace shell');

const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_shell_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(JSON.stringify(before) === JSON.stringify(after), 'generateur idempotent (seconde execution sans effet)');

/* --- resultat --------------------------------------------------------------- */
console.log('');
if (failures) {
  console.error('Contrat Chantier 04 (shell applicatif) : ' + failures + ' verification(s) en echec.');
  process.exit(1);
}
console.log('Contrat Chantier 04 (shell applicatif) : toutes les verifications passent.');
