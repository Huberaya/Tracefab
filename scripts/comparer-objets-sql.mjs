#!/usr/bin/env node
/**
 * Comparaison nominative des objets de sécurité entre deux inventaires.
 *
 * Pourquoi ce contrôle existe. Un écart de compte ne prouve rien et ne permet
 * aucune décision : « 130 politiques contre 128 » ne dit pas lesquelles sont en
 * trop, donc ni si elles sont légitimes, ni si elles sont dangereuses, ni ce
 * qu'il faudrait formaliser. Ce contrôle compare des LISTES NOMMÉES et rend la
 * différence exacte dans les deux sens.
 *
 * Les deux entrées sont des fichiers produits par scripts/lire-objets-sql.sql,
 * exécuté en lecture seule sur chaque cible. Le format attendu est une ligne par
 * objet, préfixée par POLICY ou SECDEF.
 *
 * Ce contrôle ne se connecte à aucune base : il compare deux fichiers. C'est
 * volontaire — il doit pouvoir être éprouvé sans cible distante.
 *
 * Sorties : 0 inventaires identiques · 1 divergence · 2 entrée manquante.
 */

import fs from 'node:fs';
import path from 'node:path';

function lire(fichier, etiquette) {
  if (!fichier) {
    console.log(`\n  NON EXECUTE — ${etiquette} absente.`);
    console.log('  Usage : node scripts/comparer-objets-sql.mjs --reference <fichier> --cible <fichier>');
    console.log('  Chaque fichier est la sortie de scripts/lire-objets-sql.sql sur une cible.');
    process.exit(2);
  }
  if (!fs.existsSync(fichier)) {
    console.log(`\n  NON EXECUTE — ${etiquette} introuvable : ${fichier}`);
    process.exit(2);
  }
  const lignes = fs
    .readFileSync(fichier, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('POLICY ') || l.startsWith('SECDEF '));
  if (lignes.length === 0) {
    console.log(`\n  NON EXECUTE — ${etiquette} ne contient aucune ligne POLICY ou SECDEF.`);
    console.log(`  Fichier : ${path.resolve(fichier)}`);
    console.log('  Vérifier que la sortie de lire-objets-sql.sql a bien été enregistrée,');
    console.log('  sans en-tête de colonne ni pied de page du client SQL.');
    process.exit(2);
  }
  return new Set(lignes);
}

const args = process.argv.slice(2);
const valeur = (drapeau) => {
  const i = args.indexOf(drapeau);
  return i >= 0 ? args[i + 1] : undefined;
};

const reference = lire(valeur('--reference'), 'reference');
const cible = lire(valeur('--cible'), 'cible');

const enPlus = [...cible].filter((o) => !reference.has(o)).sort();
const enMoins = [...reference].filter((o) => !cible.has(o)).sort();

console.log('');
console.log('  Objets de sécurité — comparaison nominative');
console.log('  Lecture seule : aucune connexion, aucune écriture.');
console.log('');
console.log(`  reference : ${reference.size} objets`);
console.log(`  cible     : ${cible.size} objets`);
console.log(`  sur la cible, absents de la reference : ${enPlus.length}`);
console.log(`  dans la reference, absents de la cible : ${enMoins.length}`);

if (enPlus.length > 0) {
  console.log('');
  console.log('  PRESENTS SUR LA CIBLE, ABSENTS DU SCHEMA RECONSTRUIT :');
  for (const o of enPlus) console.log(`    + ${o}`);
  console.log('');
  console.log('  Chacun doit être classé avant toute décision :');
  console.log('    legitime  -> le formaliser dans une migration versionnee reproductible');
  console.log('    obsolete  -> le prouver, puis preparer une correction testee');
  console.log('    dangereux -> ne pas le supprimer sans autorisation : fournir la preuve');
  console.log('                 manquante et un test qui permet de trancher');
}

if (enMoins.length > 0) {
  console.log('');
  console.log('  PRESENTS DANS LA REFERENCE, ABSENTS DE LA CIBLE :');
  for (const o of enMoins) console.log(`    - ${o}`);
  console.log('');
  console.log('  La cible n est pas a jour des migrations, ou un objet y a ete retire.');
}

if (enPlus.length === 0 && enMoins.length === 0) {
  console.log('');
  console.log('  ok — inventaires identiques, objet par objet.');
  process.exit(0);
}

console.log('');
console.log('  DIVERGENCE — aucun objet ne doit etre supprime avant classement.');
process.exit(1);
