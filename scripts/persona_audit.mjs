/* ==========================================================================
   TRACEFAB — Test d'acceptation par persona.

   Le cahier des charges fixe trois juges de paix :
     CEO / Fondateur       comprend la valeur en moins de 30 secondes
     Resp. Conformite      percoit la profondeur fonctionnelle
     Fournisseur           sait immediatement quoi faire

   Ce harnais mesure des indicateurs observables plutot que des impressions.
   Chaque critere affiche la valeur relevee ET le seuil, pour qu'un echec
   soit actionnable et non une opinion.

     node scripts/persona_audit.mjs --base http://127.0.0.1:3000
   ========================================================================== */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i > -1 ? process.argv[i + 1] : d;
};
const BASE = arg('--base', 'http://127.0.0.1:3000');
const OUT = arg('--out', '.visual/personas');
mkdirSync(OUT, { recursive: true });

const WPM = 220; // vitesse de lecture d'un dirigeant qui survole
const results = [];
const pad = (s, n) => String(s).padEnd(n);

function check(persona, label, ok, got, want) {
  results.push({ persona, label, ok, got, want });
  const mark = ok === true ? 'OK   ' : ok === null ? 'NOTE ' : 'ECHEC';
  console.log(`  ${mark} ${pad(label, 46)} ${pad(got, 30)} attendu: ${want}`);
}

/* Texte reellement visible dans le premier ecran, sans scroll. */
async function aboveFold(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const out = [];
    const walk = (el) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          const t = n.textContent.trim();
          if (!t) continue;
          const p = n.parentElement;
          if (!p) continue;
          const cs = getComputedStyle(p);
          if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
          const r = p.getBoundingClientRect();
          if (r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0 && r.height > 0) {
            out.push({ text: t, size: parseFloat(cs.fontSize), top: Math.round(r.top) });
          }
        } else if (n.nodeType === 1) walk(n);
      }
    };
    walk(document.body);
    return out;
  });
}

const browser = await chromium.launch();

/* ========================================================================
   PERSONA 1 — CEO / Fondateur : la valeur en moins de 30 secondes
   ======================================================================== */
