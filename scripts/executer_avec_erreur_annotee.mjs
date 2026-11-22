#!/usr/bin/env node
/**
 * EXECUTER UNE COMMANDE, ET RENDRE SON ECHEC LISIBLE DEPUIS L'API GITHUB.
 *
 * POURQUOI CE WRAPPER EXISTE
 *
 * Les journaux des jobs de ce depot sont heberges hors de l'API GitHub : la
 * session de travail recoit « EOF » en les demandant. Tout ce qui reste
 * lisible, ce sont les ANNOTATIONS du check (`check-runs/<id>/annotations`)
 * et le numero d'etape. Une etape qui echoue sans rien y ecrire ne laisse
 * donc, pour diagnostic, que « exit code 1 » — et une etape qui echoue en
 * 0,0 s ne laisse meme pas de piste.
 *
 * Le depot applique deja ce remede a la boucle R6/R7/R9 (« sans la ligne
 * `::error::` ci-dessous, on ne sait que "exit code 1" »). Ce wrapper le rend
 * reutilisable : il execute la commande en flux direct (la sortie reste celle
 * de la commande, pas de tampon qui masquerait une progression), et, en cas
 * d'echec, emet une annotation `::error::` portant les dernieres lignes.
 *
 * CE QU'IL NE FAIT PAS
 *   - il ne change pas le code de sortie de la commande : un echec reste un
 *     echec, il ne « corrige » rien ;
 *   - il n'expurge pas arbitrairement : il MASQUE toute chaine de connexion
 *     qui porterait un mot de passe, parce qu'une annotation est publique sur
 *     un depot public.
 *
 * USAGE
 *   node scripts/executer_avec_erreur_annotee.mjs "<etiquette>" <commande> [args...]
 *
 *   ex.  node scripts/executer_avec_erreur_annotee.mjs "privileges" npm run test:neon:privileges
 *
 * Sortie : celle de la commande. Code de sortie : celui de la commande.
 */
import { spawn } from 'node:child_process';

const [etiquette, commande, ...args] = process.argv.slice(2);
if (!etiquette || !commande) {
  console.error('usage : executer_avec_erreur_annotee.mjs "<etiquette>" <commande> [args...]');
  process.exit(2);
}

/** Toute chaine de connexion `schema://user:motdepasse@` est masquee. */
function masquer(ligne) {
  return String(ligne).replace(/([a-z][a-z0-9+.-]*:\/\/[^:@/\s]*):[^@/\s]*@/gi, '$1:****@');
}

/** Les caracteres qui casseraient une annotation `::error::` sur une ligne. */
function pourAnnotation(ligne) {
  return masquer(ligne)
    .replace(/%/g, '%25')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ');
}

let tampon = '';
const lignes = [];
const MAX = 25;

const enfant = spawn(commande, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
for (const flux of [enfant.stdout, enfant.stderr]) {
  flux.on('data', (morceau) => {
    process[flux === enfant.stdout ? 'stdout' : 'stderr'].write(morceau);
    tampon += morceau.toString();
    const parties = tampon.split('\n');
    tampon = parties.pop();
    for (const p of parties) {
      if (!p.trim()) continue;
      lignes.push(p);
      if (lignes.length > MAX) lignes.shift();
    }
  });
}

enfant.on('exit', (code, signal) => {
  if (tampon.trim()) {
    lignes.push(tampon);
    if (lignes.length > MAX) lignes.shift();
  }
  if (code === 0) {
    process.exit(0);
  }
  // L'annotation porte la CONCLUSION et la trace : c'est tout ce que la
  // session de travail pourra lire de cette etape.
  const derniere = lignes.filter((l) => /ECHEC|Echec|error|Error|ERREUR|REFUS|NON EXECUTE/.test(l)).slice(-4);
  const queue = lignes.slice(-MAX).map(pourAnnotation).join(' ⟂ ');
  const cause = derniere.length ? derniere.map(pourAnnotation).join(' ⟂ ') : '(aucune ligne d erreur explicite)';
  console.log(`::error::${etiquette} — code ${code}${signal ? ` (signal ${signal})` : ''}. Cause : ${cause} | Dernieres lignes : ${queue}`);
  process.exit(code ?? 1);
});
