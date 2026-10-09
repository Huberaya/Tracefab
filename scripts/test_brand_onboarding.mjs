/* Onboarding Marque — garde d'execution.
 *
 * Le defaut : POST /api/organizations existe et cree l'organisation ET son
 * premier membership owner de maniere atomique, mais aucun ecran ne l'appelait.
 * Un utilisateur Clerk sans rattachement Marque ouvrait la console sur des
 * tableaux vides, sans issue. Un backend sans bouton est une fonctionnalite
 * morte.
 *
 * Ce test EXECUTE la console dans jsdom, Clerk et l'API stubbes. Il verifie le
 * chemin reel : porte d'onboarding, soumission, corps de requete, refus affiche,
 * puis sortie de l'onboarding une fois le membership cree.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const FICHIERS = [
  'assets/i18n/en.js',
  'assets/js/tf-i18n.js',
  'assets/js/tf-actions.js',
  'assets/js/tf-sort.js',
  'assets/js/brand-console.1.js',
];

/* pk_test_<base64> : boot() decode le troisieme segment pour en tirer le
 * domaine Clerk. La valeur n'a pas a etre reelle, seulement decodable. */
const PK = 'pk_test_' + Buffer.from('clerk.tracefab.test$').toString('base64');

const VIDE = { organizations: [], suppliers: [], materials: [], products: [], requests: [], questionnaires: [], schemas: [] };

/**
 * @param {object} opt
 * @param {Array}  opt.memberships   memberships renvoyes par /api/me
 * @param {Function} [opt.onPost]    appele sur POST /api/organizations
 */
async function boot({ memberships, onPost }) {
  const html = readFileSync('brand-console/index.html', 'utf8');
  const vc = new VirtualConsole();
  const appels = [];
  const dom = new JSDOM(html, {
    url: 'https://tracefab.test/brand-console/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.Clerk = {
        load: async () => {},
        addListener: () => {},
        user: { id: 'user_1', primaryEmailAddress: { emailAddress: 'a@b.test' } },
        session: { getToken: async () => 'jeton' },
      };
      window.fetch = async (url, options = {}) => {
        const u = String(url);
        const methode = (options.method || 'GET').toUpperCase();
        appels.push({ methode, url: u, corps: options.body || null });
        const json = (o, status = 200) => ({
          ok: status < 400, status, json: async () => o,
        });
        if (u === '/api/config') return json({ publishableKey: PK });
        if (u === '/api/me') return json({ user: { id: 'user_1', email: 'a@b.test' }, memberships });
        if (u.startsWith('/api/organizations') && methode === 'POST') {
          if (onPost) return onPost(JSON.parse(options.body || '{}'));
          return json({ organization: { id: 'org_1', type: 'brand', legal_name: 'Maison Test' } });
        }
        if (u === '/api/organizations') return json({ organizations: [] });
        if (u.startsWith('/api/suppliers')) return json({ suppliers: VIDE.suppliers });
        if (u.startsWith('/api/materials')) return json({ materials: VIDE.materials });
        if (u.startsWith('/api/products')) return json({ products: VIDE.products });
        if (u.startsWith('/api/data-requests')) return json({ requests: VIDE.requests });
        if (u.startsWith('/api/questionnaires')) return json({ questionnaires: VIDE.questionnaires });
        if (u.startsWith('/api/catalog/schemas')) return json({ schemas: VIDE.schemas });
        const m = u.match(/\/([a-z]{2})\.json$/);
        if (m) {
          try {
            return json(JSON.parse(readFileSync(`assets/i18n/${m[1]}.json`, 'utf8')));
          } catch { /* locale absente */ }
        }
        return json({ error: 'not_found' }, 404);
      };
    },
  });
  // boot() injecte le SDK Clerk depuis un CDN. Ici on fait croire que le script
  // est charge, sinon la console retombe en mode demo et la porte d'onboarding —
  // qui exclut volontairement la demo — ne s'ouvre jamais. Le patch est pose
  // APRES la construction : document.head n'existe pas encore dans beforeParse.
  const head = dom.window.document.head;
  const append = head.appendChild.bind(head);
  head.appendChild = (el) => {
    if (el && el.tagName === 'SCRIPT' && /clerk\.browser\.js/.test(el.src || '')) {
      setTimeout(() => el.onload && el.onload(), 0);
      return el;
    }
    return append(el);
  };
  for (const f of FICHIERS) dom.window.eval(readFileSync(f, 'utf8'));
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  // boot() est asynchrone (config, SDK, sync) : on laisse la boucle se vider.
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 25));
  return { dom, appels };
}

let verifies = 0;
let echecs = 0;
function ok(l) { verifies += 1; console.log(`  ok    ${l}`); }
function ko(l, d) { echecs += 1; console.log(`  FAIL  ${l}${d ? '\n          ' + d : ''}`); }
async function controle(l, fn) {
  try { await fn(); ok(l); } catch (e) { ko(l, e.message.split('\n')[0]); }
}

/* --- 1. Aucun rattachement Marque : la porte s'ouvre ---------------------- */
const sansOrg = await boot({ memberships: [] });
const doc = sansOrg.dom.window.document;

await controle('sans rattachement Marque, le formulaire de creation est affiche', () => {
  const form = doc.querySelector('form.onboarding-form');
  assert.ok(form, 'aucun formulaire .onboarding-form rendu');
  for (const champ of ['legalName', 'displayName', 'countryCode']) {
    assert.ok(form.querySelector(`[name="${champ}"]`), `champ ${champ} absent`);
  }
});

