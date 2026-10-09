#!/usr/bin/env node
/**
 * CHANTIERS ADMIN 05 et 06 — les deux derniers points du cahier.
 *
 * §5 GLISSER-DÉPOSER
 *   Les dix stades existaient et la transition fonctionnait (un <select> dans la
 *   fiche), mais `draggable` n'apparaissait nulle part dans la console : le
 *   pipeline n'était pas déplaçable à la souris, ce que le cahier demande
 *   explicitement (« prospects draggable between stages »).
 *
 * §6 TITRES PRIORITAIRES
 *   `job_title` était un champ libre sans aucune reconnaissance : les dix titres
 *   du cahier des charges ne servaient à rien.
 *
 *   A.  crm-titles compile et reste pur ;
 *   B.  normalisation et reconnaissance ;
 *   C.  le refus délibéré des faux positifs ;
 *   D.  annotation côté serveur, une seule source ;
 *   E.  §5 — le tableau est déplaçable (markup + accessibilité) ;
 *   F.  §5 — la mécanique du glissement ;
 *   G.  §5 — l'équivalent clavier ;
 *   H.  §5 — une seule porte d'écriture, et LOST exige une raison ;
 *   I.  §6 — la suggestion et le badge ;
 *   J.  i18n.
 *
 *   npm run test:admin:pipeline-titles
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const check = (fn, label) => {
  try { fn(); ok(label); } catch (e) { bad(label, e?.message); }
};
const eq = (a, e, l) => check(() => {
  if (a !== e) throw new Error(`attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);
}, l);
const isTrue = (cond, l, d) => check(() => {
  if (!cond) throw new Error(d ?? 'attendu vrai');
}, l);

const run = (cmd, args) => import('node:child_process').then(({ spawn }) => new Promise((res, rej) => {
  const child = spawn(cmd, args, { cwd: root });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (c) => (c === 0 ? res(out) : rej(new Error(out.slice(-600)))));
}));

/* -------------------------------------------------------------------------- */
console.log('\nA. crm-titles compile et reste pur');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin0506-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-titles.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ]);
  ok('crm-titles.ts compile');
} catch (e) {
  bad('crm-titles.ts ne compile pas', e.message.slice(0, 400));
}
const T = await import(pathToFileURL(join(outDir, 'crm-titles.js')).href);
const titlesSrc = await readFile(at('api/_lib/crm-titles.ts'), 'utf8');
eq(/^import\s/m.test(titlesSrc), false, 'crm-titles.ts n\'importe rien');

/* -------------------------------------------------------------------------- */
console.log('\nB. Normalisation et reconnaissance');
/* -------------------------------------------------------------------------- */

const { PRIORITY_TITLES, normalizeTitle, matchPriorityTitle, isPriorityTitle, annotateContacts } = T;

eq(PRIORITY_TITLES.length, 10, 'les dix titres du cahier des charges');
eq(JSON.stringify(PRIORITY_TITLES), JSON.stringify([
  'CEO', 'Founder', 'COO', 'Supply Chain Director', 'Sustainability Director',
  'Procurement Director', 'Compliance Director', 'Digital Product Manager',
  'Product Development Director', 'CSR/ESG Manager',
]), 'dans l\'ordre du cahier des charges');

for (const title of PRIORITY_TITLES) {
  eq(matchPriorityTitle(title), title, `« ${title} » est reconnu tel quel`);
}

/* Ce qui fait tout l'intérêt de la normalisation. */
eq(matchPriorityTitle('ceo'), 'CEO', 'la casse ne compte pas');
eq(matchPriorityTitle('  CEO  '), 'CEO', 'les espaces en trop non plus');
eq(matchPriorityTitle('C.E.O.'), 'CEO', 'C.E.O. avec ses points est un CEO');
eq(matchPriorityTitle('Chief Executive Officer'), 'CEO', 'la forme longue est un CEO');
eq(matchPriorityTitle('PDG'), 'CEO', 'PDG est reconnu comme CEO');
eq(matchPriorityTitle('Président Directeur Général'), 'CEO',
  'les accents ne créent pas un titre inconnu');
eq(matchPriorityTitle('CO-FOUNDER'), 'Founder', 'CO-FOUNDER avec son tiret est un fondateur');
eq(matchPriorityTitle('Directeur Supply Chain'), 'Supply Chain Director',
  'l\'équivalent français est reconnu');
