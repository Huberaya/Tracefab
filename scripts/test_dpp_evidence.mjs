/* Preuves et certificats du passeport public — garde d'execution.
 *
 * Le defaut : la section « Certificates and legal evidence » de dpp/index.html
 * est entierement statique — numeros de certificat, dates de validite,
 * organisme accredite, verdicts « Audited » et « Compliant ». L'API ne sert
 * AUCUNE certification : il n'existe donc aucune source possible pour ces
 * valeurs. Quand un vrai passeport etait hydrate, le bandeau de demonstration
 * se cachait et les champs reels remplaçaient la demo — mais ces preuves
 * inventees restaient a l'ecran, attribuees au produit scanne.
 *
 * Ce test EXECUTE l'hydratation dans jsdom. Une relecture du source ne
 * prouverait rien : c'est le comportement au rendu qui compte.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const GTIN = '9780306406157';
const SECTION = '#panel-evidence';

/* Reponse fidele a la forme de api/_routes/dpp/[gtin].ts : { dpp, links }.
 * `pefScore` est volontairement null pour verifier l'affichage d'absence. */
const PAYLOAD_REEL = {
  dpp: {
    productName: 'Chemise Maison Alpha',
    reference: 'MB-001',
    pefScore: null,
    provenance: { status: 'incomplete', sourced: ['productName'], notProvided: ['pefScore'] },
  },
  links: { appleWalletUrl: '/api/dpp/x/apple-wallet', googleWalletUrl: '/api/dpp/x/google-wallet' },
};

const FICHIERS = [
  'assets/i18n/en.js',
  'assets/js/tf-i18n.js',
  'assets/js/tf-actions.js',
  'assets/js/dpp.2.js',
];

async function charger(url, reponse) {
  const html = readFileSync('dpp/index.html', 'utf8');
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      // Le stub doit etre pose AVANT le parse : la page peut emettre une
      // requete des l'evaluation, et il serait trop tard ensuite.
      window.fetch = (u) => {
        const cible = String(u);
        if (cible.startsWith('/api/dpp/')) {
          return reponse
            ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reponse) })
            : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        }
        const m = cible.match(/\/([a-z]{2})\.json$/);
        if (m) {
          try {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(JSON.parse(readFileSync(`assets/i18n/${m[1]}.json`, 'utf8'))),
            });
          } catch { /* locale absente : le runtime retombe sur l'anglais */ }
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      };
    },
  });
  for (const f of FICHIERS) dom.window.eval(readFileSync(f, 'utf8'));
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  // L'hydratation est asynchrone : fetch().then(). On laisse une marge plutot
  // que de compter les tours de boucle a la main.
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

/* Texte VISIBLE dans un sous-arbre, et non textContent : ce dernier inclut le
 * contenu des elements masques. Or c'est precisement ce que l'utilisateur ne
 * voit pas qui est en jeu ici — mesurer textContent ferait passer pour affiche
 * un bloc que `hidden` retire du rendu et de l'arbre d'accessibilite.
 *
 * On part de la section, pas de <body> : la section de preuves vit dans un
 * onglet dont le panneau est `display:none` tant qu'on ne l'a pas ouvert. Son
 * propre masquage n'est pas pertinent ; celui de ses enfants l'est. */
function texte(dom, selecteur) {
  const racine = dom.window.document.querySelector(selecteur);
  if (!racine) return '';
  const morceaux = [];
  const masque = (el) => {
    for (let n = el; n && n !== racine && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('hidden')) return true;
      if (n.style && n.style.display === 'none') return true;
    }
    return false;
  };
  const marche = (noeud) => {
    for (const fils of noeud.childNodes) {
      if (fils.nodeType === 3) { if (!masque(fils.parentElement)) morceaux.push(fils.nodeValue); }
      else if (fils.nodeType === 1 && !masque(fils)) marche(fils);
    }
  };
  marche(racine);
  return morceaux.join(' ').replace(/\s+/g, ' ');
}

let verifies = 0;
let echecs = 0;
function ok(l) { verifies += 1; console.log(`  ok    ${l}`); }
function ko(l, d) { echecs += 1; console.log(`  FAIL  ${l}${d ? '\n          ' + d : ''}`); }
async function controle(l, fn) {
  try { await fn(); ok(l); } catch (e) { ko(l, e.message.split('\n')[0]); }
}

/* --- 1. Sans identifiant : la demonstration est assumee ------------------- */
const demo = await charger('https://tracefab.test/dpp', null);

await controle('sans identifiant, les cartes de demonstration restent affichees', () => {
  const cartes = demo.window.document.querySelectorAll('[data-dpp-demo-only]');
  assert.ok(cartes.length >= 2, `attendu au moins 2 blocs marques, obtenu ${cartes.length}`);
  for (const c of cartes) assert.equal(c.hidden, false, 'un bloc de demo est masque sans raison');
});

await controle('sans identifiant, la mention « non servi » reste cachee', () => {
  const note = demo.window.document.querySelector('.dpp-not-served');
  assert.ok(note, '.dpp-not-served absent du document');
  assert.equal(note.hidden, true);
});

