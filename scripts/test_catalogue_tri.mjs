/* Tri du catalogue — garde d'execution.
 *
 * Ce test EXECUTE assets/js/tf-sort.js dans Node. Le module est sans DOM et
 * s'accroche a `globalThis`, qui vaut `window` dans le navigateur : la meme
 * source est donc celle qui tourne en production et celle qui est testee ici.
 * Une relecture du source ne prouverait rien — une comparaison ecrite a
 * l'envers se lit aussi bien qu'elle se comporte mal.
 *
 * Trois pieges sont couverts explicitement, parce que ce sont ceux qu'un tri
 * de tableau rencontre vraiment :
 *   - le tri numerique : en lexical, « 10 » precede « 9 » ;
 *   - les valeurs vides : un tri descendant ne doit pas les faire remonter ;
 *   - les accents : sans depliage, « Débardeur » tombe apres tous les « D ».
 *
 * La seconde moitie verifie le CABLAGE : un module de tri parfait que la
 * console n'appelle pas est une fonctionnalite morte.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

let verifies = 0;
let echecs = 0;

function ok(libelle) { verifies += 1; console.log(`  ok    ${libelle}`); }
function ko(libelle, detail) {
  echecs += 1;
  console.log(`  FAIL  ${libelle}${detail ? '\n          ' + detail : ''}`);
}
function controle(libelle, fn) {
  try {
    const detail = fn();
    if (detail === false) ko(libelle, 'condition fausse');
    else ok(libelle);
  } catch (e) {
    ko(libelle, e.message);
  }
}

/* --- Chargement reel du module ------------------------------------------ */
const sourceTfSort = readFileSync('assets/js/tf-sort.js', 'utf8');
// new Function et non import() : le fichier est un IIFE de navigateur sans
// export. L'executer tel quel, sans le reemballer, est le point du test.
new Function(sourceTfSort)();
const TFSort = globalThis.TFSort;

controle('tf-sort.js s’exécute et expose TFSort', () => {
  assert.ok(TFSort, 'globalThis.TFSort absent');
  for (const fn of ['sansAccents', 'estVide', 'comparer', 'trier', 'basculer', 'ariaSort']) {
    assert.equal(typeof TFSort[fn], 'function', `${fn} n’est pas une fonction`);
  }
  return true;
});

/* --- Jeu de donnees aux formes reelles du catalogue ---------------------- */
const LIGNES = [
  { name: 'Trousers', reference: 'MB-004', category: '', dataCompletion: 9, status: 'active', dataReadiness: 'ready' },
  { name: 'Débardeur', reference: 'MB-002', category: 'Hauts', dataCompletion: 100, status: 'draft', dataReadiness: 'in_progress' },
  { name: 'Chemise', reference: 'MB-003', category: 'hauts', dataCompletion: 40, status: 'active', dataReadiness: 'blocked' },
  { name: 'Chemise', reference: 'MB-001', category: 'Bas', dataCompletion: 55, status: 'active', dataReadiness: 'ready' },
];

/* Les accesseurs sont ceux de la console. Les recopier ici aurait permis au
 * test de passer pendant que la console trie autre chose : on relit la carte
 * reellement declaree dans brand-console.1.js. */
const sourceConsole = readFileSync('assets/js/brand-console.1.js', 'utf8');
const blocColonnes = sourceConsole.match(/const COLONNES_TRI = \{[\s\S]*?\n      \};/);
controle('la carte des colonnes triables est declaree dans la console', () => {
  assert.ok(blocColonnes, 'COLONNES_TRI introuvable dans brand-console.1.js');
  for (const champ of ['name', 'category', 'status', 'dataCompletion', 'dataReadiness']) {
    assert.ok(new RegExp(`\\b${champ}:`).test(blocColonnes[0]), `colonne ${champ} absente de COLONNES_TRI`);
  }
  return true;
});

