#!/usr/bin/env node
/**
 * Le passeport fournisseur public n'invente pas d'entreprise.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `passport.1.js` enveloppait son appel API dans un `try/catch` dont le `catch`
 * contenait un fournisseur complet et nomme : « Nhãn Textile Portugal », PT,
 * fonde en 1998, 251-1000 salaries, « ✓ AUDITED PROFILE », certifie GOTS et
 * OEKO-TEX. Toute reponse non-OK y menait.
 *
 * Deux consequences, aucune acceptable :
 *
 *   - un lien de partage vers un passeport jamais publie, ou revoque, affichait
 *     une AUTRE entreprise, auditee et certifiee ;
 *   - une panne passagere sur un VRAI passeport remplacait silencieusement le
 *     profil du fournisseur par celui du fournisseur fictif.
 *
 * La banniere « demonstration » restait visible, ce qui a longtemps tenu lieu
 * de garde-fou. Elle ne suffit pas : elle qualifie la page, pas l'entreprise
 * qu'on y lit, et personne ne deduit d'un bandeau que la societe affichee n'est
 * pas celle qu'il cherchait.
 *
 * Le defaut etait structurel : la page de demonstration elle-meme passait par
 * ce `catch` — sans `?ref`, elle interrogeait `nhan-textile-pt`, recevait 404 et
 * tombait dans le repli. La demonstration etait donc indissociable d'une panne,
 * et toute panne devenait une demonstration. Le mode demonstration est
 * desormais explicite, et le repli a disparu.
 *
 *   npm run test:passport-public      (serveur de dev requis sur :3000)
 */
