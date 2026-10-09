#!/usr/bin/env node
/**
 * La page d'acceptation d'invitation traduit depuis locales/, plus depuis son code.
 *
 * AVANT
 *   `invitations/accept/index.html` ne chargeait AUCUN runtime i18n : ses 21
 *   chaînes étaient en dur, en français, dans le HTML et dans le JavaScript.
 *   C'est la page la plus mal placée pour ça — un fournisseur allemand, italien
 *   ou néerlandais reçoit justement ce lien parce qu'il ne travaille pas dans la
 *   langue de l'organisation qui l'invite.
 *
 * CE TEST VÉRIFIE LE RENDU RÉEL, PAS LA PRÉSENCE D'UNE LIGNE
 *   Il monte la page dans jsdom avec un fetch qui sert les VRAIS fichiers
 *   locales/{lang}/invitation.json, puis asserte sur le texte effectivement
 *   produit :
 *     A. le contenu métier n'est plus dans le composant ;
 *     B. le rendu est traduit, et changer de langue retraduit la page ;
 *     C. l'interpolation `{email}` est résolue, en français comme en allemand ;
 *     D. un jeton non fourni reste visible au lieu de laisser un trou ;
 *     E. chaque code d'erreur de l'API a une phrase, dans les 7 langues ;
 *     F. les 7 dictionnaires ont les mêmes clés, aucune vide, aucune langue
 *        n'est la copie d'une autre.
 *
 *   npm run test:i18n:invitation
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
const SCOPE = 'invitation';
const html = await readFile(at('invitations/accept/index.html'), 'utf8');

/* Sert /i18n-core.js et /locales/*.json sans réseau (jsdom 30 n'a plus de
   ResourceLoader : tout passe par un intercepteur). */
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
    url: 'https://tracefab.vercel.app/invitations/accept?token=abc123',
    virtualConsole: vc,
    resources: { interceptors: [serveLocally] },
  });
  /* jsdom n'expose pas fetch au script de la page ; le runtime en a besoin dans
     une microtâche, donc l'installer juste après la construction arrive à temps. */
  dom.window.fetch = async (url) => {
    const rel = String(url).replace(/^\/+/, '');
    for (const candidate of [rel, `public/${rel}`]) {
      try {
        return { ok: true, status: 200, json: async () => JSON.parse(await readFile(at(candidate), 'utf8')) };
      } catch { /* candidat suivant */ }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  /* Attendre isReady, pas une longueur de texte : sinon on asserte sur un rendu
     produit avant l'arrivée du dictionnaire, donc sur des clés brutes. */
  for (let i = 0; i < 150; i += 1) {
    if (dom.window.TracefabI18n?.isReady) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 60));
  return { dom, window: dom.window, document: dom.window.document, errors };
}

const text = (document, selector) => (document.querySelector(selector)?.textContent || '').trim();

const flat = (o, p = '') => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const path = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flat(v, path)); else out[path] = v;
  }
  return out;
};

/* Chargés AVANT le montage : la section B compare le rendu au dictionnaire de la
   langue réellement détectée, il faut donc déjà les avoir en main. */
const dicts = {};
for (const lang of LANGS) {
  const doc = JSON.parse(await readFile(at(`locales/${lang}/${SCOPE}.json`), 'utf8'));
  dicts[lang] = flat(doc.invitation || {});
}

// ---------------------------------------------------------------------------
console.log('\nA. Le contenu métier n’est plus codé dans le composant');
// ---------------------------------------------------------------------------

