#!/usr/bin/env node
/* ==========================================================================
   Chantier 10 — injection du namespace `qualityPremium` (Quality Center premium : score decompose, drill-down, tendances,
   upload/analyse/liaisons/statuts de verification) dans les
   catalogues i18n.

   Source unique : scripts/_chantier10_quality_premium_i18n.json (7 langues).
   Cible : assets/i18n/en.js + fr/de/it/es/nl/pt.json.
   Locales partielles (tr/zh) : repli anglais, aucune cle ajoutee.

   Strictement additif : ce generateur n'efface aucune cle, et borne son
   insertion a son propre namespace. Idempotent.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = JSON.parse(readFileSync(join(ROOT, 'scripts/_chantier10_quality_premium_i18n.json'), 'utf8'));

const LANGS = Object.keys(SRC);
if (!LANGS.includes('en')) throw new Error('en manquant dans la source');

const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out;
};
const refKeys = new Set(leaves(SRC.en));
for (const lang of LANGS) {
  const keys = new Set(leaves(SRC[lang]));
  for (const k of refKeys) if (!keys.has(k)) throw new Error(`${lang}: cle manquante ${k}`);
  for (const k of keys) if (!refKeys.has(k)) throw new Error(`${lang}: cle en trop ${k}`);
}
console.log(`ok  parite source : ${refKeys.size} cles x ${LANGS.length} langues`);

/* -- en.js : insertion du bloc qualityPremium avant le }; final ------------------- */
const EN_PATH = join(ROOT, 'assets/i18n/en.js');
let en = readFileSync(EN_PATH, 'utf8');
if (/\n  "qualityPremium":\s*\{/.test(en) || /\n  qualityPremium:\s*\{/.test(en)) {
  console.log('ok  en.js : bloc qualityPremium deja present (idempotent)');
} else {
  const literal = JSON.stringify(SRC.en, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  const idx = en.lastIndexOf('};');
  if (idx === -1) throw new Error('en.js : fermeture }; introuvable');
  const head = en.slice(0, idx).replace(/[,\s]*$/, '');
  en = head + ',\n  "qualityPremium": ' + literal + '\n};\n';
  writeFileSync(EN_PATH, en);
  console.log('ok  en.js : bloc qualityPremium insere');
}

/* -- locales completes ------------------------------------------------------ */
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const path = join(ROOT, `assets/i18n/${lang}.json`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.qualityPremium = SRC[lang];
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`ok  ${lang}.json : bloc qualityPremium ecrit`);
}

console.log('injection qualityPremium i18n terminee');
