/**
 * L'hote de PRODUCTION — et la question « la Preview le joint-elle ? »
 *
 * POURQUOI CE MODULE EXISTE, SEPARE DE LA ROUTE.
 *
 * `hote_conforme` (C5.3) compare l'hote joint a l'hote DECLARE. C'est un bon
 * controle de configuration, et il ne dit rien de la seule propriete qui
 * compte : que l'hote joint ne soit pas celui de la Production. Si
 * `TRACEFAB_PREVIEW_DB_ENDPOINT` etait renseigne avec l'hote de Production, la
 * Preview joindrait la Production et `hote_conforme` vaudrait `true` — un PASS
 * parfait sur la configuration la plus grave possible. Une egalite ne peut pas
 * savoir que la valeur declaree est la mauvaise.
 *
 * Le garde `managed_host` de `scripts/lib/require-throwaway-db.mjs` refuse tout
 * hote Neon, mais il protege les scripts de migration : il ne s'execute JAMAIS
 * dans le runtime. Ce module comble ce trou au seul endroit ou la question se
 * pose vraiment.
 *
 * POURQUOI IL EST ICI ET PAS DANS LA ROUTE.
 *
 * Une regle de securite qu'aucun test ne peut atteindre sans base de donnees
 * est une regle qu'on ne verifie pas. Sortie de la route, cette logique est
 * eprouvable directement, sans Prisma et sans Postgres — donc elle est
 * reellement verifiee a chaque passage de la CI, et pas seulement presente.
 * Le test associe est `scripts/test_p107_hote_production.mjs`.
 */

/**
 * Normalise un nom d'hote pour comparaison.
 *
 * Trois differences qui ne designent PAS deux hotes distincts :
 *   - la casse (DNS insensible a la casse) ;
 *   - un point final (`ep-x.neon.tech.` = `ep-x.neon.tech`) ;
 *   - les espaces de saisie.
 *
 * On ne retire PAS le suffixe `-pooler` : c'est un hote different, et le
 * confondre avec l'endpoint direct ferait passer un test de rattachement sur
 * une base jointe par un autre chemin. Le cas est signale a part
 * (`hote_est_pooler`) et la comparaison reste stricte.
 */
export function normaliserHote(valeur: string): string {
  return valeur.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * L'hote de Production du depot.
 *
 * C'est un fait PUBLIC : il est ecrit dans `docs/`, dans
 * `RAPPORT-SECURISATION-RUNTIME.md` et dans l'historique des deploiements. Le
 * comparer n'apprend rien a un attaquant, et aucune valeur n'est publiee — la
 * route ne rend que le BOOLEEN `hote_est_production`, jamais la liste.
 *
 * La liste peut etre etendue par `TRACEFAB_PRODUCTION_DB_HOSTS` (noms separes
 * par des virgules) sans redeployer de code. Une variable absente ne desactive
 * rien : l'hote connu reste compare.
 */
const HOTES_PRODUCTION_CONNUS: readonly string[] = Object.freeze([
  'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech',
]);

export function hotesProduction(variable: string | undefined = process.env.TRACEFAB_PRODUCTION_DB_HOSTS): string[] {
  const declares = (variable ?? '')
    .split(',')
    .map((h) => normaliserHote(h))
    .filter((h) => h.length > 0);
  return [...new Set([...declares, ...HOTES_PRODUCTION_CONNUS])];
}

/**
 * L'hote donne est-il un hote de Production ?
 *
 * `true` est un FAIL pour une Preview : elle ne doit jamais joindre la
 * Production. Un hote vide ne peut etre ni l'un ni l'autre — il n'y a rien a
 * comparer, et repondre `false` laisserait croire que la question a ete posee.
 */
export function estHoteProduction(hote: string): boolean {
  const normalise = normaliserHote(hote);
  if (normalise.length === 0) return false;
  return hotesProduction().includes(normalise);
}
