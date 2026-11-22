import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { cleIdentiteSysteme, signerIdentiteSysteme } from './identite-systeme.js';

/**
 * Executer une operation SYSTEME sous une identite SYSTEME signee.
 *
 * CE QUE CETTE ENVELOPPE NE FAIT PLUS, ET POURQUOI
 *
 * Jusqu'a P10.7, elle posait `set_config('tracefab.worker_context')` — retire en
 * 20261028120100 parce qu'un GUC est falsifiable — puis elle ne faisait plus
 * qu'ouvrir une transaction, en s'appuyant sur le fait que les operations
 * systeme etaient possedees par `tracefab_worker`. Le raisonnement etait juste
 * sur la PROPRIETE et faux sur l'ORIGINE : la base executait bien la fonction
 * avec les droits du worker, mais n'importe qui pouvait la lui demander.
 *
 * Mesure du 2026-11-05, `tracefab_app` sans SUPERUSER ni BYPASSRLS, cle HMAC
 * provisionnee : `SELECT tracefab_sync_clerk_membership('mem_x', <org B>,
 * <attaquant>, 'owner')` ecrivait une adhesion `owner` chez un locataire
 * etranger. L'attaquant obtenait ensuite un jeton utilisateur VALIDE pour B —
 * non falsifie, simplement merite — et lisait les donnees de B.
 *
 * CE QUE L'ENVELOPPE FAIT MAINTENANT
 *
 *   1. elle exige une cle d'identite ; sans cle, elle LEVE (aucun repli) ;
 *   2. elle signe une identite SYSTEME (`v1|tracefab_system|...`) ;
 *   3. elle la pose dans `tracefab.identity_systeme`, portee TRANSACTIONNELLE ;
 *   4. la base verifie cette signature avant d'executer une operation systeme :
 *      une identite systeme non signee, expiree ou emise pour un autre usage est
 *      refusee en `authentication_required`, pas contournee.
 *
 * La separation des usages est ce qui rend la chaine utile : le jeton
 * utilisateur (`tracefab.identity`) ne peut pas servir de jeton systeme, et
 * reciproquement. Un role applicatif qui ne detient pas la cle ne peut produire
 * ni l'un ni l'autre.
 *
 * CE QUI RESTE VRAI, ET QUI NE DOIT PAS ETRE OUBLIE
 *
 * Le jeton systeme est signe avec la MEME cle que le jeton utilisateur. Un
 * detenteur de cette cle peut donc emettre un jeton systeme : c'est inevitable
 * avec une authentification par secret partage, et c'est sans commune mesure
 * avec l'etat anterieur, ou AUCUNE cle n'etait necessaire. La limite est ecrite
 * dans `docs/security/2026-11-05-p107-identite-systeme.md`.
 */
export async function withTracefabWorkerContext<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    const cle = cleIdentiteSysteme();
    if (cle === undefined) {
      // Fail-closed, et nomme. L'alternative — « on tente sans jeton et la base
      // decidera » — serait un repli silencieux vers l'etat vulnerable, et le
      // message d'erreur ne dirait pas pourquoi.
      throw new Error(
        'identite_systeme_indisponible: TRACEFAB_IDENTITY_KEY est absente, donc aucune '
        + 'operation systeme ne peut etre signee. Le context worker refuse de s\'ouvrir '
        + 'plutot que d\'executer une operation systeme non authentifiee.',
      );
    }

    const signe = signerIdentiteSysteme({ cle });
    if (signe === null) {
      throw new Error('identite_systeme_indisponible: la signature du contexte worker a echoue');
    }

    // Portee TRANSACTIONNELLE (`true`) : une connexion rendue au pool ne
    // conserve jamais l'identite systeme de la requete precedente.
    await tx.$executeRaw`SELECT set_config('tracefab.identity_systeme', ${signe.jeton}, true)`;

    try {
      return await callback(tx);
    } finally {
      // Nettoyage explicite, en plus de la portee transactionnelle : si
      // PostgreSQL a deja marque la transaction comme avortee, l'appel echoue et
      // l'erreur d'origine est preservee.
      try {
        await tx.$executeRaw`SELECT set_config('tracefab.identity_systeme', '', true)`;
      } catch {
        // La transaction est avortee : la portee transactionnelle garantit deja
        // l'absence de fuite vers la connexion suivante.
      }
    }
  });
}