assert(html.includes('/i18n-core.js'), 'la page charge le runtime partagé');
assert(/init\(\{\s*scope:\s*'invitation'/.test(html), 'et déclare le scope « invitation »');
for (const literal of [
  'Rejoindre une organisation fournisseur.',
  'Accepter l’invitation',
  'Le lien d’invitation est invalide.',
  'Connexion indisponible.',
]) {
  /* Le texte d'origine reste dans le markup : c'est le repli du runtime avant
     l'arrivée du dictionnaire. Ce qui doit avoir disparu, ce sont les
     littéraux utilisés COMME VALEUR par le JavaScript. */
  const asJsValue = new RegExp(`['"\`]${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  assert(!asJsValue.test(html), `« ${literal.slice(0, 32)}… » n’est plus une valeur en dur du script`);
}

// ---------------------------------------------------------------------------
console.log('\nB. La page est traduite, et changer de langue la retraduit');
// ---------------------------------------------------------------------------

const { dom, window, document, errors } = await mount();
assert(errors.length === 0, 'aucune erreur jsdom au chargement', errors.join(' | '));

/*
 * La langue de départ n'est PAS fixée à l'avance : le runtime la déduit de
 * `navigator.language`, qui vaut « en-US » sous jsdom. Asserter « fr » ici
 * reviendrait à figer un comportement de navigateur de test, pas une propriété
 * du produit — et c'est exactement l'erreur que cette première version du test
 * a commise. On asserte donc que le rendu correspond au dictionnaire de la
 * langue réellement détectée, quelle qu'elle soit.
 */
const detected = window.TracefabI18n.language;
assert(LANGS.includes(detected), `la langue détectée est servie (${detected})`, detected);
const d0 = dicts[detected];
eq(text(document, 'h1'), d0.title, `le titre rendu vient du dictionnaire ${detected}`);
eq(text(document, '.eyebrow'), d0.eyebrow, 'le sur-titre aussi');
eq(text(document, '#accept-button'), d0.accept, 'le bouton aussi');
eq(text(document, 'a.link'), d0.openPortal, 'le lien aussi');
eq(text(document, '.name small'), d0.workspace, 'le sous-titre de marque aussi');
eq(document.title, d0['meta.title'], 'le <title> aussi');

const select = document.getElementById('lang-select');
eq(select.querySelectorAll('option').length, LANGS.length, `le sélecteur propose les ${LANGS.length} langues`);

async function switchTo(lang) {
  await window.TracefabI18n.setLanguage(lang);
  await new Promise((r) => setTimeout(r, 60));
  return dicts[lang];
}

const dFr = await switchTo('fr');
eq(text(document, 'h1'), dFr.title, 'passer en français retraduit le titre');
eq(document.documentElement.getAttribute('lang'), 'fr', 'et l’attribut lang du document suit');

const dDe = await switchTo('de');
eq(text(document, 'h1'), dDe.title, 'puis en allemand');
eq(text(document, '#accept-button'), dDe.accept, 'et le bouton');
eq(select.value, 'de', 'le sélecteur reflète la langue active');

// ---------------------------------------------------------------------------
console.log('\nC. L’interpolation est résolue, pas laissée en l’état');
// ---------------------------------------------------------------------------

/* Vérifié PENDANT que l'allemand est actif : la même assertion exécutée après un
   changement de langue mesure la mauvaise langue, ce que cette première version
   du test a fait en affirmant une phrase néerlandaise sur un test allemand. */
const deSignedIn = window.TracefabI18n.t('invitation.signedIn', { email: 'anna@mill.de' });
assert(deSignedIn.includes('anna@mill.de'), 'l’adresse passée est présente', deSignedIn);
assert(!deSignedIn.includes('{email}'), 'et le jeton {email} a disparu', deSignedIn);
assert(!deSignedIn.startsWith('invitation.'), 'la clé n’est pas renvoyée telle quelle', deSignedIn);
assert(/^Angemeldet als anna@mill\.de\./.test(deSignedIn),
  'la phrase allemande place l’adresse après « Angemeldet als », pas avant', deSignedIn);

const signedIn = deSignedIn;

// ---------------------------------------------------------------------------
console.log('\nD. Un jeton non fourni reste visible');
// ---------------------------------------------------------------------------

const noValue = window.TracefabI18n.t('invitation.signedIn');
assert(noValue.includes('{email}'), 'sans valeur, le jeton reste apparent plutôt que de laisser un trou', noValue);
assert(window.TracefabI18n.t('invitation.does.not.exist') === null, 'une clé inconnue renvoie null, jamais une chaîne inventée');

// ---------------------------------------------------------------------------
console.log('\nE. Chaque code d’erreur de l’API a une phrase, dans les 7 langues');
// ---------------------------------------------------------------------------

const ERROR_CODES = [
  'invalid_invitation_token',
  'invalid_or_expired_invitation',
  'invitation_email_mismatch',
  'user_already_member',
  'unauthorized',
];
/* Les codes sont routés par une table, pas devinés : un code que l'API renverrait
   sans qu'il soit listé ici doit tomber sur genericError. */
const routed = (html.match(/invitation\.errors\.[a-z_]+/g) || []).map((s) => s.split('.').pop());
for (const code of ERROR_CODES) {
  assert(routed.includes(code), `le code ${code} est routé vers une clé`);
}
for (const lang of LANGS) {
  const doc = JSON.parse(await readFile(at(`locales/${lang}/${SCOPE}.json`), 'utf8'));
  for (const code of ERROR_CODES) {
    const value = doc.invitation?.errors?.[code];
    assert(typeof value === 'string' && value.trim().length > 8,
      `${lang} : ${code} a une vraie phrase`, JSON.stringify(value));
    assert(!/^invitation\./.test(value || ''), `${lang} : ${code} n’est pas la clé renvoyée telle quelle`);
  }
  assert(typeof doc.invitation?.genericError === 'string' && doc.invitation.genericError.trim().length > 8,
    `${lang} : un message générique existe pour un code non listé`);
}

// ---------------------------------------------------------------------------
console.log('\nF. Les 7 dictionnaires sont complets et distincts');
// ---------------------------------------------------------------------------

const reference = Object.keys(dicts.fr).sort().join('|');
eq(Object.keys(dicts.fr).length, 21, '21 chaînes par langue');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), reference, `${lang} expose exactement le même jeu de clés que fr`);
  const empty = Object.entries(dicts[lang]).filter(([, v]) => !String(v || '').trim());
  eq(empty.length, 0, `${lang} n’a aucune chaîne vide`, empty.map(([k]) => k).join(','));
}
for (const lang of LANGS.filter((l) => l !== 'fr')) {
  const identical = Object.keys(dicts.fr).filter((k) => dicts.fr[k] === dicts[lang][k] && /e$|é|s$/i.test(dicts.fr[k]));
  assert(identical.length < Object.keys(dicts.fr).length * 0.6,
    `${lang} n’est pas une copie du français`, `identiques : ${identical.length}/${Object.keys(dicts.fr).length}`);
}
assert(dicts.fr['signedIn'].includes('{email}') && dicts.de['signedIn'].includes('{email}'),
  'le jeton {email} est présent dans chaque langue qui en a besoin');

dom.window.close();

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
