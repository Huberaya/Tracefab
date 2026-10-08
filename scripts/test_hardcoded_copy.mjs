#!/usr/bin/env node
/**
 * Detection de copie metier non traduite.
 *
 * Remplace un controle qui s'intitulait « Aucune copie metier en dur hors
 * catalogue » mais n'assertait que `totalKeys > 1400`. Un catalogue volumineux
 * ne dit rien de ce qui reste en dur dans les pages : le controle promettait
 * beaucoup plus qu'il ne verifiait. Il a laisse passer quatre chaines
 * francaises affichees sur une page `lang="en"`.
 *
 * Principe : une chaine traduite CHANGE quand on bascule la langue. On releve
 * donc le texte visible en anglais, on passe en francais, on releve a nouveau,
 * et tout ce qui n'a pas bouge est suspect — sauf ce qui est invariant par
 * nature. Ces exceptions sont listees ci-dessous une par une, avec leur
 * raison : c'est la liste qu'un relecteur doit contester, pas le resultat.
 *
 * Usage : node scripts/test_hardcoded_copy.mjs [--base http://127.0.0.1:3000] [--list]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageSource } from './lib/page_source.mjs';

const argv = process.argv;
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:3000';
const LIST = argv.includes('--list');

const PAGES = ['/', '/brand-console/', '/supplier-portal/', '/quality-center/', '/operations/',
  '/passport/', '/dpp/', '/product-intelligence/', '/invitations/accept'];

/** Invariants legitimes. Chaque motif porte sa justification. */
const ALLOW = [
  // Marque et noms de surfaces : un nom de produit ne se traduit pas.
  [/tracefab/i, 'marque'],
  [/\b(brand console|supplier portal|supplier workspace|universal supplier passport)\b/i, 'nom de surface'],
  // Normes, reglements et formats : des identifiants, pas de la copie.
  [/\b(ESPR|AGEC|CSRD|GS1|OEKO-TEX|GOTS|GRS|SMETA|ISO|EPCIS|PEF|SHA-256|NDA|CSV|Excel|PDF|API)\b/, 'norme ou format'],
  [/\b(Apple|Google) Wallet\b/, 'nom de service tiers'],
  [/Control Union|Global Organic Textile Standard|Digital Link/i, 'organisme ou norme'],
  [/\bBatch:|Tier \d|Trade secret redacted/, 'valeur de demonstration'],
  [/\b(Paris|Porto|Braga|Milano|Lisboa|Guimar\u00e3es|Germany|Morocco|Tunisia|India|Vietnam|China|T\u00fcrkiye|Greece)\b|United States/, 'toponyme'],
  // La signature de marque est une identite graphique, pas une phrase.
  [/DATA \u00d7 TEXTILE \u00d7 TRUST/, 'marque'],
  [/\bCIRPASS\b|\bJSON-LD\b/, 'norme ou format'],
  // Le jeu de demonstration genere 1 248 produits, 86 fournisseurs et
  // 214 sites par composition « categorie + numero » ou « pays + metier +
  // numero ». Ces libelles sont de la donnee, pas de la copie : ils sont
  // deja en anglais (regle de triage) et n'ont pas a etre traduits.
  [/\b\d{2,4}\b\s*$/, 'ligne de demonstration numerotee'],
  [/^(AW|AT|SS)\d{2}-\d{3,4}\b/, 'reference de demonstration'],
];

// Certaines traductions sont legitimement identiques d'une langue a l'autre
// (« sites » se dit « sites »). La bascule de langue ne peut pas distinguer
// « non traduit » de « traduit a l'identique » : on tranche sur le catalogue.
// Tout mot qui est la valeur d'une cle dont EN et FR coincident est explique.
const ctx = { window: {} };
vm.runInContext(readFileSync(new URL('../assets/i18n/en.js', import.meta.url), 'utf8'),
  vm.createContext(ctx));
