/**
 * Annotations GitHub Actions — pour que le resultat soit lisible sans
 * telecharger les journaux de run.
 *
 * POURQUOI
 *   L'hote qui sert les journaux de run (results-receiver.actions.githubusercontent.com
 *   puis un blob de stockage) n'est pas joignable depuis un bac a sable
 *   d'analyse, alors que api.github.com l'est. Une mesure doit donc aussi
 *   passer par une annotation : c'est le canal qui survit au reseau restreint.
 *
 *   Le registre GitHub limite les annotations a quelques dizaines par etape :
 *   on regroupe donc les mesures en un nombre borne d'annotations, chacune
 *   portant une ligne cle=valeur.
 */

/** @param {string} title @param {string} body */
export function annoter(title, body) {
  const lignes = String(body)
    .split('\n')
    .map((l) => l.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'))
    .join('%0A');
  console.log(`::notice title=${title}::${lignes}`);
}

/** Regroupe des mesures `cle=valeur` en une annotation unique. */
export function annoterMesures(titre, mesures) {
  const corps = mesures
    .filter(([, valeur]) => valeur !== undefined && valeur !== null && valeur !== '')
    .map(([cle, valeur]) => `${cle}=${valeur}`)
    .join('\n');
  if (!corps) return;
  annoter(titre, corps);
}
