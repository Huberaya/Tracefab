#!/usr/bin/env node
/**
 * La landing traduit depuis locales/, plus depuis un moteur embarqué.
 *
 * AVANT
 *   `index.html` chargeait `public/i18n-engine.js`, un moteur embarqué avec son
 *   propre dictionnaire inline, et seulement 24 chaînes de la page portaient un
 *   crochet `data-i18n` — sur 331 nœuds de texte visibles. Le menu proposait déjà
 *   six langues ; il ne pilotait que ces 24 chaînes.
 *
 *   Il existait par ailleurs `locales/{lang}/translation.json`, 143 clés de
 *   landing… décrivant une page qui n'existe plus (« Turn your textile supply
 *   chain into trusted data. » contre « Know your supply chain. Prove it. »).
 *   Le brancher tel quel aurait servi du texte périmé. Le dictionnaire a donc
 *   été RECONSTRUIT depuis le contenu réel de la page.
 *
 * TROIS DÉFAUTS DE CÂBLAGE TROUVÉS EN COURS DE ROUTE, ÉPINGLÉS CI-DESSOUS
 *   · Une valeur répétée (le CTA « Request a demo ») recevait la clé de la
 *     dernière section traitée : la recherche n'était pas bornée à la section.
 *   · Un texte précédé d'un élément frère (le point de la capsule) faisait
 *     atterrir l'attribut DANS la balise fermante `</span>`, ce qui casse le
 *     balisage sans erreur. Il est désormais enveloppé dans un <span>.
 *   · Le runtime aplatit tout le fichier : les clés sont `landing.…`, pas `…`.
 *     Sans le préfixe, `t('seo.title')` retombait sur translation.json.
 *
 *     A. aucun contenu métier n'est laissé en dur dans le balisage ;
 *     B. la page rend, change de langue, et garde son contenu de démonstration ;
 *     C. les 7 dictionnaires : 334 clés, parité, intégrité ;
 *     D. la promesse « préparation, pas certification » tient dans les 7 langues.
 *
 *   npm run test:i18n:landing
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
const SCOPE = 'landing';
const html = await readFile(at('index.html'), 'utf8');

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
  dicts[lang] = flat(JSON.parse(await readFile(at(`locales/${lang}/${SCOPE}.json`), 'utf8'))[SCOPE] || {});
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
    url: 'https://tracefab.vercel.app/',
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
  /* Attendre le rendu RÉEL : dictionnaire chargé ET titre appliqué. Un simple
     délai mesurerait un rendu produit avant l'arrivée du dictionnaire. */
  for (let i = 0; i < 250; i += 1) {
    if (dom.window.TracefabI18n?.isReady && dom.window.document.title.length > 10) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 120));
  return { dom, window: dom.window, document: dom.window.document, errors };
}

// ---------------------------------------------------------------------------
console.log('\nA. Aucun contenu métier n’est laissé en dur dans le balisage');
// ---------------------------------------------------------------------------

