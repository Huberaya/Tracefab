#!/usr/bin/env node
/**
 * Mutations : les gardes de l'historique DPP savent-ils encore echouer ?
 *
 * POURQUOI CE CONTROLE EXISTE
 *
 * Les etapes 1 a 4 ont livre trois gardes :
 *   - `test:brand-console:dpp-journey` (77 controles sur la console) ;
 *   - `test:i18n` (cles appelees presentes dans les 7 catalogues) ;
 *   - l'UI elle-meme (panneau, formulaire de rectification).
 *
 * Ces gardes ont ete PROUVES par mutation, a la main, dans un terminal. Le
 * probleme est la : une mutation faite a la main ne laisse aucune trace. Si
 * quelqu'un retire le panneau de l'historique dans six mois, le test le
 * signalera — mais personne ne saura jamais si le test aurait rougi pour la
 * bonne raison, ni si un `if` malencontreux a rendu un controle inoperant.
 *
 * Ce script rejoue donc les mutations fondatrices. Chacune casse UNE propriete
 * que le produit doit tenir, et exige que le garde correspondant rougisse.
 *
 * REGLE : une mutation qui laisse le garde VERT est un echec de ce script.
 * Elle signifie que le garde ne garde pas — pas que le code est bon.
 *
 * Les fichiers sont restaures dans un `finally`, y compris si une mutation
 * leve. Un worktree laisse mute apres un plantage serait pire que pas de
 * controle du tout.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = join(ROOT, 'assets/js/brand-console.1.js');

let echecs = 0;
let executions = 0;

const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); echecs += 1; };

/** Lance une suite `npm run <script>` et rend sa sortie et son code. */
function suite(script) {
  executions += 1;
  try {
    const sortie = execFileSync('npm', ['run', '-s', script], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600_000,
    });
    return { code: 0, texte: sortie };
  } catch (error) {
    return { code: error.status ?? 1, texte: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

/**
 * Applique une mutation sur un fichier, lance une suite, restaure.
 * `attendu` est un fragment que le garde doit citer en echec : un garde qui
 * rougit pour une mauvaise raison (import casse, fichier absent) ne prouve
 * rien sur la propriete visee.
 */
function mutation({ nom, fichier, avant, apres, script, attendu }) {
  // `fichier` peut etre une liste : une cle se retire des SEPT catalogues, pas
  // seulement de `en.js`. Mesure de l'erreur : retirer la cle du seul `en.js`
  // fait rougir le controle de PARITE (« 1 cle en trop » dans fr/de/it/es/nl/pt),
  // pas le controle des REFERENCES. La mutation mesurait alors autre chose que
  // ce qu'elle annoncait — et, comme le fragment attendu apparaissait dans les
  // deux messages, elle passait pour un succes.
  const fichiers = Array.isArray(fichier) ? fichier : [fichier];
  const originaux = fichiers.map((f) => [f, readFileSync(f, 'utf8')]);
  // Les catalogues n'ont pas la meme syntaxe : `en.js` est un objet JS
  // (`k: "v",`), les autres sont du JSON (`"k": "v",`). Une ancre unique ne
  // peut pas couvrir les deux ; on accepte donc plusieurs ancres possibles, et
  // on exige que CHAQUE fichier en porte exactement une.
  // Les catalogues n'ont ni la meme syntaxe (`k: "v",` en JS, `"k": "v",` en
  // JSON) ni la meme VALEUR par langue. Ancrer sur le texte anglais ne marche
  // que pour `en.js` : mesure de l'erreur, la mutation echouait sur fr.json
  // (« Toutes les categories »). On ancre donc sur la CLE, par expression
  // reguliere : quelle que soit la valeur, la ligne qui declare la cle.
  // `mutes` contient le contenu A ECRIRE (original moins l'ancre). Il est
  // distinct de `originaux`, qui sert a restaurer. Confondre les deux a
  // precisement produit le bug que ce script doit interdire : une premiere
  // version ecrivait `retraits.set(f, contenu.replace(...))` puis iterait
  // `for (const [f, [, mute]] of retraits)` — la valeur etait le contenu
  // mutile range dans un tableau, `mute` valait `undefined`, et le fichier
  // etait remplace par la chaine « undefined » (1 octet mesure). La console
  // ne demarrait plus et TOUTES les mutations paraissaient rougir.
  const mutes = new Map();
  for (const [f, contenu] of originaux) {
    // `avant` est un litteral, ou une expression reguliere quand la ligne
    // depend de la langue (la valeur change, la cle non).
    const regex = avant instanceof RegExp;
    const compteur = regex
      ? (contenu.match(avant) || []).length
      : contenu.split(avant).length - 1;
    if (compteur !== 1) {
      fail(`${nom} — ancre introuvable ou ambigue dans ${f.split('/').pop()} (${compteur}) : la mutation ne mesure plus rien`);
      return;
    }
    const mute = contenu.replace(avant, '');
    if (mute.length < contenu.length * 0.9) {
      // Garde-fou : une mutation retire une ligne, pas la moitie du fichier.
      fail(`${nom} — la mutation emporterait ${contenu.length - mute.length} octets de ${f.split('/').pop()} : ancre trop large`);
      return;
    }
    mutes.set(f, mute);
  }
  let resultat;
  try {
    for (const [f, mute] of mutes) writeFileSync(f, mute);
    resultat = suite(script);
  } finally {
    for (const [f, contenu] of originaux) writeFileSync(f, contenu);
  }
  if (resultat.code === 0) {
    fail(`${nom} — ${script} reste VERT alors que la propriete est cassee`);
    return;
  }
  if (attendu && !resultat.texte.includes(attendu)) {
    fail(`${nom} — ${script} rougit, mais pas pour la raison visee (attendu : « ${attendu} »)`);
    return;
  }
  ok(`${nom} → ${script} rougit (${attendu ? 'raison visee' : 'code non nul'})`);
}

/* ---------------------------------------------------------------- mutations */
console.log('Mutations de la console et de l i18n\n');

// A. L'historique n'est plus affiche. Sans panneau, il n'y a rien a corriger :
// c'est la regression la plus probable, un composant qu'on debranche.
mutation({
  nom: 'A. panneau de l historique retire',
  fichier: CONSOLE,
  avant: '          ${dppEventsPanel(p)}\n',
  apres: '',
  script: 'test:brand-console:dpp-journey',
  attendu: 'historique : la vue DPP expose un panneau',
});

// B. La correction ne vise plus l'entree cliquee. `data_corrected` pointerait
// vers n'importe quoi : la base l'accepterait (le CHECK exige une cible, pas
// la BONNE), et l'historique mentirait sans qu'aucune contrainte ne bronche.
mutation({
  nom: 'B. correctsEventId fige sur un identifiant errone',
  fichier: CONSOLE,
  avant: '          correctsEventId: c.correctsEventId,',
  apres: "          correctsEventId: 'evt-faux-999',",
  script: 'test:brand-console:dpp-journey',
  attendu: 'correctsEventId designe l entree visee',
});

// C. La cle d'idempotence est regeneree a chaque envoi. Deux clics sur
// « Envoyer » creent alors deux corrections pour un seul geste : la contrainte
// UNIQUE n'arrete que si la cle est la MEME.
mutation({
  nom: 'C. cle d idempotence regeneree a chaque envoi',
  fichier: CONSOLE,
  avant: '        const donnees = new FormData(form);',
  apres: "        c.idempotencyKey = `corr-${Date.now()}-${Math.random()}`;\n        const donnees = new FormData(form);",
  script: 'test:brand-console:dpp-journey',
  attendu: 'le rejeu conserve la meme cle d idempotence',
});

// D. L'erreur serveur redevient un code brut. L'utilisateur lit
// `dpp_event_role_required` : il ne sait ni ce qui a echoue ni quoi faire.
mutation({
  nom: 'D. codes d erreur non traduits',
  fichier: CONSOLE,
  avant: '        const cle = DPP_EVENT_ERRORS[code];\n        return cle ? bt(cle) : String(code);',
  apres: '        return String(code);',
  script: 'test:brand-console:dpp-journey',
  attendu: 'le role insuffisant est explique',
});

// Les cles se retirent des SEPT catalogues. Retirer d'un seul fait rougir la
// parite, ce qui masquerait le controle vise. Le fragment attendu cite donc
// « afficheraient une cle brute » (le controle des references), et pas le nom
// de la cle, qui apparait aussi dans le message de parite.
const CATALOGUES = [
  join(ROOT, 'assets/i18n/en.js'),
  ...['fr', 'de', 'it', 'es', 'nl', 'pt'].map((l) => join(ROOT, `assets/i18n/${l}.json`)),
];

// E. Une cle atteinte INDIRECTEMENT par un parametre disparait des 7.
// C'est l'angle mort ferme a l'etape 3 : le litteral `bt('...')` n'existe pas,
// la cle n'apparait que chez l'appelant.
mutation({
  nom: 'E. cle atteinte par parametre retiree des 7 catalogues',
  fichier: CATALOGUES,
  avant: /^    "?pdAllCategories"?: "[^"]*",\n/m,
  apres: '',
  script: 'test:i18n',
  attendu: 'afficheraient une cle brute',
});

// F. Une cle atteinte par TABLE disparait. Angle mort ferme a l'etape 1.
mutation({
  nom: 'F. cle atteinte par table retiree des 7 catalogues',
  fichier: CATALOGUES,
  avant: /^    "?dpStatusCorroborated"?: "[^"]*",\n/m,
  apres: '',
  script: 'test:i18n',
  attendu: 'afficheraient une cle brute',
});

/* -------------------------------------------------------------------- bilan */
console.log('');
if (executions === 0) {
  fail('aucune mutation executee — le script est casse, pas le code');
}
if (echecs) {
  console.error(`Mutations DPP : ${echecs} probleme(s) sur ${executions} mutation(s).`);
  process.exit(1);
}
console.log(`Mutations DPP : OK — ${executions}/${executions} gardes rougissent quand leur propriete est cassee.`);
