#!/usr/bin/env node
/**
 * Batterie d'audit des phases 6 a 8 du cahier des charges TRACEFAB.
 *
 *   PHASE 6 — Supplier Portal   : portail fournisseur « dead-simple »
 *   PHASE 7 — Data Collection   : chaine Marque -> Donnee verifiee + 6 etats
 *   PHASE 8 — Evidence + Quality: centre de preuves et centre de qualite
 *
 * Ces trois phases ont ete livrees sans la validation imposee apres chaque
 * phase. Ce script mesure a posteriori ce que le cahier des charges exige
 * explicitement, puis la liste de controles imposee : responsive,
 * accessibilite, performance, routes, API. Aucun chiffre n'est ecrit en
 * dur cote attendu metier : tout est lu dans la page rendue.
 *
 *   node scripts/audit_phases_6_8.mjs --base http://127.0.0.1:3000
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Sans --base, indexOf renvoie -1 et l'index 0 pointe le binaire node :
// on ne consulte la forme « --base <url> » que si le drapeau existe.
const iBase = process.argv.indexOf('--base');
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1]
  || (iBase !== -1 ? process.argv[iBase + 1] : null)
  || 'http://127.0.0.1:3000';

const results = [];
let failed = 0;

function check(phase, label, ok, got, want) {
  results.push({ phase, label, ok: !!ok, got: String(got), want: String(want) });
  if (!ok) failed++;
}

/** Clique une vue de navigation laterale et rend la main une fois peinte. */
async function gotoView(page, view) {
  const done = await page.evaluate(async (v) => {
    const b = document.querySelector(`button[data-view="${v}"]`);
    if (!b) return false;
    b.click();
    await new Promise((r) => setTimeout(r, 700));
    return true;
  }, view);
  return done;
}

/** Texte rendu, normalise : innerText renvoie la casse transformee par CSS. */
async function texte(page) {
  return (await page.evaluate(() => document.body.innerText)).toLowerCase();
}

/** Controles imposes apres chaque phase, mesures sur une surface donnee. */
async function controlesImposes(page, phase, nom) {
  // --- responsive : 390 px, debordement horizontal et cibles tactiles
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  const r = await page.evaluate(() => {
    const d = document.documentElement;
    const petites = [...document.querySelectorAll('button, a[href], select, input, [role="button"]')]
      .filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && (b.height < 40 || b.width < 40);
      }).length;
    return { debord: d.scrollWidth - d.clientWidth, petites };
  });
  check(phase, `${nom} — pas de debordement a 390 px`, r.debord <= 1, r.debord + ' px', '<= 1 px');
  check(phase, `${nom} — cibles tactiles >= 40 px`, r.petites === 0, r.petites + ' trop petite(s)', '0');

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForTimeout(400);

  // --- fuites de gabarit : une phase livree sans relecture en laisse
  const fuite = await page.evaluate(() =>
    /\$\{|\bundefined\b|\bNaN\b|\[object Object\]/.test(document.body.innerText));
  check(phase, `${nom} — aucune fuite de gabarit rendue`, !fuite, fuite ? 'fuite detectee' : 'aucune', 'aucune');

  // --- accessibilite : jamais mesuree sur ces phases avant ce jour
  await page.addScriptTag({ content: AXE });
  const a11y = await page.evaluate(async () => {
    const res = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return res.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id + '(' + v.nodes.length + ')');
  });
  check(phase, `${nom} — 0 infraction WCAG serieuse`, a11y.length === 0,
    a11y.length ? a11y.join(' ') : '0', '0');
}

const browser = await chromium.launch();

