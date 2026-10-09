#!/usr/bin/env node
/**
 * La vue Exploitation traduit depuis locales/, plus depuis un glossaire.
 *
 * AVANT
 *   `operations/index.html` chargeait `auto-translate.js`, qui traduit par
 *   GLOSSAIRE : il remplace des termes isolés qu'il connaît et laisse intact tout
 *   le reste. Des phrases complètes — « L'outbox reste la source durable de
 *   vérité », « Les métriques sont agrégées par organisation… » — n'étaient donc
 *   jamais traduites, alors que la page donnait l'impression d'être
 *   multilingue.
 *
 * PIÈGE CORRIGÉ AU PASSAGE
 *   Deux rendus d'état étaient des chaînes à GUILLEMETS SIMPLES. Y injecter
 *   `${t('…')}` ne produit pas une interpolation : l'apostrophe de la clé ferme
 *   la chaîne et le reste devient du code — « Unexpected identifier
 *   'operations' », page blanche. Les deux sont devenus des littéraux de
 *   gabarit. Une substitution réussie n'est pas une page qui fonctionne.
 *
 *     A. le contenu métier n'est plus codé dans le composant ;
 *     B. le rendu est traduit, et changer de langue le retraduit ;
 *     C. les états (chargement, authentification) sont traduits aussi ;
 *     D. les 7 dictionnaires : 31 clés, parité, aucune vide, aucune copie.
 *
 *   npm run test:i18n:operations
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
const SCOPE = 'operations';
const html = await readFile(at('operations/index.html'), 'utf8');

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

async function mount(search) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: `https://tracefab.vercel.app/operations${search}`,
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
  for (let i = 0; i < 150; i += 1) {
    if (dom.window.TracefabI18n?.isReady
      && (dom.window.document.getElementById('app')?.innerHTML || '').length > 400) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 100));
  return { dom, window: dom.window, document: dom.window.document, errors };
}

const all = (document, sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || '').trim());

// ---------------------------------------------------------------------------
console.log('\nA. Le contenu métier n’est plus codé dans le composant');
// ---------------------------------------------------------------------------

assert(html.includes('/i18n-core.js'), 'la page charge le runtime partagé');
assert(!html.includes('/auto-translate.js'), 'et ne s’appuie plus sur le glossaire auto-translate.js');
assert(/init\(\{\s*scope:\s*'operations'/.test(html), 'et déclare le scope « operations »');

/* Les deux rendus d'état doivent être des littéraux de gabarit : une chaîne à
   guillemets simples contenant ${t('…')} casse la page au lieu de la traduire. */
