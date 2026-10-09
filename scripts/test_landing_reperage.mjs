/* ==========================================================================
   TRACEFAB — landing, chantier L4 : savoir ou l'on est.

   La page fait 6179px en desktop et 9473px sur telephone, et rien n'y disait
   ou l'on en etait ni combien il restait.

   Le surlignage du menu ne pouvait pas l'ecrire. L'ordre du menu est fixe par
   le cahier des charges (Why / Platform / Supply Chain / ...) et ne suit pas
   l'ordre de la page (hero > supply-chain > platform > why) : l'element actif
   bondissait en arriere, 3 > 2 > 4 > 5 > 1 > 6. Et sur telephone le menu dort
   dans un tiroir ferme. Le rail de progression, lui, avance toujours.

   Le tiroir, lui, est devenu une vraie table des matieres : il suit l'ordre de
   la page et porte les numeros de chapitre que la page affiche elle-meme.
   Il numerotait « Why TRACEFAB = 01 » alors que la page ecrit
   « 01 — THE CONNECTED FOUNDATION » sur Supply Chain : deux « 01 » differents.

   Ce test garde aussi un defaut systemique trouve en chemin, qui depasse la
   landing : 14 references var(--tf-...) pointaient vers des tokens inexistants,
   sans valeur de repli. Un var() introuvable rend la declaration invalide et la
   propriete retombe en heritage — ici du vert emeraude devenu noir sur noir,
   et six regles de survol qui ne faisaient rien. L'echec est totalement
   silencieux : ni erreur console, ni regle barree dans l'inspecteur.

   Usage : node scripts/test_landing_reperage.mjs
   ========================================================================== */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageSource } from './lib/page_source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DS = join(ROOT, 'assets/design-system');

let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const html = pageSource('index.html');
const css = readFileSync(join(DS, 'tracefab-site.css'), 'utf8');
const js = readFileSync(join(ROOT, 'assets/js/tf-landing.js'), 'utf8');

/* --- 1. aucun var() ne pointe dans le vide ------------------------------ */
const feuilles = readdirSync(DS).filter((f) => f.endsWith('.css'));
const definis = new Set();
for (const f of feuilles) {
  for (const m of readFileSync(join(DS, f), 'utf8').matchAll(/(--tf-[a-z0-9-]+)\s*:/g)) definis.add(m[1]);
}
ok(definis.size > 100, 'le catalogue de tokens est lisible', `${definis.size} tokens`);

const morts = [];
for (const f of feuilles) {
  const s = readFileSync(join(DS, f), 'utf8');
  for (const m of s.matchAll(/var\(\s*(--tf-[a-z0-9-]+)\s*\)/g)) {
    if (!definis.has(m[1])) morts.push(`${f}:${m[1]}`);
  }
}
ok(morts.length === 0,
  'aucune reference var(--tf-...) sans repli ne vise un token inexistant',
  [...new Set(morts)].join(', '));

/* --- 2. le rail de progression existe et avance ------------------------- */
ok(/<div class="tf-progress"[^>]*>\s*<span class="tf-progress__fill">/.test(html),
  'le rail de progression est dans l\'en-tete');
ok(/aria-hidden="true"[^>]*>\s*<span class="tf-progress__fill"|<div class="tf-progress" aria-hidden="true"/.test(html),
  'le rail est purement visuel, retire de l\'arbre d\'accessibilite');
ok(/\.tf-progress__fill[\s\S]{0,300}?transform:\s*scaleX\(0\)/.test(css),
  'le rail part de zero');
ok(/\.tf-progress__fill[\s\S]{0,300}?transform-origin:\s*left/.test(css),
  'le rail se remplit depuis la gauche');
