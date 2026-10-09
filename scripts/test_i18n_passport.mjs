#!/usr/bin/env node
/**
 * Le Passeport Fournisseur Universel traduit depuis locales/, plus depuis son code.
 *
 * AVANT
 *   `passport/index.html` ne chargeait AUCUN runtime i18n : 56 chaînes étaient
 *   en dur, en français, réparties entre le markup, trois gabarits HTML et les
 *   gestionnaires du formulaire. C'est une page publique dont l'objet même est
 *   d'être lue par des donneurs d'ordre étrangers.
 *
 *   Au passage, `date()` appelait `toLocaleDateString('fr-FR')` en dur : même
 *   une page entièrement traduite aurait affiché « 14 janv. 2027 » à un lecteur
 *   allemand.
 *
 * CE TEST VÉRIFIE LE RENDU RÉEL
 *   La page est montée dans jsdom avec un fetch servant les VRAIS fichiers
 *   locales/{lang}/passport.json. L'appel à /api/passport échoue, donc la page
 *   charge son repli de démonstration : c'est justement le chemin de rendu que
 *   l'on veut observer, et les assertions portent sur les LIBELLÉS (qui viennent
 *   du dictionnaire), jamais sur les données de démonstration.
 *
 *     A. le contenu métier n'est plus codé dans le composant ;
 *     B. le rendu est traduit, et changer de langue retraduit la page ;
 *     C. le modal ouvert est traduit lui aussi ;
 *     D. les jetons {count} et {supplier} sont résolus ;
 *     E. la date suit la langue active ;
 *     F. les 7 dictionnaires : 56 clés, parité, aucune vide, aucune copie,
 *        jetons identiques d'une langue à l'autre.
 *
 *   npm run test:i18n:passport
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
const SCOPE = 'passport';
const html = await readFile(at('passport/index.html'), 'utf8');

/* Le seul <script> inline de la page : c'est là que vivaient les littéraux. */
const scriptBody = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];

const flat = (o, p = '') => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const path = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flat(v, path)); else out[path] = v;
  }
  return out;
};

/* Chargés avant le montage : la section B compare le rendu au dictionnaire de la
   langue réellement détectée, il faut donc déjà les avoir en main. */
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
    url: 'https://tracefab.vercel.app/passport?ref=demo',
    virtualConsole: vc,
    resources: { interceptors: [serveLocally] },
  });
  dom.window.fetch = async (url) => {
    const rel = String(url).replace(/^\/+/, '');
    for (const candidate of [rel, `public/${rel}`]) {
      try {
        return { ok: true, status: 200, json: async () => JSON.parse(await readFile(at(candidate), 'utf8')) };
      } catch { /* candidat suivant : /api/passport/... tombe ici, ce qui déclenche
                  le repli de démonstration — le chemin de rendu que l'on teste. */ }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  /* Attendre le rendu effectif (le gabarit est injecté après le fetch), pas une
     simple attente de dictionnaire : sinon on asserte sur une page vide. */
  for (let i = 0; i < 200; i += 1) {
    const ready = dom.window.TracefabI18n?.isReady;
    const rendered = (dom.window.document.getElementById('app')?.innerHTML || '').length > 800;
    if (ready && rendered) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 80));
  return { dom, window: dom.window, document: dom.window.document, errors };
}

const all = (document, selector) =>
  Array.from(document.querySelectorAll(selector)).map((el) => (el.textContent || '').trim());

// ---------------------------------------------------------------------------
console.log('\nA. Le contenu métier n’est plus codé dans le composant');
// ---------------------------------------------------------------------------