eq(matchPriorityTitle('Responsable RSE'), 'CSR/ESG Manager', 'Responsable RSE est reconnu');
eq(matchPriorityTitle('Einkaufsdirektor'), 'Procurement Director', 'l\'équivalent allemand est reconnu');

eq(normalizeTitle('C.E.O.'), 'ceo', 'normalizeTitle retire la ponctuation');
eq(normalizeTitle('Directeur  Supply-Chain'), 'directeur supply chain',
  'et réduit les espaces et tirets');
/*
 * Un même accent s'écrit de deux façons en Unicode : « é » précomposé (U+00E9)
 * ou « e » + accent aigu combinant (U+0065 U+0301). Un fichier exporté d'un CRM
 * peut très bien utiliser la forme décomposée. Sans repli, les deux donneraient
 * deux clés différentes et le même titre serait reconnu une fois sur deux.
 */
const precomposed = 'Président Directeur Général';
const decomposed = 'Pre\u0301sident Directeur Ge\u0301ne\u0301ral';
isTrue(precomposed !== decomposed, 'les deux formes sont bien des chaînes différentes');
eq(normalizeTitle(decomposed), normalizeTitle(precomposed),
  'les deux formes Unicode d\'un même accent se normalisent pareil');
eq(matchPriorityTitle(decomposed), 'CEO',
  'un titre saisi en Unicode décomposé est reconnu');

eq(normalizeTitle(null), '', 'null ne lève pas');
eq(normalizeTitle(undefined), '', 'undefined ne lève pas');
eq(normalizeTitle(42), '', 'un nombre ne lève pas');

eq(isPriorityTitle('CEO'), true, 'isPriorityTitle — vrai');
eq(isPriorityTitle('Stagiaire'), false, 'isPriorityTitle — faux');
eq(isPriorityTitle(''), false, 'une chaîne vide n\'est pas prioritaire');

/* -------------------------------------------------------------------------- */
console.log('\nC. Le refus délibéré des faux positifs');
/* -------------------------------------------------------------------------- */

/* Un faux positif coûte plus cher qu'un oubli : il fait perdre du temps
   commercial sur quelqu'un qui ne décide pas, puis fait ignorer le signal. */
eq(matchPriorityTitle('Product Manager'), null,
  '« Product Manager » n\'est PAS « Digital Product Manager » — rôle plus large, refusé');
eq(matchPriorityTitle('Assistant'), null, '« Assistant » n\'est pas prioritaire');
eq(matchPriorityTitle('Director'), null, '« Director » seul ne suffit pas : directeur de quoi ?');
eq(matchPriorityTitle('Supply Chain Manager'), null,
  '« Supply Chain Manager » n\'est pas « Supply Chain Director »');
eq(matchPriorityTitle('CEO of Nothing'), null,
  'une chaîne qui CONTIENT un titre prioritaire n\'est pas ce titre');
eq(matchPriorityTitle('Ex-CEO'), null, 'un ancien CEO n\'est plus la cible');

/* -------------------------------------------------------------------------- */
console.log('\nD. Annotation côté serveur, une seule source');
/* -------------------------------------------------------------------------- */

const annotated = annotateContacts([
  { id: '1', job_title: 'C.E.O.' },
  { id: '2', job_title: 'Stagiaire' },
  { id: '3' },
  { id: '4', job_title: null },
]);
eq(annotated[0].priority_title, 'CEO', 'le titre canonique est renvoyé, pas un booléen');
eq(annotated[1].priority_title, null, 'un titre non reconnu vaut null');
eq(annotated[2].priority_title, null, 'un contact sans titre vaut null');
eq(annotated[3].priority_title, null, 'un titre explicitement null vaut null');
eq(annotated[0].job_title, 'C.E.O.',
  'la valeur SAISIE n\'est pas réécrite : le produit signale, il ne corrige pas');
eq(JSON.stringify(annotateContacts('pas une liste')), '[]',
  'une entrée mal typée ne lève pas');

