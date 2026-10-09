#!/usr/bin/env node
/**
 * Verrou sur la pagination des tables de la console.
 *
 * Pourquoi ce test existe
 * -----------------------
 * La vue catalogue rendait ses 1 248 lignes d'un seul bloc : 86 543 px de
 * haut, soit 96 ecrans. Le registre de risque faisait 88 789 px. Rien ne le
 * signalait : la page « fonctionnait », aucun test ne regardait sa taille, et
 * le defaut n'a ete vu qu'en essayant d'en prendre une capture — Chrome a
 * refuse. Un budget de hauteur non surveille derive toujours dans le meme
 * sens.
 *
 * Ce test mesure donc les vues DANS le navigateur, comme un utilisateur les
 * recoit. Les noms de vues ne sont pas ecrits en dur : ils sont enumeres a
 * l'execution, parce qu'ils sont generes par le script et qu'une liste figee
 * se desynchronise en silence.
 *
 *   npm run test:pagination
 */

import { chromium } from 'playwright';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';

/* Budget de hauteur. Une vue de console tient normalement en quelques
 * ecrans. 12 000 px laisse largement place aux tableaux de bord les plus
 * denses tout en attrapant l'ordre de grandeur qui pose probleme : au dela,
 * ce n'est plus une page, c'est un export. */
const BUDGET_PX = 12000;
const PAR_PAGE = 25;

let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

const nav = await chromium.launch();
const page = await nav.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(`${BASE}/brand-console/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[data-view]', { timeout: 20000 });

  const vues = await page.$$eval('button[data-view]',
    (b) => [...new Set(b.map((x) => x.dataset.view))]);
  console.log(`\n  ${vues.length} vue(s) de console enumeree(s) a l'execution\n`);

  // --- A. aucune vue ne depasse le budget de hauteur ---
  console.log('  A. budget de hauteur');
  const trop = [];
  const paginables = [];
  for (const vue of vues) {
    await page.click(`button[data-view="${vue}"]`);
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => ({
      h: Math.round(document.documentElement.scrollHeight),
      tr: document.querySelectorAll('tbody tr').length,
      pager: !!document.querySelector('.pager'),
      total: document.querySelector('.pager-count strong:last-of-type')?.textContent || '',
    }));
    if (m.h > BUDGET_PX) trop.push(`${vue} (${m.h} px)`);
    if (m.pager) paginables.push({ vue, ...m });
    if (m.tr > PAR_PAGE) {
      ok(false, `${vue} rend ${m.tr} lignes d'un bloc — la pagination ne s'applique pas`);
    }
  }
  ok(trop.length === 0,
    trop.length ? `vues au dela de ${BUDGET_PX} px : ${trop.join(' · ')}`
      : `les ${vues.length} vues tiennent sous ${BUDGET_PX} px`);

  // --- B. les listes longues sont bien paginees ---
  console.log('\n  B. listes longues paginees');
  ok(paginables.length >= 3,
    `${paginables.length} vue(s) portent une barre de pagination : `
    + paginables.map((x) => `${x.vue} (${x.total})`).join(' · '));

  // --- C. bornes de navigation sur la plus longue liste ---
  console.log('\n  C. bornes de navigation');
  const cible = 'products';
  await page.click(`button[data-view="${cible}"]`);
  await page.waitForTimeout(220);

  ok(await page.$eval('.pager-step', (e) => e.disabled),
    'page 1 : « precedent » est desactive');

  const totalTexte = await page.$eval('.pager-count strong:last-of-type', (e) => e.textContent);
  const total = Number(totalTexte.replace(/[^\d]/g, ''));
  const nbPages = Math.ceil(total / PAR_PAGE);

  await page.locator('.pager-num').last().click();
  await page.waitForTimeout(260);
  const fin = await page.evaluate(() => ({
    cur: document.querySelector('.pager-num.is-current')?.textContent.replace(/[^\d]/g, ''),
    tr: document.querySelectorAll('tbody tr').length,
    suivDesactive: [...document.querySelectorAll('.pager-step')].pop().disabled,
  }));
  ok(Number(fin.cur) === nbPages, `derniere page = ${fin.cur} / ${nbPages}`);
  // Le reste exact est le piege classique : une erreur de borne rend soit une
  // page vide, soit une page pleine qui repete les lignes precedentes.
  const reste = total - (nbPages - 1) * PAR_PAGE;
  ok(fin.tr === reste, `derniere page = ${fin.tr} ligne(s), reste attendu ${reste}`);
  ok(fin.suivDesactive, 'derniere page : « suivant » est desactive');

  // --- D. une page hors bornes est ramenee dans le domaine ---
  console.log('\n  D. demandes hors bornes');
  const demander = async (arg) => {
    await page.evaluate((a) => {
      const b = document.createElement('button');
      b.setAttribute('data-tf-act', 'pg');
      b.setAttribute('data-tf-arg', a);
      document.body.appendChild(b);
      b.click();
      b.remove();
    }, arg);
    await page.waitForTimeout(240);
    return page.evaluate(() => ({
      cur: document.querySelector('.pager-num.is-current')?.textContent.replace(/[^\d]/g, ''),
      tr: document.querySelectorAll('tbody tr').length,
    }));
  };
  const haut = await demander(`${cible}:99999`);
  ok(Number(haut.cur) === nbPages && haut.tr === reste,
    `page 99999 ramenee a ${haut.cur} avec ${haut.tr} ligne(s)`);
  const bas = await demander(`${cible}:-7`);
  ok(Number(bas.cur) === 1 && bas.tr === PAR_PAGE,
    `page -7 ramenee a ${bas.cur} avec ${bas.tr} ligne(s)`);
  const nan = await demander(`${cible}:abc`);
  ok(Number(nan.cur) === 1, 'page non numerique ramenee a 1, jamais de table vide');

  // --- E. etat de page independant par liste ---
  console.log('\n  E. etat par liste');
  await page.locator('.pager-num').last().click();
  await page.waitForTimeout(240);
  await page.click('button[data-view="risk"]');
  await page.waitForTimeout(240);
  const risque = await page.$eval('.pager-num.is-current', (e) => e.textContent.replace(/[^\d]/g, ''));
  ok(risque === '1', 'risk conserve sa propre page, sans heriter de products');
  await page.click(`button[data-view="${cible}"]`);
  await page.waitForTimeout(240);
  const retour = await page.$eval('.pager-num.is-current', (e) => e.textContent.replace(/[^\d]/g, ''));
  ok(Number(retour) === nbPages,
    `retour sur ${cible} : page ${retour} conservee — on ne perd pas sa lecture`);

  // --- F. cibles tactiles en etroit ---
  console.log('\n  F. etroit (390 x 844)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const etroit = await page.evaluate(() => {
    const visibles = [...document.querySelectorAll('.pager-num, .pager-step')]
      .filter((e) => e.offsetParent !== null);
    const barre = document.querySelector('.pager');
    return {
      petits: visibles.filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width < 40 || b.height < 40;
      }).length,
      debord: barre ? Math.round(barre.scrollWidth - barre.clientWidth) : 0,
      numeros: visibles.filter((e) => e.classList.contains('pager-num')).length,
    };
  });
  ok(etroit.petits === 0, `${etroit.petits} cible tactile sous 40 px`);
  ok(etroit.debord <= 0, `debordement horizontal de la barre : ${etroit.debord} px`);
  ok(etroit.numeros <= 2, `${etroit.numeros} numero(s) affiche(s) en etroit`);
} finally {
  await nav.close();
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Pagination verifiee dans le navigateur, bornes comprises.\n');
process.exit(echecs ? 1 : 0);