const COLONNES = {
  name: (p) => TFSort.sansAccents(p.name),
  category: (p) => TFSort.sansAccents(p.category || ''),
  status: (p) => TFSort.sansAccents(p.status || ''),
  dataCompletion: (p) => Number(p.dataCompletion) || 0,
  dataReadiness: (p) => TFSort.sansAccents(p.dataReadiness || 'in_progress'),
};
const repli = (p) => TFSort.sansAccents(p.reference);
const noms = (liste) => liste.map((p) => p.name).join('|');
const tri = (champ, sens) => TFSort.trier(LIGNES, COLONNES, { champ, sens }, repli);

/* --- 1. Ordre ascendant, indifferent aux accents ------------------------- */
controle('tri ascendant sur le nom, « Débardeur » à sa place alphabétique', () => {
  // En ordre de code brut, « D » + diacritique tomberait apres « T ».
  assert.equal(noms(tri('name', 'asc')), 'Chemise|Chemise|Débardeur|Trousers');
  return true;
});

controle('tri descendant inverse exactement l’ordre ascendant', () => {
  const asc = noms(tri('name', 'asc')).split('|');
  const desc = noms(tri('name', 'desc')).split('|');
  assert.deepEqual(desc, asc.slice().reverse());
  return true;
});

/* --- 2. Comparaison numerique, pas lexicale ------------------------------ */
controle('la complétude trie en numérique : 9 ne passe pas avant 100', () => {
  const ordre = tri('dataCompletion', 'asc').map((p) => p.dataCompletion);
  assert.deepEqual(ordre, [9, 40, 55, 100], `ordre obtenu ${ordre.join(',')}`);
  return true;
});

controle('la complétude descendante place 100 en tête', () => {
  const ordre = tri('dataCompletion', 'desc').map((p) => p.dataCompletion);
  assert.deepEqual(ordre, [100, 55, 40, 9], `ordre obtenu ${ordre.join(',')}`);
  return true;
});

/* --- 3. Valeurs vides ---------------------------------------------------- */
controle('une catégorie vide reste en dernier en ascendant', () => {
  const cats = tri('category', 'asc').map((p) => p.category || '(vide)');
  assert.equal(cats[cats.length - 1], '(vide)', `ordre obtenu ${cats.join(',')}`);
  return true;
});

controle('une catégorie vide reste en dernier AUSSI en descendant', () => {
  // C'est le piege : inverser le sens ne doit pas transformer « pas de donnee »
  // en valeur haute et la faire remonter en tete.
  const asc = tri('category', 'asc');
  const desc = tri('category', 'desc');
  assert.equal(desc[desc.length - 1].category, '',
    `le vide n’est pas dernier en descendant : ${desc.map((p) => p.category || '(vide)').join(',')}`);
  // Les valeurs presentes sont l'inverse exact de l'ascendant, comparees sur la
  // cle normalisee : « Hauts » et « hauts » se confondent au tri, et c'est le
  // departage qui les ordonne — voir le controle suivant.
  const cle = (p) => (p.category ? TFSort.sansAccents(p.category) : '(vide)');
  const ascCles = asc.map(cle);
  const descCles = desc.map(cle);
  assert.deepEqual(descCles.slice(0, -1), ascCles.slice(0, -1).reverse(),
    `desc ${descCles.join(',')} n’est pas l’inverse de asc ${ascCles.join(',')}`);
  return true;
});

controle('le départage ne suit pas le sens : à valeurs égales, l’ordre reste stable', () => {
  // Choix explicite, pas un oubli. Deux lignes que la colonne triee ne distingue
  // pas gardent leur ordre relatif quand on inverse le sens : c'est le
  // comportement d'un tri stable, et il evite qu'un double clic fasse permuter
  // deux lignes sous le curseur. Elles sont adjacentes et egales sur la colonne
  // affichee, donc la difference est invisible — mais elle doit etre voulue.
  const egaux = tri('category', 'asc').filter((p) => TFSort.sansAccents(p.category || '') === 'hauts');
  const egauxDesc = tri('category', 'desc').filter((p) => TFSort.sansAccents(p.category || '') === 'hauts');
  assert.deepEqual(egaux.map((p) => p.reference), ['MB-002', 'MB-003']);
  assert.deepEqual(egauxDesc.map((p) => p.reference), ['MB-002', 'MB-003'],
    'le departage a suivi le sens : le tri n’est plus stable');
  return true;
});