/* Les deux routes qui servent des contacts doivent annoter pareil. */
for (const [label, file] of [
  ['contacts.ts', 'api/_routes/admin/contacts.ts'],
  ['la fiche entreprise', 'api/_routes/admin/companies/[companyId].ts'],
]) {
  const src = await readFile(at(file), 'utf8');
  isTrue(/annotateContacts\(/.test(src), `${label} annote les titres prioritaires`);
  isTrue(!/PRIORITY_TITLES\s*=\s*\[/.test(src),
    `${label} ne recopie pas la liste : une seule source de vérité`);
}
const contactsSrc = await readFile(at('api/_routes/admin/contacts.ts'), 'utf8');
isTrue(/priority_titles: \[\.\.\.PRIORITY_TITLES\]/.test(contactsSrc),
  'la liste canonique est SERVIE par l\'API, pas codée dans le composant');

/* -------------------------------------------------------------------------- */
console.log('\nE. §5 — le tableau est déplaçable');
/* -------------------------------------------------------------------------- */

const page = await readFile(at('admin/index.html'), 'utf8');
isTrue(/draggable="true"/.test(page), 'les cartes du pipeline sont déplaçables');
isTrue(/data-drop="\$\{esc\(s\)\}"/.test(page),
  'chaque colonne déclare le stade qu\'elle reçoit');
isTrue(/data-drag="\$\{esc\(c\.id\)\}"/.test(page), 'chaque carte porte son identifiant de glissement');
isTrue(/data-stage="\$\{esc\(c\.stage\)\}"/.test(page),
  'et son stade actuel — nécessaire au déplacement au clavier');
isTrue(/tabindex="0"/.test(page), 'les cartes sont atteignables au clavier');
isTrue(/role="listitem"/.test(page), 'et portent un rôle de liste');
isTrue(/aria-live="polite"/.test(page),
  'une région vivante annonce le résultat — un glissement est invisible au lecteur d\'écran');
isTrue(/pipeline\.keyboardHint/.test(page),
  'l\'équivalent clavier est expliqué, pas seulement implémenté');

/* -------------------------------------------------------------------------- */
console.log('\nF-H. §5 — mécanique, clavier et porte d\'écriture unique');
/* -------------------------------------------------------------------------- */

/* UNE SEULE PORTE : la fiche et le tableau doivent passer par la même fonction,
   sinon un des deux chemins finira par écrire sans journaliser. */
isTrue(/async function applyStageMove\(companyId, stage\)/.test(page),
  'applyStageMove existe : la porte d\'écriture unique');
isTrue(/async function moveStage\(stage\)[\s\S]{0,400}applyStageMove\(company\.id, stage\)/.test(page),
  'moveStage (la fiche) délègue à applyStageMove');
isTrue(/async function moveCompanyTo\(companyId, stage\)[\s\S]{0,900}applyStageMove\(companyId, stage\)/.test(page),
  'moveCompanyTo (le tableau) délègue à applyStageMove');
eq((page.match(/companies\/\$\{encodeURIComponent\([^)]*\)\}\/stage/g) || []).length, 1,
  'un seul appel PATCH /stage dans toute la console : deux portes finiraient par diverger');
isTrue(/stage === 'lost'[\s\S]{0,200}window\.prompt\(t\('pipeline\.lostReasonPrompt'\)\)/.test(page),
  'passer à LOST exige une raison (§5) — y compris par glisser-déposer');
isTrue(/if \(!lostReason\) return null/.test(page),
  'et un abandon du dialogue ne force pas la perte');
isTrue(/event\.preventDefault\(\)/.test(page),
  'dragover appelle preventDefault : sans lui le navigateur annule le dépôt sans erreur');
isTrue(/setData\('text\/plain'/.test(page),
  'dragstart remplit dataTransfer : sans setData, Firefox annule le glissement');

/* -------------------------------------------------------------------------- */
console.log('\nI. §6 — suggestion et badge');
/* -------------------------------------------------------------------------- */

isTrue(/<datalist id="job-title-list">/.test(page),
  'une liste de suggestions existe pour le titre de poste');
isTrue(/list="job-title-list"/.test(page),
  'et le champ titre y est relié par l\'attribut list');
isTrue(/state\.contacts\.priority_titles/.test(page),
  'les suggestions viennent de la liste SERVIE, pas d\'une copie dans le composant');
isTrue(/const DEMO_PRIORITY_TITLES = \[/.test(page),
  'le mode démonstration a sa liste — aucun appel réseau n\'y est possible');
isTrue(/titleCell\(c\.job_title, c\.priority_title\)/.test(page),
  'la liste des contacts affiche le badge prioritaire');
isTrue(/titleCell\(k\.job_title, k\.priority_title\)/.test(page),
  'l\'onglet CONTACTS de la fiche l\'affiche aussi — un contact ne peut pas être prioritaire dans une vue et inconnu dans l\'autre');

/* -------------------------------------------------------------------------- */
console.log('\nJ. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const l of LANGS) dicts[l] = JSON.parse(await readFile(at(`locales/${l}/admin.json`), 'utf8'));
const NEW_KEYS = ['pipeline.dragHelp', 'pipeline.keyboardHint',
  'contacts.jobTitleHint', 'contacts.priorityTitle'];
for (const l of LANGS) {
  eq(NEW_KEYS.filter((k) => !dicts[l][k]).length, 0, `${l} : les 4 nouvelles clés sont présentes`);
  eq(Object.keys(dicts[l]).length, Object.keys(dicts.en).length, `${l} : même nombre de clés qu'en`);
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(JSON.stringify(dicts[l])),
    `${l} : aucun caractère CJK`);
}
const untranslated = [];
for (const l of LANGS.filter((x) => x !== 'en')) {
  for (const k of Object.keys(dicts.en)) {
    if (dicts[l][k] === dicts.en[k] && /[a-z]/i.test(dicts.en[k]) && dicts.en[k].split(' ').length > 1) {
      untranslated.push(`${l}:${k}`);
    }
  }
}
eq(untranslated.length, 0, 'aucune entrée multilingue laissée en anglais', untranslated.slice(0, 4).join(', '));
for (const l of LANGS) {
  /* « Strg » en allemand est la traduction correcte de Ctrl : exiger « Ctrl »
     partout punirait une bonne traduction. */
  isTrue(/Ctrl|Strg/.test(dicts[l]['pipeline.keyboardHint']),
    `${l} : l'aide clavier nomme la touche, pas seulement « le clavier »`);
}

/* -------------------------------------------------------------------------- */
console.log('\nK. Rendu réel dans jsdom');
/* -------------------------------------------------------------------------- */

const stub = `<script>window.TracefabI18n = {
  isReady: true, init: async () => true, setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => page
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);
const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));
const dom = new JSDOM(booted(dicts.fr, 'fr'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();
const click = (el) => {
  if (!el) throw new Error('élément introuvable');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};

click(document.querySelector('[data-view="pipeline"]'));
await settle();
await settle();

const cards = [...document.querySelectorAll('[data-drag]')];
isTrue(cards.length > 0, 'le pipeline affiche des cartes déplaçables', `${cards.length} cartes`);
const zones = [...document.querySelectorAll('[data-drop]')];
eq(zones.length, 10, 'dix zones de dépôt : les neuf stades plus LOST');
eq(zones.map((z) => z.dataset.drop).join(','),
  'new,qualified,to_contact,contacted,replied,meeting,demo,pilot,customer,lost',
  'dans l\'ordre du cahier des charges');
eq(zones[0].getAttribute('role'), 'list', 'une zone de dépôt porte role="list"');
eq(cards[0].getAttribute('draggable'), 'true', 'une carte est draggable');
eq(cards[0].getAttribute('tabindex'), '0', 'et atteignable au clavier');
isTrue(/Glissez vers une autre colonne/.test(cards[0].getAttribute('aria-label') || ''),
  'l\'aria-label explique le glissement, pas seulement le contenu');
isTrue(Boolean(document.getElementById('pipeline-live')),
  'la région vivante est bien rendue');
isTrue(/Clavier/.test(document.getElementById('app').textContent || ''),
  'l\'aide clavier est visible sous le tableau');

/* --- mécanique du glissement -------------------------------------------- */
/* jsdom n'implémente pas DragEvent : on construit un Event et on y attache un
   dataTransfer conforme. Ce qui est testé, c'est le comportement du code de la
   page (preventDefault, classes, données), pas l'implémentation du navigateur. */
const fakeTransfer = () => {
  const store = {};
  return {
    effectAllowed: '', dropEffect: '',
    setData: (k, v) => { store[k] = v; },
    getData: (k) => store[k] ?? '',
  };
};
const drag = (el, type, transfer, extra = {}) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: transfer });
  Object.defineProperty(ev, 'target', { value: el });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(ev, k, { value: v });
  el.dispatchEvent(ev);
  return ev;
};

const first = cards[0];
const target = zones.find((z) => z.dataset.drop !== first.dataset.stage);
const transfer = fakeTransfer();
drag(first, 'dragstart', transfer);
eq(transfer.getData('text/plain'), first.dataset.drag,
  'dragstart place l\'identifiant dans dataTransfer');
eq(transfer.effectAllowed, 'move', 'et déclare un déplacement');
isTrue(first.classList.contains('dragging'), 'la carte tenue est marquée visuellement');

const overEvent = drag(target, 'dragover', transfer);
eq(overEvent.defaultPrevented, true,
  'dragover empêche le comportement par défaut — sans ça aucun dépôt n\'est possible');
eq(transfer.dropEffect, 'move', 'et propose le déplacement');
isTrue(target.classList.contains('dropover'), 'la colonne cible est mise en évidence');

/* En démonstration l'écriture est refusée : la démo ne doit pas faire croire
   qu'elle a écrit. Ce qui est vérifié ici, c'est que le refus est explicite. */
const dropEvent = drag(target, 'drop', transfer);
eq(dropEvent.defaultPrevented, true, 'le dépôt est accepté par la colonne');
await settle();
isTrue(!target.classList.contains('dropover'),
  'la mise en évidence retombe après le dépôt');
isTrue(!first.classList.contains('dragging'),
  'et la carte n\'est plus marquée comme tenue');

/* --- équivalent clavier -------------------------------------------------- */
const kb = new window.KeyboardEvent('keydown', {
  key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true,
});
cards[0].dispatchEvent(kb);
eq(kb.defaultPrevented, true,
  'Ctrl + flèche est intercepté : le clavier remplace bien la souris');
const plain = new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
cards[0].dispatchEvent(plain);
eq(plain.defaultPrevented, false,
  'une flèche sans Ctrl n\'est pas interceptée : le défilement normal reste possible');

/* --- §6 rendu ------------------------------------------------------------ */
click(document.querySelector('[data-view="contacts"]'));
await settle();
await settle();
const appText = document.getElementById('app').textContent || '';
isTrue(appText.includes('Cible prioritaire'),
  '§6 : un contact au titre prioritaire porte son badge',
  appText.slice(0, 120));
isTrue(!appText.includes('priority_title'), '§6 : aucune clé brute affichée');
isTrue(!appText.includes('undefined'), '§6 : aucun undefined affiché');

/*
 * La liste de démonstration doit être IDENTIQUE au module serveur : ajouter un
 * titre d'un seul côté passerait inaperçu sans cette comparaison.
 */
/* La constante vit dans l'IIFE : window.eval ne peut pas l'atteindre. Elle est
   donc extraite du source, ce qui vérifie la même chose. */
const demoBlock = page.match(/const DEMO_PRIORITY_TITLES = \[([\s\S]*?)\];/);
isTrue(Boolean(demoBlock), 'la constante de démonstration existe');
const demoList = (demoBlock ? demoBlock[1].match(/'([^']+)'/g) || [] : []).map((x) => x.slice(1, -1));
eq(JSON.stringify(demoList), JSON.stringify([...PRIORITY_TITLES]),
  'la liste de démonstration est identique au module serveur crm-titles.ts');

/* Le datalist doit être rendu avec les dix titres quand le formulaire est ouvert. */
const addBtn = document.getElementById('new-contact');
if (addBtn) {
  click(addBtn);
  await settle();
  const options = [...document.querySelectorAll('#job-title-list option')];
  eq(options.length, 10, 'le datalist propose les dix titres prioritaires');
  eq(options[0].value, 'CEO', 'en commençant par CEO');
  /* modalContact() préfixe ses champs par `kc-`, pas `fc-`. */
  const field = document.getElementById('kc-job_title');
  eq(field && field.getAttribute('list'), 'job-title-list',
    'le champ titre est bien relié au datalist');
} else {
  bad('le formulaire de contact est ouvrable', 'bouton d\'ajout introuvable');
}

eq(pageErrors.length, 0, 'aucune erreur JavaScript pendant le rendu', pageErrors.slice(0, 3).join(' | '));

console.log(`\n${failures ? 'ÉCHEC' : 'SUCCÈS'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures ? 1 : 0);