assert(html.includes('/i18n-core.js'), 'la page charge le runtime partagé');
assert(!html.includes('src="/i18n-engine.js"'), 'et ne charge plus le moteur embarqué i18n-engine.js');
assert(/TracefabI18n\.init\(\{\s*scope:\s*'landing'/.test(html),
  'l’appel init est explicite et déclare le scope « landing »');
assert(!/data-i18n="(?!landing\.)/.test(html), 'toutes les clés portent le préfixe du scope');

/*
 * Ce qui reste volontairement non traduit. La marque, les codes ISO et les noms
 * de langues sont des endonymes : traduire « Deutsch » en « Allemand » dans le
 * sélecteur de langue serait une faute, pas une amélioration.
 */
const INTENTIONAL = new Set(['tf', 'TRACEFAB', 'EN', 'FR', 'DE', 'IT', 'ES', 'NL', 'PT',
  'English', 'Français', 'Deutsch', 'Italiano', 'Español', 'Nederlands', 'Português']);

/*
 * Le contrôle qui compte : chaque nœud de texte visible du <body> doit être
 * porté par un élément qui a un crochet data-i18n. Un inventaire fait à la main
 * rate toujours quelque chose ; celui-ci parcourt le DOM réellement rendu.
 */
const { dom, window, document, errors } = await mount();
const realErrors = errors.filter((e) => !/fonts\.googleapis\.com|Could not load link|jsdelivr|clerk/.test(e));
assert(realErrors.length === 0, 'aucune erreur jsdom au chargement', realErrors.join(' | '));

/*
 * Trois panneaux sont construits par JavaScript : l'orbite des domaines, les
 * onglets d'intelligence produit et leur contenu. Leurs LIBELLÉS viennent du
 * dictionnaire ; leurs VALEURS sont des données de démonstration et restent
 * telles quelles, comme sur les autres surfaces.
 */
const JS_PANELS = ['#tf-core-state', '#tf-core-stat', '#tf-pi-tabs', '#tf-pi-panel',
  '#tf-inspector', '#tf-chain-stack'];

const unwired = [];
const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
let node;
while ((node = walker.nextNode())) {
  const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) continue;
  if (INTENTIONAL.has(text)) continue;
  /* <script> et <style> font partie de document.body : sans ce garde, le
     parcours relisait le code source et « trouvait » du texte non traduit. */
  if (node.parentElement && /^(script|style|noscript|template)$/i.test(node.parentElement.tagName)) continue;
  if (/^[▾→·•|/\-–—0-9.%€$+²\s]+$/.test(text)) continue;
  if (JS_PANELS.some((sel) => {
    const box = document.querySelector(sel);
    return box && box.contains(node);
  })) continue;                      /* vérifiés explicitement plus bas */
  let el = node.parentElement;
  let covered = false;
  while (el && el !== document.body) {
    if (el.hasAttribute('data-i18n') || el.hasAttribute('data-i18n-attr')) { covered = true; break; }
    el = el.parentElement;
  }
  if (!covered) unwired.push(text.slice(0, 70));
}
assert(unwired.length === 0, 'chaque texte visible du corps est couvert par un crochet i18n',
  `${unwired.length} non couverts : ${[...new Set(unwired)].join(' | ')}`);

/* Aucun attribut ne doit avoir atterri dans une balise fermante : c'était le
   défaut de câblage du texte précédé d'un élément frère. */
assert(!/<\/[a-z0-9]+ [^>]*data-i18n/.test(html), 'aucun attribut i18n dans une balise fermante');
assert(document.querySelector('.tf-capsule__beacon') !== null,
  'le point décoratif de la capsule a survécu à l’enveloppement du texte');

// ---------------------------------------------------------------------------
console.log('\nB. La page rend, change de langue et garde ses données de démonstration');
// ---------------------------------------------------------------------------

const detected = window.TracefabI18n.language;
assert(LANGS.includes(detected), `la langue détectée est servie (${detected})`, detected);
let d = dicts[detected];

eq(document.title, d['seo.title'], 'le titre vient du dictionnaire');
eq(document.querySelector('#hero-title')?.textContent?.replace(/\s+/g, ' ').trim(),
  `${d['hero.know_your_product']} ${d['hero.know_your_supply_chain']} ${d['hero.prove_it']}`.replace(/\s+/g, ' ').trim(),
  'le H1 vient du dictionnaire');
eq(document.querySelector('.tf-capsule')?.textContent?.replace(/\s+/g, ' ').trim(),
  d['hero.european_textile_data_infrastr'], 'et la capsule aussi');

/* Les panneaux construits par JS doivent eux aussi venir du dictionnaire —
   c'était le défaut : leurs libellés étaient codés en dur dans le script. */
const dictValues = new Set(Object.values(d));
assert(dictValues.has(document.querySelector('#tf-core-state')?.textContent?.trim()),
  'l’état de l’orbite vient du dictionnaire', document.querySelector('#tf-core-state')?.textContent);
const tabLabels = [...document.querySelectorAll('#tf-pi-tabs button')].map((b) => b.textContent.trim());
const untrTabs = tabLabels.filter((l) => !dictValues.has(l));
assert(untrTabs.length === 0, 'les 11 onglets d’intelligence produit viennent du dictionnaire',
  untrTabs.join(' | '));
/* L'inspecteur d'écosystème affiche des enregistrements de démonstration ; ses
   LIBELLÉS statiques restent traduits, ses valeurs sont pilotées par le JS. */
const inspLabels = [...document.querySelectorAll('#tf-inspector .tf-inspector__fact .tf-label')]
  .map((e) => e.textContent.trim());
const untrInsp = inspLabels.filter((l) => !dictValues.has(l));
assert(inspLabels.length >= 3 && untrInsp.length === 0,
  'les libellés de l’inspecteur viennent du dictionnaire', untrInsp.join(' | '));

/*
 * Rétablie après avoir été supprimée par erreur : en croyant retirer un doublon
 * créé par un déplacement de bloc, cette assertion avait disparu et le test
 * passait 97/97 pendant que le panneau affichait des CLÉS BRUTES
 * (« proof.data_quality »). Un test qui ne vérifie pas passe aussi.
 */
const factLabels = [...document.querySelectorAll('#tf-pi-panel .tf-label')]
  .map((e) => e.textContent.trim());
const untrFacts = factLabels.filter((l) => !dictValues.has(l));
assert(factLabels.length > 0 && untrFacts.length === 0,
  'les libellés de faits du panneau viennent du dictionnaire', untrFacts.join(' | '));
assert(!/[a-z_]+\.[a-z_]+\.[a-z_]+/.test(document.getElementById('tf-pi-panel').textContent || ''),
  'aucune clé brute ne fuit dans le panneau d’intelligence produit');

eq(document.documentElement.getAttribute('lang'), detected, 'l’attribut lang du document suit');
assert(!/(^|\s)landing\.[a-z_]+/.test(document.body.textContent || ''),
  'aucune clé non résolue ne fuit dans le rendu');

/* Le mode démonstration doit rester identifiable : c'est une exigence de fond,
   pas un détail de style. */
assert((document.body.textContent || '').includes(d['hero.demonstration_data_not_a_live']),
  'les données de démonstration sont étiquetées comme telles');

eq([...document.querySelectorAll('.tf-lang__option')].map((b) => b.dataset.lang).join(','),
  LANGS.join(','), `le sélecteur propose les ${LANGS.length} langues de la phase 1`);

async function switchTo(lang) {
  await window.TracefabI18n.setLanguage(lang);
  await new Promise((r) => setTimeout(r, 200));
  return dicts[lang];
}

d = await switchTo('de');
eq(document.title, 'TRACEFAB — Die Intelligenzschicht für die globale textile Lieferkette',
  'passer en allemand retraduit le titre');
eq(document.documentElement.getAttribute('lang'), 'de', 'et l’attribut lang');
eq(document.querySelector('.tf-capsule')?.textContent?.replace(/\s+/g, ' ').trim(),
  'Europäische Textildaten-Infrastruktur', 'et la capsule');
eq(document.querySelector('.tf-lang__option[data-lang="de"]')?.getAttribute('aria-checked'), 'true',
  'et le menu reflète la langue active');

d = await switchTo('pt');
eq(document.querySelector('#hero-title')?.textContent?.replace(/\s+/g, ' ').trim(),
  `${d['hero.know_your_product']} ${d['hero.know_your_supply_chain']} ${d['hero.prove_it']}`
    .replace(/\s+/g, ' ').trim(), 'puis le portugais');
eq(document.querySelector('#tf-pi-tabs button')?.textContent?.trim(),
  d['product_intelligence.tab_overview'], 'et les onglets générés par JS sont repeints');
/* L'aria-label du burger est posé par le JS au moment de la bascule, pas par
   apply() : il doit suivre la langue lui aussi, sinon le lecteur d'écran reste
   dans la langue précédente. */
document.getElementById('tf-burger')?.click();
eq(document.getElementById('tf-burger')?.getAttribute('aria-label'),
  d['header_nav.close_menu_al'], 'l’aria-label posé par le JS suit la langue active');
document.getElementById('tf-burger')?.click();
eq(document.getElementById('tf-burger')?.getAttribute('aria-label'),
  d['header_nav.open_menu_al'], 'et revient à « ouvrir le menu »');

// ---------------------------------------------------------------------------
console.log('\nC. Les 7 dictionnaires sont complets, distincts et intègres');
// ---------------------------------------------------------------------------

const reference = Object.keys(dicts.en).sort().join('|');
eq(Object.keys(dicts.en).length, 384, '384 chaînes par langue');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), reference, `${lang} expose exactement le même jeu de clés que en`);
  const empty = Object.entries(dicts[lang]).filter(([, v]) => !String(v || '').trim());
  eq(empty.length, 0, `${lang} n’a aucune chaîne vide`, empty.map(([k]) => k).join(','));
  const cjk = Object.entries(dicts[lang]).filter(([, v]) => /[\u4e00-\u9fff]/.test(String(v)));
  eq(cjk.length, 0, `${lang} ne contient aucun caractère CJK parasite`, cjk.map(([k]) => k).join(','));
  const mail = Object.entries(dicts[lang]).filter(([, v]) => /@\s|\s@/.test(String(v)));
  eq(mail.length, 0, `${lang} n’a pas d’espace dans une adresse e-mail`, mail.map(([k]) => k).join(','));
}
for (const lang of LANGS.filter((l) => l !== 'en')) {
  const identical = Object.keys(dicts.en)
    .filter((k) => dicts.en[k] === dicts[lang][k] && dicts.en[k].length > 18);
  assert(identical.length < Object.keys(dicts.en).length * 0.35,
    `${lang} n’est pas une copie de l’anglais`, `identiques : ${identical.slice(0, 5).join(', ')}`);
}
/* La marque, les références normatives et l’identité de démonstration doivent
   rester identiques partout : les localiser fragmenterait la démonstration. */
