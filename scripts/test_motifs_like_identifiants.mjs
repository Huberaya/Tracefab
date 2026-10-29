#!/usr/bin/env node
/**
 * `LIKE '%tracefab_worker%'` MATCHE `tracefab.worker_context`.
 *
 * Dans un motif LIKE, `_` n'est pas un caractere : c'est un JOKER qui vaut
 * n'importe QUEL caractere. Un motif ecrit pour reconnaitre un identifiant
 * (role, fonction, politique) est donc plus large que ce qu'on croit, et une
 * sonde de securite batie dessus peut rendre un faux « conformé ».
 *
 * Le cas s'est produit pour de vrai dans ce chantier : la sonde d'etendue des
 * champs reserves affichait « 11 politiques sur le role worker » sur une base
 * ou la migration n'etait PAS appliquee — parce que la chaine
 * `tracefab.worker_context`, ecrite avec un POINT, satisfaisait le motif ecrit
 * avec un BLANC SOULIGNE.
 *
 * CE QUE CE TEST CHERCHE, ET POURQUOI IL NE SIGNALE PAS TOUT
 *
 * Signaler tout motif contenant `_` rendrait le controle inutilisable : la
 * plupart sont legitimes (`%owner%` dans un predicat de politique, par
 * exemple). Le test ne signale donc que les motifs dont le JOKER EST
 * DEMONTRE : il substitue chaque `_` du motif par un `.`, et verifie si la
 * chaine obtenue existe ailleurs dans le depot. Si oui, il y a deux formes
 * voisines qui se confondent — et c'est exactement le piege.
 *
 * La correction attendue est `strpos(chaine, 'litteral') > 0`, qui compare des
 * caracteres et non un motif.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

function fichiers(dossier, extensions, acc = []) {
  if (!existsSync(dossier)) return acc;
  for (const e of readdirSync(dossier, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dossier, e.name);
    if (e.isDirectory()) fichiers(p, extensions, acc);
    else if (extensions.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

// --- 1. Le corpus --------------------------------------------------------
const sources = [
  ...fichiers(join(racine, 'docs'), ['.sql', '.md']),
  ...fichiers(join(racine, 'prisma', 'migrations'), ['.sql']),
  ...fichiers(join(racine, 'scripts'), ['.mjs']),
];
console.log(`Corpus : ${sources.length} fichiers (docs .sql/.md, migrations, scripts)`);

const MOI = fileURLToPath(import.meta.url);
/**
 * Le detecteur s'exclut lui-meme : ses cas-temoins citent VOLONTAIREMENT les
 * motifs pieges, entre guillemets, pour prouver qu'il les reconnait. Les
 * inclure ferait echouer le controle sur sa propre documentation.
 * L'exclusion porte sur un seul fichier, nomme, et non sur un motif large.
 */
const corpus = new Map(sources
  .filter((f) => f !== MOI)
  .map((f) => [f, readFileSync(f, 'utf8')]));
// Index des fragments de texte du depot, pour decider si un quasi-identifiant
// (underscores remplaces par des points) existe reellement ailleurs.
const texteTotal = [...corpus.values()].join('\n');

// --- 2. Les motifs LIKE a identifiant ------------------------------------
/**
 * Un motif « a identifiant » : `%<corps>%` ou le corps est un identifiant
 * snake_case (lettres, chiffres, blancs soulignes). On ignore les motifs qui
 * contiennent deja des espaces, des parentheses ou des jokers explicites :
 * ce sont des freres de phrase, pas des identifiants.
 */
