/**
 * Affichage d'une donnée de passeport sur une carte Wallet.
 *
 * POURQUOI CE MODULE EXISTE
 *   Les deux générateurs (Apple et Google) portaient chacun leurs propres valeurs
 *   de substitution : `data.certifiedComposition || 'Fibres naturelles
 *   certifiées'`, `data.countryOfManufacture || 'UE'`,
 *   `data.supplyChainSummary || 'Nœuds certifiés GOTS/GRS auditables.'`.
 *
 *   Nettoyer le résolveur n'aurait donc servi à rien : la fabrication se serait
 *   simplement déplacée d'un étage. Deux portes pour la même question — « cette
 *   valeur existe-t-elle ? » — doivent partager un seul lecteur.
 *
 *   Une carte Wallet est un objet que le consommateur conserve. Y écrire « UE »
 *   parce que le pays est inconnu, c'est affirmer un pays.
 */

/** Mention explicite d'une donnée absente. Ce n'est pas une valeur métier. */
export const NOT_PROVIDED = 'Non renseigné';

/**
 * Rend une valeur de passeport, ou la mention d'absence.
 *
 * Une chaîne vide, `null` et `undefined` sont traités de la même façon : aucune
 * des trois n'est une information.
 */
export function display(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return NOT_PROVIDED;
  const text = String(value).trim();
  return text.length > 0 ? text : NOT_PROVIDED;
}

/**
 * Rend des consignes structurées (`care_instructions` est une colonne Json).
 *
 * Les clés sont affichées telles quelles : ce sont les libellés saisis par la
 * marque, pas un texte que ce module inventerait.
 */
export function displayStructured(value: Record<string, unknown> | null | undefined): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NOT_PROVIDED;
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
  if (entries.length === 0) return NOT_PROVIDED;
  return entries.map(([k, v]) => `${k} : ${String(v)}`).join(' · ');
}
