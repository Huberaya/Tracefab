#!/usr/bin/env node
/**
 * Coherence des chiffres de demonstration entre les surfaces.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La meme metrique s'affichait avec deux valeurs selon la page : 92,4 % de
 * qualite des donnees sur l'accueil, 91,4 % dans la console. Pour une
 * plateforme dont l'argument est « pouvez-vous faire confiance a vos
 * donnees ? », c'est le defaut qui coute le plus cher : il se voit en
 * trente secondes et il discredite tout le reste.
 *
 * Aucun test ne pouvait l'attraper, parce que chaque surface etait verifiee
 * contre elle-meme. Une valeur fausse mais stable passait. Ce test est le
 * premier a lire les deux surfaces ensemble et a exiger qu'elles disent la
 * meme chose.
 *
 * CE QU'IL VERIFIE, ET DANS QUEL ORDRE
 *
 * 1. Le catalogue i18n, dans les sept langues. C'est la surface fragile :
 *    l'accueil n'affiche pas des nombres mais des chaines traduites a la
 *    main, sept fois. Rien n'empeche aujourd'hui d'y saisir 93,4 %. On
 *    compare donc des NOMBRES, pas des chaines — « 1.248 » en allemand vaut
 *    mille deux cent quarante-huit, « 92.4 » en anglais vaut quatre-vingt-
 *    douze virgule quatre, et le meme point y joue deux roles opposes.
 *
 * 2. L'accueil rendu, en anglais et en francais : le chemin catalogue ->
 *    compteur anime -> ecran.
 *
 * 3. La console rendue : elle, calcule ses chiffres a l'execution a partir
 *    de fixtures tirees au sort. C'est de la que venait la derive.
 *
 * POURQUOI IL ECHOUE QUAND IL NE TROUVE RIEN
 *
 * Un selecteur qui ne renvoie aucun noeud ferait passer ce test pour de
 * mauvaises raisons : zero ecart sur zero valeur. Chaque etape declare donc
 * ce qu'elle doit trouver et echoue si le compte n'y est pas.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';
let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

/* --- source unique -------------------------------------------------------- */
const brut = readFileSync(new URL('../assets/js/tf-demo-figures.js', import.meta.url), 'utf8');
const apres = brut.slice(brut.indexOf('=') + 1).trim().replace(/;\s*$/, '');
let CHIFFRES;
try {
  CHIFFRES = JSON.parse(apres);
} catch (e) {
  console.log(`  ECHEC tf-demo-figures.js n'est plus du JSON strict apres le « = » : ${e.message}`);
  process.exit(1);
}

/* --- catalogues ----------------------------------------------------------- */
const ctx = { window: {} };
vm.runInContext(readFileSync(new URL('../assets/i18n/en.js', import.meta.url), 'utf8'),
  vm.createContext(ctx));
const CATALOGUES = { en: ctx.window.TF_I18N_BUNDLES.en };
for (const l of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  CATALOGUES[l] = JSON.parse(readFileSync(new URL(`../assets/i18n/${l}.json`, import.meta.url), 'utf8'));
}

// Separateurs par langue. Les deduire de la chaine elle-meme serait une
// devinette : « 1.248 » est mille deux cent quarante-huit en allemand et un
// virgule deux quarante-huit en anglais. On les declare.
const SEPARATEURS = {
  en: { groupe: ',', decimal: '.' },
  fr: { groupe: ' ', decimal: ',' },
  de: { groupe: '.', decimal: ',' },
  it: { groupe: '.', decimal: ',' },
  es: { groupe: '.', decimal: ',' },
  nl: { groupe: '.', decimal: ',' },
  pt: { groupe: '.', decimal: ',' },
};

