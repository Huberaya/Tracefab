#!/usr/bin/env node
/**
 * Verrou sur la recherche et le filtrage du catalogue produits.
 *
 * Pourquoi ce test existe
 * -----------------------
 * Paginer le catalogue l'a rendu lisible, pas trouvable : parcourir 50 pages
 * pour atteindre une reference n'est pas une recherche. Le filtrage comble ce
 * manque, mais il introduit trois pieges classiques, tous verifies ici :
 *
 *  1. le re-rendu vole le focus du champ de saisie, et la recherche au fil de
 *     la frappe devient inutilisable des le deuxieme caractere ;
 *  2. filtrer sans ramener a la page 1 laisse l'utilisateur sur une page qui
 *     n'existe plus, donc sur un tableau vide ;
 *  3. les facettes ecrites en dur se desynchronisent des donnees en silence.
 *
 *   npm run test:catalogue
 */

import { chromium } from 'playwright';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';

let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

const nav = await chromium.launch();
const page = await nav.newPage({ viewport: { width: 1280, height: 900 } });

const total = () => page.evaluate(() => {
  const el = document.querySelector('.pager-count strong:last-of-type');
  return el ? Number(el.textContent.replace(/[^\d]/g, ''))
    : document.querySelectorAll('tbody tr').length;
});
const lignes = () => page.locator('tbody tr').count();
const facette = (i) => page.locator('.filters--catalogue select').nth(i);
const saisir = async (v) => { await page.fill('#pd-recherche', v); await page.waitForTimeout(260); };
const vider = async () => {
  const b = page.locator('[data-tf-act="fx"]').first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(260); }
};

