#!/usr/bin/env node
/**
 * Verrou sur la coherence du jeu de demonstration.
 *
 * Pourquoi ce test existe
 * -----------------------
 * Le tableau de bord annoncait « 12 produits incomplets » au-dessus d'un
 * catalogue qui en montrait 1 246 a 0 % de completude. Trois causes :
 *
 *  1. les produits generes n'avaient aucun champ dataCompletion ;
 *  2. leur dataReadiness valait 'verified', absent de l'enum
 *     product_data_readiness — le libelle sortait brut, non traduit ;
 *  3. le registre de risque comparait a 'ready', valeur que rien ne produit,
 *     donc les 1 248 produits etaient signales.
 *
 * Pour une plateforme dont l'argument est « pouvez-vous faire confiance a vos
 * donnees ? », une demonstration qui se contredit detruit la demonstration.
 * C'est la premiere chose qu'un responsable conformite remarque.
 *
 *   npm run test:donnees-demo
 */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';

/* L'enum fait foi : prisma/schema.prisma, product_data_readiness. Un jeu de
 * demonstration qui produit une valeur hors enum fabrique des donnees que le
 * backend ne pourra jamais rendre. */
const SCHEMA = readFileSync('prisma/schema.prisma', 'utf8');
const ENUM_READINESS = (SCHEMA.match(/enum product_data_readiness \{([^}]+)\}/) || [, ''])[1]
  .split('\n').map((l) => l.trim()).filter(Boolean);

const SRC = readFileSync('assets/js/tf-demo-figures.js', 'utf8');
const CHIFFRES = JSON.parse(SRC.slice(SRC.indexOf('=') + 1).trim().replace(/;\s*$/, ''));

let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

const nav = await chromium.launch();
const page = await nav.newPage({ viewport: { width: 1280, height: 900 } });

const vue = async (v) => {
  await page.click(`button[data-view="${v}"]`);
  await page.waitForTimeout(300);
};

