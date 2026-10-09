#!/usr/bin/env node
/**
 * TRACEFAB Supplier Portal — internationalisation.
 *
 * Le portail fournisseur est la SEULE surface qui propose neuf langues, dont le
 * turc et le chinois (`SUPPLIER_LANGUAGES`). Or deux choses y étaient codées en
 * dur en français :
 *
 *   1. `const labels = { draft:'Brouillon', … }` — 24 étiquettes de statut ;
 *   2. `new Intl.DateTimeFormat('fr-FR')` et `.toLocaleString('fr-FR')` — dates
 *      et nombres.
 *
 * Un fournisseur turc choisissait Türkçe et continuait de lire « Brouillon » et
 * des dates au format français. Ce test monte la VRAIE page avec le VRAI
 * dictionnaire `locales/tr/supplier.json`, puis contrevérifie avec le français :
 * si le rendu est identique dans les deux langues, le câblage est mort et le
 * test échoue.
 *
 *   npm run test:supplier-portal:i18n
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

const html = await readFile(new URL('supplier-portal/index.html', root), 'utf8');

const LANGUAGES = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh'];
const STATUS_KEYS = [
  'active', 'inactive', 'draft', 'sent', 'in_progress', 'submitted', 'changes_requested', 'approved',
  'cancelled', 'pending', 'answered', 'accepted', 'needs_review',
  'verified_by_reviewer', 'not_started', 'uploaded', 'scanning', 'available',
  'rejected', 'deleted', 'declared', 'documented', 'suspended', 'revoked',
];

/**
 * Monte la page avec un runtime qui sert le vrai dictionnaire demandé.
 *
 * Le stub est installé dans `beforeParse` : `t()` est appelé pendant le rendu et
 * `init()` à l'exécution du script, donc un stub posé après la construction
 * arriverait trop tard. On écrit `tracefab_lang` dans localStorage parce que
 * c'est cette clé que la page lit pour décider de la langue demandée à `init()`.
 */
async function mount(lang) {
  const dictionary = JSON.parse(
    await readFile(new URL(`locales/${lang}/supplier.json`, root), 'utf8'),
  );
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://tracefab.vercel.app/supplier-portal/?demo=1',
    virtualConsole,
    beforeParse(window) {
      try { window.localStorage.setItem('tracefab_lang', lang); } catch { /* ignore */ }
      const runtime = {
        language: lang,
        missing: [],
        t(key) {
          const value = dictionary[key];
          return value === undefined ? null : value;
        },
        init(options) {
          this.language = (options && options.language) || lang;
          return Promise.resolve(this.language);
        },
        apply() {},
      };
      window.TracefabI18n = runtime;
    },
  });

  const { window } = dom;
  const { document } = window;
  if (document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  await new Promise((r) => setTimeout(r, 80));

  /** Le texte du conteneur rendu uniquement : `document.body` inclut la source
   *  du <script>, ce qui ferait passer des assertions sur le code lui-même. */
  const appText = () => (document.getElementById('app') || {}).textContent || '';

  // Plusieurs vues rendent des statuts ; on cumule pour ne pas dépendre d'une
  // vue en particulier.
  const views = [...document.querySelectorAll('.nav [data-view]')].map((e) => e.dataset.view);
  const seen = [];
  /** Badges rendus par status() et options du select d'état : les deux seuls
   *  chemins qui lisaient la table de libellés. On les isole parce qu'une
   *  recherche par sous-chaîne dans tout le rendu attrape aussi du français
   *  sans rapport (un titre contenant « Actifs », par exemple). */
  const badges = [];
  const options = [];
  for (const view of views) {
    const el = document.querySelector(`[data-view="${view}"]`);
    if (el) el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    seen.push(appText());
    badges.push(...[...document.querySelectorAll('.status')].map((e) => e.textContent.trim()));
    options.push(...[...document.querySelectorAll('select[name="status"] option')].map((e) => e.textContent.trim()));
  }

  return {
    window,
    document,
    appText: () => seen.join('\n'),
    badges,
    options,
    pageErrors,
    views,
  };
}

const TR = JSON.parse(await readFile(new URL('locales/tr/supplier.json', root), 'utf8'));
const FR = JSON.parse(await readFile(new URL('locales/fr/supplier.json', root), 'utf8'));

