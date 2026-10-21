#!/usr/bin/env node
/**
 * Séparation démonstration / réalité sur le passeport public.
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * Un audit a trouvé sur /dpp/ des certifications fictives (« GOTS Certified »,
 * « OEKO-TEX Class 1 », « 100% certified materials », « Made in Portugal »),
 * un lot inventé (« Batch: 2026-FW ») et un JSON-LD de démonstration (Atelier
 * Demo, faux numéros de certificats, usines imaginées) qui survivaient à
 * l'hydratation d'un passeport RÉEL. Un consommateur, un douanier ou un
 * moteur de recherche lisait alors des affirmations non étayées comme
 * authentiques.
 *
 * LA RÈGLE
 * --------
 * 1. toute valeur de démonstration visible est portée par un élément
 *    `data-dpp-demo-only` (masqué dès qu'un identifiant est demandé) ou
 *    remplacée par un binding `data-dpp-field` ;
 * 2. le JSON-LD est réécrit depuis les données servies à l'hydratation, et
 *    neutralisé si le passeport est indisponible ;
 * 3. une certification n'entre dans le JSON-LD que pour une affirmation
 *    `third_party_verified` avec au moins une preuve acceptée ;
 * 4. la modale/export JSON-LD lit le contenu au moment du clic.
 *
 * Exécution : node scripts/test_dpp_demo_separation.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'dpp', 'index.html'), 'utf8');
const dpp2 = readFileSync(join(root, 'assets', 'js', 'dpp.2.js'), 'utf8');
const dpp1 = readFileSync(join(root, 'assets', 'js', 'dpp.1.js'), 'utf8');

let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

/* ---------------------------------------------------------------------------
 * 1. Portée `data-dpp-demo-only` : chaque mention fictive auditéee doit être
 *    dans un sous-arbre de démonstration, ou remplacée par un binding.
 * ------------------------------------------------------------------------- */

/**
 * Analyse structurelle minimale : empile les éléments ouverts et marque les
 * positions de texte selon la présence d'un ancêtre `data-dpp-demo-only` ou
 * d'un attribut `data-dpp-field` sur l'élément courant.
 */
function analyseTextScope(source) {
  const scopes = []; // { demo: boolean, field: boolean }
  const results = []; // { text, demoScope, fieldBound, inJsonLd }
  let inJsonLd = false;
  let inScript = false;
  const voidTags = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse', 'use', 'stop', 'source']);
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/)?>/g;
  let last = 0;
  let m;
  const flushText = (end) => {
    const text = source.slice(last, end);
    if (text.trim() && scopes.length) {
      results.push({
        text,
        demoScope: scopes.some((s) => s.demo),
        fieldBound: scopes[scopes.length - 1].field,
        inJsonLd,
      });
    } else if (text.trim() && !scopes.length && inJsonLd) {
      results.push({ text, demoScope: false, fieldBound: false, inJsonLd: true });
    }
  };
  while ((m = tagRe.exec(source)) !== null) {
    flushText(m.index);
    last = tagRe.lastIndex;
    const closing = Boolean(m[1]);
    const name = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClosed = Boolean(m[4]);
    if (!closing) {
      const demo = /data-dpp-demo-only/.test(attrs);
      const field = /data-dpp-field=/.test(attrs);
      const isJsonLd = /application\/ld\+json/.test(attrs) && name === 'script';
      if (isJsonLd) inJsonLd = true;
      if (name === 'script' && !isJsonLd) inScript = true;
      if (!selfClosed && !voidTags.has(name)) {
        scopes.push({ demo, field });
      } else if (demo || field) {
        results.push({ text: '', demoScope: demo, fieldBound: field, inJsonLd: false, selfTag: true });
      }
    } else {
      if (name === 'script') { inScript = false; if (inJsonLd) inJsonLd = false; }
      // pop jusqu'à l'élément correspondant
      for (let i = scopes.length - 1; i >= 0; i -= 1) {
        scopes.pop();
        break;
      }
    }
  }
  return results;
}

const mentions = [
  '100% certified materials',
  'GOTS Certified',
  'OEKO-TEX Class 1',
  'Made in Portugal',
];
const scopes = analyseTextScope(html);
for (const mention of mentions) {
  const hits = scopes.filter((s) => s.text.includes(mention));
  ok(hits.length === 0, `allégation fictive supprimée du HTML : « ${mention} »`);
}