try {
  console.log(`\n  enum product_data_readiness : ${ENUM_READINESS.join(', ')}\n`);
  await page.goto(`${BASE}/brand-console/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[data-view]', { timeout: 20000 });

  // --- A. le catalogue porte de vraies completudes ---
  console.log('  A. completude du catalogue');
  await vue('products');
  const comp = await page.$$eval('tbody tr td:nth-child(4)',
    (c) => c.map((x) => Number(x.innerText.replace(/[^\d]/g, ''))));
  const zeros = comp.filter((v) => v === 0).length;
  ok(zeros === 0, `${zeros} produit(s) a 0 % sur les ${comp.length} de la page`);
  ok(new Set(comp).size > 5,
    `${new Set(comp).size} valeurs distinctes : la distribution n'est pas plate`);

  // --- B. la maturite respecte l'enum et se traduit ---
  console.log('\n  B. maturite des donnees');
  const libelles = await page.$$eval('tbody tr td:nth-child(5)',
    (c) => [...new Set(c.map((x) => x.innerText.trim()))]);
  // Un libelle non traduit ressort tel que la base le stocke : minuscules et
  // tirets bas. C'est exactement ce que faisait 'verified'.
  const bruts = libelles.filter((l) => /^[a-z][a-z_]*$/.test(l));
  ok(bruts.length === 0,
    bruts.length ? `libelle(s) non traduit(s) : ${bruts.join(', ')}`
      : `les ${libelles.length} libelles affiches sont traduits`);

  // On verifie aussi la valeur sous-jacente, pas seulement son rendu.
  const valeurs = await page.evaluate(() => {
    const vus = new Set();
    document.querySelectorAll('tbody tr td:nth-child(5) .status').forEach((e) => {
      const c = [...e.classList].find((x) => x.startsWith('status-'));
      if (c) vus.add(c.replace('status-', ''));
    });
    return [...vus];
  });
  const horsEnum = valeurs.filter((v) => !ENUM_READINESS.includes(v));
  ok(horsEnum.length === 0,
    horsEnum.length ? `valeur(s) hors enum : ${horsEnum.join(', ')}`
      : `valeurs conformes a l'enum : ${valeurs.join(', ')}`);

  // --- C. la pastille ne contredit pas le catalogue ---
  console.log('\n  C. accord tableau de bord / catalogue');
  await vue('overview');
  const pastilles = await page.$$eval('.mc-attention-num',
    (e) => e.map((x) => Number(x.textContent.replace(/[^\d]/g, ''))));
  ok(pastilles.length === 4, `${pastilles.length} pastilles ATTENTION`);
  const [manquantes, certs, fourn, incomplets] = pastilles;
  const at = CHIFFRES.attention;
  ok(manquantes === at.donneesManquantes && certs === at.certificatsExpirant
    && fourn === at.fournisseursARevoir,
    `les trois premieres suivent la source unique : ${manquantes} · ${certs} · ${fourn}`);
  ok(incomplets === at.produitsIncomplets,
    `produits incomplets affiches ${incomplets}, source unique ${at.produitsIncomplets}`);

  // --- D. la pastille mene a son correctif ---
  console.log('\n  D. de l\'indicateur a son correctif');
  await page.click('[data-tf-act="p19"]');
  await page.waitForTimeout(420);
  const apres = await page.evaluate(() => ({
    puce: !!document.querySelector('.filters-chip'),
    tr: document.querySelectorAll('tbody tr').length,
    comps: [...document.querySelectorAll('tbody tr td:nth-child(4)')]
      .map((e) => Number(e.innerText.replace(/[^\d]/g, ''))),
  }));
  ok(apres.puce, 'le catalogue indique visiblement qu\'il est filtre');
  ok(apres.tr === incomplets,
    `le catalogue filtre rend ${apres.tr} ligne(s) pour ${incomplets} annoncee(s)`);
  ok(apres.comps.length > 0 && apres.comps.every((c) => c < 70),
    `les ${apres.comps.length} lignes sont bien sous le seuil de 70 %`);

  // --- E. le registre de risque hierarchise ---
  console.log('\n  E. registre de risque');
  await vue('risk');
  const registre = await page.evaluate(() => {
    const el = document.querySelector('.pager-count strong:last-of-type');
    return el ? Number(el.textContent.replace(/[^\d]/g, ''))
      : document.querySelectorAll('tbody tr').length;
  });
  ok(registre === CHIFFRES.signauxOuverts,
    `${registre} signaux ouverts, source unique ${CHIFFRES.signauxOuverts}`);
  const catalogue = CHIFFRES.produits;
  ok(registre < catalogue / 10,
    `le registre couvre ${registre} / ${catalogue} produits : il hierarchise au lieu de tout lister`);
  // --- F. les nombres suivent reellement la source, ils ne la recopient pas ---
  //
  // Comparer l'affichage a la valeur canonique ne distingue pas un nombre
  // CALCULE d'un nombre ECRIT EN DUR a la meme valeur. On sert donc une
  // source modifiee : si l'affichage ne bouge pas, c'est qu'il est fige.
  console.log('\n  F. derivation reelle (source modifiee a la volee)');
  const page2 = await nav.newPage({ viewport: { width: 1280, height: 900 } });
  const INCOMPLETS_TEST = 7;
  const SIGNAUX_TEST = 23;
  await page2.route('**/tf-demo-figures.js*', async (route) => {
    const modifie = { ...CHIFFRES, signauxOuverts: SIGNAUX_TEST,
      attention: { ...CHIFFRES.attention, produitsIncomplets: INCOMPLETS_TEST } };
    await route.fulfill({ status: 200, contentType: 'application/javascript',
      body: `window.TF_DEMO_FIGURES = ${JSON.stringify(modifie)};` });
  });
  await page2.goto(`${BASE}/brand-console/`, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('button[data-view]', { timeout: 20000 });
  await page2.click('button[data-view="overview"]');
  await page2.waitForTimeout(340);
  const suivi = await page2.$$eval('.mc-attention-num',
    (e) => Number(e[3].textContent.replace(/[^\d]/g, '')));
  ok(suivi === INCOMPLETS_TEST,
    `source a ${INCOMPLETS_TEST} -> pastille affiche ${suivi} : le nombre est calcule, pas recopie`);

  await page2.click('button[data-view="risk"]');
  await page2.waitForTimeout(340);
  const reg2 = await page2.evaluate(() => {
    const el = document.querySelector('.pager-count strong:last-of-type');
    return el ? Number(el.textContent.replace(/[^\d]/g, ''))
      : document.querySelectorAll('tbody tr').length;
  });
  ok(reg2 === SIGNAUX_TEST,
    `source a ${SIGNAUX_TEST} -> registre rend ${reg2} signaux`);
  await page2.close();
} finally {
  await nav.close();
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Le jeu de demonstration ne se contredit plus.\n');
process.exit(echecs ? 1 : 0);