const EN = ctx.window.TF_I18N_BUNDLES.en;
const FR = JSON.parse(readFileSync(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8'));
const sameInBoth = new Set();
// Le catalogue est imbrique sur plusieurs niveaux : un parcours a profondeur
// fixe rate les valeurs profondes et les signale a tort comme non traduites.
const walkCatalogue = (en, fr) => {
  if (!en || typeof en !== 'object' || !fr || typeof fr !== 'object') return;
  for (const [k, v] of Object.entries(en)) {
    if (typeof v === 'string') {
      if (fr[k] === v) v.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean).forEach((w) => sameInBoth.add(w));
    } else walkCatalogue(v, fr[k]);
  }
};
walkCatalogue(EN, FR);

// --- Vocabulaire des jeux de demonstration -------------------------------
// Le chrome de ces pages est du texte dans un gabarit HTML ; la donnee de
// demonstration est une valeur de propriete dans un litteral d'objet. On
// derive donc les chaines de demo de la source plutot que de les enumerer
// a la main : une liste ecrite a la main enfle et finit par tout autoriser,
// alors qu'une derivation reste juste quand les fixtures changent.
const SOURCES = {
  '/': ['index.html', 'assets/js/tf-product.js'],
  '/brand-console/': ['brand-console/index.html'],
  '/supplier-portal/': ['supplier-portal/index.html'],
  '/quality-center/': ['quality-center/index.html'],
  '/operations/': ['operations/index.html'],
  '/passport/': ['passport/index.html'],
  '/dpp/': ['dpp/index.html'],
  '/product-intelligence/': ['product-intelligence/index.html', 'assets/js/tf-product.js'],
  '/invitations/accept': ['invitations/accept/index.html'],
};
const DATA_PROPS = 'name|label|title|description|desc|action|detail|issuer|category|summary|question|answer|text|site|facility|note|hint|reason|recommendation|displayName|display_name|originalFilename|dataKey|ruleKey|sku|reference|kind|statement|value|org|supplier|product|city|country|fullName|email|role|unit|step|stage|scope|message|severity|mill|workshop|lot|key|type';
const fixtureVocab = (url) => {
  const words = new Set();
  for (const rel of SOURCES[url] || []) {
    let src = '';
    // Le vocabulaire de demonstration est extrait de la source de la page.
    // Depuis le durcissement CSP, cette source est repartie entre le HTML et
    // /assets/js/ : lire le seul HTML ne trouverait plus aucune fixture, et
    // 85 valeurs de demonstration seraient signalees comme copie non traduite.
    try {
      src = rel.endsWith('.html') ? pageSource(rel) : readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    } catch { continue; }
    // On ancre sur « prop: "valeur" ». Un balayage naif des guillemets se
    // desynchronise sur les apostrophes de texte (facility's) et perd alors
    // de vrais litteraux : l'ancrage sur le nom de propriete y resiste.
    const add = (v) => {
      v = v.replace(/\\(.)/g, '$1').trim();
      if (v.length < 3 || !/[A-Za-zÀ-ÿ]{2}/.test(v) || /\$\{/.test(v)) return;
      words.add(v);
      // Si une cle machine est une fixture, son rendu humanise l'est aussi :
      // c'est la meme donnee, passee par fieldLabel().
      if (/^[a-z0-9]+([_-][a-z0-9]+)+$/.test(v)) {
        const h = v.replace(/[_-]/g, ' ');
        words.add(h);
        words.add(h.charAt(0).toUpperCase() + h.slice(1));
      }
    };
    const re = new RegExp(`\\b[A-Za-z]*(?:${DATA_PROPS})\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`, 'gi');
    let m;
    while ((m = re.exec(src))) add(m[2]);
    // Tableaux de chaines : ['Ana Silva', 'Rui Costa'] — meme nature de donnee.
    const arr = /\[\s*((?:'(?:\\.|[^'])*'\s*,?\s*){2,})\]/g;
    while ((m = arr.exec(src))) {
      const inner = /'((?:\\.|[^'])*)'/g; let q;
      while ((q = inner.exec(m[1]))) add(q[1]);
    }
  }
  return [...words].sort((a, b) => b.length - a.length);
};

// Une chaine est « de la donnee » si, une fois retirees toutes les valeurs de
// fixture qu'elle contient, il ne reste plus une seule lettre.
const isFixtureData = (s, vocab) => {
  // L'instantane tronque a 80 caracteres : une fixture plus longue arrive
  // amputee, on la reconnait donc aussi par prefixe.
  const t = s.trim();
  if (t.length >= 40 && vocab.some((v) => v.startsWith(t) || v.includes(t))) return true;
  let rest = s;
  for (const v of vocab) { if (rest.includes(v)) rest = rest.split(v).join(' '); }
  return !/[A-Za-zÀ-ÿ]{2}/.test(rest);
};

