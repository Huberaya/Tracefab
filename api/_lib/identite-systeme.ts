import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Identite SYSTEME signee — la seconde moitie de la chaine de confiance P10.7.
 *
 * LE DEFAUT MESURE, ET POURQUOI CE MODULE EXISTE
 *
 * P10.5 a rendu l'identite UTILISATEUR non forgeable : l'application signe,
 * la base verifie. Mesure du 2026-11-05, base jetable dont le proprietaire des
 * objets est un role NON superutilisateur (forme Neon), cle HMAC provisionnee,
 * `tracefab_app` sans SUPERUSER ni BYPASSRLS :
 *
 *   1. l'attaquant obtient un jeton VALIDE pour SA propre organisation — la
 *      chaine HMAC fonctionne, elle n'est pas contournee ;
 *   2. il appelle `tracefab_sync_clerk_membership('mem_x', <org B>, <lui>, 'owner')` ;
 *   3. une adhesion `owner` est ecrite chez B ;
 *   4. `tracefab_has_org_role(<org B>, 'owner')` rend `true` ;
 *   5. il signe un jeton pour B — que la base accepte, puisqu'il est desormais
 *      REELLEMENT membre — et lit les produits de B.
 *
 * Le jeton n'a pas ete falsifie : il a ete OBTENU. Une identite signee ne
 * protege que les chemins qui la lisent, et treize operations systeme ne
 * lisaient rien du tout : elles etaient declarees au registre runtime, donc
 * executables par le role applicatif, sans aucun controle d'origine.
 *
 * CE QUE CE MODULE GARANTIT
 *
 *   1. l'identite systeme est SIGNEE (HMAC-SHA256) : le role applicatif ne
 *      peut pas en fabriquer une, il ne connait pas la cle de signature ;
 *   2. elle est DELIVREE par un canal authentifie : seule une requete portant
 *      le secret d'exploitation (`TRACEFAB_NOTIFICATION_WORKER_SECRET`, deja
 *      utilise par les routes worker) obtient un jeton. Le role PostgreSQL,
 *      lui, ne detient pas ce secret : il vit dans l'application ;
 *   3. elle est bornee dans le TEMPS (duree de vie courte) : un jeton vole
 *      n'est pas eternel ;
 *   4. elle est PROUVEE a l'execution : le jeton n'est pas une declaration
 *      supposee vraie, il est verifie par la base avant tout appel systeme, et
 *      un refus est un refus (aucun repli) ;
 *   5. elle ne confond pas les usages : le corps signe porte un usage distinct
 *      de celui du jeton utilisateur, donc un jeton utilisateur ne peut pas
 *      servir de jeton systeme, ni l'inverse.
 *
 * CE QUE CE MODULE NE FAIT PAS, ET QU'IL FAUT SAVOIR
 *
 *   - il n'empeche pas un detenteur du secret d'exploitation d'obtenir un jeton
 *     systeme : c'est le propre d'une authentification par secret partage, et
 *     c'est deja le modele de toutes les routes worker. La difference avec
 *     l'etat d'avant n'est pas la, elle est que ce secret n'est PAS dans la
 *     base : un detenteur des seuls identifiants PostgreSQL ne peut plus rien ;
 *   - il ne remplace pas la rotation de la cle d'identite : le jeton systeme
 *     est signe avec la MEME cle que le jeton utilisateur, donc il suit la
 *     rotation et la revocation de `tracefab_identity_cles`.
 */

/** Usage du jeton systeme. Distinct de `tracefab_identity` a dessein. */
export const USAGE_IDENTITE_SYSTEME = 'tracefab_system';

/**
 * Duree de vie. 60 s comme le jeton utilisateur : une operation systeme dure
 * des millisecondes, et un jeton systeme est emis juste avant l'appel, dans la
 * meme transaction. Allonger cette duree n'apporterait aucune disponibilite et
 * elargirait la fenetre d'un jeton intercepte.
 */
export const DUREE_JETON_SYSTEME_SECONDES = 60;