const MOTIF = /(['"])(%[^'"%]*%)\1/g;

const suspects = [];
for (const [fichier, texte] of corpus) {
  // Les commentaires SQL sont conserves : un motif cite dans un commentaire
  // n'est pas execute, on ne le signale donc pas. On retire les lignes `--`
  // et `//` avant analyse.
  const lignes = texte.split('\n');
  lignes.forEach((ligne, i) => {
    const sansCommentaire = ligne.replace(/--.*$/, '').replace(/\/\/.*$/, '');
    if (!/\b(I?LIKE)\b/i.test(sansCommentaire)) return;
    /**
     * Une PROSE qui cite un motif n'est pas un motif execute.
     *
     * Un rapport peut legitiment ecrire « le compteur utilisait
     * LIKE '%tracefab_worker%' » pour expliquer un defaut : cette phrase ne
     * s'execute pas. La CI a signale exactement cela sur le rapport de mission,
     * et le detecteur avait raison de mordre — c'est la regle qui etait trop
     * large. On ne retient donc que les lignes qui ressemblent a du SQL, par la
     * presence d'un mot-cle de requete sur la MEME ligne.
     */
    if (!/\b(SELECT|WHERE|AND|OR|WHEN|qual|with_check|prosrc|pg_get_expr)\b/i.test(sansCommentaire)) return;
    for (const m of sansCommentaire.matchAll(MOTIF)) {
      const corps = m[2].slice(1, -1);
      if (!/^[a-z][a-z0-9_]*$/.test(corps)) continue;
      if (!corps.includes('_')) continue; // sans souligne, pas de joker trompeur
      const quasi = corps.replace(/_/g, '.');
      // Le joker est DEMONTRE si la variante pointee existe dans le depot.
      if (texteTotal.includes(quasi)) {
        suspects.push({
          fichier: relative(racine, fichier),
          ligne: i + 1,
          motif: corps,
          quasi,
        });
      }
    }
  });
}

console.log(`\nMotifs dont le joker est demontre : ${suspects.length}`);
for (const s of suspects) {
  console.log(`  ${s.fichier}:${s.ligne}`);
  console.log(`      motif  '${s.motif}'  (le _ est un joker)`);
  console.log(`      matche aussi '${s.quasi}', present ailleurs dans le depot`);
}

// --- 3. Le verdict -------------------------------------------------------
/**
 * Aucun de ces motifs ne doit SUBSISTER. La correction n'est pas de renommer :
 * c'est `strpos(chaine, 'litteral') > 0`, qui compare des caracteres.
 *
 * Le test echoue donc sur tout motif demontre, sans liste d'exceptions : une
 * exception écrite ici redeviendrait un angle mort.
 */
ok('aucun motif LIKE a identifiant dont le joker est demontre',
  suspects.length === 0,
  suspects.map((s) => `${s.fichier}:${s.ligne} '${s.motif}'`).join(' | '));

// --- 4. Le detecteur mord-il ? ------------------------------------------
console.log('\nLe detecteur lui-meme');
{
  // On lui soumet trois cas synthetiques : le piege reel, un motif legitime,
  // et un motif sans souligne.
  const juger = (sql, corps) => {
    const m = sql.match(/(I?LIKE)\s+'%([^%']*)%'/i);
    if (!m) return null;
    const c = m[2];
    if (!/^[a-z][a-z0-9_]*$/.test(c) || !c.includes('_')) return 'ignore';
    return texteTotal.includes(c.replace(/_/g, '.')) ? 'signale' : 'ignore';
  };
  ok('un motif dont la variante pointee existe est SIGNALE',
    juger("WHERE qual LIKE '%tracefab_worker%'", 'tracefab_worker') === 'signale');
  ok('un motif dont la variante pointee n existe pas est IGNORE',
    juger("WHERE prosrc LIKE '%reviewed_at%'", 'reviewed_at') === 'ignore');
  ok('un motif sans souligne est IGNORE',
    juger("WHERE name LIKE '%owner%'", 'owner') === 'ignore');
}

// --- 5. Les cas reels deja corriges restent corriges ---------------------
console.log('\nLes deux corrections deja faites ne regressent pas');
{
  const sonde = readFileSync(join(racine, 'docs', 'security', '2026-10-28-tour30-C-sondes-effets.sql'), 'utf8');
  // `lower()` est exigee : `pg_policies.qual` rend `CURRENT_USER` en
    // majuscules, et un `strpos` sensible a la casse ne trouvait qu'une
    // politique sur onze. La casse fait partie du controle.
  ok('la sonde worker de tour30-C utilise strpos(lower(...))',
    /strpos\(pg_catalog\.lower\(coalesce\(qual, ''\)\), 'tracefab_worker'\)/.test(sonde));
  // Le fichier EXPLIQUE le motif piege dans ses commentaires : on analyse le
  // code, pas la prose — la lecon deja apprise sur le test de reconciliation.
  const sondeCode = sonde.split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  ok('elle n utilise plus ILIKE sur ce fragment (code, hors commentaires)',
    !/ILIKE\s+'%tracefab_worker%/.test(sondeCode));

  const etendue = readFileSync(join(racine, 'docs', 'security', '2026-10-29-etendue-champs-reserves-lecture-seule.sql'), 'utf8');
  const code = etendue.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  ok('le script d etendue compare avec strpos', /strpos\(/.test(code));
  ok('et n emploie plus LIKE sur le nom du role', !/LIKE\s+'%tracefab_worker%'/.test(code));
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Aucun motif LIKE a identifiant ne peut plus matcher une forme voisine.');