// Noms propres du jeu de demonstration qui contiennent des mots francais.
// Cette liste doit rester courte : si elle s'allonge, c'est que du chrome
// francais s'y faufile.
const FRENCH_PROPER_NOUNS = [
  /^Filature du Sud-Ouest$/, /^Maison Rivage$/, /^Atelier Milano$/, /^Atelier Demo$/,
  /^EcoDye Aquitaine$/,
];
// Grammaire francaise : des mots-outils qu'un nom propre isole ne porte pas.
const FRENCH_GRAMMAR = /\b(?:de la|de l'|du|des|les|une|votre|vos|cette|cet|avec|pour|sans|sous|selon|afin|ainsi|aucun|aucune|veuillez|disponible|indisponible|en cours|obligatoire|est|sont|être|avoir|nous|vous|leur|plus de|moins de)\b/i;
const looksFrench = (s) => {
  if (FRENCH_PROPER_NOUNS.some((re) => re.test(s))) return false;
  const hits = (s.match(new RegExp(FRENCH_GRAMMAR, 'gi')) || []).length;
  return hits >= 2 || (hits >= 1 && /[àâçéèêëîïôûùüÿœ]/i.test(s));
};

const explain = (s, vocab) => {
  const hit = ALLOW.find(([re]) => re.test(s));
  if (hit) return hit;
  // mots restants une fois retires chiffres et ponctuation
  const words = s.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter((w) => w && !/^\d+$/.test(w));
  if (words.length && words.every((w) => sameInBoth.has(w))) {
    return [null, 'traduction identique en FR (cle presente au catalogue)'];
  }
  if (vocab && isFixtureData(s, vocab)) return [null, 'contenu du jeu de demonstration'];
  return undefined;
};

const snapshot = (page) => page.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
    if (t.length < 4 || !/[A-Za-z]{3}/.test(t)) continue;
    const el = n.parentElement;
    // <code> balise explicitement un identifiant technique : ce n'est pas
    // de la copie traduisible, et l'afficher sert la tracabilite d'audit.
    // [data-tf-demo] marque une valeur du jeu de demonstration : la page la
    // declare comme illustration, elle n'a donc pas de cle de traduction.
    // Le marquage est pose sur la feuille, jamais sur une vue entiere, pour
    // que le chrome voisin reste controle.
    if (!el || el.closest('script,style,code,[data-tf-demo]')) continue;
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    out.push(t.slice(0, 80));
  }
  return out;
});

const browser = await chromium.launch();
let suspects = 0;
let scanned = 0;
const allowedHits = new Map();

const enumerateViews = (page) => page.evaluate(() =>
  [...new Set([...document.querySelectorAll('[data-view]')].map((b) => b.dataset.view))].filter(Boolean));

const showView = (page, view) => page.evaluate((v) => {
  const b = document.querySelector(`[data-view="${v}"]`);
  if (b) b.click();
}, view);

/* Vues de detail a visiter, par page.
 *
 * Une vue de detail s'ouvre en cliquant une ligne, pas un bouton de
 * navigation : elle n'apparait donc dans aucun [data-view] et echappait
 * entierement au balayage. C'est la que vivent la lignee produit, la fiche
 * fournisseur et leurs onglets — c'est-a-dire la partie la plus dense de
 * l'application.
 */
const DRILLDOWNS = {
  '/brand-console/': [
    { cle: 'produit', vue: 'products', ouvrir: 'button[data-product-id]', retour: 'products',
      onglets: ['overview', 'composition', 'materials', 'supplyChain', 'manufacturing',
                'suppliers', 'evidence', 'certifications', 'quality', 'dpp', 'history'] },
    { cle: 'fournisseur', vue: 'suppliers', ouvrir: '[data-supplier-id-view]', retour: 'suppliers' },
  ],
};

const enterDrilldown = async (page, drill) => {
  await page.evaluate((v) => document.querySelector(`[data-view="${v}"]`)?.click(), drill.vue);
  await page.waitForTimeout(400);
  const opened = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, drill.ouvrir);
  if (!opened) return false;
  await page.waitForTimeout(500);
  return true;
};