const enNombre = (texte, langue) => {
  const sep = SEPARATEURS[langue];
  let s = String(texte)
    .replace(/[\u00a0\u202f\u2009]/g, ' ')   // espaces insecables et fines
    .replace(/[%\s]/g, '');
  if (sep.groupe !== ' ') s = s.split(sep.groupe).join('');
  s = s.replace(sep.decimal, '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

// Compteurs de l'accueil : cle du catalogue -> metrique de reference.
// Les deux valeurs propres a l'accueil (elements de preuve, signaux ouverts)
// sont dans la source unique elles aussi, sinon elles ne seraient tenues
// par rien.
const COMPTEURS_ACCUEIL = {
  'core.stat1': 'produits',
  'core.stat2': 'sites',
  'core.stat3': 'qualite',
  'spine.layers.l1.value': 'sites',
  'spine.layers.l2.value': 'produits',
  'spine.layers.l3.value': 'elementsPreuve',
  'spine.layers.l4.value': 'qualite',
  'spine.layers.l5.value': 'tracables',
  'spine.layers.l6.value': 'signauxOuverts',
  'spine.layers.l7.value': 'dpp',
};

// Sous-indicateurs de la console, par leur libelle anglais.
const KPI_CONSOLE = {
  'Products catalogued': 'produits',
  'Tier 1–4 suppliers': 'fournisseurs',
  'Audited sites & facilities': 'sites',
  'Production countries': 'pays',
  'Overall data quality': 'qualite',
  'Evidence coverage': 'preuves',
  'Third-party verified data': 'verifies',
  'Fully traceable products': 'tracables',
  'Passports ready': 'dpp',
};

const lire = (objet, chemin) => chemin.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), objet);

/* --- 1. catalogue, sept langues ------------------------------------------- */
/* La regle n'est pas « les dix compteurs sont bons » mais « aucun nombre du
 * catalogue ne m'est inconnu ». La premiere version de ce test tenait une
 * liste de dix cles ecrite a la main ; le catalogue en contenait quarante-
 * huit. Les trente-huit autres — les noeuds du visuel heros, ou se lisent
 * « 86 fournisseurs » et « 92.4% » au survol — n'etaient tenus par rien.
 *
 * Une liste tenue a la main mesure ce qu'on a pense a y mettre. Une regle
 * d'exhaustivite mesure ce qui est la. */
const ATTENDU = new Map();
for (const [cle, metrique] of Object.entries(COMPTEURS_ACCUEIL)) ATTENDU.set(cle, CHIFFRES[metrique]);
for (const [noeud, lignes] of Object.entries(CHIFFRES.noeuds || {})) {
  for (const [ligne, valeur] of Object.entries(lignes)) ATTENDU.set(`core.nodes.${noeud}.${ligne}`, valeur);
}

// Un numero de section (« 01 », « 02 ») n'est pas un chiffre de demonstration.
const PAS_UN_CHIFFRE = /(^|\.)index$/;
const EST_NUMERIQUE = /^\s*\d[\d.,\s\u00a0\u202f]*\s*%?\s*$/;

console.log('\n1. Catalogue i18n — la valeur est saisie a la main, sept fois');
let cellules = 0;
const vusParCle = new Map();
for (const [langue, cat] of Object.entries(CATALOGUES)) {
  const ecarts = [];
  const parcourir = (noeud, chemin) => {
    for (const [k, v] of Object.entries(noeud)) {
      const cle = chemin ? `${chemin}.${k}` : k;
      if (v && typeof v === 'object') { parcourir(v, cle); continue; }
      if (typeof v !== 'string' || !EST_NUMERIQUE.test(v) || PAS_UN_CHIFFRE.test(cle)) continue;
      cellules += 1;
      vusParCle.set(cle, (vusParCle.get(cle) || 0) + 1);
      if (!ATTENDU.has(cle)) {
        ecarts.push(`${cle} « ${v} » : chiffre non declare dans tf-demo-figures.js`);
        continue;
      }
      const vu = enNombre(v, langue);
      const attendu = ATTENDU.get(cle);
      if (Number.isNaN(vu)) ecarts.push(`${cle} « ${v} » illisible`);
      else if (Math.abs(vu - attendu) > 1e-9) ecarts.push(`${cle} « ${v} » = ${vu}, attendu ${attendu}`);
    }
  };
  parcourir(cat, '');
  if (ecarts.length) ko(`${langue} : ${ecarts.length} ecart(s)\n         ${ecarts.join('\n         ')}`);
}
// Une cle qui disparait d'un catalogue ne doit pas passer pour « rien a verifier ».
const incomplets = [...ATTENDU.keys()].filter((c) => (vusParCle.get(c) || 0) !== Object.keys(CATALOGUES).length);
if (incomplets.length) {
  ko(`${incomplets.length} cle(s) declaree(s) absente(s) d'au moins un catalogue : ${incomplets.slice(0, 6).join(' · ')}`);
}
if (!echecs) ok(`${cellules} valeurs numeriques, ${ATTENDU.size} cles, 7 langues — toutes declarees et conformes`);

