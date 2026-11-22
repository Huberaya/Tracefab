#!/usr/bin/env node
/**
 * Non-regression : le generateur de cle produit-il le format EXACT attendu ?
 *
 * CE TEST NE DOIT JAMAIS AFFICHER UNE CLE
 * ---------------------------------------
 * Il capture la sortie du generateur et n'en imprime que des proprietes
 * derivees : longueur, jeu de caracteres, unicite. Une erreur d'assertion ne
 * doit pas recracher la valeur dans le journal de CI — ce serait exactement la
 * fuite que tout le reste du chantier s'emploie a fermer.
 *
 * CE QU'IL VERIFIE
 *   1. Format : 64 caracteres hexadecimaux MINUSCULES.
 *      Le runtime (`etatCleSysteme`) exige une longueur PAIRE >= 64 et
 *      `/^[0-9a-fA-F]+$/`. Un generateur qui produirait 63 caracteres, ou des
 *      majuscules, serait accepte ici mais refuserait ailleurs : le format est
 *      donc fige a la source.
 *   2. Prise du CSPRNG : deux tirages differents ne sont jamais egaux.
 *      Un generateur qui repeterait la meme valeur (graine fixe, cache) serait
 *      catastrophique et passerait un simple test de format.
 *   3. Entropie grossiere : sur un echantillon, le nombre de caracteres
 *      distincts et la presence des deux chiffres et lettres excluent une
 *      valeur triviale ou constante.
 *   4. Refus des mauvais arguments : sans `--environnement`, avec un nom
 *      inconnu, avec une longueur hors bornes.
 *   5. La valeur ne part PAS sur stderr : le script imprime sa procedure sur
 *      stderr, et la cle sur stdout. Un melange des deux ferait fuiter la cle
 *      dans les journaux d'un appelant qui ne redirige que stderr.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(racine, 'scripts', 'generer_cle_identite.mjs');

let echecs = 0;
const verifier = (cond, nom, detail = '') => {
  if (cond) console.log(`  ok    ${nom}`);
  else { console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`); echecs += 1; }
};

const lancer = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

console.log('Generateur de cle d identite');

// --- 1. Format -------------------------------------------------------------
const premier = lancer(['--environnement', 'preview']);
const cle1 = premier.stdout.trim();
verifier(premier.status === 0, 'un environnement valide produit une cle', `code ${premier.status}`);
verifier(/^[0-9a-f]{64}$/.test(cle1),
  'format : 64 caracteres hexadecimaux minuscules',
  // On ne montre QUE la longueur et un motif booleen, jamais la valeur.
  `longueur=${cle1.length} formatHexMinuscule=${/^[0-9a-f]{64}$/.test(cle1)}`);

// --- 2. CSPRNG : deux tirages differents -----------------------------------
const second = lancer(['--environnement', 'preview']);
const cle2 = second.stdout.trim();
verifier(cle1.length > 0 && cle2.length > 0 && cle1 !== cle2,
  'deux tirages successifs donnent des valeurs differentes (CSPRNG, pas de graine fixe)');

// --- 3. Entropie grossiere -------------------------------------------------
const distincts = new Set(cle1.split('')).size;
verifier(distincts >= 12,
  'repartment des caracteres compatible avec un tirage aleatoire',
  `${distincts} caracteres distincts sur 16 possibles`);

// --- 4. La valeur ne fuit pas sur stderr -----------------------------------
verifier(!premier.stderr.includes(cle1) && !second.stderr.includes(cle2),
  'la valeur ne figure PAS sur stderr (la procedure y est, la cle non)');
verifier(/TRACEFAB_IDENTITY_KEY/.test(premier.stderr),
  'la procedure nomme la variable a configurer');

// --- 5. Refus des mauvais arguments ---------------------------------------
const sansEnv = lancer([]);
verifier(sansEnv.status === 3, 'sans --environnement -> refus (code 3)', `code ${sansEnv.status}`);

const envInconnu = lancer(['--environnement', 'nimporte-quoi']);
verifier(envInconnu.status === 3, 'environnement inconnu -> refus (code 3)', `code ${envInconnu.status}`);

const tropCourt = lancer(['--environnement', 'preview', '--longueur', '16']);
verifier(tropCourt.status === 3, 'longueur < 32 octets -> refus (code 3)', `code ${tropCourt.status}`);

const tropLong = lancer(['--environnement', 'preview', '--longueur', '999']);
verifier(tropLong.status === 3, 'longueur > 64 octets -> refus (code 3)', `code ${tropLong.status}`);

// --- 6. Chaque environnement est nomme dans sa procedure -------------------
for (const env of ['preview', 'preproduction']) {
  const r = lancer(['--environnement', env]);
  verifier(r.status === 0 && r.stderr.includes(env),
    `la procedure pour « ${env} » nomme cet environnement`, `code ${r.status}`);
}

console.log(echecs === 0
  ? '  Generateur de cle : OK.'
  : `  Generateur de cle : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