console.log('\nA. Le contenu métier n’est plus codé dans le composant');
/** `fr-FR` ne subsiste que comme valeur de la table LOCALES : partout ailleurs
 *  ce serait une locale forcée. */
eq((html.match(/'fr-FR'/g) || []).length, 1, 'fr-FR n’apparaît qu’une fois, dans la table LOCALES');
assert(/const LOCALES = \{[^}]*fr:'fr-FR'[^}]*\};/.test(html), 'fr-FR est une entrée de LOCALES');
eq(/new Intl\.DateTimeFormat\('fr-FR'/.test(html), false, 'DateTimeFormat ne force plus le français');
eq(/toLocaleString\('fr-FR'/.test(html), false, 'toLocaleString ne force plus le français');
const hardcoded = STATUS_KEYS.filter((k) => html.includes(`:'${FR[`status_${k}`]}'`));
eq(hardcoded.length, 0, 'aucune des 24 étiquettes de statut n’est en dur', hardcoded.join(', '));
assert(html.includes('const statusLabel = (value)'), 'les étiquettes passent par une résolution au rendu');

console.log('\nB. La locale suit la langue active');
for (const [lang, tag] of [['fr', 'fr-FR'], ['tr', 'tr-TR'], ['zh', 'zh-CN'], ['de', 'de-DE'],
  ['it', 'it-IT'], ['es', 'es-ES'], ['nl', 'nl-NL'], ['pt', 'pt-PT'], ['en', 'en-GB']]) {
  assert(html.includes(`${lang}:'${tag}'`), `locale déclarée pour ${lang} (${tag})`);
}

console.log('\nC. Parité des dictionnaires (9 langues)');
const sets = {};
for (const lang of LANGUAGES) {
  const d = JSON.parse(await readFile(new URL(`locales/${lang}/supplier.json`, root), 'utf8'));
  sets[lang] = d;
  const missing = STATUS_KEYS.filter((k) => !d[`status_${k}`]);
  eq(missing.length, 0, `${lang} : les 24 clés de statut sont traduites`, missing.join(', '));
}
const ref = new Set(Object.keys(sets.en));
for (const lang of LANGUAGES) {
  const got = new Set(Object.keys(sets[lang]));
  const missing = [...ref].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !ref.has(k));
  eq(missing.length + extra.length, 0, `${lang} : même jeu de clés que en`,
    `manquantes ${missing.join(',') || '—'} ; en trop ${extra.join(',') || '—'}`);
}

console.log('\nD. Rendu réel en turc');
const tr = await mount('tr');
eq(tr.pageErrors.length, 0, 'aucune erreur de page en turc', tr.pageErrors.join(' | '));
assert(tr.views.length >= 10, `les vues sont rendues (${tr.views.length})`);
const trText = tr.appText();
assert(trText.length > 200, 'du contenu est rendu');

const fr = await mount('fr');
const frText = fr.appText();
eq(fr.pageErrors.length, 0, 'aucune erreur de page en français', fr.pageErrors.join(' | '));

const frValues = new Set(STATUS_KEYS.map((k) => FR[`status_${k}`]));
const trValues = new Set(STATUS_KEYS.map((k) => TR[`status_${k}`]));

/** Certains badges .status ne sont pas des statuts : « CSV / Excel » est un
 *  format, « open » un jeton brut sans libellé. On n'exige donc pas que tout
 *  badge soit dans le dictionnaire, mais que tout badge QUI est un libellé de
 *  statut français ait son équivalent turc — c'est exactement ce que le
 *  câblage garantit. */
const frBadges = fr.badges.filter((b) => b && b !== '—');
const frStatusBadges = frBadges.filter((b) => frValues.has(b));
assert(frStatusBadges.length > 0,
  `des badges de statut sont rendus en français (${frStatusBadges.length}/${frBadges.length})`,
  'aucun badge de statut rendu : le test ne prouverait rien');

const trBadges = tr.badges.filter((b) => b && b !== '—');
assert(trBadges.length > 0, `des badges sont rendus en turc (${trBadges.length})`);
const frenchBadges = trBadges.filter((b) => frValues.has(b) && !trValues.has(b));
eq(frenchBadges.length, 0, 'aucun badge de statut français ne subsiste en turc',
  frenchBadges.join(' | '));

const untranslated = STATUS_KEYS.filter((k) => {
  const frLabel = FR[`status_${k}`];
  const trLabel = TR[`status_${k}`];
  return frLabel !== trLabel && frStatusBadges.includes(frLabel) && !trBadges.includes(trLabel);
});
eq(untranslated.length, 0, 'chaque libellé français rendu a son équivalent turc rendu',
  untranslated.map((k) => `${k}: ${FR[`status_${k}`]} -> ${TR[`status_${k}`]}`).join(', '));

const frOptions = fr.options.filter(Boolean);
const trOptions = tr.options.filter(Boolean);
assert(frOptions.length > 0, `les options d’état sont rendues (${frOptions.length})`);
eq(frOptions.filter((o) => frValues.has(o) || o === FR.statusField).length, frOptions.length,
  'chaque option française vient du dictionnaire', frOptions.join(' | '));
const notTurkishOptions = trOptions.filter((o) => !trValues.has(o) && o !== TR.statusField);
eq(notTurkishOptions.length, 0, 'chaque option turque vient du dictionnaire turc',
  notTurkishOptions.join(' | '));

assert(trText !== frText, 'le rendu turc diffère du rendu français (câblage vivant)');

console.log('\nE. Contrevérification : sans dictionnaire, pas de valeur inventée');
const bare = await new Promise(async (resolve) => {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://tracefab.vercel.app/supplier-portal/?demo=1',
    virtualConsole,
    beforeParse(window) {
      // Runtime présent mais dictionnaire vide : t() renvoie null.
      window.TracefabI18n = {
        language: 'tr',
        missing: [],
        t() { return null; },
        init() { return Promise.resolve('tr'); },
        apply() {},
      };
    },
  });
  const { window } = dom;
  if (window.document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  setTimeout(() => resolve({
    document: window.document,
    text: ((window.document.getElementById('app') || {}).textContent || ''),
  }), 80);
});
eq(bare.text.includes('Brouillon'), false, 'sans dictionnaire, aucun libellé français n’est inventé');
assert(bare.text.length > 200, 'la page reste utilisable sans dictionnaire');

