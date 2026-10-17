#!/usr/bin/env node
/**
 * TRACEFAB — garde des commentaires de fin de ligne dans les routes compactees.
 *
 * POURQUOI CETTE GARDE EXISTE
 *
 * Plusieurs routes de `api/_routes` sont ecrites sur une seule ligne physique
 * (`resolve/[publicId].ts`, `resolve/[publicId]/qr.ts`, `dpp/identities.ts`,
 * `dpp/quality-check.ts`). Dans un fichier ordinaire, un commentaire `//` ne
 * porte que sur sa ligne. Dans un fichier compacte, il porte sur TOUT le
 * handler.
 *
 * Le cas est reel et a failli partir en Production le 2026-10-17 : un
 * commentaire `//` ajoute devant la nouvelle branche `retired` de
 * `resolve/[publicId].ts` a mis en commentaire la branche `retired` ET la
 * branche de redirection HTML qui la suivait. TypeScript n'a rien dit — le
 * fichier restait syntaxiquement valide, il ne faisait simplement plus rien.
 *
 * Un correctif silencieux est pire qu'une erreur : rien ne le signale, ni le
 * compilateur, ni la CI, ni le test de la route.
 *
 * CE QUE LA GARDE VERIFIE
 *
 * Sur chaque ligne d'une route, si un `//` (hors chaine, hors `://`) est suivi
 * sur la MEME ligne physique d'un marqueur de code executable (`;` puis un
 * mot-cle, ou directement `if(`, `return `, `const `, `await `), le fichier est
 * signale. Le motif est volontairement etroit : il vise le cas « commentaire
 * qui a avale du code », pas la lisibilite generale.
 *
 * Usage : node scripts/test_minified_comment_guard.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = join(ROOT, 'api', '_routes');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Position du premier `//` de commentaire sur la ligne, ou -1.
 *
 * Sautent : `://` (une URL), `//` a l'interieur d'une chaine, et un `//` deja
 * vu comme dernier element de la ligne (commentaire legitime, rien derriere).
 */
function firstLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < line.length - 1; i += 1) {
    const c = line[i];
    const prev = line[i - 1];
    if (c === "'" && !inDouble && !inTemplate && prev !== '\\') inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inTemplate && prev !== '\\') inDouble = !inDouble;
    else if (c === '`' && !inSingle && !inDouble && prev !== '\\') inTemplate = !inTemplate;
    else if (c === '/' && line[i + 1] === '/' && !inSingle && !inDouble && !inTemplate) {
      if (line[i - 1] === ':') continue; // https://
      return i;
    }
  }
  return -1;
}

/** Code executable apres un commentaire, sur la meme ligne physique. */
const LIVE_CODE_AFTER_COMMENT = /(;|\})\s*(if\s*\(|return\s|const\s|let\s|await\s|res\.|const\{)/;

let echecs = 0;
const files = walk(ROUTES);
const suspects = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const at = firstLineComment(line);
    if (at === -1) return;
    const after = line.slice(at + 2);
    if (!LIVE_CODE_AFTER_COMMENT.test(after)) return;
    suspects.push(`${file.replace(`${ROOT}/`, '')}:${index + 1}`);
  });
}

console.log(`\n=== TRACEFAB — commentaires de fin de ligne dans les routes ===`);
console.log(`Routes inspectees : ${files.length}`);

if (suspects.length) {
  console.log(`\n${suspects.length} commentaire(s) suspect(s) :\n`);
  for (const s of suspects) console.log(`  - ${s}`);
  console.log('\n  Dans un fichier compacte sur une ligne, un commentaire `//` met en');
  console.log('  commentaire tout ce qui le suit sur la ligne — donc potentiellement');
  console.log('  tout le handler. Le code reste syntaxiquement valide et ne fait plus');
  console.log('  rien. Utiliser un commentaire bloc /* */ ou passer le fichier en');
  console.log('  multi-lignes.\n');
  process.exit(1);
}

console.log('Aucun commentaire n avale de code executable.');
