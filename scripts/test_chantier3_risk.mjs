/* ==========================================================================
   TRACEFAB — chantier 3 : la vue Risk de la console.

   Le cahier des charges impose la navigation :
     Overview, Products, Suppliers, Materials, Supply Chain, Data Collection,
     Evidence, Certifications, Quality, RISK, DPP, Reports, Settings
   La vue Risk etait absente. Ce test verrouille sa presence, son cablage et
   sa couverture i18n, pour qu'elle ne reparte pas silencieusement.

   Il verrouille aussi la vue 'intelligence', qui etait declaree dans la nav
   mais absente du dispatch : elle retombait sur requestDetailView(). Une
   entree de nav sans branche de dispatch est exactement le defaut que ce
   test doit empecher de revenir.

   Usage : node scripts/test_chantier3_risk.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageSource } from './lib/page_source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['fr', 'de', 'it', 'es', 'nl', 'pt'];

let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const page = pageSource('brand-console/index.html');

/* --- 1. cablage de la vue ------------------------------------------------ */
ok(page.includes("navButton('risk'"), "entree de navigation 'risk'");
ok(/state\.view === 'risk' \? riskView\(\)/.test(page), "branche de dispatch 'risk'");
ok((page.match(/function riskView\(\)/g) || []).length === 1, 'riskView() definie une fois');
ok((page.match(/function riskSignals\(\)/g) || []).length === 1, 'riskSignals() definie une fois');
ok(/risk: bt\('riskViewLabel'\)/.test(page), 'libelle de vue localise');

/* --- 2. regression : toute entree de nav doit avoir une branche ---------- */
const vuesNav = [...page.matchAll(/navButton\('([a-zA-Z]+)'/g)].map((m) => m[1]);
const sansDispatch = vuesNav.filter((v) => v !== 'overview'
  && !new RegExp(`state\\.view === '${v}' \\?`).test(page));
ok(sansDispatch.length === 0, 'chaque entree de nav a une branche de dispatch',
  sansDispatch.length ? `sans branche : ${sansDispatch.join(', ')}` : '');

/* --- 3. le score ne doit jamais etre presente comme une certification ---- */
const bundle = {};
global.window = { TF_I18N_BUNDLES: bundle };
await import(`file://${join(ROOT, 'assets/i18n/en.js')}`);
const en = bundle.en;
ok(!!en?.console?.riskLead, 'console.riskLead present');
ok(/not a certification/i.test(en.console.riskLead || ''),
  'riskLead ecarte explicitement la certification');
ok(/certification/i.test(en.console.riskNotCertification || ''),
  'badge riskNotCertification present');

/* --- 4. couverture i18n : toute cle bt('riskX') lue par la page existe --- */
const clesLues = [...new Set([...page.matchAll(/bt\('(risk[A-Za-z]*)'\)/g)].map((m) => m[1]))];
ok(clesLues.length >= 25, `la page lit ${clesLues.length} cles risk*`);

const manquantesEn = clesLues.filter((k) => en.console[k] === undefined);
ok(manquantesEn.length === 0, 'toutes les cles lues existent en anglais',
  manquantesEn.join(', '));

for (const lang of LANGS) {
  const d = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${lang}.json`), 'utf8'));
  const manquantes = clesLues.filter((k) => !d.console || d.console[k] === undefined);
  const vides = clesLues.filter((k) => d.console && typeof d.console[k] === 'string' && !d.console[k].trim());
  ok(manquantes.length === 0 && vides.length === 0, `couverture ${lang}`,
    [manquantes.length ? `absentes: ${manquantes.join(', ')}` : '',
      vides.length ? `vides: ${vides.join(', ')}` : ''].filter(Boolean).join(' · '));
}

/* --- 5. pas de copie metier en dur dans la vue --------------------------- */
// On isole le corps de riskView() et on verifie que le texte visible passe
// par bt(). Les seules chaines litterales admises sont techniques (classes
// CSS, noms de vues, unites), pas de la phrase.
const i = page.indexOf('function riskView()');
// Delimitation par comptage d'accolades : se reperer sur l'indentation de la
// fonction suivante deborde sur qualityView(), qui n'est pas indentee pareil.
let prof = 0; let fin = -1;
for (let k = page.indexOf('{', i); k < page.length; k += 1) {
  if (page[k] === '{') prof += 1;
  else if (page[k] === '}') { prof -= 1; if (prof === 0) { fin = k; break; } }
}
const corps = page.slice(i, fin > 0 ? fin + 1 : i + 9000);
const phrases = [...corps.matchAll(/>([^<>{}$]{18,})</g)]
  .map((m) => m[1].trim())
  .filter((t) => /[a-zA-Z]{4,}\s+[a-zA-Z]{4,}/.test(t));
ok(phrases.length === 0, 'aucune phrase en dur dans riskView()',
  phrases.slice(0, 3).join(' | '));

/* --- 6. le generateur est idempotent ------------------------------------ */
ok(readFileSync(join(ROOT, 'scripts/build_risk_i18n.mjs'), 'utf8').includes('indexOf(DEBUT)'),
  'build_risk_i18n.mjs retire sa region avant reecriture');

console.log(ko === 0 ? '\n  chantier 3 : vue Risk conforme.' : `\n  chantier 3 : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
