#!/usr/bin/env node
/* ==========================================================================
   Chantier 09 — injection du namespace `certifications` (Certification Intelligence : sante, veille et revue des certificats,
   upload/analyse/liaisons/statuts de verification) dans les
   catalogues i18n.

   Source unique : scripts/_chantier09_certifications_i18n.json (7 langues).
   Cible : assets/i18n/en.js + fr/de/it/es/nl/pt.json.
   Locales produit : sept catalogues complets (en/fr/de/it/es/nl/pt). tr/zh retirees au chantier 15.

   Strictement additif : ce generateur n'efface aucune cle, et borne son
   insertion a son propre namespace. Idempotent.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = JSON.parse(readFileSync(join(ROOT, 'scripts/_chantier09_certifications_i18n.json'), 'utf8'));

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

/* -- en.js : insertion du bloc certifications avant le }; final ------------------- */
const EN_PATH = join(ROOT, 'assets/i18n/en.js');
let en = readFileSync(EN_PATH, 'utf8');
if (/\n  "certifications":\s*\{/.test(en) || /\n  certifications:\s*\{/.test(en)) {
  console.log('ok  en.js : bloc certifications deja present (idempotent)');
} else {
  const literal = JSON.stringify(SRC.en, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  const idx = en.lastIndexOf('};');
  if (idx === -1) throw new Error('en.js : fermeture }; introuvable');
  const head = en.slice(0, idx).replace(/[,\s]*$/, '');
  en = head + ',\n  "certifications": ' + literal + '\n};\n';
  writeFileSync(EN_PATH, en);
  console.log('ok  en.js : bloc certifications insere');
}

/* -- locales completes ------------------------------------------------------ */
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const path = join(ROOT, `assets/i18n/${lang}.json`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.certifications = SRC[lang];
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`ok  ${lang}.json : bloc certifications ecrit`);
}

console.log('injection certifications i18n terminee');
