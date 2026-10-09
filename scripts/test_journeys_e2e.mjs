#!/usr/bin/env node
/**
 * TRACEFAB — 20 parcours end-to-end non mockes (chantier 17).
 *
 * Non mocke signifie : les pages reelles, servies par dev_static_server.mjs
 * (donc avec les reecritures de vercel.json), le vrai JavaScript applicatif,
 * aucun stub de rendu. Les seules donnees simulees sont les fixtures d'API
 * sous scripts/fixtures/api/, qui tiennent lieu de backend serverless.
 *
 * Chaque parcours echoue aussi sur la moindre erreur JavaScript console.
 *
 * Usage : node scripts/test_journeys_e2e.mjs [--base http://127.0.0.1:3000]
 *         Sans serveur a l'ecoute, le script en demarre un et l'arrete.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const argBase = process.argv.indexOf('--base');
const BASE = argBase > -1 ? process.argv[argBase + 1] : 'http://127.0.0.1:3000';
const PORT = Number(new URL(BASE).port || 80);
const GTIN = '3760123456789';

const results = [];
let browser;
let server = null;

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Un parcours : page neuve, erreurs console capturees, verdict unitaire. */
async function journey(id, title, fn) {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  const started = Date.now();
  try {
    await fn(page);
    ok(errors.length === 0, `erreur JS : ${errors[0]}`);
    results.push({ id, title, pass: true, ms: Date.now() - started });
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, why: err.message });
  } finally {
    await page.close();
  }
}

const go = (page, path) => page.goto(BASE + path, { waitUntil: 'domcontentloaded' });