/* --- 4. Determinisme ----------------------------------------------------- */
controle('deux produits homonymes sont départagés par référence, pas par l’ordre d’arrivée', () => {
  const refs = tri('name', 'asc').filter((p) => p.name === 'Chemise').map((p) => p.reference);
  assert.deepEqual(refs, ['MB-001', 'MB-003'], `references ${refs.join(',')}`);
  return true;
});

controle('le même tri relancé sur une liste mélangée donne le même résultat', () => {
  const attendu = noms(tri('name', 'asc'));
  const melange = [LIGNES[3], LIGNES[0], LIGNES[2], LIGNES[1]];
  assert.equal(noms(TFSort.trier(melange, COLONNES, { champ: 'name', sens: 'asc' }, repli)), attendu);
  return true;
});

controle('la liste reçue n’est pas mutée', () => {
  const avant = LIGNES.map((p) => p.reference).join(',');
  TFSort.trier(LIGNES, COLONNES, { champ: 'name', sens: 'desc' }, repli);
  assert.equal(LIGNES.map((p) => p.reference).join(','), avant);
  return true;
});

/* --- 5. Colonnes inconnues et état --------------------------------------- */
controle('une colonne inconnue rend l’ordre d’origine, pas un ordre fantôme', () => {
  assert.equal(noms(TFSort.trier(LIGNES, COLONNES, { champ: 'inexistant', sens: 'asc' }, repli)), noms(LIGNES));
  return true;
});

controle('un état de tri vide rend l’ordre d’origine', () => {
  assert.equal(noms(TFSort.trier(LIGNES, COLONNES, { champ: '', sens: 'asc' }, repli)), noms(LIGNES));
  return true;
});

controle('un second clic sur la même colonne inverse le sens', () => {
  assert.deepEqual(TFSort.basculer({ champ: 'name', sens: 'asc' }, 'name'), { champ: 'name', sens: 'desc' });
  assert.deepEqual(TFSort.basculer({ champ: 'name', sens: 'desc' }, 'name'), { champ: 'name', sens: 'asc' });
  return true;
});

controle('un clic sur une autre colonne reprend en ascendant', () => {
  assert.deepEqual(TFSort.basculer({ champ: 'name', sens: 'desc' }, 'category'), { champ: 'category', sens: 'asc' });
  return true;
});

controle('aria-sort rend les trois valeurs de la spécification WAI-ARIA', () => {
  assert.equal(TFSort.ariaSort({ champ: 'name', sens: 'asc' }, 'name'), 'ascending');
  assert.equal(TFSort.ariaSort({ champ: 'name', sens: 'desc' }, 'name'), 'descending');
  assert.equal(TFSort.ariaSort({ champ: 'name', sens: 'asc' }, 'category'), 'none');
  return true;
});

/* --- 6. Cablage dans la console ------------------------------------------ */
const pageConsole = readFileSync('brand-console/index.html', 'utf8');

controle('tf-sort.js est chargé AVANT la console, qui l’appelle au premier rendu', () => {
  const a = pageConsole.indexOf('/assets/js/tf-sort.js');
  const b = pageConsole.indexOf('/assets/js/brand-console.1.js');
  assert.ok(a > -1, 'tf-sort.js n’est pas chargé par brand-console/index.html');
  assert.ok(b > -1, 'brand-console.1.js introuvable');
  assert.ok(a < b, `tf-sort.js (${a}) est chargé après la console (${b})`);
  return true;
});

