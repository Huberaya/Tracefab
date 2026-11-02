import { createHmac } from 'node:crypto';

/**
 * Jeton d'identité signé — la moitié applicative de la vérification en base.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * `tracefab.user_id` est un GUC : une valeur que l'appelant choisit. P10.4 a
 * mesuré ce que cela permet, sur base jetable et avec le rôle applicatif réel :
 * forger l'identité du propriétaire d'une autre marque, appeler l'ingestion
 * PLM/ERP, et écrire chez ce locataire (M3 : succès, 1 produit). La RLS ne
 * peut rien y faire : le rôle a le droit d'appeler, seule l'identité est
 * fausse.
 *
 * Le correctif est asymétrique, et c'est ce qui le rend utile : l'application
 * SIGNE, la base VÉRIFIE. La clé n'est jamais lisible par le rôle PostgreSQL du
 * runtime (mesuré : `42501 permission denied for table tracefab_identity_cles`),
 * donc un détenteur des identifiants de la base ne peut pas fabriquer de jeton.
 *
 * FORMAT
 *
 *   v1|<user_id>|<organization_id>|tracefab_identity|<exp>.<HMAC-SHA256 hex>
 *
 *   - `v1` : version du format, refusée si absente ou inconnue ;
 *   - `organization_id` : lié au contexte. La base compare ce champ à
 *     `current_setting('tracefab.active_organization_id')` ; un jeton émis
 *     pour une organisation ne vaut pas pour une autre ;
 *   - `exp` : secondes Unix, comparées à l'horloge de la BASE, jamais à celle
 *     du client ;
 *   - le séparateur entre corps et MAC est le POINT. Le champ d'usage porte
 *     donc un souligné : « tracefab.identity » coupait le corps en deux et
 *     faisait refuser tous les jetons (mesuré).
 *
 * CE QUE CE MODULE NE FAIT PAS
 *   - il ne décide pas de l'identité : il signe celle que Clerk a résolue ;
 *   - il ne vérifie rien : une vérification côté application serait un
 *     contrôle que l'attaquant peut retirer. La seule vérification qui compte
 *     est celle de la base, dans `tracefab_identity_jeton_utilisateur()`.
 */

export const IDENTITY_PURPOSE = 'tracefab_identity';

/**
 * Une clé d'identité est de l'hexadécimal, au moins 32 octets (64 caractères),
 * longueur PAIRE. La validation n'est pas cosmétique : `Buffer.from(x, 'hex')`
 * ignore silencieusement ce qui n'est pas hexadécimal, donc une clé mal saisie
 * (64 caractères quelconques) produirait un HMAC sur une clé VIDE — un jeton
 * vérifiable par quiconque connaît la clé vide. Mieux vaut refuser et retomber
 * en mode permissif, où la base applique sa propre politique.
 */
export function cleIdentiteValide(cle: string | undefined): cle is string {
  if (typeof cle !== 'string') return false;
  const v = cle.trim();
  return v.length >= 64 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v);
}

/** Duree de vie par defaut : 60 s. Une transaction dure des millisecondes. */
export const DUREE_JETON_SECONDES = 60;

export type JetonIdentite = {
  /** Le jeton complet, à poser dans `tracefab.identity`. */
  jeton: string;
  /** Échéance Unix, pour les journaux (jamais le jeton lui-même). */
  expiration: number;
};

/**
 * Signe l'identité résolue par l'authentification.
 *
 * `cle` est lue dans l'environnement par l'appelant, pas ici : un module qui
 * lit un secret à l'import le rend impossible à tester sans le poser.
 * Retourne `null` si la clé est absente — l'appelant retombe alors sur le mode
 * permissif, qui est le comportement antérieur, et la base le sait.
 */
export function signerIdentite({
  userId,
  organizationId,
  cle,
  maintenant = Math.floor(Date.now() / 1000),
  dureeSecondes = DUREE_JETON_SECONDES,
}: {
  userId: string;
  organizationId?: string | null;
  cle: string | undefined;
  maintenant?: number;
  dureeSecondes?: number;
}): JetonIdentite | null {
  if (!cleIdentiteValide(cle)) return null;
  const cleHex = cle.trim();
  const expiration = maintenant + dureeSecondes;
  const corps = `v1|${userId}|${organizationId ?? ''}|${IDENTITY_PURPOSE}|${expiration}`;
  const mac = createHmac('sha256', Buffer.from(cleHex, 'hex')).update(corps).digest('hex');
  return { jeton: `${corps}.${mac}`, expiration };
}

/** Vrai si une clé d'identité est configurée. Ne révèle jamais sa valeur. */
export function identiteSigneeConfiguree(): boolean {
  return cleIdentiteValide(process.env.TRACEFAB_IDENTITY_KEY);
}

/** La clé, ou `undefined`. Point unique de lecture de l'environnement. */
export function cleIdentite(): string | undefined {
  const cle = process.env.TRACEFAB_IDENTITY_KEY;
  return cleIdentiteValide(cle) ? cle.trim() : undefined;
}