for (const url of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const perView = {};
  try {
    await page.goto(BASE + url, { waitUntil: 'load' });
    await page.waitForTimeout(1700);
    // Une SPA ne montre qu'une vue a la fois : ne mesurer que l'accueil
    // laisse passer tout le reste. On parcourt donc chaque vue atteignable,
    // dans les deux langues. (C'est l'angle mort qui avait laisse « Profil
    // Actif » et « exigences satisfaites » en francais sur une page EN.)
    const views = await enumerateViews(page);
    const targets = views.length ? views : [null];
    for (const lang of ['en', 'fr']) {
      const switched = await page.evaluate((l) =>
        (window.TF_I18N ? window.TF_I18N.setLanguage(l).then(() => true, () => false) : false), lang);
      if (!switched && lang === 'fr') {
        console.log(`  ECHEC ${url} : bascule de langue impossible`); suspects += 1; break;
      }
      await page.waitForTimeout(900);
      for (const v of targets) {
        if (v) { await showView(page, v); await page.waitForTimeout(260); }
        const key = v || '(accueil)';
        (perView[key] ||= {})[lang] = await snapshot(page);
      }
      // Les vues de detail ne portent pas de [data-view] : on y descend en
      // cliquant une ligne. C'etait l'angle mort suivant — sept libelles de
      // lignee sont restes en francais sur une page EN pendant quinze
      // chantiers parce que la garde ne passait jamais cette porte.
      for (const drill of DRILLDOWNS[url] || []) {
        const entered = await enterDrilldown(page, drill);
        if (!entered) continue;
        (perView[`${drill.cle}`] ||= {})[lang] = await snapshot(page);
        for (const tab of drill.onglets || []) {
          const shown = await page.evaluate((t) => {
            const b = document.querySelector(`[data-tab="${t}"]`);
            if (!b) return false;
            b.click();
            return true;
          }, tab);
          if (!shown) continue;
          await page.waitForTimeout(260);
          (perView[`${drill.cle}/${tab}`] ||= {})[lang] = await snapshot(page);
        }
        await showView(page, drill.retour);
        await page.waitForTimeout(260);
      }
    }
  } catch (e) {
    console.log(`  ECHEC ${url} : ${String(e).slice(0, 70)}`);
    suspects += 1; await page.close(); continue;
  }

  const vocab = fixtureVocab(url);
  const unexplained = new Map();
  const machineCodes = new Set();
  const frenchLeaks = new Set();
  let frozenCount = 0;
  for (const [view, pair] of Object.entries(perView)) {
    if (!pair.en || !pair.fr) continue;
    scanned += pair.en.length;
    const frozen = [...new Set(pair.en.filter((t) => pair.fr.includes(t)))]
      // Ce filtre a longtemps exige un espace ET trois minuscules consecutives.
      // Les deux conditions etaient des angles morts, pas des garde-fous :
      // « ACTIF » et « 01. FIBRE » sont en capitales, « Valider » et
      // « COMPLET » sont des mots isoles. La garde ne pouvait voir aucune
      // etiquette courte ou capitalisee — c'est-a-dire la majeure partie du
      // vocabulaire d'une interface dense. On ne retient plus que la presence
      // de trois lettres, casse indifferente.
      .filter((t) => /[a-zA-Z]{3}/.test(t));
    frozenCount += frozen.length;
    // Du francais sur une page dont la langue par defaut est l'anglais.
    for (const t of (pair.en || [])) {
      if (looksFrench(t)) frenchLeaks.add(t);
    }
    // Une valeur machine ne doit jamais atteindre l'ecran, traduite ou non.
    for (const t of (pair.en || [])) {
      for (const w of t.split(/[^A-Za-z0-9_]+/)) {
        if (/^[a-z]+(_[a-z]+){2,}$/.test(w)) machineCodes.add(w);
      }
    }
    for (const t of frozen) {
      const hit = explain(t, vocab);
      if (hit) allowedHits.set(hit[1], (allowedHits.get(hit[1]) || 0) + 1);
      else if (!unexplained.has(t)) unexplained.set(t, view);
    }
  }
  if (frenchLeaks.size) {
    console.log(`  ECHEC ${url} : ${frenchLeaks.size} chaine(s) francaise(s) sur une page anglaise`);
    [...frenchLeaks].forEach((w) => console.log(`         « ${w} »`));
    suspects += frenchLeaks.size;
  }
  if (machineCodes.size) {
    console.log(`  ECHEC ${url} : ${machineCodes.size} code(s) machine affiche(s) a l'utilisateur`);
    [...machineCodes].forEach((w) => console.log(`         « ${w} »`));
    suspects += machineCodes.size;
  }
  if (unexplained.size) {
    console.log(`  ECHEC ${url} : ${unexplained.size} chaine(s) non traduite(s) sur ${Object.keys(perView).length} vue(s)`);
    [...unexplained].forEach(([t, v]) => console.log(`         [${v}] « ${t} »`));
    suspects += unexplained.size;
  } else {
    console.log(`  ok    ${url.padEnd(24)} ${String(Object.keys(perView).length).padStart(2)} vue(s), ${String(frozenCount).padStart(3)} invariant(s) justifie(s)`);
  }
  await page.close();
}

await browser.close();

console.log(`\n  ${scanned} chaines visibles analysees sur ${PAGES.length} pages, toutes vues confondues`);
console.log(`  exceptions appliquees : ${[...allowedHits].map(([k, v]) => `${k} (${v})`).join(', ')}`);
console.log(suspects
  ? `\n${suspects} chaine(s) de copie metier non traduite(s)`
  : '\nCopie metier : aucune chaine non traduite hors exceptions justifiees');
process.exit(suspects ? 1 : 0);