ok(/scaleX\('\s*\+\s*part/.test(js) || /'scaleX\(' \+ part/.test(js),
  'le remplissage passe par scaleX, une propriete composee');
ok(/requestAnimationFrame/.test(js) && /enVol/.test(js),
  'un seul calcul par frame, pas un par evenement de defilement');
ok(/\.tf-header\.is-stuck \.tf-progress \{ opacity: 1/.test(css),
  'le rail n\'apparait qu\'une fois la page quittee du haut');
ok(/poserEncoches/.test(js) && /main > section\[id\]/.test(js),
  'les encoches sont posees sur les vraies frontieres de section');
ok(/addEventListener\('resize'[\s\S]{0,120}?poserEncoches/.test(js),
  'les encoches se replacent au redimensionnement');

/* --- 3. le tiroir est une table des matieres --------------------------- */
const liens = [...html.matchAll(/<a class="tf-drawer__link([^"]*)" href="#([^"]+)"[\s\S]*?<b class="tf-drawer__num">([^<]*)<\/b>/g)]
  .map((m) => ({ sub: m[1].includes('--sub'), cible: m[2], num: m[3].trim() }));
ok(liens.length === 6, 'le tiroir garde ses six entrees', `${liens.length}`);

// ordre : chaque cible doit apparaitre dans le document apres la precedente
const pos = liens.map((l) => html.indexOf(`id="${l.cible}"`));
ok(pos.every((v) => v > 0) && pos.every((v, i) => i === 0 || v > pos[i - 1]),
  'le tiroir suit l\'ordre de la page, donc le repere n\'y recule jamais',
  liens.map((l) => l.cible).join(' > '));

// les numeros du tiroir sont ceux que la page affiche elle-meme
const chapitres = {};
for (const m of html.matchAll(/data-i18n="(eco|spine|promise)\.index">(\d+)</g)) {
  chapitres[{ eco: 'supply-chain', spine: 'platform', promise: 'why' }[m[1]]] = m[2];
}
ok(Object.keys(chapitres).length === 3, 'la page numerote bien trois chapitres',
  JSON.stringify(chapitres));
const faux = liens.filter((l) => chapitres[l.cible] && l.num !== chapitres[l.cible]);
ok(faux.length === 0,
  'les numeros du tiroir sont ceux que la page affiche, pas une suite inventee',
  faux.map((l) => `${l.cible}: tiroir=${l.num} page=${chapitres[l.cible]}`).join(', '));

// les entrees qui ne sont pas des chapitres n'inventent pas de numero
const sansChapitre = liens.filter((l) => !chapitres[l.cible]);
ok(sansChapitre.every((l) => l.num === ''),
  'les entrees qui ne sont pas des chapitres ne portent aucun numero',
  sansChapitre.map((l) => `${l.cible}=${l.num}`).join(', '));

// les deux liens internes au chapitre 02 sont subordonnes
const subs = liens.filter((l) => l.sub);
ok(subs.length === 2 && subs.every((l) => l.cible.startsWith('layer-')),
  'les deux liens internes a Platform sont marques comme subordonnes',
  subs.map((l) => l.cible).join(', '));
ok(/\.tf-drawer a\.tf-drawer__link--sub[\s\S]{0,200}?padding-left/.test(css),
  'la subordination se voit : les sous-entrees sont decalees');

/* --- 4. le libelle du tiroir n'est pas typographie comme son numero ----- */
ok(!/\.tf-drawer a\.tf-drawer__link span\s*\{[^}]*font-size:\s*var\(--tf-size-3xs\)/.test(css),
  'la regle du numero ne frappe plus tous les enfants du lien');
ok(/\.tf-drawer a\.tf-drawer__link \.tf-drawer__num\s*\{/.test(css),
  'le numero porte sa propre classe');

/* --- 5. le repere s'allume aussi dans le tiroir ------------------------- */
ok(/\$\$\('\.tf-nav a\[href\^="#"\], \.tf-drawer a\[href\^="#"\]'\)/.test(js),
  'le reperage de section couvre le menu et le tiroir');
ok(/\.tf-drawer a\.tf-drawer__link\.is-active \{/.test(css),
  'le chapitre courant se marque dans le tiroir');

/* --- 6. le tiroir est opaque ------------------------------------------- */
ok(!/\.tf-drawer \{[\s\S]{0,200}?background: rgba\(4, 11, 8, 0\.9/.test(css),
  'le tiroir ne laisse plus transparaitre la section claire qui defile derriere');

console.log(ko === 0 ? '\n  landing : le reperage tient.' : `\n  landing : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