assert(html.includes('/i18n-core.js'), 'la page charge le runtime partagé');
assert(/init\(\{\s*scope:\s*'passport'/.test(html), 'et déclare le scope « passport »');
for (const literal of [
  'Complétude Profil', 'Preuves Documentaires', 'Certifications Actives', 'Sites Déclarés',
  '✓ Vérifié IA', 'Localisation :', 'Origine fibre :', 'Annuler', 'Compris',
  'Envoyer la demande d\'accès', 'Protection des Secrets d\'Affaires',
  'Sites de Production Vérifiés', 'Matières & Capacités Circulaires',
]) {
  /*
   * Un libellé ne peut plus rester que comme texte de repli dans le markup —
   * c'est-à-dire dans un élément porteur de data-i18n. Ce qui doit avoir
   * disparu, c'est sa présence comme VALEUR produite par le JavaScript : entre
   * guillemets, ou dans un gabarit.
   *
   * On isole donc le contenu du <script> et on y cherche le littéral.
   */
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp('["\'`]' + escaped + '["\'`]');
  assert(!quoted.test(scriptBody), `« ${literal} » n’est plus une valeur produite par le script`);
}
assert(!html.includes("toLocaleDateString('fr-FR'"),
  'date() ne force plus le français — la locale suit la langue active');

// ---------------------------------------------------------------------------
console.log('\nB. La page est traduite, et changer de langue la retraduit');
// ---------------------------------------------------------------------------

const { dom, window, document, errors } = await mount();
/*
 * La feuille de style Google Fonts ne peut pas être chargée ici : cet
 * environnement n'a pas d'accès à fonts.googleapis.com. Ce n'est pas un défaut
 * du code et l'ignorer en bloc masquerait une vraie erreur — on l'écarte
 * nommément, et toute autre erreur reste un échec.
 */
const realErrors = errors.filter((e) => !/fonts\.googleapis\.com|Could not load link/.test(e));
assert(realErrors.length === 0, 'aucune erreur jsdom au chargement hors polices distantes', realErrors.join(' | '));

/* La langue de départ n'est pas fixée à l'avance : le runtime la déduit de
   navigator.language, qui vaut « en-US » sous jsdom. On compare donc le rendu au
   dictionnaire de la langue réellement détectée. */
const detected = window.TracefabI18n.language;
assert(LANGS.includes(detected), `la langue détectée est servie (${detected})`, detected);
const d0 = dicts[detected];

for (const [label, key] of [
  ['Complétude Profil', 'kpi.profile'], ['Preuves Documentaires', 'kpi.evidence'],
  ['Certifications Actives', 'kpi.certifications'], ['Sites Déclarés', 'kpi.sites'],
]) {
  assert(all(document, '.kpi-label').includes(d0[key]),
    `le KPI « ${label} » est rendu depuis le dictionnaire ${detected}`,
    all(document, '.kpi-label').join(' | '));
}
for (const key of ['certs.title', 'sites.title', 'materials.title']) {
  const heads = all(document, '.card-head h2');
  assert(heads.some((h) => h === d0[key]),
    `« ${key} » est rendu depuis le dictionnaire ${detected}`, heads.join(' | '));
}
assert(all(document, '.sticky-text strong').includes(d0['sticky.title']),
  'la barre de conversion est traduite');
assert(all(document, '.nda-content strong').includes(d0['nda.title']),
  'le bandeau secret d’affaires est traduit');
assert(all(document, '.kpi-label').every((s) => !/^passport\./.test(s)),
  'aucun KPI n’affiche une clé brute');

const select = document.getElementById('lang-select');
eq(select.querySelectorAll('option').length, LANGS.length, `le sélecteur propose les ${LANGS.length} langues`);

async function switchTo(lang) {
  await window.TracefabI18n.setLanguage(lang);
  await new Promise((r) => setTimeout(r, 120));
  return dicts[lang];
}

const dFr = await switchTo('fr');
assert(all(document, '.kpi-label').includes('Complétude Profil'), 'passer en français retraduit les KPI');
assert(all(document, '.kpi-label').includes(dFr['kpi.profile']), 'et correspond au dictionnaire français');
eq(document.documentElement.getAttribute('lang'), 'fr', 'l’attribut lang du document suit');

const dDe = await switchTo('de');
assert(all(document, '.kpi-label').includes('Profilvollständigkeit'), 'puis en allemand');
assert(all(document, '.card-head h2').some((h) => h === dDe['certs.title']), 'y compris les titres de cartes');
eq(select.value, 'de', 'le sélecteur reflète la langue active');

// ---------------------------------------------------------------------------
console.log('\nC. Le modal ouvert est traduit lui aussi');
// ---------------------------------------------------------------------------

window.openRequestModal();
await new Promise((r) => setTimeout(r, 60));
const modalLabels = all(document, '#modal-container .form-group label');
for (const key of ['nameLabel', 'emailLabel', 'companyLabel', 'messageLabel']) {
  assert(modalLabels.some((l) => l === dDe[`modal.${key}`]),
    `le champ « modal.${key} » est traduit en allemand`, modalLabels.join(' | '));
}
assert((document.getElementById('modal-container').textContent || '').includes(dDe['modal.submit']),
  'le bouton d’envoi du modal est traduit');
assert((document.getElementById('modal-container').textContent || '').includes(dDe['modal.cancel']),
  'et celui d’annulation');
assert(!(document.getElementById('modal-container').textContent || '').includes('{supplier}'),
  'le jeton {supplier} de l’introduction a été résolu');

// ---------------------------------------------------------------------------
console.log('\nD. Les jetons sont résolus');
// ---------------------------------------------------------------------------

const count = window.TracefabI18n.t('passport.certs.count', { count: 3 });
assert(count.includes('3') && !count.includes('{count}'), 'certs.count substitue {count}', count);
const founded = window.TracefabI18n.t('passport.hero.foundedIn', { year: 1998 });
assert(founded.includes('1998') && !founded.includes('{year}'), 'hero.foundedIn substitue {year}', founded);
assert(!window.TracefabI18n.t('passport.certs.count').includes('undefined'),
  'sans valeur, {count} reste apparent au lieu d’afficher « undefined »',
  window.TracefabI18n.t('passport.certs.count'));

// ---------------------------------------------------------------------------
console.log('\nE. La date suit la langue active');
// ---------------------------------------------------------------------------

const validUntil = Array.from(document.querySelectorAll('.item-desc'))
  .map((el) => el.textContent).find((s) => s.includes(dDe['certs.validUntil']));
assert(!!validUntil, 'la ligne « Valide jusqu’au » est présente en allemand', dDe['certs.validUntil']);
assert(!/\d{1,2}\s+(janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc)\./.test(validUntil || ''),
  'elle n’affiche pas un mois abrégé français', validUntil);

// ---------------------------------------------------------------------------
console.log('\nF. Les 7 dictionnaires sont complets, distincts et cohérents');
// ---------------------------------------------------------------------------

const reference = Object.keys(dicts.fr).sort().join('|');
eq(Object.keys(dicts.fr).length, 56, '56 chaînes par langue');
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