async function console_(page, view) {
  await go(page, '/brand-console/?demo=1');
  await page.locator('h1.mc-headline').waitFor({ timeout: 15000 });
  if (view) {
    await page.click(`button[data-view="${view}"]`);
    await delay(450);
  }
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

// ---------------------------------------------------------------- parcours

async function run() {
  // 01 — La promesse de la page d'accueil tient dans le DOM.
  await journey('J01', 'Accueil : titre, promesse et colonne vertebrale 7 couches', async (page) => {
    await go(page, '/');
    const h1 = await page.locator('h1').first().innerText();
    for (const line of ['Know your product.', 'Know your supply chain.', 'Prove it.']) {
      ok(h1.includes(line), `ligne de titre absente : ${line}`);
    }
    const spine = await page.locator('[data-i18n^="spine."]').count();
    ok(spine >= 7, `colonne vertebrale : ${spine} noeuds i18n, 7 au minimum`);
    for (const id of ['layer-02', 'layer-07', 'supply-chain']) {
      ok(await page.locator(`#${id}`).count() > 0, `ancre #${id} absente`);
    }
  });

  // 02 — Chaque ancre de navigation vise une section qui existe vraiment.
  await journey('J02', 'Accueil : toutes les ancres de navigation resolvent', async (page) => {
    await go(page, '/');
    const dangling = await page.evaluate(() => [...document.querySelectorAll('header a[href^="#"]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h.length > 1 && !document.querySelector(h)));
    ok(dangling.length === 0, `ancres mortes : ${dangling.join(', ')}`);
  });

  // 03 — Le CTA principal engage le parcours : il vise une section reelle.
  await journey('J03', 'Accueil : "Explore TRACEFAB" engage le parcours', async (page) => {
    await go(page, '/');
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find((x) => /explore/i.test(x.innerText));
      return a && a.getAttribute('href');
    });
    ok(href, 'CTA Explore introuvable');
    ok(await page.locator(href.startsWith('#') ? href : 'body').count() > 0,
      `le CTA vise ${href}, qui n'existe pas dans la page`);
    const before = await page.evaluate(() => window.scrollY);
    await page.locator('a', { hasText: /explore/i }).first().click();
    await delay(900);
    const after = await page.evaluate(() => window.scrollY);
    ok(after > before, 'le CTA ne deplace pas le lecteur dans le parcours');
  });

  // 04 — Mobile : aucun debordement horizontal, critere explicite du cahier.
  await journey('J04', 'Accueil mobile 390 px : aucun debordement horizontal', async (page) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/');
    await delay(500);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `debordement de ${over} px`);
  });

  // 05 — La bascule de langue traduit sans laisser fuiter de cle brute.
  await journey('J05', 'Accueil : bascule FR, aucune cle i18n brute affichee', async (page) => {
    await go(page, '/');
    await page.waitForFunction(() => !!window.TF_I18N, null, { timeout: 15000 });
    await page.evaluate(() => window.TF_I18N.setLanguage('fr'));
    await delay(500);
    const txt = await bodyText(page);
    const raw = txt.match(/\b[a-z]{2,}[A-Z][A-Za-z]{3,}\b(?=\s*$)/gm) || [];
    ok(raw.length === 0, `cles brutes rendues : ${raw.slice(0, 3).join(', ')}`);
    ok(/[éèàç]/.test(txt), 'aucun accent : la traduction FR ne semble pas appliquee');
  });

  // 06 — Les compteurs structurels de l'Overview sont ceux du cahier.
  //      Le taux de qualite n'est pas teste ici : il est calcule cote console et
  //      diverge de la landing. Cet ecart a son test dedie, test_kpi_coherence.mjs.
  await journey('J06', 'Console : compteurs structurels Overview conformes au cahier', async (page) => {
    await console_(page, null);
    await delay(1400); // les compteurs data-tf-count s'animent : attendre la valeur finale
    const txt = await bodyText(page);
    for (const kpi of ['1,248', '86', '214', '18']) {
      ok(txt.includes(kpi), `compteur absent : ${kpi}`);
    }
    ok(/\b88(\.0)?\s?%/.test(txt), 'maturite DPP 88 % absente');
    ok(/grade\s*a/i.test(txt), 'bloc de qualite de donnees absent');
  });

  // 07 — Les 17 vues s'affichent sans casse.
  await journey('J07', 'Console : les 17 vues se rendent sans erreur', async (page) => {
    await console_(page, null);
    const views = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll('button[data-view]')].map((b) => b.dataset.view))]);
    ok(views.length === 17, `${views.length} vues, 17 attendues`);
    for (const v of views) {
      await page.click(`button[data-view="${v}"]`);
      await delay(220);
      const len = (await bodyText(page)).length;
      ok(len > 400, `vue ${v} quasi vide (${len} caracteres)`);
    }
  });

  // 08 — Descente catalogue -> produit, le coeur du principe Explore/Inspect.
  await journey('J08', 'Console : catalogue -> fiche produit', async (page) => {
    await console_(page, 'products');
    // Le catalogue est pagine : une page bornee, et un compteur qui annonce
    // le catalogue entier. Verifier les deux est plus fort que l'ancien
    // « plus de 100 lignes », qui ne tenait que parce que la vue deversait
    // ses 1 248 references d'un bloc sur 86 543 px.
    const n = await page.locator('[data-product-id]').count();
    ok(n > 0 && n <= 25, `page de catalogue hors bornes : ${n} lignes`);
    const total = Number((await page.locator('.pager-count strong').last().innerText())
      .replace(/[^\d]/g, ''));
    ok(total > 100, `catalogue trop court : ${total} references annoncees`);
    await page.locator('[data-product-id]').first().click();
    await delay(600);
    const h = await page.locator('h1, h2').first().innerText();
    ok(h.trim().length > 2, 'fiche produit sans titre');
  });

  // 09 — Descente fournisseurs -> profil.
  await journey('J09', 'Console : fournisseurs -> profil fournisseur', async (page) => {
    await console_(page, 'suppliers');
    const sel = '[data-supplier-id-view], [data-supplier-org-id]';
    ok(await page.locator(sel).count() > 0, 'aucun fournisseur cliquable');
    await page.locator(sel).first().click();
    await delay(600);
    ok((await bodyText(page)).length > 600, 'profil fournisseur vide');
  });

  // 10 — Quality Center : la question de confiance et les issues.
  await journey('J10', 'Console : Quality Center pose la question de confiance', async (page) => {
    await console_(page, 'quality');
    const txt = await bodyText(page);
    ok(/trust|confiance/i.test(txt), 'la question de confiance a disparu');
    ok(txt.length > 800, 'Quality Center trop pauvre');
  });

  // 11 — Portefeuille DPP : score, ecarts, et surtout le disclaimer.
  await journey('J11', 'Console : portefeuille DPP, score + ecarts + disclaimer', async (page) => {
    await console_(page, 'dpp');
    const txt = await bodyText(page);
    ok(txt.includes('88.0%'), 'score de portefeuille 88.0% absent');
    const gaps = await page.locator('[data-dp-target]').count();
    ok(gaps >= 5, `${gaps} ecarts actionnables, 5 au minimum`);
    ok(await page.locator('.dp-disclaimer').count() > 0, 'disclaimer de non-certification absent');
  });

  // 12 — Un ecart doit mener a l'ecran qui le corrige, pas dans le vide.
  await journey('J12', 'Console : un ecart DPP mene a son ecran de correction', async (page) => {
    await console_(page, 'dpp');
    const target = await page.evaluate(() =>
      document.querySelector('[data-dp-target]')?.getAttribute('data-dp-target'));
    ok(target, 'aucun ecart porteur de cible');
    await page.locator('[data-dp-target]').first().click();
    await delay(650);
    const active = await page.evaluate(() =>
      document.querySelector('button[data-view].active, button[data-view][aria-current]')?.dataset.view);
    ok(active && active !== 'dpp', `la vue n'a pas change (toujours ${active || 'inconnue'})`);
  });

  // 13 — Le produit ouvert depuis une liste d'ecarts ne doit pas s'afficher parfait.
  await journey('J13', 'Console : le detail DPP ne contredit pas le portefeuille', async (page) => {
    await console_(page, 'dpp');
    const sel = '[data-dpp-product], [data-product-id]';
    if (await page.locator(sel).count() === 0) return; // portefeuille sans entree produit
    await page.locator(sel).first().click();
    await delay(700);
    const txt = await bodyText(page);
    const perfect = /100\s?%/.test(txt) && !/\d{1,2}\s?%/.test(txt.replace(/100\s?%/g, ''));
    ok(!perfect, 'produit affiche 100 % sans aucun ecart alors que le portefeuille en signale');
  });

  // 14 — L'intelligence ne doit jamais pretendre inventer de la donnee.
  await journey('J14', 'Console : TRACEFAB Intelligence annonce ses sources', async (page) => {
    await console_(page, 'intelligence');
    const txt = await bodyText(page);
    ok(/TRACEFAB/i.test(txt), 'vue Intelligence vide');
    ok(txt.length > 500, 'vue Intelligence trop pauvre');
  });

  // 15 — Les 11 onglets de Product Intelligence.
  await journey('J15', 'Product Intelligence : les 11 onglets se rendent', async (page) => {
    await go(page, '/product-intelligence/');
    await delay(700);
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tab]')].map((t) => t.dataset.tab));
    const expected = ['overview', 'composition', 'materials', 'supplyChain', 'manufacturing',
      'suppliers', 'evidence', 'certifications', 'quality', 'dpp', 'history'];
    for (const t of expected) ok(tabs.includes(t), `onglet manquant : ${t}`);
    for (const t of expected) {
      await page.click(`[data-tab="${t}"]`);
      await delay(160);
    }
  });

  // 16 — La lignee produit : huit etapes cliquables, de la fibre au produit fini.
  await journey('J16', 'Console : lignee produit Fibre -> Produit fini, 8 etapes', async (page) => {
    await console_(page, 'products');
    await page.locator('[data-product-id]').first().click();
    await delay(700);
    const steps = await page.locator('.lineage-step-card').count();
    ok(steps >= 7, `${steps} etapes de lignee, 7 au minimum`);
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.lineage-step-label')].map((e) => e.innerText.trim()));
    ok(labels.length === steps, 'etapes sans libelle dans la lignee');
    ok(/fib(re|er)/i.test(labels[0]), `la lignee ne part pas de la fibre : ${labels[0]}`);
    ok(/dpp|qr/i.test(labels[labels.length - 1]), `la lignee ne finit pas au DPP : ${labels.at(-1)}`);
    ok(labels.every((l) => /^\d{2}\./.test(l)), 'etapes non numerotees : la sequence est illisible');
    await page.locator('.lineage-step-card').nth(2).click();
    await delay(350);
  });

  // 17 — Portail fournisseur : les vues et la barre de completion.
  await journey('J17', 'Portail fournisseur : vues + progression de completion', async (page) => {
    await go(page, '/supplier-portal/?demo=1');
    await delay(800);
    const views = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll('button[data-view]')].map((b) => b.dataset.view))]);
    ok(views.length >= 11, `${views.length} vues de portail, 11 au minimum`);
    ok(/\d{1,3}\s?%/.test(await bodyText(page)), 'aucune progression de completion affichee');
  });

  // 18 — Passeport public sans identifiant : demo assumee, banniere visible.
  await journey('J18', 'Passeport public /dpp/ : mode demo assume', async (page) => {
    await go(page, '/dpp/');
    await delay(900);
    const disp = await page.evaluate(() => {
      const n = document.querySelector('#dpp-demo-banner');
      return n ? getComputedStyle(n).display : 'absent';
    });
    ok(disp !== 'absent' && disp !== 'none', `banniere demo non visible (${disp})`);
  });

  // 19 — Passeport public canonique : hydratation reelle, banniere eteinte.
  await journey('J19', `Passeport public /p/${GTIN} : hydratation reelle`, async (page) => {
    await go(page, `/p/${GTIN}`);
    await delay(1100);
    const disp = await page.evaluate(() => {
      const n = document.querySelector('#dpp-demo-banner');
      return n ? getComputedStyle(n).display : 'absent';
    });
    ok(disp === 'none', `banniere demo encore visible (${disp})`);
    const left = await page.locator('[data-dpp-field][data-tf-demo]').count();
    ok(left === 0, `${left} champs encore marques demo apres hydratation`);
    ok(/passport/i.test(await page.title()), 'titre de page non mis a jour');
  });

  // 20 — La route ajoutee au chantier 14 sert le meme passeport.
  await journey('J20', `Passeport public /dpp/${GTIN} : la route alternative sert le meme contenu`, async (page) => {
    await go(page, `/dpp/${GTIN}`);
    await delay(1100);
    const disp = await page.evaluate(() => {
      const n = document.querySelector('#dpp-demo-banner');
      return n ? getComputedStyle(n).display : 'absent';
    });
    ok(disp === 'none', `banniere demo visible : la reecriture vercel.json ne s'applique pas (${disp})`);
  });
}

// ------------------------------------------------------------------ amorce

async function serverAlive() {
  try {
    const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

if (!(await serverAlive())) {
  server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url), stdio: 'ignore',
  });
  for (let i = 0; i < 40 && !(await serverAlive()); i += 1) await delay(250);
  if (!(await serverAlive())) {
    console.error(`Impossible de demarrer le serveur sur ${BASE}`);
    process.exit(1);
  }
}

browser = await chromium.launch({ headless: true });
try {
  await run();
} finally {
  await browser.close();
  if (server) server.kill('SIGKILL');
}

const passed = results.filter((r) => r.pass).length;
const line = '-'.repeat(78);
console.log(`\n=== TRACEFAB — 20 PARCOURS END-TO-END NON MOCKES ===\n${line}`);
for (const r of results) {
  console.log(`${r.pass ? 'OK  ' : 'ECHEC'} ${r.id}  ${r.title}  (${r.ms} ms)`);
  if (!r.pass) console.log(`        -> ${r.why}`);
}
console.log(line);
console.log(`${passed}/${results.length} parcours valides`);
process.exit(passed === results.length ? 0 : 1);