/* --- 2 et 3. surfaces rendues --------------------------------------------- */
const navigateur = await chromium.launch();

console.log('\n2. Accueil rendu — catalogue, compteur anime, ecran');
for (const langue of ['en', 'fr']) {
  const page = await navigateur.newPage();
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    if (langue !== 'en') {
      await page.evaluate((l) => window.TF_I18N && window.TF_I18N.setLanguage(l), langue);
      await page.waitForTimeout(1600);
    }
    const vus = await page.$$eval('[data-tf-count]', (es) => es.map((e) => ({
      cle: e.getAttribute('data-i18n') || '', texte: e.textContent.trim(),
    })));
    if (vus.length !== Object.keys(COMPTEURS_ACCUEIL).length) {
      ko(`accueil ${langue} : ${vus.length} compteur(s) rendus, ${Object.keys(COMPTEURS_ACCUEIL).length} attendus`);
    }
    const ecarts = [];
    for (const { cle, texte } of vus) {
      const metrique = COMPTEURS_ACCUEIL[cle];
      if (!metrique) { ecarts.push(`compteur inconnu « ${cle} »`); continue; }
      const vu = enNombre(texte, langue);
      if (Math.abs(vu - CHIFFRES[metrique]) > 1e-9) ecarts.push(`${cle} affiche « ${texte} » (${vu}), attendu ${CHIFFRES[metrique]}`);
    }
    if (ecarts.length) ko(`accueil ${langue} : ${ecarts.join(' · ')}`);
    else ok(`accueil ${langue} : ${vus.length} compteurs conformes`);
  } catch (e) {
    ko(`accueil ${langue} : ${String(e).slice(0, 90)}`);
  }
  await page.close();
}

console.log('\n3. Console rendue — elle calcule ses chiffres a l\'execution');
{
  const page = await navigateur.newPage();
  try {
    await page.goto(`${BASE}/brand-console/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1900);
    const vus = await page.$$eval('.mc-stat-subitem', (es) => es.map((e) => ({
      libelle: e.querySelector('span')?.textContent.trim() || '',
      valeur: e.querySelector('strong')?.textContent.trim() || '',
    })).filter((x) => x.libelle && x.valeur));
    if (!vus.length) ko('console : aucun sous-indicateur lu — selecteur .mc-stat-subitem a change');
    const trouves = new Set();
    const ecarts = [];
    for (const { libelle, valeur } of vus) {
      const metrique = KPI_CONSOLE[libelle];
      if (!metrique) continue;
      trouves.add(libelle);
      const vu = enNombre(valeur, 'en');
      if (Math.abs(vu - CHIFFRES[metrique]) > 1e-9) ecarts.push(`« ${libelle} » affiche ${valeur}, attendu ${CHIFFRES[metrique]}`);
    }
    const manquants = Object.keys(KPI_CONSOLE).filter((l) => !trouves.has(l));
    if (manquants.length) ko(`console : ${manquants.length} indicateur(s) introuvable(s) — libelle renomme ? [${manquants.join(' · ')}]`);
    if (ecarts.length) ko(`console : ${ecarts.join(' · ')}`);
    if (!manquants.length && !ecarts.length) ok(`console : ${trouves.size} indicateurs egaux a la source unique`);
  } catch (e) {
    ko(`console : ${String(e).slice(0, 90)}`);
  }
  await page.close();
}

await navigateur.close();

console.log(`\n${echecs ? `${echecs} incoherence(s)` : 'Toutes les surfaces affichent les memes chiffres.'}`);
process.exit(echecs ? 1 : 0);