/* --- réponse initiale : JSON-LD statique et métadonnées sans affirmation --- */
{
  const blocs = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  ok(blocs.length >= 1, 'bloc JSON-LD statique présent');
  for (const bloc of blocs) {
    const contenu = bloc[1];
    let parseOk = true; let doc = null;
    try { doc = JSON.parse(contenu); } catch { parseOk = false; }
    ok(parseOk, 'JSON-LD statique analysable (JSON valide)');
    if (!parseOk) continue;
    ok(!('certifications' in doc) || (Array.isArray(doc.certifications) && doc.certifications.length === 0),
      'JSON-LD statique sans certification déclarée');
    ok(!('verificationSignature' in doc), 'JSON-LD statique sans signature de vérification inventée');
    ok(!('traceability' in doc), 'JSON-LD statique sans provenance déclarée');
    ok(!/atelier-demo|Atelier Demo/i.test(contenu), 'JSON-LD statique sans marque de démonstration');
    ok(!/CU-881294|21\.HPT\.94112|GOTS|OEKO-TEX|SMETA|Made in Portugal|Portugal/i.test(contenu),
      'JSON-LD statique sans certification ni conformité inventée');
    const marque = doc.brand;
    ok(marque === undefined || marque === null,
      'JSON-LD statique sans marque présentée comme réelle');
  }
  const head = html.slice(0, html.indexOf('</head>'));
  ok(!/Atelier Demo/i.test(head), 'métadonnées <head> sans marque de démonstration');
  ok(!/Organic Cotton Essential/i.test(head), 'métadonnées <head> sans produit de démonstration');
  ok(!/GOTS|OEKO-TEX|2026-FW|certified materials/i.test(head), 'métadonnées <head> sans certification fictive');
}

// Le bandeau de démonstration doit rester visible sans identifiant.
ok(/id="dpp-demo-banner"/.test(html), 'bandeau de démonstration présent');
// La barre d'affirmations réelles existe.
ok(/id="dpp-claims-bar"/.test(html), 'barre d affirmations réelles présente');
ok(!/GOTS Certified|OEKO-TEX Class 1|100% certified materials/.test(html),
  'aucun badge de certification fictif conservé dans le HTML');

/* ---------------------------------------------------------------------------
 * 2. Réécriture / neutralisation du JSON-LD par dpp.2.js
 * ------------------------------------------------------------------------- */
ok(/setJsonLd\(jsonLdFor\(payload\)\)/.test(dpp2), 'apply() réécrit #dpp-jsonld depuis les données servies');
ok(/neutralizeForMissingPassport\(\)/.test(dpp2), 'catch() neutralise le passeport indisponible');
ok(/'third_party_verified'/.test(dpp2) && /accepted_evidence_count/.test(dpp2),
  'une certification JSON-LD exige third_party_verified + preuve acceptée');
ok(/setMetaDescription/.test(dpp2), 'meta description réécrite / neutralisée');
ok(/renderClaimsBar\(payload\.claims\)/.test(dpp2), 'affirmations réelles rendues depuis l API');

// Aucune valeur de substitution dans le résolveur de données de l'API.
const resolver = readFileSync(join(root, 'api', '_lib', 'wallet', 'dpp-data-resolver.ts'), 'utf8');
ok(!/Atelier Demo|2026-FW|100% certified|GOTS Certified|OEKO-TEX Class/.test(resolver),
  'le résolveur DPP API ne contient aucune valeur de substitution');

/* ---------------------------------------------------------------------------
 * 3. Lecture JSON-LD au moment du clic (pas de contenu figé au chargement)
 * ------------------------------------------------------------------------- */
ok(/readJsonLd\(\)/.test(dpp1) && !/const jsonContent = document\.getElementById\('dpp-jsonld'\)\.textContent/.test(dpp1),
  'modale/export JSON-LD lisent le contenu au moment du clic');

console.log(`\n  Séparation démo/réel du passeport public : ${echecs === 0 ? 'OK' : `${echecs} échec(s)`}.`);
process.exit(echecs === 0 ? 0 : 1);
