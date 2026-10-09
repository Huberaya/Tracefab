#!/usr/bin/env node
/**
 * Appose une empreinte de contenu sur chaque ressource liee depuis le HTML.
 *
 * POURQUOI
 *
 * Vercel sert les fichiers statiques avec `public, max-age=0, must-revalidate`
 * par defaut. Le CDN garde le fichier, mais le navigateur, lui, redemande a
 * chaque chargement : « est-ce toujours a jour ? ». Meme quand la reponse est
 * 304 sans corps, l'aller-retour a lieu. Vingt-trois ressources, vingt-trois
 * allers-retours, a chaque page, pour un visiteur qui a deja tout en cache.
 *
 * On ne peut pas simplement passer a `immutable` : les fichiers s'appellent
 * `brand-console.1.js` et gardent ce nom d'une version a l'autre. Un
 * navigateur qui a mis cette URL en cache pour un an ne reverrait jamais la
 * correction qu'on vient de deployer.
 *
 * D'ou l'empreinte : `/assets/js/brand-console.1.js?v=9f2c41b8`. Le contenu
 * change, l'URL change, le cache est contourne de lui-meme. L'URL devient
 * reellement immuable, donc `immutable` devient honnete.
 *
 * CE QUI NE PEUT PAS ETRE VERSIONNE
 *
 * Les catalogues de langue `/assets/i18n/<lang>.json` sont recuperes a
 * l'execution par tf-i18n.js, pas ecrits dans le HTML : rien ne peut leur
 * coller une empreinte au moment de la construction. Ils gardent donc un
 * cache court dans vercel.json. Les y inclure aurait fige les traductions
 * pour un an.
 *
 * L'OUBLI EST IMPOSSIBLE
 *
 * Modifier un fichier sans relancer ce script laisserait une empreinte
 * perimee, et donc du code ancien servi pour un an. `npm run test:assets`
 * recalcule tout et echoue si une seule empreinte ne correspond plus.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const REF = /(<(?:script|link)[^>]*?(?:src|href)=")(\/assets\/[^"?]+)(\?v=[0-9a-f]+)?(")/g;

export function empreinte(cheminAbsolu) {
  return createHash('sha256').update(readFileSync(cheminAbsolu)).digest('hex').slice(0, 8);
}

export function pagesHtml() {
  return execSync('git ls-files "*.html"', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let touchees = 0;
  let references = 0;
  const manquants = [];

  for (const page of pagesHtml()) {
    const chemin = join(ROOT, page);
    const avant = readFileSync(chemin, 'utf8');
    const apres = avant.replace(REF, (whole, tete, url, ancienne, queue) => {
      const fichier = join(ROOT, url.slice(1));
      if (!existsSync(fichier)) { manquants.push(`${page} -> ${url}`); return whole; }
      references += 1;
      return `${tete}${url}?v=${empreinte(fichier)}${queue}`;
    });
    if (apres !== avant) { writeFileSync(chemin, apres); touchees += 1; }
  }

  for (const m of manquants) console.log(`  introuvable : ${m}`);
  console.log(`  ${references} reference(s) versionnee(s) dans ${touchees} page(s) modifiee(s)`);
  if (manquants.length) process.exit(1);
}
