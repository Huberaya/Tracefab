#!/usr/bin/env node
/**
 * TRACEFAB Passeport public — état d'erreur.
 *
 * Défaut corrigé : `fetchPassport()` attrapait toute erreur d'API — référence
 * inconnue, réseau coupé, serveur en panne — et la remplaçait silencieusement par
 * un fournisseur inventé dont les trois certificats portaient `isVerified: true`,
 * un score de 92 et 28 consultations. Le visiteur lisait un profil « vérifié »
 * qui ne correspondait à aucune entreprise, et un incident de production
 * ressemblait à un passeport valide.
 *
 * Désormais :
 *   - sans ?demo=1, un échec affiche un état d'erreur et masque le sceau
 *     « Profil Industriel Vérifié » ;
 *   - avec ?demo=1, les valeurs de démonstration s'affichent mais sont
 *     étiquetées comme telles.
 *
 *   npm run test:passport:error
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name, detail) {
  if (actual === expected) ok(name);
  else bad(name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}${detail ? `\n        ${detail}` : ''}`);
}

const html = await readFile(new URL('passport/index.html', root), 'utf8');
const dict = JSON.parse(await readFile(new URL('locales/fr/passport.json', root), 'utf8'));

/** Dictionnaire aplati : la page appelle t('passport.error.title'). */
const flat = {};
(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
    else flat[`${prefix}${k}`] = v;
  }
}(dict, ''));

const VALID = {
  passport: { id: 'p1', slug: 'atelier-rivage', headline: 'Filature intégrée', tradeSecretMode: 'redacted', viewsCount: 3, lastViewedAt: '2026-01-01T00:00:00.000Z' },
  supplier: { legalName: 'Atelier Rivage SAS', displayName: 'Atelier Rivage', countryCode: 'FR', activityTypes: ['spinning'], profileSummary: 'Filature de lin.', employeeCountRange: '51-250', yearEstablished: 2001, profileCompletion: 80, contactName: 'Claire Rivage' },
  sites: [{ id: 's1', name: 'Atelier de Roubaix', countryCode: 'FR', city: 'Roubaix', address: '12 rue du Lin', activityTypes: ['spinning'], isActive: true }],
  certifications: [{ id: 'c1', standardName: 'GOTS', standardCode: 'GOTS 7.0', issuerName: 'Control Union', certificateNumber: 'CU-1', issuedAt: '2025-01-15', expiresAt: '2027-01-14', isVerified: true }],
  materials: [{ id: 'm1', name: 'Lin peigné', materialType: 'yarn', originCountryCode: 'FR', composition: { linen: 100 } }],
  qualityScore: { completeness: 80, freshness: 80, documentationCoverage: 80, consistency: 80 },
  tradeSecretProtection: { exactAddressesMasked: false, mode: 'full', legalBasis: 'Directive (UE) 2016/943' },
};

/**
 * Monte la page. `fetch` est installé dans `beforeParse` : la page l'appelle
 * pendant l'exécution du script, donc un stub posé après la construction
 * arriverait trop tard.
 */
async function mount(search, fetchBehaviour) {
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: `https://tracefab.vercel.app/p/ref${search}`,
    virtualConsole,
    beforeParse(window) {
      window.fetch = async () => fetchBehaviour();
      window.TracefabI18n = {
        LANGS: ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'],
        language: 'fr',
        missing: [],
        setLanguage() {},
        t(key, values) {
          const value = flat[key];
          if (value === undefined) return null;
          return values
            ? String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, n) => (n in values ? values[n] : m))
            : value;
        },
        init() { return Promise.resolve('fr'); },
        apply() {},
      };
    },
  });

  const { window } = dom;
  const { document } = window;
  if (document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  await new Promise((r) => setTimeout(r, 80));

  const app = document.getElementById('app');
  return {
    window,
    document,
    pageErrors,
    text: () => (app ? app.textContent : ''),
    htmlOf: () => (app ? app.innerHTML : ''),
    seal: () => document.getElementById('verified-seal'),
    sealVisible: () => {
      const seal = document.getElementById('verified-seal');
      return !!seal && seal.style.display !== 'none';
    },
  };
}