/* Auto-controle du harnais : si la mesure de visibilite etait aveugle, les
 * controles suivants passeraient a vide. En mode demo, le texte des preuves
 * DOIT etre visible — c'est le cas nominal de la page. */
await controle('le harnais voit bien le texte visible (mode demo)', () => {
  const t = texte(demo, SECTION);
  for (const attendu of ['Compliant', 'SEDEX-SMETA-2026-PT', 'CU-881294-GOTS-2026']) {
    assert.ok(t.includes(attendu), `${attendu} invisible en mode demo : la mesure de visibilite est cassee`);
  }
  assert.ok(!t.includes('Certificates and audit reports are not part'),
    'la mention « non servi » est lue alors qu’elle est masquee');
});

/* --- 2. Avec un passeport reel : la demo ne survit pas -------------------- */
const reel = await charger(`https://tracefab.test/dpp?gtin=${GTIN}`, PAYLOAD_REEL);

await controle('sur un passeport reel, les preuves inventees sont retirees', () => {
  const cartes = reel.window.document.querySelectorAll('[data-dpp-demo-only]');
  assert.ok(cartes.length >= 2, `attendu au moins 2 blocs marques, obtenu ${cartes.length}`);
  for (const c of cartes) assert.equal(c.hidden, true, 'un bloc de demonstration survit a l’hydratation');
});

await controle('le verdict « Compliant » n’est plus affiche sur un passeport reel', () => {
  assert.ok(!/\bCompliant\b/.test(texte(reel, SECTION)), '« Compliant » encore present dans le rendu');
});

await controle('aucun numero de certificat invente ne survit', () => {
  const t = texte(reel, SECTION);
  for (const ref of ['SEDEX-SMETA-2026-PT', 'CU-881294-GOTS-2026', '21.HPT.94112', 'Valid 2027', 'Valid 2026']) {
    assert.ok(!t.includes(ref), `${ref} encore affiche sous un passeport reel`);
  }
});

await controle('la page dit explicitement que les certificats ne sont pas servis', () => {
  const note = reel.window.document.querySelector('.dpp-not-served');
  assert.ok(note, '.dpp-not-served absent');
  assert.equal(note.hidden, false, 'la mention reste cachee sur un passeport reel');
  assert.ok(note.textContent.trim().length > 10, 'la mention est vide');
});

await controle('le bandeau de demonstration est bien cache quand la donnee est reelle', () => {
  const b = reel.window.document.getElementById('dpp-demo-banner');
  assert.ok(b, 'dpp-demo-banner absent');
  assert.equal(b.hidden, true);
});

/* --- 3. Absence affichee comme absence, dans la langue de la page --------- */
await controle('un champ absent affiche le libelle du catalogue, pas un litteral code en dur', () => {
  const el = reel.window.document.querySelector('[data-dpp-field="pefScore"]');
  if (!el) return; // la page n'expose pas ce champ : rien a verifier
  assert.equal(el.dataset.dppState, 'non-renseigne');
  assert.equal(el.textContent.trim(), 'Not provided',
    `obtenu « ${el.textContent.trim()} » — attendu la valeur anglaise du catalogue`);
});

await controle('dpp.2.js ne contient plus de litteral francais de rendu', () => {
  const src = readFileSync('assets/js/dpp.2.js', 'utf8');
  assert.ok(!src.includes("'Non renseigné'"), 'le litteral « Non renseigné » est encore dans le composant');
  assert.ok(/dpp\.notProvided/.test(src), 'le libelle n’est pas lu dans le catalogue');
});

/* --- 4. Catalogue et feuille de style ------------------------------------- */
await controle('dpp.notProvided et dpp.evNotServed existent dans les 7 locales', () => {
  const g = {};
  new Function('window', readFileSync('assets/i18n/en.js', 'utf8'))(g);
  const en = g.TF_I18N_BUNDLES.en.dpp;
  for (const k of ['notProvided', 'evNotServed']) {
    assert.ok(en[k] && en[k].length > 3, `dpp.${k} absent du catalogue anglais`);
  }
  for (const l of ['fr', 'de', 'es', 'it', 'nl', 'pt']) {
    const o = JSON.parse(readFileSync(`assets/i18n/${l}.json`, 'utf8'));
    for (const k of ['notProvided', 'evNotServed']) {
      assert.ok(o.dpp[k] && o.dpp[k].length > 3, `dpp.${k} absent de ${l}`);
    }
  }
});

await controle('les classes et etats ajoutes ont une regle CSS', () => {
  const page = readFileSync('dpp/index.html', 'utf8');
  assert.ok(page.includes('.dpp-not-served {'), '.dpp-not-served sans regle CSS');
  assert.ok(page.includes('[data-dpp-state="non-renseigne"] {'),
    'data-dpp-state="non-renseigne" sans regle : l’absence ne se distinguerait pas d’une valeur sourcee');
});

console.log('');
if (echecs > 0) {
  console.log(`test:dpp:evidence — ${echecs} échec(s) sur ${verifies + echecs} contrôles.`);
  process.exit(1);
}
console.log(`test:dpp:evidence passed — ${verifies} contrôles, 0 échec.`);