export type JetonSysteme = {
  /** Le jeton complet, a poser dans `tracefab.identity_systeme`. */
  jeton: string;
  /** Echeance Unix — pour les journaux, jamais le jeton. */
  expiration: number;
};

/**
 * Le corps signe, canonique et non ambigu.
 *
 *   v1|<usage>|<identite>|<expiration>
 *
 * L'ordre est fixe, les champs ne contiennent ni `|` ni `.` (ils sont
 * valides avant signature), et le corps ne peut pas etre reordonne sans
 * invalider le MAC. L'identite est un libelle fixe, pas une valeur libre :
 * un jeton systeme ne peut designer QUE l'identite systeme. Accepter un nom
 * d'identite libre transformerait le jeton en droit d'endosser n'importe quel
 * role, ce qui n'est pas le besoin et serait une surface inutile.
 */
export const IDENTITE_SYSTEME = 'tracefab_worker';

export type EtatCleSysteme = 'absente' | 'valide' | 'invalide';

/**
 * Etat de la cle de signature, sans jamais en reveler la valeur.
 *
 * Le format est celui de `identite-jeton.ts` : hexadecimale, longueur paire,
 * au moins 64 caracteres. Une cle presente mais malformee est une ERREUR
 * d'exploitation, pas un etat de transition : elle doit arreter la requete, pas
 * degrader silencieusement vers une identite non signee.
 */
export function etatCleSysteme(brute?: string): EtatCleSysteme {
  // DEUX APPELS, DEUX SENS — ET LA DIFFERENCE COMPTE.
  //
  //   etatCleSysteme()            -> lit la variable d'environnement (usage courant)
  //   etatCleSysteme(undefined)   -> « la cle que je te donne est absente »
  //
  // Trois ecritures ont ete essayees, et deux etaient fausses :
  //
  //   1. `brute = process.env.TRACEFAB_IDENTITY_KEY` (valeur par defaut) :
  //      `signerIdentiteSysteme({ cle: undefined })` — « je n'ai pas de cle » —
  //      retombait sur la variable d'environnement, la declarait VALIDE, puis
  //      dereferencait `undefined` et levait un TypeError. Mesure du 06/11 par
  //      `test:p107:identite-systeme-module`, des que la variable etait posee.
  //      Un `TypeError` dans le chemin de signature ne ressemble pas a « pas de
  //      cle » : il ressemble a une panne ;
  //   2. une sentinelle en valeur par defaut : elle ne corrige rien, car
  //      JavaScript applique la valeur par defaut aussi sur un `undefined`
  //      EXPLICITE. Mesure : `etatCleSysteme(undefined)` rendait `valide` ;
  //   3. `arguments.length` : le seul signal qui distingue « aucun argument » de
  //      « un argument valant undefined ». C'est celui qui est garde.
  const valeur = arguments.length === 0 ? process.env.TRACEFAB_IDENTITY_KEY : brute;
  if (valeur === undefined || valeur.trim() === '') return 'absente';
  const v = valeur.trim();
  return v.length >= 64 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v) ? 'valide' : 'invalide';
}

/**
 * Signe l'identite systeme.
 *
 * Rend `null` si la cle est ABSENTE : l'appelant doit alors refuser l'operation
 * systeme, puisqu'il ne peut pas prouver son origine. Il n'existe AUCUN repli
 * « sans jeton » : ce serait exactement le mode que l'on ferme.
 */
export function signerIdentiteSysteme({
  cle,
  identite = IDENTITE_SYSTEME,
  maintenant = Math.floor(Date.now() / 1000),
  dureeSecondes = DUREE_JETON_SYSTEME_SECONDES,
}: {
  cle: string | undefined;
  identite?: string;
  maintenant?: number;
  dureeSecondes?: number;
}): JetonSysteme | null {
  if (etatCleSysteme(cle) !== 'valide') return null;
  if (!/^[a-z_]{3,32}$/.test(identite)) {
    throw new Error('identite systeme invalide : [a-z_]{3,32} attendu');
  }
  const cleHex = cle!.trim();
  const expiration = maintenant + dureeSecondes;
  const corps = `v1|${USAGE_IDENTITE_SYSTEME}|${identite}|${expiration}`;
  const mac = createHmac('sha256', Buffer.from(cleHex, 'hex')).update(corps).digest('hex');
  return { jeton: `${corps}.${mac}`, expiration };
}

