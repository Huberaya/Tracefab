#!/usr/bin/env node
/**
 * Le Quality Center traduit depuis locales/, plus depuis un glossaire.
 *
 * AVANT
 *   `quality-center/index.html` chargeait auto-translate.js, qui traduit par
 *   GLOSSAIRE : 7 termes sur les ~130 chaînes de la page. Tout le reste — les
 *   quatre vues, les tableaux, les formulaires de plan d'action, les messages —
 *   était en français en dur.
 *
 * TROIS PIÈGES CORRIGÉS AU PASSAGE
 *   · `api()` déclarait déjà `const t = await token()` pour le jeton Clerk. Un
 *     traducteur nommé `t` dans la même portée l'aurait masqué : la collision
 *     entre un jeton d'authentification et une fonction de traduction ne se voit
 *     qu'en production. Le helper s'appelle `tr`.
 *   · Les libellés d'énumérations étaient trois objets littéraux. Ils deviennent
 *     des fonctions qui construisent la clé ; une valeur inconnue retombe sur la
 *     valeur brute, jamais sur une étiquette inventée.
 *   · `toLocaleString('fr-FR')` et `toLocaleDateString('fr-FR')` étaient en dur :
 *     même une page entièrement traduite afficherait « 14/01/2027 » à un lecteur
 *     allemand.
 *
 * DÉCISION ASSUMÉE : les enregistrements de démonstration ne sont PAS traduits
 *   `demoData()` contient des messages d'issues et des titres de plans. Ce sont
 *   des DONNÉES, ce que l'API renverrait ; en production elles viennent de la
 *   base et le client ne traduit pas les données du serveur. Le mode démo est
 *   déjà explicitement étiqueté à chaque action.
 *
 *     A. le contenu métier n'est plus codé dans le composant ;
 *     B. les quatre vues sont traduites, et changer de langue les retraduit ;
 *     C. les libellés d'énumérations et le pluriel suivent la langue ;
 *     D. les 7 dictionnaires : 130 clés, parité, jetons identiques.
 *
 *   npm run test:i18n:quality
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdomPkg;

const root = new URL('../', import.meta.url);
const at = (p) => new URL(p, root);

let checks = 0;
let failures = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => { failures += 1; checks += 1; console.error(`  FAIL  ${label}\n        ${detail ?? 'assertion failed'}`); };
const assert = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));
const eq = (actual, expected, label) =>
  assert(actual === expected, label, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const SCOPE = 'quality';
const html = await readFile(at('quality-center/index.html'), 'utf8');
const scriptBody = (html.match(/<div id="app"><\/div>\s*<script>\n([\s\S]*?)\n {2}<\/script>/) || [, ''])[1];

const flat = (o, p = '') => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const path = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flat(v, path)); else out[path] = v;
  }
  return out;
};
const dicts = {};
for (const lang of LANGS) {
  const doc = JSON.parse(await readFile(at(`locales/${lang}/${SCOPE}.json`), 'utf8'));
  dicts[lang] = flat(doc[SCOPE] || {});
}

const serveLocally = requestInterceptor((request) => {
  const rel = new URL(request.url).pathname.replace(/^\/+/, '');
  for (const candidate of [rel, `public/${rel}`]) {
    const full = fileURLToPath(at(candidate));
    if (existsSync(full)) {
      const body = readFileSync(full, 'utf8');
      const type = candidate.endsWith('.json') ? 'application/json' : 'application/javascript';
      return new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8` } });
    }
  }
  return new Response('', { status: 404 });
});

async function mount() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    /* ?demo=1 : la page sert ses données de démonstration sans Clerk ni API,
       ce qui est exactement le chemin de rendu observé ici. */
    url: 'https://tracefab.vercel.app/quality-center?demo=1',
    virtualConsole: vc,
    resources: { interceptors: [serveLocally] },
  });
  dom.window.fetch = async (url) => {
    const rel = String(url).replace(/^\/+/, '');
    for (const candidate of [rel, `public/${rel}`]) {
      try {
        return { ok: true, status: 200, json: async () => JSON.parse(await readFile(at(candidate), 'utf8')) };
      } catch { /* candidat suivant */ }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  for (let i = 0; i < 200; i += 1) {
    if (dom.window.TracefabI18n?.isReady
      && (dom.window.document.getElementById('app')?.innerHTML || '').length > 800) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 80));
  return { dom, window: dom.window, document: dom.window.document, errors };
}