import { chromium } from 'playwright';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';
let echecs = 0;
const ok = (condition, libelle) => {
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${libelle}`);
  if (!condition) echecs += 1;
};

/**
 * Etat lisible de la page. Tout est declare DANS la fonction : `page.evaluate`
 * serialise le corps et l'execute dans le navigateur, ou la portee du script
 * de test n'existe pas.
 */
const etat = () => {
  const vu = (el) => {
    if (el.hidden) return '';
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return '';
    return [...el.childNodes]
      .map((n) => (n.nodeType === 3 ? n.textContent : n.nodeType === 1 ? vu(n) : ''))
      .join(' ');
  };
  const bloc = document.querySelector('[data-passport-indisponible]');
  const banniere = document.getElementById('passport-demo-banner');
  return {
    texte: vu(document.body).replace(/\s+/g, ' '),
    bloc: bloc ? bloc.getAttribute('data-passport-indisponible') : null,
    banniere: banniere ? !banniere.hidden : null,
    demo: document.body.hasAttribute('data-tf-demo'),
  };
};

/**
 * Attend que `#app` ait rendu quelque chose, ou que l'ecran d'indisponibilite
 * soit la. Borne, et sans dependre du reseau : avec `networkidle`, une requete
 * qui n'aboutit jamais faisait expirer la navigation au bout de 30 s, et le
 * test signalait une panne de navigateur la ou il aurait du signaler une
 * assertion fausse.
 */
const attendreRendu = (page) => page.waitForFunction(() => {
  const app = document.getElementById('app');
  return !!document.querySelector('[data-passport-indisponible]')
    || (app && app.children.length > 0);
}, null, { timeout: 6000 }).catch(() => {});

const navigateur = await chromium.launch();

async function consulter(url, statut) {
  const page = await navigateur.newPage();
  if (statut) {
    await page.route('**/api/passport/**', (r) => r.fulfill({
      status: statut, contentType: 'application/json', body: JSON.stringify({ error: 'indisponible' }),
    }));
  }
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await attendreRendu(page);
  const vu = await page.evaluate(etat);
  await page.close();
  return vu;
}

try {
  console.log('\n  Passeport fournisseur public\n');

  // --- A. la demonstration reste une demonstration ---
  console.log('  A. page de demonstration');
  const demo = await consulter('/passport/', null);
  ok(/Nh.?n Textile/.test(demo.texte), 'le fournisseur de demonstration est affiche');
  ok(demo.banniere === true, 'sous sa banniere');
  ok(demo.demo, 'et la page se declare comme donnee de demonstration');
  ok(demo.bloc === null, 'aucun ecran d\'indisponibilite');

  // --- B. passeport inexistant ou revoque ---
  console.log('\n  B. passeport inexistant, revoque ou prive');
  for (const statut of [404, 403, 410]) {
    const vu = await consulter('/passport/?ref=fournisseur-reel', statut);
    ok(vu.bloc === 'absent', `HTTP ${statut} : ecran « indisponible » (${vu.bloc})`);
    ok(!/Nh.?n Textile/.test(vu.texte), `HTTP ${statut} : aucun fournisseur fictif`);
    for (const mot of ['GOTS', 'OEKO-TEX', 'AUDITED']) {
      ok(!vu.texte.includes(mot), `HTTP ${statut} : « ${mot} » n'est pas affiche`);
    }
    ok(vu.banniere === false && !vu.demo,
      `HTTP ${statut} : la banniere de demonstration est retiree`);
  }

  // --- C. panne du service ---
  // Distincte du cas B : le visiteur doit savoir s'il faut redemander un lien
  // ou simplement revenir plus tard.
  console.log('\n  C. panne du service');
  for (const statut of [500, 502]) {
    const vu = await consulter('/passport/?ref=fournisseur-reel', statut);
    ok(vu.bloc === 'erreur', `HTTP ${statut} : ecran « panne », distinct de « absent » (${vu.bloc})`);
    ok(!/Nh.?n Textile/.test(vu.texte), `HTTP ${statut} : aucun fournisseur fictif`);
    ok(/again|nouveau|erneut|riprova|reintentar|opnieuw/i.test(vu.texte),
      `HTTP ${statut} : une reprise est proposee`);
  }

  // --- D. un vrai passeport s'affiche, et seul ---
  console.log('\n  D. passeport reel');
  const page = await navigateur.newPage();
  await page.route('**/api/passport/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      passport: { id: 'p1', slug: 'vrai', shareToken: 't', headline: 'Knitted fabrics',
        tradeSecretMode: 'redacted', viewsCount: 1, lastViewedAt: new Date().toISOString() },
      supplier: { legalName: 'Fil Réel SAS', displayName: 'Fil Réel', countryCode: 'FR' },
      qualityScore: { overall: 70, completeness: 70, evidence: 70, freshness: 70, consistency: 70 },
      tradeSecretProtection: { exactAddressesMasked: true, mode: 'redacted', legalBasis: 'Directive (EU) 2016/943' },
    }),
  }));
  await page.goto(`${BASE}/passport/?ref=vrai`, { waitUntil: 'domcontentloaded' });
  await attendreRendu(page);
  const reel = await page.evaluate(etat);
  await page.close();
  ok(/Fil R[ée]el/.test(reel.texte), 'le fournisseur reel est affiche');
  ok(!/Nh.?n Textile/.test(reel.texte), 'sans trace du fournisseur de demonstration');
  ok(reel.banniere === false && !reel.demo, 'et sans banniere de demonstration');

  // --- D bis. reponse reelle incomplete ---
  // Tant que le repli fictif existait, une reponse a laquelle il manquait un
  // tableau etait sans consequence visible. Sans lui, `render()` levait pendant
  // la construction du gabarit et la page restait BLANCHE : le visiteur n'avait
  // plus ni donnee, ni explication.
  console.log('\n  D bis. reponse reelle incomplete');
  const partielle = await navigateur.newPage();
  await partielle.route('**/api/passport/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      passport: { id: 'p2', slug: 'partiel', shareToken: 't', tradeSecretMode: 'redacted' },
      supplier: { legalName: 'Tissage Minimal SARL', displayName: 'Tissage Minimal', countryCode: 'FR' },
      qualityScore: { overall: 40, completeness: 40, evidence: 40, freshness: 40, consistency: 40 },
      tradeSecretProtection: { exactAddressesMasked: true, mode: 'redacted', legalBasis: 'Directive (EU) 2016/943' },
    }),
  }));
  await partielle.goto(`${BASE}/passport/?ref=partiel`, { waitUntil: 'domcontentloaded' });
  await attendreRendu(partielle);
  const vuPartiel = await partielle.evaluate(etat);
  await partielle.close();
  ok(/Tissage Minimal/.test(vuPartiel.texte),
    'un passeport sans certifications, sites ni matieres s\'affiche quand meme');
  ok(vuPartiel.texte.length > 200, `la page n'est pas blanche (${vuPartiel.texte.length} caracteres)`);
  ok(vuPartiel.bloc === null, 'et ce n\'est pas un ecran d\'erreur');

  // --- E. le jeu de demonstration n'est plus dans le chemin d'erreur ---
  // Garde de structure : la correction consiste autant a avoir SORTI l'objet du
  // `catch` qu'a avoir change le rendu. S'il y retourne, les cas B et C
  // pourraient redevenir verts par accident tout en reintroduisant le defaut.
  console.log('\n  E. structure du code');
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('assets/js/passport.1.js', 'utf8');
  const apresCatch = source.slice(source.indexOf('} catch (e) {'));
  const finCatch = apresCatch.slice(0, apresCatch.indexOf('state.loading = false;'));
  ok(!/Nh.?n Textile/.test(finCatch), 'le bloc catch ne contient aucun fournisseur fictif');
  ok(source.includes('const PASSEPORT_DEMONSTRATION'),
    'le jeu de demonstration est nomme et sorti du chemin d\'erreur');
  ok(/MODE_DEMONSTRATION\s*=\s*!urlParams\.get\('ref'\)/.test(source),
    'le mode demonstration est decide par l\'URL, pas par un echec');
} finally {
  await navigateur.close();
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Aucune entreprise inventee n\'est servie a la place d\'une autre.\n');
process.exit(echecs ? 1 : 0);
