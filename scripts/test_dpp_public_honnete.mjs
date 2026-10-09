#!/usr/bin/env node
/**
 * Le passeport public ne doit jamais presenter une valeur de demonstration
 * comme une valeur reelle.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La page /dpp/ est servie en statique avec des valeurs de demonstration, puis
 * hydratee par /api/dpp/:gtin quand l'URL porte un identifiant. La regle etait :
 * « une valeur absente laisse la valeur affichee intacte ». Elle tenait tant
 * que l'API comblait systematiquement les trous.
 *
 * Elle ne tient plus. Depuis que le resolveur a cesse d'inventer (plus de
 * grade B par defaut, plus de « 100% Coton peigne », plus de 3,42 kg CO2e),
 * un produit reel mais incomplet renvoie des champs absents. L'ancienne regle
 * aurait alors laisse le chiffre de demonstration a l'ecran, banniere de
 * demonstration masquee et page declaree « live » : une valeur inventee
 * presentee comme la donnee du produit scanne.
 *
 * On sert donc a la page une reponse d'API controlee, et on verifie ce qui
 * reste affiche.
 *
 *   npm run test:dpp-public
 */

import { chromium } from 'playwright';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';
let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

const navigateur = await chromium.launch();
const page = await navigateur.newPage();

/** Sert une reponse d'API choisie, puis rend l'etat de la page. */
async function avecPasseport(dpp) {
  await page.route('**/api/dpp/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ dpp, links: {} }),
  }));
  await page.goto(`${BASE}/dpp/?gtin=3000000000001`, { waitUntil: 'networkidle' });
  return page.evaluate(() => {
    const racine = document.documentElement;
    const champs = [...document.querySelectorAll('[data-dpp-field]')].map((el) => ({
      champ: el.dataset.dppField,
      texte: (el.textContent || '').trim(),
      manquant: el.hasAttribute('data-dpp-missing'),
      demo: el.hasAttribute('data-tf-demo'),
    }));
    const banniere = document.getElementById('dpp-demo-banner');
    return {
      source: racine.getAttribute('data-dpp-source'),
      nbManquants: racine.getAttribute('data-dpp-missing-count'),
      banniereVisible: banniere ? !banniere.hidden : null,
      champs,
    };
  });
}

try {
  // --- reference : ce que la page statique affiche sans hydratation ---
  await page.goto(`${BASE}/dpp/`, { waitUntil: 'networkidle' });
  const statique = await page.evaluate(() =>
    [...document.querySelectorAll('[data-dpp-field]')]
      .map((el) => [el.dataset.dppField, (el.textContent || '').trim()]));
  const demoParChamp = Object.fromEntries(statique);
  ok(statique.length > 0, `la page statique expose ${statique.length} champs de demonstration`);

  // --- A. produit reel mais incomplet ---
  console.log('\n  A. produit publie dont la marque n\'a pas tout renseigne');
  const minimal = {
    productId: 'p-1', brandName: 'Marque Reelle', productName: 'Tee-shirt lin',
    productReference: 'REF-9', sku: 'REF-9-M', gtin: '3000000000001',
    materials: [], dppUrl: '/p/REF-9',
    // ni PEF, ni composition, ni pays, ni chaine : la marque ne les a pas saisis
  };
  const a = await avecPasseport(minimal);
  ok(a.source === 'live', `la page se declare « live » (${a.source})`);
  ok(a.banniereVisible === false, 'la banniere de demonstration est masquee');

  const renseignes = a.champs.filter((c) => !c.manquant);
  const absents = a.champs.filter((c) => c.manquant);
  ok(absents.length > 0, `${absents.length} rubriques sont signalees absentes`);
  ok(Number(a.nbManquants) === absents.length,
    `le compteur de rubriques absentes concorde (${a.nbManquants})`);

  const survivants = absents.filter((c) => {
    const demo = demoParChamp[c.champ];
    return demo && c.texte === demo && demo !== '—';
  });
  ok(survivants.length === 0,
    survivants.length
      ? `valeur de demonstration conservee sur une page live : ${survivants.slice(0, 3).map((c) => `${c.champ}="${c.texte}"`).join(', ')}`
      : 'aucune valeur de demonstration ne survit a l\'hydratation');
  ok(absents.every((c) => c.texte === '—'),
    'chaque rubrique absente affiche un tiret, pas un chiffre');
  ok(absents.every((c) => !c.demo),
    'les rubriques absentes ne sont plus marquees comme traduisibles');
  ok(renseignes.some((c) => c.texte === 'Tee-shirt lin'),
    'les rubriques reellement fournies sont bien affichees');

  // --- B. produit complet : rien ne doit etre barre ---
  console.log('\n  B. produit entierement renseigne');
  const complet = {
    ...minimal,
    countryOfManufacture: 'PT', countryOfDesign: 'FR', weightGrams: 185,
    certifiedComposition: '60% Lin, 40% Coton', pefScore: 71, pefGrade: 'C',
    carbonFootprintKgCo2e: 4.8, waterScarcityM3: 2.1, circularityScore: 64,
    supplyChainSummary: 'Filature (ES) ➔ Confection (PT)',
    verificationDate: '2026-03-04',
    materials: [{ name: 'Lin', percentage: 60 }],
  };
  const b = await avecPasseport(complet);
  ok(b.source === 'live', 'la page reste « live »');
  const manquantsB = b.champs.filter((c) => c.manquant);
  ok(manquantsB.length < absents.length,
    `moins de rubriques absentes qu'au cas incomplet (${manquantsB.length} < ${absents.length})`);
  ok(b.champs.some((c) => c.texte.includes('4.8')), 'l\'empreinte carbone reelle est affichee');
  const marque = b.champs.find((c) => c.champ === 'brandName');
  ok(marque && marque.texte === 'Marque Reelle',
    `la marque affichee est celle du produit, pas « Atelier Demo » (${marque ? marque.texte : 'absente'})`);
  const mono = await page.evaluate(() => {
    const el = document.querySelector('[data-dpp-initials]');
    return el ? (el.textContent || '').trim() : null;
  });
  ok(mono === 'MR', `le monogramme suit la marque reelle (${mono})`);

  // --- C. passeport inconnu : retour assume a la demonstration ---
  console.log('\n  C. passeport inconnu');
  await page.unroute('**/api/dpp/**');
  await page.route('**/api/dpp/**', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"product_passport_not_found"}',
  }));
  await page.goto(`${BASE}/dpp/?gtin=0000000000000`, { waitUntil: 'networkidle' });
  const c = await page.evaluate(() => ({
    source: document.documentElement.getAttribute('data-dpp-source'),
    banniere: (() => { const b = document.getElementById('dpp-demo-banner'); return b ? !b.hidden : null; })(),
  }));
  ok(c.source === 'demo', `la page retombe en mode demonstration (${c.source})`);
  ok(c.banniere === true, 'la banniere de demonstration est reaffichee');
} finally {
  await navigateur.close();
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Aucune valeur de demonstration n\'est presentee comme reelle.\n');
process.exit(echecs ? 1 : 0);