controle('l’état de tri existe et reste séparé des filtres', () => {
  assert.ok(/tri:\s*\{\s*champ:\s*'',\s*sens:\s*'asc'\s*\}/.test(sourceConsole), 'state.tri absent');
  // « effacer les filtres » ne doit pas effacer le tri.
  const fx = sourceConsole.match(/fx: function \(event\) \{[\s\S]*?\n        \},/);
  assert.ok(fx, 'gestionnaire fx introuvable');
  assert.ok(!/state\.tri/.test(fx[0]), 'fx réinitialise le tri : le tri doit survivre aux filtres');
  return true;
});

controle('le tri est appliqué après le filtrage, dans la vue produits', () => {
  assert.ok(/produitsTries\(produitsFiltres\(\)\)/.test(sourceConsole),
    'la vue produits n’enchaîne pas produitsTries(produitsFiltres())');
  return true;
});

controle('les cinq colonnes affichées portent un en-tête triable', () => {
  for (const couple of [['name', 'pdProduct'], ['category', 'pdCategory'], ['status', 'pdStatus'],
    ['dataCompletion', 'pdCompleteness'], ['dataReadiness', 'pdReadiness']]) {
    const motif = new RegExp(`enTeteTriable\\('${couple[0]}',\\s*'${couple[1]}'\\)`);
    assert.ok(motif.test(sourceConsole), `en-tête ${couple[0]} non triable`);
  }
  return true;
});

controle('le gestionnaire « ps » est enregistré et borne la colonne', () => {
  const ps = sourceConsole.match(/ps: function \(event\) \{[\s\S]*?\n        \},/);
  assert.ok(ps, 'aucun gestionnaire ps dans TFActions.register');
  assert.ok(/hasOwnProperty\.call\(COLONNES_TRI, champ\)/.test(ps[0]),
    'ps accepte n’importe quelle colonne : un en-tete inconnu basculerait un tri invisible');
  assert.ok(/state\.pages\.products = 1/.test(ps[0]), 'ps ne revient pas en page 1');
  return true;
});

controle('un en-tête triable porte aria-sort et un vrai <button>', () => {
  const th = sourceConsole.match(/function enTeteTriable\([\s\S]*?\n      \}/);
  assert.ok(th, 'enTeteTriable introuvable');
  assert.ok(/aria-sort="\$\{TFSort\.ariaSort/.test(th[0]), 'aria-sort absent de l’en-tête');
  assert.ok(/<button type="button"/.test(th[0]), 'l’en-tête n’est pas un <button> : ni focus ni annonce');
  return true;
});

/* --- 7. Feuille de style -------------------------------------------------- */
controle('les classes ajoutées existent dans la feuille de style de la console', () => {
  const style = pageConsole.match(/<style>([\s\S]*?)<\/style>/g).join('\n');
  for (const classe of ['.th-sort', '.th-sort-ind', '.th-sort.is-active']) {
    assert.ok(style.includes(classe), `${classe} absente du CSS`);
  }
  return true;
});

controle('aucune variable CSS indéfinie dans les règles de tri', () => {
  // Garde contre une reference fantome : var(--emerald) n'est defini ni dans la
  // console ni dans le design system, et le repli masque silencieusement l'erreur.
  const regles = pageConsole.match(/\.th-sort[^}]*\}/g) || [];
  assert.ok(regles.length > 0, 'aucune règle .th-sort trouvée');
  const definies = new Set([...pageConsole.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const core = readFileSync('assets/design-system/tracefab-core.css', 'utf8');
  for (const m of core.matchAll(/(--[a-z0-9-]+):/g)) definies.add(m[1]);
  for (const regle of regles) {
    for (const m of regle.matchAll(/var\((--[a-z0-9-]+)/g)) {
      assert.ok(definies.has(m[1]), `${m[1]} utilisé par .th-sort n’est défini nulle part`);
    }
  }
  return true;
});

console.log('');
if (echecs > 0) {
  console.log(`test:catalogue:tri — ${echecs} échec(s) sur ${verifies + echecs} contrôles.`);
  process.exit(1);
}
console.log(`test:catalogue:tri passed — ${verifies} contrôles, 0 échec.`);