const all = (document, sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || '').trim());
const shown = (view) => {
  const qc = dom.window.tracefabQualityCenter;
  qc.state.view = view;
  qc.state.capDetail = null;
  qc.render();
};

// ---------------------------------------------------------------------------
console.log('\nA. Le contenu métier n’est plus codé dans le composant');
// ---------------------------------------------------------------------------

assert(html.includes('/i18n-core.js'), 'la page charge le runtime partagé');
assert(!html.includes('src="/auto-translate.js"'), 'et ne s’appuie plus sur le glossaire auto-translate.js');
assert(/init\(\{\s*scope:\s*'quality'/.test(html), 'et déclare le scope « quality »');

/* Le helper doit s'appeler `tr` : `t` est le jeton Clerk dans api(). */
assert(/const tr = \(key, values\)/.test(scriptBody), 'le traducteur s’appelle tr(), pas t()');
assert(/const t = await token\(\)/.test(scriptBody), 'et api() conserve son jeton t sans collision');

for (const literal of ['Vue d’ensemble', 'Rafraîchir', 'Mode démonstration', 'Complétude des données',
  'Couverture des preuves', 'Issues critiques', 'Voir toutes les issues', 'Boucle de correction',
  'Acquitter', 'Plan d’action', 'Notes de revue', 'Fil de discussion', 'Aucun score calculé',
  'Peut-on faire confiance à la donnée ?', 'Qualité indisponible', 'Contrôler la qualité de la donnée.']) {
  const quoted = new RegExp(`['"\`]${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  assert(!quoted.test(scriptBody), `« ${literal} » n’est plus une valeur produite par le script`);
}
assert(!scriptBody.includes("toLocaleString('fr-FR')"), 'les nombres ne forcent plus le français');
assert(!scriptBody.includes("toLocaleDateString('fr-FR')"), 'et les dates non plus');
assert(!scriptBody.includes('tf-select--sm'), 'aucune classe CSS inventée (seule .tf-select existe)');

/*
 * Les trois tables de libellés doivent CONSTRUIRE une clé, pas porter du texte.
 *
 * Vérifier seulement la forme `(v) =>` était trop faible : contre-vérifié, une
 * table codée en dur réécrite en fonction fléchée —
 * `(v) => ({ blocking: 'Critique', … }[v] || v)` — la satisfaisait et les 120
 * vérifications passaient quand même. L'assertion porte donc sur ce qui compte :
 * le corps appelle tr() avec le bon préfixe de clé.
 */
for (const [name, prefix] of [['SEVERITY_LABEL', 'quality.severity.'],
  ['STATUS_LABEL', 'quality.status.'], ['CAP_STATUS_LABEL', 'quality.capStatus.']]) {
  const body = (scriptBody.match(new RegExp(`const ${name} = \\(v\\) => ([^;]+);`)) || [, ''])[1];
  assert(body.includes(`tr('${prefix}'`) && !/'[A-ZÀ-Ý][a-zéèêàçîôû]/.test(body),
    `${name} construit la clé ${prefix}… au lieu de porter du texte`, body);
}

/* Décision assumée : les enregistrements de démonstration restent tels quels.
   Les épingler ici évite qu'un prochain passage les « traduise » en croyant
   bien faire — ce serait faire mentir la page sur l'origine de la donnée. */
const demoBlock = (scriptBody.match(/function demoData\(\) \{([\s\S]*?)\n {4}\}/) || [, ''])[1];
assert(demoBlock.includes('Composition incomplète sur une matière secondaire.'),
  'les enregistrements de démonstration restent en français (données, pas interface)');

// ---------------------------------------------------------------------------
console.log('\nB. Les quatre vues sont traduites, et changer de langue les retraduit');
// ---------------------------------------------------------------------------

const { dom, window, document, errors } = await mount();
const realErrors = errors.filter((e) => !/fonts\.googleapis\.com|Could not load link|jsdelivr/.test(e));
assert(realErrors.length === 0, 'aucune erreur jsdom au chargement', realErrors.join(' | '));

const detected = window.TracefabI18n.language;
assert(LANGS.includes(detected), `la langue détectée est servie (${detected})`, detected);
let d = dicts[detected];

eq(document.querySelector('h1')?.textContent?.trim(), d['overview.title'], 'le titre de la vue d’ensemble vient du dictionnaire');
eq(all(document, '.tf-tile .tf-label').join(' | '),
  ['completeness', 'evidence', 'freshness', 'consistency', 'product', 'supplier', 'critical', 'open']
    .map((k) => d[`tiles.${k}`]).join(' | '),
  'les 8 tuiles de confiance viennent du dictionnaire');
eq(all(document, '.tf-sidenav__link span').filter((s) => s && !/^\d+$/.test(s)).join(' | '),
  [d['nav.overview'], d['nav.issues'], d['nav.caps'], d['nav.scores']].join(' | '),
  'la navigation latérale vient du dictionnaire');
assert(all(document, '.tf-sidenav__link').some((s) => s === d['nav.home']),
  'y compris le lien d’accueil');
assert(!(document.getElementById('app').textContent || '').includes('{'),
  'aucun jeton non résolu ne fuit dans le rendu');

shown('issues');
eq(all(document, '.tf-table th').slice(0, 5).join(' | '),
  ['subject', 'issue', 'severity', 'status', 'action'].map((k) => d[`table.${k}`]).join(' | '),
  'les en-têtes de la vue Issues viennent du dictionnaire');
eq(all(document, '#qc-sev option').join(' | '),
  ['allSeverities', 'blocking', 'warnings', 'info'].map((k) => d[`issues.${k}`]).join(' | '),
  'et le filtre de gravité');
eq(all(document, '#qc-st option').join(' | '),
  ['allStatuses', 'stOpen', 'stAcknowledged', 'stWaived'].map((k) => d[`issues.${k}`]).join(' | '),
  'et le filtre de statut');

shown('caps');
eq(document.querySelector('.tf-app__topbar h1')?.textContent?.trim(), d['caps.title'],
  'la vue Plans d’action est traduite');
eq(all(document, '#qc-capst option').join(' | '),
  [d['issues.allStatuses'], d['caps.stRequested'], d['caps.stSubmitted'], d['caps.stApproved'], d['caps.stRejected']].join(' | '),
  'et son filtre de statut');

shown('scores');
eq(document.querySelector('.tf-app__topbar h1')?.textContent?.trim(), d['scores.title'],
  'la vue Scores est traduite');
eq(all(document, '.tf-bar > span:first-child').slice(0, 4).join(' | '),
  ['completeness', 'freshness', 'evidence', 'consistency'].map((k) => d[`scores.${k}`]).join(' | '),
  'et les quatre dimensions');

/* --- changement de langue : tout doit être retraduit, vue par vue --- */
async function switchTo(lang) {
  await window.TracefabI18n.setLanguage(lang);
  await new Promise((r) => setTimeout(r, 120));
  return dicts[lang];
}

shown('overview');
d = await switchTo('de');
eq(document.querySelector('h1')?.textContent?.trim(), 'Kann man den Daten vertrauen?',
  'passer en allemand retraduit le titre');
eq(all(document, '.tf-tile .tf-label')[0], 'Datenvollständigkeit', 'et les tuiles');
eq(document.documentElement.getAttribute('lang'), 'de', 'l’attribut lang du document suit');

shown('issues');
eq(all(document, '.tf-table th')[0], d['table.subject'], 'la vue Issues suit aussi');
eq(all(document, '#qc-sev option')[1], d['issues.blocking'], 'y compris les options de filtre');

shown('scores');
eq(all(document, '.tf-bar > span:first-child')[0], d['scores.completeness'], 'et les dimensions de score');

const langSelect = document.getElementById('qc-lang');
eq(langSelect.querySelectorAll('option').length, LANGS.length, `le sélecteur propose les ${LANGS.length} langues`);
eq(langSelect.value, 'de', 'et reflète la langue active');

d = await switchTo('pt');
shown('overview');
eq(all(document, '.tf-tile .tf-label')[0], 'Completude dos dados', 'puis en portugais');

// ---------------------------------------------------------------------------
console.log('\nC. Libellés d’énumérations et pluriel suivent la langue');
// ---------------------------------------------------------------------------

/* Les badges de gravité et de statut sont construits depuis la valeur de l'API :
   ils doivent suivre la langue comme le reste. */
shown('issues');
const badges = all(document, '.tf-badge');
for (const key of ['severity.blocking', 'status.open']) {
  const value = dicts.pt[key];
  assert(badges.some((b) => b === value) || (document.body.textContent || '').includes(value),
    `le libellé ${key} est rendu en portugais`, value);
}
const countHead = all(document, '.tf-panel__head h2').find((h) => /\d/.test(h));
assert(!!countHead && !/\{\w+\}/.test(countHead || ''),
  'le compteur d’issues résout son jeton {count}', countHead);
assert(/issue/i.test(countHead || ''), 'et produit un nom de langue, pas une clé', countHead);
assert(dicts.pt['issues.countOne'] !== dicts.pt['issues.countMany'],
  'le portugais distingue le singulier du pluriel');
assert(dicts.it['issues.countOne'] === dicts.it['issues.countMany'],
  'l’italien ne le distingue pas — « issue » est invariable, et le forcer serait une faute');

// ---------------------------------------------------------------------------
console.log('\nD. Les 7 dictionnaires sont complets, distincts et cohérents');
// ---------------------------------------------------------------------------

const reference = Object.keys(dicts.fr).sort().join('|');
eq(Object.keys(dicts.fr).length, 130, '130 chaînes par langue');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), reference, `${lang} expose exactement le même jeu de clés que fr`);
  const empty = Object.entries(dicts[lang]).filter(([, v]) => !String(v || '').trim());
  eq(empty.length, 0, `${lang} n’a aucune chaîne vide`, empty.map(([k]) => k).join(','));
  const cjk = Object.entries(dicts[lang]).filter(([, v]) => /[\u4e00-\u9fff]/.test(String(v)));
  eq(cjk.length, 0, `${lang} ne contient aucun caractère CJK parasite`, cjk.map(([k]) => k).join(','));
}
/* Un jeton oublié dans une traduction casserait le rendu sans qu'aucune erreur ne
   le signale : la parité des clés ne suffit pas, il faut celle des jetons. */
for (const key of Object.keys(dicts.fr).filter((k) => dicts.fr[k].includes('{'))) {
  const expect = (dicts.fr[key].match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const lang of LANGS) {
    const got = (String(dicts[lang][key]).match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
    eq(got, expect, `${lang} : ${key} porte les mêmes jetons que fr`);
  }
}
for (const lang of LANGS.filter((l) => l !== 'fr')) {
  const identical = Object.keys(dicts.fr).filter((k) => dicts.fr[k] === dicts[lang][k] && dicts.fr[k].length > 12);
  assert(identical.length < Object.keys(dicts.fr).length * 0.4,
    `${lang} n’est pas une copie du français`, `identiques : ${identical.join(', ')}`);
}

dom.window.close();

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