console.log('\nF. Aucune chaîne française ne subsiste dans les autres langues');
/** Valeurs propres au français : si l'une d'elles s'affiche dans une autre
 *  langue, la migration est incomplète. On exige >= 6 caractères pour limiter
 *  les faux positifs sur des fragments courts. */
/** Les données de démonstration ne sont pas du texte d'interface : une fausse
 *  adresse ou un faux motif de demande représentent ce qu'un fournisseur aurait
 *  saisi, pas un libellé de l'application. Elles restent donc non traduites, et
 *  doivent être retirées du corpus de contrôle — sinon « Certificats et sites
 *  uniquement » (message d'une demande de démo) ferait échouer le test à tort. */
const demoBody = (() => {
  const start = html.indexOf('function demoData()');
  const end = html.indexOf('\n      function ', start + 10);
  return start >= 0 && end > start ? html.slice(start, end) : '';
})();
assert(demoBody.length > 1000, `le corps de demoData est isolé (${demoBody.length})`);

const frDictValues = [...new Set(Object.values(FR))];

for (const lang of ['tr', 'zh', 'de', 'en']) {
  const dict = JSON.parse(await readFile(new URL(`locales/${lang}/supplier.json`, root), 'utf8'));
  /** Le corpus est propre à chaque langue : certains libellés français et
   *  anglais sont identiques (« Site »), et les comparer à un corpus calculé
   *  contre le turc faisait échouer l'anglais à tort. */
  const langSet = new Set(Object.values(dict));
  const frOnly = frDictValues.filter((v) => v.length >= 6 && !langSet.has(v) && !demoBody.includes(v));
  assert(frOnly.length > 200, `${lang} : un corpus de contrôle suffisant (${frOnly.length})`);
  const mounted = await mount(lang);
  eq(mounted.pageErrors.length, 0, `aucune erreur de page en ${lang}`, mounted.pageErrors.join(' | '));
  const text = mounted.appText();
  const dictValues = new Set(Object.values(dict));
  const leftovers = frOnly.filter((v) => text.includes(v));
  eq(leftovers.length, 0, `${lang} : aucune chaîne française ne s'affiche`, leftovers.slice(0, 6).join(' | '));
  const translated = [...dictValues].filter((v) => v.length >= 6 && text.includes(v));
  assert(translated.length >= 15,
    `${lang} : des libellés traduits s'affichent réellement (${translated.length})`);
}