/**
 * Verifie un jeton systeme COTE APPLICATION.
 *
 * POURQUOI UNE VERIFICATION COTE APPLICATION EXISTE ICI, ALORS QUE P10.5 LA
 * REFUSAIT POUR LE JETON UTILISATEUR
 *
 * Pour le jeton UTILISATEUR, une verification applicative serait un controle que
 * l'attaquant peut retirer : l'identite y est une DONNEE que la base doit
 * croire, donc seule la base peut la valider. Pour le jeton SYSTEME, l'objet
 * verifie n'est pas une identite mais un DROIT D'EMISSION : l'application
 * elle-meme est le verificateur (c'est elle qui detient la cle), et c'est ce qui
 * permet a la base de ne PAS avoir a faire confiance a un GUC.
 *
 * La base ne peut pas verifier seule qu'un appel vient du webhook : elle ne
 * connait pas le secret d'exploitation et ne doit pas le connaitre. La
 * verification se fait donc a la frontiere HTTP, avec `timingSafeEqual`, et le
 * resultat est ensuite PROUVE a la base par une signature qu'elle sait verifier.
 *
 * Comparaison a temps constant : une comparaison `===` sur un MAC laisse fuir,
 * par le temps de reponse, le nombre d'octets corrects. C'est lent a exploiter
 * sur 64 caracteres hexadecimaux, et c'est gratuit a fermer.
 */
export function jetonSystemeValide(
  jeton: string | undefined | null,
  { cle, maintenant = Math.floor(Date.now() / 1000), identite = IDENTITE_SYSTEME }:
  { cle: string | undefined; maintenant?: number; identite?: string },
): boolean {
  if (typeof jeton !== 'string' || jeton === '') return false;
  if (etatCleSysteme(cle) !== 'valide') return false;

  const separateur = jeton.lastIndexOf('.');
  if (separateur <= 0) return false;
  const corps = jeton.slice(0, separateur);
  const macFourni = jeton.slice(separateur + 1);
  if (!/^[0-9a-f]{64}$/.test(macFourni)) return false;

  const parties = corps.split('|');
  if (parties.length !== 4) return false;
  const [version, usage, identiteSignee, expiration] = parties;
  if (version !== 'v1') return false;
  if (usage !== USAGE_IDENTITE_SYSTEME) return false;
  if (identiteSignee !== identite) return false;
  if (!/^[0-9]{1,12}$/.test(expiration)) return false;

  // Expiration verifiee ICI sur une horloge applicative, et de nouveau par la
  // BASE sur la sienne : deux horloges divergent, et c'est la base qui fait foi
  // pour l'autorisation. Cette premiere verification evite d'envoyer a la base
  // un jeton deja mort.
  if (Number(expiration) <= maintenant) return false;

  const attendu = createHmac('sha256', Buffer.from(cle!.trim(), 'hex')).update(corps).digest('hex');
  const a = Buffer.from(macFourni, 'hex');
  const b = Buffer.from(attendu, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * La cle de signature, ou `undefined` si elle est ABSENTE.
 *
 * Une cle presente mais malformee LEVE : c'est un defaut d'exploitation, et un
 * defaut d'exploitation ne doit pas se degrader en mode permissif silencieux.
 */
export function cleIdentiteSysteme(): string | undefined {
  const etat = etatCleSysteme();
  if (etat === 'absente') return undefined;
  if (etat === 'invalide') {
    throw new Error(
      'TRACEFAB_IDENTITY_KEY est presente mais inutilisable (hexadecimal, longueur paire, '
      + '>= 64 caracteres attendu) : aucun jeton systeme ne peut etre produit, donc aucune '
      + 'operation systeme ne peut etre executee. Corriger la variable avant de poursuivre.',
    );
  }
  return process.env.TRACEFAB_IDENTITY_KEY!.trim();
}