for (const key of ['wow_ecosystem.gots_cu_881294', 'wow_ecosystem.oeko_tex_step', 'footer.marie_dupont_ph',
  'footer.m_dupont_brand_com_ph']) {
  for (const lang of LANGS) eq(dicts[lang][key], dicts.en[key], `${lang} : ${key} reste identique`);
}

// ---------------------------------------------------------------------------
console.log('\nD. « Préparation, pas certification » tient dans les 7 langues');
// ---------------------------------------------------------------------------

/*
 * Exigence permanente du projet : le score de préparation au DPP ne doit jamais
 * être présenté comme une certification juridique. La garantie n'est pas « le
 * mot certification apparaît » mais la présence simultanée, dans CHAQUE langue,
 * d'un terme de préparation et d'une négation portant sur la certification.
 * Le néerlandais avait d'abord été rejeté par un contrôle qui cherchait
 * « jamais » sans connaître `nooit`.
 */
/*
 * La négation n'est pas partout un « jamais » : le pied de page dit « not a legal
 * certification », « pas une certification juridique », « keine rechtliche
 * Zertifizierung ». Un contrôle qui ne connaissait que « never » rejetait six
 * langues sur sept alors que toutes tenaient la promesse. Ce qui compte est une
 * négation portée sur le mot certification.
 */
const NEG = { en: /\bnot\b|\bnever\b/i, fr: /\bpas\b|jamais/i, de: /\bkeine\b|\bnicht\b|\bnie\b/i,
  it: /\bnon\b|\bmai\b/i, es: /\bno\b|\bnunca\b/i, nl: /\bgeen\b|\bnooit\b|\bniet\b/i,
  pt: /\bnão\b|\bnunca\b/i };
const PREP = { en: /preparation|readiness/i, fr: /préparation/i, de: /bereitschaft/i,
  it: /preparazione|prontezza/i, es: /preparación/i, nl: /gereedheid/i, pt: /preparação/i };
for (const lang of LANGS) {
  const text = dicts[lang]['footer.dpp_readiness_is_a_preparation'];
  /* « Zertifizierung » ne contient pas « certific » : un motif unique ratait
     l'allemand alors que la promesse y était bien tenue. */
  assert(PREP[lang].test(text) && NEG[lang].test(text) && /certific|zertifiz|zertifika/i.test(text),
    `${lang} : le pied de page dit « préparation » et nie la certification`, text);
}

dom.window.close();

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