/* ===================== PHASE 6 — Supplier Portal ===================== */
{
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const t0 = Date.now();
  const resp = await page.goto(BASE + '/supplier-portal/', { waitUntil: 'load' });
  const charge = Date.now() - t0;
  await page.waitForTimeout(1800);

  check('6', 'Route /supplier-portal/ servie', resp && resp.status() === 200,
    resp ? resp.status() : 'pas de reponse', '200');
  check('6', 'Performance — chargement sous 3 s', charge < 3000, charge + ' ms', '< 3000 ms');

  const vues = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('button[data-view]')]
      .map((e) => e.getAttribute('data-view')))]);
  check('6', 'Portail multi-vues', vues.length >= 12, vues.length + ' vues', '>= 12');

  // Le cahier des charges nomme la promesse faite au fournisseur.
  const txt = await texte(page);
  check('6', 'Promesse « Your data. Your profile. »', txt.includes('your data') && txt.includes('your profile'),
    txt.includes('your data') ? 'presente' : 'absente', 'presente');
  check('6', 'Promesse « reusable across your customers »', txt.includes('reusable across'),
    txt.includes('reusable across') ? 'presente' : 'absente', 'presente');

  // « dead-simple » se mesure : une barre de progression chiffree, pas un discours.
  const prog = await page.evaluate(() => {
    const barres = [...document.querySelectorAll('.progress, [class*="progress"], progress')];
    const pct = (document.body.innerText.match(/\b\d{1,3}\s?%/g) || []);
    return { barres: barres.length, pct: pct.slice(0, 4) };
  });
  check('6', 'Barre de progression de completion', prog.barres > 0, prog.barres + ' barre(s)', '>= 1');
  check('6', 'Taux de completion chiffre affiche', prog.pct.length > 0, prog.pct.join(' ') || 'aucun', '>= 1 pourcentage');

  // Les vues que le cahier des charges rattache au fournisseur.
  for (const v of ['passport', 'requests', 'dataPoints', 'documents', 'certifications']) {
    const ok = vues.includes(v);
    check('6', `Vue « ${v} » presente`, ok, ok ? 'presente' : 'absente', 'presente');
  }

  // Le passeport fournisseur reutilisable est le coeur de la promesse.
  if (vues.includes('passport')) {
    await gotoView(page, 'passport');
    const pt = await texte(page);
    check('6', 'Vue passeport : partage reutilisable', /passport|partage|share/.test(pt),
      /passport/.test(pt) ? 'rendue' : 'vide', 'rendue');
    await gotoView(page, 'overview');
  }

  await controlesImposes(page, '6', 'Portail');
  await page.close();
}

/* ===================== PHASE 7 — Data Collection ===================== */
{
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const t0 = Date.now();
  const resp = await page.goto(BASE + '/brand-console/', { waitUntil: 'load' });
  const charge = Date.now() - t0;
  await page.waitForTimeout(1900);

  check('7', 'Route /brand-console/ servie', resp && resp.status() === 200,
    resp ? resp.status() : 'pas de reponse', '200');
  check('7', 'Performance — chargement sous 3 s', charge < 3000, charge + ' ms', '< 3000 ms');

  const vues = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('button[data-view]')]
      .map((e) => e.getAttribute('data-view')))]);
  for (const v of ['requests', 'questionnaires', 'suppliers', 'products']) {
    const ok = vues.includes(v);
    check('7', `Vue « ${v} » presente`, ok, ok ? 'presente' : 'absente', 'presente');
  }

  // La chaine imposee : Marque -> Fournisseur -> Produit -> Donnee requise
  // -> Preuve -> Revue -> Donnee verifiee. On mesure la vue qui la porte.
  const ouvert = await gotoView(page, 'requests');
  check('7', 'Vue « Data Collection » atteignable', ouvert, ouvert ? 'ouverte' : 'injoignable', 'ouverte');
  await page.waitForTimeout(600);
  const txt = await texte(page);

  // Les six etats imposes. Mesures sur le texte reellement rendu, pas sur
  // le code source : une constante non affichee ne vaut pas un etat visible.
  const etats = { missing: 'Missing', requested: 'Requested', submitted: 'Submitted',
    'under review': 'Under Review', accepted: 'Accepted', rejected: 'Rejected' };
  const vus = Object.keys(etats).filter((e) => txt.includes(e));
  check('7', 'Les 6 etats de collecte rendus', vus.length === 6,
    vus.length + '/6 (' + vus.map((v) => etats[v]).join(', ') + ')', '6/6');

  // Un etat doit etre lisible sans couleur seule (daltonisme) : on verifie
  // qu'une pastille d'etat porte aussi du texte.
  const pastilles = await page.evaluate(() =>
    [...document.querySelectorAll('[class*="status"]')]
      .filter((e) => e.textContent.trim().length > 0).length);
  check('7', 'Etats lisibles hors couleur (texte)', pastilles > 0, pastilles + ' pastille(s) textuelle(s)', '>= 1');

  // La preuve est le maillon central de la chaine.
  check('7', 'Preuve citee dans la collecte', /evidence|preuve/.test(txt),
    /evidence|preuve/.test(txt) ? 'citee' : 'absente', 'citee');

  // L'API doit exposer la collecte, sinon l'ecran est une maquette.
  const api = fs.readFileSync('api/index.ts', 'utf8');
  for (const r of ['data-requests', 'data-points']) {
    const ok = api.includes(r);
    check('7', `API « ${r} » exposee`, ok, ok ? 'exposee' : 'absente', 'exposee');
  }

  await controlesImposes(page, '7', 'Collecte');
  await page.close();
}

