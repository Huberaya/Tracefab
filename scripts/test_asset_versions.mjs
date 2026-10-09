#!/usr/bin/env node
/**
 * Chaque ressource liee depuis le HTML porte l'empreinte de son contenu reel.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `/assets/js/` et `/assets/design-system/` sont servis avec
 * `max-age=31536000, immutable`. Cette promesse n'est tenable que si l'URL
 * change quand le contenu change. Elle repose entierement sur l'empreinte
 * `?v=` apposee par build_asset_versions.mjs.
 *
 * Modifier un bundle sans relancer le generateur laisserait l'ancienne
 * empreinte dans le HTML. Les visiteurs ayant deja l'URL en cache
 * continueraient a executer l'ancien code — pendant un an. Un correctif de
 * securite deploye et jamais recu.
 *
 * Ce test recalcule l'empreinte de chaque fichier et la compare a celle
 * ecrite dans le HTML. C'est la seule chose qui rend `immutable` honnete.
 *
 * Il verifie aussi l'inverse : qu'aucune ressource servie en immuable ne soit
 * liee sans empreinte.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REF, empreinte, pagesHtml } from './build_asset_versions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Prefixes declares immuables dans vercel.json. */
const IMMUABLES = ['/assets/js/', '/assets/design-system/'];

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };

/* --- 1. vercel.json promet-il bien l'immuabilite, et seulement la ou il faut ? */
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const regles = new Map((vercel.headers || []).map((h) => [
  h.source,
  Object.fromEntries(h.headers.map((x) => [x.key.toLowerCase(), x.value])),
]));

for (const prefixe of IMMUABLES) {
  const source = `${prefixe}(.*)`;
  const r = regles.get(source);
  if (!r) { ko(`vercel.json n a pas de regle pour ${source}`); continue; }
  const cc = r['cache-control'] || '';
  if (!/immutable/.test(cc) || !/max-age=\d{7,}/.test(cc)) {
    ko(`${source} : cache-control inattendu « ${cc} »`);
  }
}

const i18n = regles.get('/assets/i18n/(.*)');
if (!i18n) {
  ko('vercel.json ne traite pas /assets/i18n/ a part — les catalogues de langue '
    + 'sont recuperes a l execution et ne peuvent pas porter d empreinte');
} else if (/immutable/.test(i18n['cache-control'] || '')) {
  ko('/assets/i18n/ est declare immuable : les traductions seraient figees pour un an');
} else {
  console.log(`  ok    /assets/i18n/ garde un cache revalidable — « ${i18n['cache-control']} »`);
}

/* --- 2. chaque reference porte-t-elle l'empreinte de son contenu ? --------- */
let verifiees = 0;
const perimees = [];
const nues = [];

for (const page of pagesHtml()) {
  const html = readFileSync(join(ROOT, page), 'utf8');
  for (const m of html.matchAll(REF)) {
    const url = m[2];
    const version = m[3] ? m[3].slice(3) : null;
    const fichier = join(ROOT, url.slice(1));
    if (!existsSync(fichier)) { ko(`${page} reference ${url}, qui n existe pas`); continue; }

    const attendue = empreinte(fichier);
    const immuable = IMMUABLES.some((p) => url.startsWith(p));
    verifiees += 1;

    if (!version) {
      if (immuable) nues.push(`${page} -> ${url}`);
    } else if (version !== attendue) {
      perimees.push(`${page} -> ${url} porte ?v=${version}, le contenu vaut ${attendue}`);
    }
  }
}

if (nues.length) {
  ko(`${nues.length} reference(s) servie(s) en immuable sans empreinte :`);
  nues.forEach((n) => console.log(`         ${n}`));
}
if (perimees.length) {
  ko(`${perimees.length} empreinte(s) perimee(s) — du code ancien serait servi pour un an :`);
  perimees.forEach((p) => console.log(`         ${p}`));
  console.log('         Correction : npm run assets:version');
}
if (!nues.length && !perimees.length) {
  console.log(`  ok    ${verifiees} reference(s) portent l empreinte exacte de leur contenu`);
}

console.log();
if (echecs) {
  console.log(`${echecs} probleme(s). « immutable » n est tenable que si l URL change avec le contenu.`);
  process.exit(1);
}
console.log('Les URL changent quand le contenu change : la promesse d immuabilite est tenue.');