eq((html.match(/innerHTML='<div class="auth">/g) || []).length, 0,
  'aucun rendu d’état n’est une chaîne à guillemets simples');
const scriptBody = (html.match(/<div id="app"><\/div><script>\n([\s\S]*?)\n<\/script>/) || [, ''])[1];
for (const literal of ['Chargement des opérations', 'Gouverner les traitements', 'Rafraîchir',
  'Dépendances protégées', 'Règles d’exploitation', 'En attente', 'Configuré']) {
  const quoted = new RegExp(`['"\`]${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  assert(!quoted.test(scriptBody), `« ${literal} » n’est plus une valeur produite par le script`);
}
assert(!html.includes("toLocaleString('fr-FR')"), 'la locale de date suit la langue active');

// ---------------------------------------------------------------------------
console.log('\nB. La page est traduite, et changer de langue la retraduit');
// ---------------------------------------------------------------------------

/* ?demo=1 : la page sert alors ses données de démonstration sans Clerk ni API,
   ce qui est exactement le chemin de rendu observé ici. */
const { dom, window, document, errors } = await mount('?demo=1');
const realErrors = errors.filter((e) => !/fonts\.googleapis\.com|Could not load link/.test(e));
assert(realErrors.length === 0, 'aucune erreur jsdom au chargement', realErrors.join(' | '));

const detected = window.TracefabI18n.language;
assert(LANGS.includes(detected), `la langue détectée est servie (${detected})`, detected);
const d0 = dicts[detected];

eq(document.querySelector('h1')?.textContent?.trim(), d0.title, 'le titre vient du dictionnaire');
eq(all(document, '.card label').join(' | '),
  [d0['kpi.pending'], d0['kpi.processing'], d0['kpi.failed'], d0['kpi.blocked']].join(' | '),
  'les 4 KPI viennent du dictionnaire');
eq(all(document, '.panel h2').join(' | '), `${d0['deps.title']} | ${d0['rules.title']}`,
  'les deux panneaux viennent du dictionnaire');
assert(all(document, '.status b').every((s) => !/^operations\./.test(s)),
  'aucun état de dépendance n’affiche une clé brute');
/* Porté sur #app, pas sur <body> : le texte d'un <script> fait partie de
   body.textContent, donc chercher là-dedans relit le code source et non le
   rendu — une assertion qui ne mesure pas ce qu'elle prétend mesurer. */
assert(!(document.getElementById('app').textContent || '').includes('{lang}'),
  'aucun jeton de commentaire ne fuit dans le rendu');

async function switchTo(lang) {
  await window.TracefabI18n.setLanguage(lang);
  await new Promise((r) => setTimeout(r, 150));
  return dicts[lang];
}

const dFr = await switchTo('fr');
eq(document.querySelector('h1')?.textContent?.trim(), 'La santé des traitements, visible.',
  'passer en français retraduit le titre');
eq(all(document, '.card label')[0], 'En attente', 'et les KPI');
eq(document.documentElement.getAttribute('lang'), 'fr', 'l’attribut lang du document suit');

const dDe = await switchTo('de');
eq(document.querySelector('h1')?.textContent?.trim(), dDe.title, 'puis en allemand');
eq(all(document, '.card label')[0], 'Wartend', 'et les KPI en allemand');
eq(all(document, '.panel h2')[0], dDe['deps.title'], 'y compris les panneaux');

dom.window.close();

// ---------------------------------------------------------------------------
console.log('\nC. L’état d’authentification est traduit lui aussi');
// ---------------------------------------------------------------------------

/*
 * Sans ?demo=1, /api/config n'est pas joignable : la page rend l'écran
 * « Vue opérateur indisponible ». C'est l'état d'erreur, pas celui de connexion
 * — la première version de ce test supposait le contraire et cherchait le titre
 * d'authentification sur un écran qui ne l'affiche pas.
 *
 * Peu importe lequel des deux : ce qui compte est qu'un état NON nominal porte
 * lui aussi du texte traduit. Un écran d'erreur resté en français au milieu
 * d'une page allemande est exactement le trou que ce chantier doit fermer.
 */
const failed = await mount('');
const fErrors = failed.errors.filter((e) => !/fonts\.googleapis\.com|Could not load link/.test(e));
assert(fErrors.length === 0, 'aucune erreur jsdom sur l’écran d’erreur', fErrors.join(' | '));
const body = failed.document.getElementById('app').textContent || '';
const df = dicts[failed.window.TracefabI18n.language];
assert(body.includes(df.unavailableTitle), 'le titre de l’écran d’erreur est traduit', df.unavailableTitle);
assert(body.includes(df.brand), 'et son sur-titre de marque', df.brand);
assert(body.includes(df.retry), 'et son bouton de relance', df.retry);
await failed.window.TracefabI18n.setLanguage('es');
await new Promise((r) => setTimeout(r, 150));
const ds = dicts.es;
assert((failed.document.getElementById('app').textContent || '').includes(ds.unavailableTitle),
  'l’écran d’erreur se retraduit au changement de langue', ds.unavailableTitle);
failed.dom.window.close();

// ---------------------------------------------------------------------------
console.log('\nD. Les 7 dictionnaires sont complets et distincts');
// ---------------------------------------------------------------------------

const reference = Object.keys(dicts.fr).sort().join('|');
eq(Object.keys(dicts.fr).length, 31, '31 chaînes par langue');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), reference, `${lang} expose exactement le même jeu de clés que fr`);
  const empty = Object.entries(dicts[lang]).filter(([, v]) => !String(v || '').trim());
  eq(empty.length, 0, `${lang} n’a aucune chaîne vide`, empty.map(([k]) => k).join(','));
  const cjk = Object.entries(dicts[lang]).filter(([, v]) => /[\u4e00-\u9fff]/.test(String(v)));
  eq(cjk.length, 0, `${lang} ne contient aucun caractère CJK parasite`, cjk.map(([k]) => k).join(','));
}
for (const lang of LANGS.filter((l) => l !== 'fr')) {
  const identical = Object.keys(dicts.fr).filter((k) => dicts.fr[k] === dicts[lang][k] && dicts.fr[k].length > 12);
  assert(identical.length < Object.keys(dicts.fr).length * 0.4,
    `${lang} n’est pas une copie du français`, `identiques : ${identical.join(', ')}`);
}

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