/* ================== PHASE 8 — Evidence + Quality ==================== */
{
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(BASE + '/brand-console/', { waitUntil: 'load' });
  await page.waitForTimeout(1900);

  const vues = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('button[data-view]')]
      .map((e) => e.getAttribute('data-view')))]);
  for (const v of ['documents', 'certifications', 'quality']) {
    const ok = vues.includes(v);
    check('8', `Vue « ${v} » presente`, ok, ok ? 'presente' : 'absente', 'presente');
  }

  // --- Centre de preuves : chaque piece doit porter ses attributs.
  await gotoView(page, 'documents');
  await page.waitForTimeout(600);
  const tDoc = await texte(page);
  const attributs = ['source', 'date', 'issuer', 'status'].filter((a) => tDoc.includes(a));
  check('8', 'Preuves : attributs Source/Date/Issuer/Status', attributs.length >= 3,
    attributs.join(', ') || 'aucun', '>= 3 sur 4');

  // Le cahier des charges traite le centre de preuves comme un tout. Le
  // produit le repartit sur deux vues : Documents porte les pieces,
  // Certifications porte la veille d'expiration. On mesure donc la surface
  // de preuves entiere, pas la seule vue Documents.
  await gotoView(page, 'certifications');
  await page.waitForTimeout(600);
  const tCert = await texte(page);
  const expir = /expir/.test(tDoc) || /expir/.test(tCert);
  check('8', 'Preuves : expiration suivie', expir,
    expir ? (/expir/.test(tCert) ? 'suivie (vue Certifications)' : 'suivie (vue Documents)') : 'absente', 'suivie');

  // Le systeme visuel de confiance : jetons dedies, pas une palette libre.
  const confiance = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return ['missing', 'review', 'declared', 'documented', 'verified', 'certified']
      .filter((n) => s.getPropertyValue('--tf-trust-' + n).trim() !== '').length;
  });
  check('8', 'Echelle de confiance a 6 niveaux', confiance === 6, confiance + '/6 jetons', '6/6');

  // Les jetons d'encre dedies au texte : l'echelle sert aussi de libelle,
  // et un libelle doit tenir 4,5:1 la ou une pastille n'y est pas tenue.
  const encres = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return ['missing', 'review', 'declared', 'documented', 'verified', 'certified']
      .filter((n) => s.getPropertyValue('--tf-trust-' + n + '-ink').trim() !== '').length;
  });
  check('8', 'Variantes texte de l echelle de confiance', encres === 6, encres + '/6 jetons -ink', '6/6');

  // --- Centre de qualite : la question posee par le cahier des charges.
  await gotoView(page, 'quality');
  await page.waitForTimeout(700);
  const tQ = await texte(page);
  check('8', 'Question « Can you trust your data? »', tQ.includes('can you trust'),
    tQ.includes('can you trust') ? 'posee' : 'absente', 'posee');

  const dims = ['completeness', 'evidence coverage', 'verification rate', 'supplier quality', 'product quality']
    .filter((d) => tQ.includes(d));
  check('8', 'Les 5 dimensions de qualite', dims.length === 5, dims.length + '/5 (' + dims.join(', ') + ')', '5/5');

  const sev = ['critical', 'warning', 'review', 'resolved'].filter((s) => tQ.includes(s));
  check('8', 'Les 4 niveaux de severite', sev.length === 4, sev.length + '/4 (' + sev.join(', ') + ')', '4/4');

  // « every issue links to its fix » : une anomalie sans action est un constat.
  const actionnable = await page.evaluate(() => {
    const zone = document.querySelector('.view, main, #view') || document.body;
    return zone.querySelectorAll('button, a[href]').length;
  });
  check('8', 'Anomalies actionnables (commandes presentes)', actionnable > 0,
    actionnable + ' commande(s)', '>= 1');

  await controlesImposes(page, '8', 'Preuves/Qualite');
  await page.close();
}

/* --- Le Quality Center a sa propre surface : elle doit tenir seule. --- */
{
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const t0 = Date.now();
  const resp = await page.goto(BASE + '/quality-center/', { waitUntil: 'load' });
  const charge = Date.now() - t0;
  await page.waitForTimeout(1500);
  check('8', 'Route /quality-center/ servie', resp && resp.status() === 200,
    resp ? resp.status() : 'pas de reponse', '200');
  check('8', 'Quality Center — chargement sous 3 s', charge < 3000, charge + ' ms', '< 3000 ms');
  await controlesImposes(page, '8', 'Quality Center');
  await page.close();
}

await browser.close();

/* ------------------------------------------------------------------ */
const byPhase = {};
for (const r of results) (byPhase[r.phase] ||= []).push(r);
const titles = { 6: 'Supplier Portal', 7: 'Data Collection', 8: 'Evidence + Quality' };
for (const p of ['6', '7', '8']) {
  const rs = byPhase[p] || [];
  const okN = rs.filter((r) => r.ok).length;
  console.log(`\nPHASE ${p} — ${titles[p]}   ${okN}/${rs.length}`);
  for (const r of rs) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(46)} ${r.got}${r.ok ? '' : '   (attendu ' + r.want + ')'}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} controles valides`);
fs.mkdirSync('.visual/phases', { recursive: true });
fs.writeFileSync('.visual/phases/audit-6-8.json', JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
