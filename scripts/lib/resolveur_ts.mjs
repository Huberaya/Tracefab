/**
 * Hook de résolution ESM : `.js` → `.ts` lorsque le `.js` demandé n'existe pas.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Le code de l'API importe ses voisins en `.js` alors que les fichiers sont en
 * `.ts` :
 *
 *     import { validateGtin } from '../plm-erp/gtin-engine.js';
 *
 * C'est la convention attendue par les bundlers et par TypeScript en
 * `moduleResolution: "Bundler"` (celle du `tsconfig.json` du dépôt) : le
 * spécificateur désigne le fichier COMPILÉ, le bundler fait la correspondance.
 * Next.js la comprend. Node, non : un script de test exécuté par `node` échoue
 * à la LIAISON (`ERR_MODULE_NOT_FOUND`), avant même d'avoir évalué la moindre
 * instruction — donc avant la garde de cible.
 *
 * Conséquence mesurée le 30/10 : `test_neon_bulk_operations_chantier8.mjs` ne
 * s'exécutait ni en CI ni en local, et n'avait donc jamais rien mesuré.
 *
 * CE QUE CE HOOK FAIT
 *
 * Il tente d'abord la résolution NORMALE. Il ne bascule vers le `.ts` voisin
 * que dans un seul cas : la résolution normale a échoué en
 * `ERR_MODULE_NOT_FOUND` et le spécificateur se terminait par `.js`. Toute
 * autre erreur est propagée telle quelle — une erreur de syntaxe, un export
 * manquant ou un échec de chargement ne sont jamais maquillés en « fichier
 * absent ».
 *
 * CE QU'IL NE FAIT PAS
 *
 *   — il ne touche à rien qui existe : si le `.js` est présent, c'est lui qui
 *     est chargé, jamais le `.ts` ;
 *   — il ne s'applique qu'aux spécificateurs relatifs ou `file:` ; les paquets
 *     npm ne sont jamais réécrits ;
 *   — il n'écrit rien sur disque, ne remplace aucun module et ne modifie pas
 *     le code applicatif ;
 *   — il ne transforme pas le TypeScript : il s'appuie sur le stripage de
 *     types natif de Node 22 (`--experimental-strip-types`, actif par défaut
 *     à partir de la 22.18). Les fichiers `.ts` du dépôt n'utilisent ni enum
 *     ni namespace, qui exigeraient une vraie compilation.
 *
 * LIMITES ASSUMÉES
 *
 *   — Node 22.18+ requis pour charger un `.ts` sans étape de compilation ;
 *   — `paths` de TypeScript (`@/…`) n'est pas résolu : aucun fichier exécuté
 *     par `node` n'en dépend aujourd'hui ;
 *   — le hook ne s'active que si le script appelant l'enregistre
 *     explicitement (`register('./lib/resolveur_ts.mjs', import.meta.url)`),
 *     AVANT le chargement des modules concernés. Il n'est pas global.
 */
export async function resolve(specifier, context, next) {
  const concerne = specifier.endsWith('.js')
    && (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:'));

  if (!concerne) return next(specifier, context);

  try {
    return await next(specifier, context);
  } catch (erreur) {
    // Seul « ce fichier n'existe pas » autorise la substitution. Toute autre
    // erreur remonte intacte : le hook ne doit pas masquer un vrai défaut.
    if (erreur?.code !== 'ERR_MODULE_NOT_FOUND') throw erreur;

    const candidat = `${specifier.slice(0, -3)}.ts`;
    try {
      return await next(candidat, context);
    } catch {
      // Aucun `.ts` voisin non plus : on rend l'erreur D'ORIGINE, qui nomme
      // le spécificateur réellement demandé par le code.
      throw erreur;
    }
  }
}
