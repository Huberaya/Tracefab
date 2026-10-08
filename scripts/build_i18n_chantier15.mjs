#!/usr/bin/env node
/* ==========================================================================
   Chantier 15 — injection du namespace `i18n15` (metadonnees localisees,
   Brand Console, Portail Fournisseur et Quality Center) dans les catalogues.

   Source unique : scripts/_chantier15_i18n.json (7 langues).
   Cible : assets/i18n/en.js + fr/de/it/es/nl/pt.json.
   Les seules locales produit sont les sept langues completes (EN/FR/DE/IT/ES/NL/PT).

   Strictement additif : ce generateur n'efface aucune cle, et borne son
   insertion a son propre namespace. Idempotent.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = JSON.parse(readFileSync(join(ROOT, 'scripts/_chantier15_i18n.json'), 'utf8'));

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

/* -- en.js : insertion du bloc i18n15 avant le }; final ------------------- */
const EN_PATH = join(ROOT, 'assets/i18n/en.js');
let en = readFileSync(EN_PATH, 'utf8');
if (/\n  "i18n15":\s*\{/.test(en) || /\n  i18n15:\s*\{/.test(en)) {
  console.log('ok  en.js : bloc i18n15 deja present (idempotent)');
} else {
  const literal = JSON.stringify(SRC.en, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  const idx = en.lastIndexOf('};');
  if (idx === -1) throw new Error('en.js : fermeture }; introuvable');
  const head = en.slice(0, idx).replace(/[,\s]*$/, '');
  en = head + ',\n  "i18n15": ' + literal + '\n};\n';
  writeFileSync(EN_PATH, en);
  console.log('ok  en.js : bloc i18n15 insere');
}

/* -- locales completes ------------------------------------------------------ */
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const path = join(ROOT, `assets/i18n/${lang}.json`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.i18n15 = SRC[lang];
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`ok  ${lang}.json : bloc i18n15 ecrit`);
}

console.log('injection i18n15 terminee');