const failing = () => { const e = new Error('503 upstream unavailable'); throw e; };
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'passport_not_found' }) });
const success = () => ({ ok: true, status: 200, json: async () => VALID });

console.log('\nA. Échec réseau, sans ?demo=1');
const net = await mount('?ref=inconnu', failing);
eq(net.pageErrors.length, 0, 'aucune erreur de page', net.pageErrors.join(' | '));
const netText = net.text();
assert(netText.length > 10, `un état d'erreur est rendu (${netText.length} caractères)`);
eq(netText.includes('Nhãn Textile'), false, 'aucun fournisseur inventé n’est affiché');
eq(netText.includes('Control Union'), false, 'aucun certificat inventé n’est affiché');
eq(net.htmlOf().includes('error-card'), true, 'la carte d’erreur est rendue');
eq(net.htmlOf().includes('role="alert"'), true, 'l’échec est exposé aux technologies d’assistance');
assert(!!net.seal(), 'le sceau existe dans le DOM (sinon l’assertion passerait à tort)');
eq(net.sealVisible(), false, 'le sceau « Profil Industriel Vérifié » est masqué');
eq(netText.includes('passport.error'), false, 'aucune clé brute ne fuite', netText.slice(0, 120));
eq(netText.includes(flat['passport.error.title']), true, 'le titre d’erreur vient du dictionnaire');

console.log('\nB. Réponse 404, sans ?demo=1');
const nf = await mount('?ref=introuvable', notFound);
const nfText = nf.text();
eq(nfText.includes('Nhãn Textile'), false, 'un 404 n’affiche pas de fournisseur inventé');
eq(nf.htmlOf().includes('error-card'), true, 'la carte d’erreur est rendue');
eq(nfText.includes('passport_not_found'), true, 'le motif renvoyé par le serveur est restitué');
assert(!!nf.seal(), 'le sceau existe dans le DOM');
eq(nf.sealVisible(), false, 'le sceau est masqué');

console.log('\nC. Démonstration explicite (?demo=1) avec API en échec');
const demo = await mount('?ref=demo&demo=1', failing);
const demoText = demo.text();
eq(demo.htmlOf().includes('demo-banner'), true, 'le bandeau de démonstration est rendu');
eq(demoText.includes(flat['passport.demo.banner']), true, 'le bandeau annonce des données de démonstration');
eq(demoText.includes('Nhãn Textile'), true, 'les valeurs de démonstration sont bien servies sur demande');
eq(demo.htmlOf().includes('error-card'), false, 'pas de carte d’erreur en mode démonstration');

console.log('\nD. ?demo=0 désactive la démonstration');
const off = await mount('?ref=inconnu&demo=0', failing);
eq(off.htmlOf().includes('demo-banner'), false, '?demo=0 ne sert aucune donnée de démonstration');
eq(off.htmlOf().includes('error-card'), true, '?demo=0 affiche l’état d’erreur');

console.log('\nE. Succès : le passeport réel s’affiche normalement');
const good = await mount('?ref=atelier-rivage', success);
const goodText = good.text();
eq(good.pageErrors.length, 0, 'aucune erreur de page', good.pageErrors.join(' | '));
eq(goodText.includes('Atelier Rivage'), true, 'le fournisseur réel est affiché');
eq(good.htmlOf().includes('error-card'), false, 'pas de carte d’erreur');
eq(good.htmlOf().includes('demo-banner'), false, 'pas de bandeau de démonstration');
assert(!!good.seal(), 'le sceau existe dans le DOM');
eq(good.sealVisible(), true, 'le sceau est visible pour un passeport réellement chargé');

console.log('\nF. Le repli silencieux a disparu du code');
eq(/fallback to realistic verified demo supplier/.test(html), false, 'le commentaire du repli silencieux a disparu');
eq(html.includes('demoRequested'), true, 'la démonstration est conditionnée à un paramètre explicite');
eq(/isVerified: true/.test(html.slice(html.indexOf('function demoPassport'))), true,
  'les certificats de démonstration restent dans demoPassport(), pas dans le chemin d’erreur');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:passport:error FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:passport:error passed — ${checks} contrôles, 0 échec.`);