console.log('\n=== PERSONA 1 — CEO / Fondateur (landing, 1440x900) ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('[data-i18n="hero.line1"]', { timeout: 10000 }).catch(() => {});
  const tHero = Date.now() - t0;
  await page.waitForTimeout(1500);

  const af = await aboveFold(page);
  const words = af.map((x) => x.text).join(' ').split(/\s+/).filter(Boolean).length;
  const readSec = Math.round((words / WPM) * 60);

  check('CEO', 'Titre affiche rapidement', tHero <= 3000, `${tHero} ms`, '<= 3000 ms');
  check('CEO', 'Lecture du premier ecran', readSec <= 30, `${readSec} s (${words} mots)`, '<= 30 s');

  // La promesse doit etre lisible sans scroll : label + 3 lignes + sous-titre + CTA
  const need = ['hero.label', 'hero.line1', 'hero.line2', 'hero.line3', 'hero.sub', 'hero.ctaPrimary'];
  const visible = await page.evaluate((keys) => {
    const vh = window.innerHeight;
    return keys.filter((k) => {
      const el = document.querySelector(`[data-i18n="${k}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top < vh && r.bottom > 0 && r.height > 0;
    });
  }, need);
  check('CEO', 'Promesse complete sans scroll', visible.length === need.length,
    `${visible.length}/${need.length}`, '6/6');

  // Le plus gros texte de l'ecran doit porter la promesse, pas un ornement
  const biggest = af.slice().sort((a, b) => b.size - a.size)[0];
  const heroWords = ['know', 'product', 'supply', 'prove', 'conhe', 'produto', 'cadeia'];
  const isPromise = biggest && heroWords.some((w) => biggest.text.toLowerCase().includes(w));
  check('CEO', 'Le plus gros texte porte la promesse', !!isPromise,
    `"${(biggest?.text || '').slice(0, 24)}" ${Math.round(biggest?.size || 0)}px`, 'le titre hero');

  // Deux CTA maximum au-dessus de la ligne de flottaison : au-dela, on hesite
  const ctas = await page.evaluate(() => {
    const vh = window.innerHeight;
    // Les boutons de l'en-tete (Sign in / Request a demo) sont de la
    // navigation permanente, pas des appels a l'action de la page : les
    // compter ferait echouer n'importe quel site correctement concu.
    return [...document.querySelectorAll('a.tf-btn, button.tf-btn')]
      .filter((e) => !e.closest('header, .tf-header, nav'))
      .filter((e) => { const r = e.getBoundingClientRect(); return r.top < vh && r.bottom > 0 && r.height > 0; })
      .map((e) => e.textContent.trim());
  });
  check('CEO', 'CTA de contenu, hors en-tete', ctas.length <= 2,
    `${ctas.length} : ${ctas.join(' / ').slice(0, 36)}`, '<= 2');

  // Les chiffres de demonstration doivent etre signales comme tels
  const demoFlag = await page.evaluate(() =>
    !!document.querySelector('[data-i18n="common.demoData"], [data-i18n="common.demoNote"]'));
  check('CEO', 'Chiffres signales comme demonstration', demoFlag, demoFlag ? 'present' : 'absent', 'present');

  await page.screenshot({ path: `${OUT}/ceo-landing-1440.png` });
  await ctx.close();
}

/* ========================================================================
   PERSONA 2 — Responsable Conformite : la profondeur fonctionnelle
   ======================================================================== */
console.log('\n=== PERSONA 2 — Responsable Conformite (brand console, 1440x900) ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/brand-console/', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Les 7 couches du cahier des charges doivent etre atteignables en 1 clic
  const LAYERS = {
    '01 Supply Chain': 'supplyChain',
    '02 Product Data': 'products',
    '03 Evidence': 'documents',
    '04 Data Quality': 'quality',
    '05 Traceability': 'supplyChain',
    '06 Intelligence': 'intelligence',
    '07 DPP': 'dpp',
  };
  const navKeys = await page.evaluate(() =>
    [...document.querySelectorAll('.nav button')].map((b) => b.getAttribute('data-view') || ''));
  const reachable = Object.entries(LAYERS).filter(([, v]) => navKeys.includes(v));
  check('Conformite', 'Les 7 couches atteignables en 1 clic', reachable.length === 7,
    `${reachable.length}/7`, '7/7');

  const missingLayers = Object.entries(LAYERS).filter(([, v]) => !navKeys.includes(v)).map(([k]) => k);
  if (missingLayers.length) check('Conformite', '  couches absentes', false, missingLayers.join(', '), '-');

  // Le cahier des charges impose une entree Risque
  check('Conformite', 'Vue Risque presente', navKeys.includes('risk'),
    navKeys.includes('risk') ? 'present' : 'absent', 'present (exige)');

  // Profondeur : chaque vue cle doit afficher du contenu reel, pas un ecran vide
  const depth = [];
  for (const view of ['supplyChain', 'documents', 'quality', 'dpp', 'certifications']) {
    const ok = await page.evaluate(async (v) => {
      const b = document.querySelector(`.nav button[data-view="${v}"]`);
      if (!b) return null;
      b.click();
      await new Promise((r) => setTimeout(r, 700));
      const main = document.querySelector('.content, main, .view') || document.body;
      const txt = main.innerText.replace(/\s+/g, ' ').trim();
      const rows = main.querySelectorAll('tr, .card, .mc-tile, li').length;
      // Un ecran qui invite explicitement a selectionner quelque chose est un
      // etat vide valide, pas une vue incomplete. On le distingue.
      const empty = /s[ée]lectionnez|choisir|choisissez|select a |aucun[e]? /i.test(txt) && txt.length < 800;
      return { chars: txt.length, rows, empty };
    }, view);
    if (ok) depth.push({ view, ...ok });
  }
  const shallow = depth.filter((d) => !d.empty && (d.chars < 400 || d.rows < 3));
  const empties = depth.filter((d) => d.empty);
  check('Conformite', 'Vues cles avec contenu substantiel', shallow.length === 0,
    shallow.length ? shallow.map((d) => d.view).join(', ') : `${depth.length - empties.length} vues OK`,
    '>= 400 car. et >= 3 blocs');
  for (const d of depth) {
    console.log(`         ${pad(d.view, 18)} ${pad(d.chars + ' car.', 12)} ${pad(d.rows + ' blocs', 10)}${d.empty ? 'etat vide' : ''}`);
  }
  if (empties.length) {
    // Pour une demonstration, atterrir sur un etat vide prive le visiteur de
    // la profondeur qu'on cherche justement a lui montrer.
    check('Conformite', 'Aucune vue cle en etat vide a l\'arrivee', false,
      empties.map((d) => d.view).join(', '), 'un element pre-selectionne');
  }

  check('Conformite', 'Aucune erreur JS pendant la navigation', errs.length === 0,
    `${errs.length}`, '0');

  await page.screenshot({ path: `${OUT}/compliance-console-1440.png` });
  await ctx.close();
}

/* ========================================================================
   PERSONA 3 — Fournisseur : savoir immediatement quoi faire
   ======================================================================== */
console.log('\n=== PERSONA 3 — Fournisseur (supplier portal, 1440x900 + 390x844) ===');
for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/supplier-portal/', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const af = await aboveFold(page);
  const words = af.map((x) => x.text).join(' ').split(/\s+/).filter(Boolean).length;
  const readSec = Math.round((words / WPM) * 60);
  // Le cahier des charges ne chiffre pas de duree pour le fournisseur : il
  // demande qu'il sache "immediatement quoi faire". Le volume de lecture est
  // un indicateur, pas un critere — on le publie sans en faire un echec.
  check('Fournisseur', `[${tag}] Volume du premier ecran`, null,
    `${readSec} s (${words} mots)`, 'indicatif');

  // Une progression chiffree doit etre visible sans scroll
  const prog = await page.evaluate(() => {
    const vh = window.innerHeight;
    const hit = [...document.querySelectorAll('*')].find((e) => {
      const r = e.getBoundingClientRect();
      if (!(r.top < vh && r.bottom > 0 && r.height > 0)) return false;
      // Le pourcentage est souvent accompagne d'un mot ("72% complete") :
      // on accepte tout petit element feuille qui porte un pourcentage.
      return e.children.length === 0 && /\d{1,3}\s?%/.test(e.textContent) && e.textContent.trim().length < 30;
    });
    return hit ? hit.textContent.trim() : null;
  });
  check('Fournisseur', `[${tag}] Progression visible sans scroll`, !!prog, prog || 'absente', 'un pourcentage');

  // Une action suivante dominante, pas une foret de boutons equivalents
  const actions = await page.evaluate(() => {
    const vh = window.innerHeight;
    // La navigation laterale n'est pas une "action suivante" : la comparer
    // au CTA principal n'a pas de sens.
    return [...document.querySelectorAll('button, a[href]')]
      .filter((e) => !e.closest('.sidebar, .nav, header'))
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.top < vh && r.bottom > 0 && r.height > 24 && r.width > 60 && e.innerText.trim();
      })
      .map((e) => ({ t: e.innerText.trim().slice(0, 28), a: Math.round(e.getBoundingClientRect().width * e.getBoundingClientRect().height) }))
      .sort((x, y) => y.a - x.a);
  });
  const top = actions[0];
  const second = actions[1];
  const dominant = top && second ? top.a >= second.a * 1.25 : !!top;
  check('Fournisseur', `[${tag}] Une action suivante dominante`, dominant,
    top ? `"${top.t}"${second ? ` vs "${second.t}"` : ''}` : 'aucune', 'la 1re >= 1,25x la 2e');

  await page.screenshot({ path: `${OUT}/supplier-portal-${tag}.png` });
  await ctx.close();
}

await browser.close();

/* ===================== Synthese ===================== */
console.log('\n' + '='.repeat(74));
const byPersona = {};
for (const r of results) {
  if (r.ok === null) continue;
  (byPersona[r.persona] ||= { ok: 0, ko: 0, fails: [] });
  if (r.ok) byPersona[r.persona].ok++;
  else { byPersona[r.persona].ko++; byPersona[r.persona].fails.push(r.label.trim()); }
}
let allPass = true;
for (const [p, s] of Object.entries(byPersona)) {
  const verdict = s.ko === 0 ? 'VALIDE' : 'A REPRENDRE';
  if (s.ko) allPass = false;
  console.log(`${pad(p, 14)} ${s.ok}/${s.ok + s.ko}  ${verdict}`);
  for (const f of s.fails) console.log(`                 - ${f}`);
}
console.log('='.repeat(74));
console.log(allPass
  ? 'Les trois personas passent.'
  : 'Au moins un persona est perdu : le cahier des charges impose une reprise UX.');

writeFileSync(`${OUT}/report.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
console.log(`\nRapport : ${OUT}/report.json`);
process.exit(allPass ? 0 : 1);