console.log('\nG. Contrôle au niveau du mot : rien de français ne subsiste');
/**
 * La section F compare au dictionnaire : une chaîne jamais migrée lui est donc
 * invisible. C'est exactement ce qui a laissé passer « Annuler », « Fermer » et
 * « Connexion indisponible ». Ce contrôle ne s'appuie sur aucun dictionnaire —
 * il cherche des mots français sans ambiguïté dans le rendu.
 *
 * Restreint aux langues qui ne partagent pas ces mots : l'italien, l'espagnol
 * et le portugais emploient legitimately « la », « que », « un », « nos ».
 * Le néerlandais utilise « de » comme article : il est retiré pour cette langue.
 */
/** Mots français à fort signal. Les mots courts ambigus en sont exclus, mesurés
 *  comme tels : « et » est un verbe turc (« beyan et »), « des » un article
 *  allemand, « un » un mot turc. Les garder produisait des échecs imaginaires et
 *  aurait fini par faire ignorer ce contrôle. */
const FRENCH_WORDS = ['du', 'les', 'une', 'votre', 'vos', 'nos',
  'mes', 'cette', 'ces', 'pour', 'sans', 'avec', 'dans', 'tous', 'être',
  'aucun', 'aucune', 'chaque', 'après', 'avant', 'dont',
  'vous', 'nous', 'elle', 'leur', 'leurs', 'aux',
  'enregistrer', 'ajouter', 'déclarer', 'renseigner', 'annuler', 'fermer', 'importer',
  'indisponible', 'rechercher', 'téléverser', 'répondre', 'soumettre', 'créer',
  'modifier', 'supprimer', 'retour', 'accueil', 'demande', 'demandes', 'réponse',
  'réponses', 'certificat', 'certificats', 'preuve', 'preuves', 'matériau', 'matériaux',
  'marque', 'marques', 'fournisseur', 'donnée', 'données', 'vue', 'ouverte', 'ouvertes'];
const WORD_EXCLUDE = { nl: ['de'], de: [], en: [], tr: [], zh: [] };

/** Les valeurs de démonstration sont du français assumé : on les retire du rendu
 *  avant de compter, plutôt que d'affaiblir la liste de mots. */
/** L'extraction par expression régulière se désynchronisait sur les apostrophes
 *  échappées et laissait passer des phrases entières de démonstration. On passe
 *  par l'AST : les littéraux de demoData() sont énumérés exactement. */
const demoStrings = (() => {
  const open = html.lastIndexOf('<script>') + '<script>'.length;
  const code = html.slice(open, html.indexOf('</script>', open));
  const sf = ts.createSourceFile('sp.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out = [];
  const collect = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    ts.forEachChild(node, collect);
  };
  const find = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'demoData') collect(node);
    ts.forEachChild(node, find);
  };
  find(sf);
  return out.filter((v) => v.length >= 4);
})();

for (const lang of ['tr', 'zh', 'de', 'nl', 'en']) {
  const dict = JSON.parse(await readFile(new URL(`locales/${lang}/supplier.json`, root), 'utf8'));
  const mounted = await mount(lang);
  let text = mounted.appText();
  for (const d of demoStrings) text = text.split(d).join(' ');
  const allowed = new Set((WORD_EXCLUDE[lang] || []).concat(Object.values(dict)));
  const found = FRENCH_WORDS.filter((w) => !allowed.has(w)
    && new RegExp(`\\b${w}\\b`, 'iu').test(text));
  eq(found.length, 0, `${lang} : aucun mot français dans le rendu`, found.join(', '));
}

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:supplier-portal:i18n FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:supplier-portal:i18n passed — ${checks} contrôles, 0 échec.`);
