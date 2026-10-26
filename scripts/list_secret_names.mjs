#!/usr/bin/env node
/**
 * Inventaire des NOMS de secrets visibles dans le contexte du runner.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Une cle de test peut porter n'importe quel nom. Deviner des noms dans un
 *   workflow serait une suite d'essais aveugles ; lister les noms est une
 *   mesure. Un NOM n'est pas une valeur : ce script n'affiche que les noms,
 *   jamais une valeur, jamais un prefixe de valeur.
 *
 * CE QU'IL AFFICHE
 *   - le nombre de secrets visibles ;
 *   - le nom de chacun, trie.
 *
 * CE QU'IL NE FAIT PAS
 *   - il n'affiche aucune valeur, meme tronquee ;
 *   - il n'ecrit rien.
 */
const brut = process.env.TF_SECRET_NAMES || '{}';

let noms = [];
try {
  const objet = JSON.parse(brut);
  noms = Object.keys(objet || {}).sort();
} catch {
  console.error('TF_SECRET_NAMES illisible : aucun inventario possible.');
  process.exit(2);
}

console.log(`secret_count=${noms.length}`);
for (const nom of noms) console.log(`nom_secret=${nom}`);