try {
  await page.goto(`${BASE}/brand-console/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[data-view]', { timeout: 20000 });
  await page.click('button[data-view="products"]');
  await page.waitForTimeout(260);

  const catalogue = await total();
  console.log(`\n  catalogue de depart : ${catalogue} reference(s)\n`);
  ok(catalogue > 100, 'le catalogue de demonstration est assez grand pour que filtrer ait un sens');

  // --- A. recherche texte ---
  console.log('  A. recherche');
  const premier = await page.locator('tbody tr strong').first().innerText();
  await saisir(premier);
  const parNom = await total();
  ok(parNom > 0 && parNom < catalogue, `par nom « ${premier} » : ${parNom} resultat(s)`);

  const ref = (await page.locator('tbody tr .meta').first().innerText()).split('·')[0].trim();
  await saisir(ref);
  ok(await lignes() >= 1, `par reference « ${ref} » : ${await lignes()} ligne(s)`);

  // --- B. insensibilite casse et accents ---
  console.log('\n  B. normalisation');
  await saisir(premier.toUpperCase());
  const maj = await total();
  await saisir(premier.toLowerCase());
  const min = await total();
  ok(maj === parNom && min === parNom,
    `casse indifferente : ${maj} en majuscules, ${min} en minuscules, ${parNom} tel quel`);
  // Une recherche accentuee ne doit pas tomber en panne meme si le catalogue
  // de demonstration est en anglais : on verifie qu'elle repond sans erreur.
  await saisir('réf');
  ok(typeof (await total()) === 'number', 'une saisie accentuee ne casse pas la recherche');
  await saisir('');

  // --- C. facettes construites sur les donnees ---
  console.log('\n  C. facettes');
  const nbFacettes = await page.locator('.filters--catalogue select').count();
  ok(nbFacettes === 3, `${nbFacettes} facette(s) proposee(s)`);

  const options = await facette(0).locator('option').allInnerTexts();
  const categoriesVues = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('tbody tr td:nth-child(2)')]
      .map((t) => t.innerText.trim()))]);
  const manquantes = categoriesVues.filter((c) => c && !options.some((o) => o.trim() === c));
  ok(manquantes.length === 0,
    manquantes.length ? `categories absentes de la facette : ${manquantes.join(', ')}`
      : `les categories affichees figurent toutes dans la facette (${options.length - 1} valeurs)`);

  const cible = options[1].trim();
  await facette(0).selectOption({ label: cible });
  await page.waitForTimeout(280);
  const parCat = await total();
  const toutesCibles = await page.evaluate((c) =>
    [...document.querySelectorAll('tbody tr td:nth-child(2)')].every((t) => t.innerText.trim() === c), cible);
  ok(toutesCibles && parCat > 0, `facette « ${cible} » : ${parCat} produit(s), tous conformes`);

  // Cumul : une facette ET un texte, jamais un OU. On choisit volontairement
  // un terme present DANS la categorie filtree — sinon l'assertion « le
  // resultat est plus petit » serait vraie meme si le cumul renvoyait
  // toujours zero, et le test ne prouverait rien.
  const dansCat = await page.locator('tbody tr strong').first().innerText();
  await saisir(dansCat);
  const croise = await total();
  const resteConforme = await page.evaluate((c) =>
    [...document.querySelectorAll('tbody tr td:nth-child(2)')].every((t) => t.innerText.trim() === c), cible);
  ok(croise >= 1 && croise <= parCat && resteConforme,
    `cumul « ${cible} » + « ${dansCat} » : ${croise} resultat(s), intersection non vide et conforme`);
  // Et l'inverse : un texte absent de la categorie doit donner zero.
  await saisir('zzz-absent-de-cette-categorie');
  ok(await page.locator('tbody tr').count() === 0,
    'un texte absent de la categorie filtree donne zero — le ET est bien un ET');
  await vider();
  ok(await total() === catalogue, `« effacer » restaure les ${catalogue} references`);

  // --- D. le filtrage ramene a la premiere page ---
  //
  // Piege de redaction : si l'on filtre jusqu'a ne garder qu'une seule page,
  // le bornage de la pagination ramene deja a la page 1, et le test passe
  // meme si la remise a zero a disparu. Il faut donc un filtre qui laisse
  // PLUSIEURS pages, pour que seule la remise a zero puisse expliquer le
  // retour en page 1.
  console.log('\n  D. interaction avec la pagination');
  await vider();
  await page.locator('.pager-num').nth(2).click();
  await page.waitForTimeout(280);
  const avant = (await page.locator('.pager-num.is-current').innerText()).trim();
  ok(avant === '3', `place en page ${avant}`);

  await facette(0).selectOption({ label: cible });
  await page.waitForTimeout(300);
  const apres = await page.evaluate(() => ({
    page: document.querySelector('.pager-num.is-current')?.textContent.trim() || '1',
    pages: document.querySelectorAll('.pager-num').length,
    dernier: [...document.querySelectorAll('.pager-num')].pop()?.textContent.trim(),
    tr: document.querySelectorAll('tbody tr').length,
  }));
  ok(Number(apres.dernier) >= 3,
    `le resultat filtre compte ${apres.dernier} pages : rester en page 3 serait possible`);
  ok(apres.page === '1', `filtrer depuis la page ${avant} ramene page ${apres.page}`);
  ok(apres.tr > 0, `le tableau rend ${apres.tr} ligne(s), pas une page vide`);
  await vider();

  // Meme verification pour l'autre chemin : la saisie texte. Les deux
  // gestionnaires remettent la page a zero separement, donc ils peuvent
  // regresser separement.
  await page.locator('.pager-num').nth(2).click();
  await page.waitForTimeout(280);
  const avantTexte = (await page.locator('.pager-num.is-current').innerText()).trim();
  await saisir(cible);
  const apresTexte = await page.evaluate(() => ({
    page: document.querySelector('.pager-num.is-current')?.textContent.trim() || '1',
    dernier: [...document.querySelectorAll('.pager-num')].pop()?.textContent.trim(),
  }));
  ok(Number(apresTexte.dernier) >= 3,
    `la recherche « ${cible} » laisse ${apresTexte.dernier} pages : rester en page 3 serait possible`);
  ok(apresTexte.page === '1',
    `rechercher depuis la page ${avantTexte} ramene page ${apresTexte.page}`);
  await vider();

  // --- E. aucun resultat ---
  console.log('\n  E. aucun resultat');
  await saisir('zzz-aucune-reference-ne-porte-ce-texte');
  const rien = await page.evaluate(() => ({
    vide: !!document.querySelector('.empty'),
    tr: document.querySelectorAll('tbody tr').length,
    bouton: !!document.querySelector('.empty [data-tf-act="fx"]'),
  }));
  ok(rien.vide && rien.tr === 0, 'un etat vide dedie remplace le tableau');
  ok(rien.bouton, 'cet etat propose lui-meme d\'effacer les filtres');
  await page.click('.empty [data-tf-act="fx"]');
  await page.waitForTimeout(280);
  ok(await total() === catalogue, 'le bouton de l\'etat vide restaure le catalogue');

  // --- F. focus et curseur pendant la frappe ---
  console.log('\n  F. saisie au fil de la frappe');
  await page.click('#pd-recherche');
  await page.type('#pd-recherche', 'cott', { delay: 60 });
  await page.waitForTimeout(260);
  const frappe = await page.evaluate(() => ({
    id: document.activeElement?.id,
    v: document.getElementById('pd-recherche')?.value,
    c: document.getElementById('pd-recherche')?.selectionStart,
  }));
  ok(frappe.id === 'pd-recherche', `le focus reste dans le champ (${frappe.id || 'perdu'})`);
  ok(frappe.v === 'cott', `les 4 caracteres sont tous arrives : « ${frappe.v} »`);
  ok(frappe.c === 4, `curseur en fin de saisie (${frappe.c})`);

  // Edition au milieu : le curseur ne doit pas sauter a la fin.
  await page.evaluate(() => {
    const i = document.getElementById('pd-recherche');
    i.focus(); i.setSelectionRange(2, 2);
  });
  await page.keyboard.type('X');
  await page.waitForTimeout(260);
  const milieu = await page.evaluate(() => ({
    v: document.getElementById('pd-recherche')?.value,
    c: document.getElementById('pd-recherche')?.selectionStart,
  }));
  ok(milieu.v === 'coXtt' && milieu.c === 3,
    `edition en milieu de chaine : « ${milieu.v} », curseur ${milieu.c}`);
  await saisir('');

  // --- G. libelles traduits ---
  console.log('\n  G. i18n');
  await page.selectOption('select[data-tf-act="p01"]', 'fr');
  await page.waitForTimeout(450);
  const fr = await page.evaluate(() => ({
    ph: document.getElementById('pd-recherche')?.placeholder || '',
    aria: document.getElementById('pd-recherche')?.getAttribute('aria-label') || '',
    opt: document.querySelector('.filters--catalogue select option')?.textContent || '',
  }));
  ok(/[Nn]om|[Rr]éférence/.test(fr.ph), `placeholder traduit : « ${fr.ph} »`);
  ok(fr.aria.length > 3 && !/^pd[A-Z]/.test(fr.aria), `aria-label traduit : « ${fr.aria} »`);
  ok(/[Tt]outes/.test(fr.opt), `option « tout » traduite : « ${fr.opt} »`);
  await page.selectOption('select[data-tf-act="p01"]', 'en');
  await page.waitForTimeout(400);

  // --- H. etroit ---
  console.log('\n  H. etroit (390 x 844)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(320);
  const etroit = await page.evaluate(() => {
    const champs = [...document.querySelectorAll('.filters--catalogue .input, .filters--catalogue .select')];
    const barre = document.querySelector('.filters--catalogue');
    return {
      petits: champs.filter((e) => e.getBoundingClientRect().height < 40).length,
      debord: barre ? Math.round(barre.scrollWidth - barre.clientWidth) : 0,
      nb: champs.length,
    };
  });
  ok(etroit.petits === 0, `${etroit.petits} champ sous 40 px de haut sur ${etroit.nb}`);
  ok(etroit.debord <= 0, `debordement horizontal de la barre : ${etroit.debord} px`);
} finally {
  await nav.close();
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Catalogue : recherche, facettes, bornes et saisie verifiees.\n');
process.exit(echecs ? 1 : 0);