await controle('la raison sociale est la seule donnee obligatoire', () => {
  const form = doc.querySelector('form.onboarding-form');
  assert.equal(form.querySelector('[name="legalName"]').hasAttribute('required'), true);
  assert.equal(form.querySelector('[name="displayName"]').hasAttribute('required'), false);
  assert.equal(form.querySelector('[name="countryCode"]').hasAttribute('required'), false);
});

await controle('la console n’est pas tombee en mode demo pour afficher l’onboarding', () => {
  const st = sansOrg.dom.window.tracefabBrandConsole.state;
  assert.equal(st.demo, false, 'state.demo est vrai : la porte serait ouverte pour la mauvaise raison');
  assert.equal(st.user !== null && st.user !== undefined, true, 'aucun utilisateur : on serait sur l’ecran d’auth');
});

await controle('les libelles viennent du catalogue, pas de litteraux', () => {
  const texte = doc.querySelector('.onboarding-form').parentElement.textContent;
  assert.ok(/Create your brand organization/.test(texte), 'titre anglais du catalogue absent');
  assert.ok(!/\bobTitle\b|\bobSubmit\b/.test(texte), 'une cle i18n non resolue est affichee telle quelle');
});

/* --- 2. Soumission : le corps de requete est celui de la route ------------ */
await controle('soumettre POSTe /api/organizations avec le contrat de la route', async () => {
  const form = doc.querySelector('form.onboarding-form');
  form.querySelector('[name="legalName"]').value = 'Maison Test';
  form.querySelector('[name="displayName"]').value = 'Maison';
  form.querySelector('[name="countryCode"]').value = 'pt';
  form.dispatchEvent(new sansOrg.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 25));
  const post = sansOrg.appels.find((a) => a.methode === 'POST' && a.url === '/api/organizations');
  assert.ok(post, 'aucun POST /api/organizations emis');
  const corps = JSON.parse(post.corps);
  assert.equal(corps.legalName, 'Maison Test');
  assert.equal(corps.type, 'brand');
  assert.equal(corps.displayName, 'Maison');
  assert.equal(corps.countryCode, 'PT', 'le code pays doit etre normalise en majuscules');
});

/* --- 3. Refus metier : l'erreur reste sur le formulaire ------------------- */
const refuse = await boot({
  memberships: [],
  onPost: () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_organization' }) }),
});
await controle('un refus de l’API s’affiche sur le formulaire, pas en panne de console', async () => {
  const d = refuse.dom.window.document;
  const form = d.querySelector('form.onboarding-form');
  form.querySelector('[name="legalName"]').value = 'x';
  form.dispatchEvent(new refuse.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 25));
  const erreur = d.querySelector('.form-error');
  assert.ok(erreur, 'aucune .form-error affichee apres un refus');
  assert.equal(erreur.getAttribute('role'), 'alert', 'l’erreur n’est pas annoncee au lecteur d’ecran');
  assert.ok(/invalid_organization/.test(erreur.textContent), 'le code d’erreur n’est pas montre');
  assert.ok(d.querySelector('form.onboarding-form'), 'le formulaire a disparu : l’utilisateur perd sa saisie');
});

/* --- 4. Rattachement existant : la porte reste fermee --------------------- */
const avecOrg = await boot({
  memberships: [{ organization_id: 'org_1', role: 'owner', organizations: { id: 'org_1', type: 'brand', legal_name: 'Maison Alpha' } }],
});
await controle('avec un rattachement Marque, l’onboarding ne s’affiche pas', () => {
  const d = avecOrg.dom.window.document;
  assert.equal(d.querySelector('form.onboarding-form'), null, 'l’onboarding s’affiche alors qu’une marque existe');
});

/* --- 5. Catalogue et feuille de style ------------------------------------- */
await controle('les 9 cles d’onboarding existent dans les 7 locales', () => {
  const CLES = ['obTitle', 'obLead', 'obLegalName', 'obDisplayName', 'obCountry', 'obCountryHint', 'obSubmit', 'obCreating', 'obError'];
  const g = {};
  new Function('window', readFileSync('assets/i18n/en.js', 'utf8'))(g);
  const en = g.TF_I18N_BUNDLES.en.console;
  for (const k of CLES) assert.ok(en[k] && en[k].length > 1, `console.${k} absent du catalogue anglais`);
  for (const l of ['fr', 'de', 'es', 'it', 'nl', 'pt']) {
    const o = JSON.parse(readFileSync(`assets/i18n/${l}.json`, 'utf8'));
    for (const k of CLES) assert.ok(o.console[k] && o.console[k].length > 1, `console.${k} absent de ${l}`);
  }
});

await controle('les classes ajoutees ont une regle CSS et aucune variable fantome', () => {
  const page = readFileSync('brand-console/index.html', 'utf8');
  for (const c of ['.onboarding-form', '.form-error']) {
    assert.ok(page.includes(c + ' {') || page.includes(c + ' .') || page.includes(c + ':'),
      `${c} sans regle CSS`);
  }
  const regles = page.match(/\.(onboarding-form|form-error)[^}]*\}/g) || [];
  for (const r of regles) {
    for (const m of r.matchAll(/var\((--[a-z0-9-]+)/g)) {
      assert.ok(page.includes(m[1] + ':'), `${m[1]} n’est defini nulle part`);
    }
  }
});

console.log('');
if (echecs > 0) {
  console.log(`test:brand-onboarding — ${echecs} échec(s) sur ${verifies + echecs} contrôles.`);
  process.exit(1);
}
console.log(`test:brand-onboarding passed — ${verifies} contrôles, 0 échec.`);
