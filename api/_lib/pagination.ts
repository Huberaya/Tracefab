import type { VercelRequest } from './vercel-types.js';

/**
 * Plafond de collection.
 *
 * Avant ce module, 36 appels `findMany` du dossier `_routes` n'avaient aucun
 * `take`. Avec le jeu de demonstration — 1 248 produits — cela ne se voit
 * pas. Avec le catalogue d'une marque reelle, `GET /api/products` serialise
 * la table entiere en une seule reponse : la fonction depasse sa memoire ou
 * son delai, et la route ne repond plus du tout.
 *
 * CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS
 *
 * Il borne. Chaque collection repond au plus `limit` elements et annonce
 * `nextCursor` quand il en reste. Un echec dur — delai depasse, memoire
 * epuisee — devient une reponse partielle et signalee, ce qui est toujours
 * mieux.
 *
 * Il ne rend pas les clients paginants pour autant. La console et le portail
 * lisent encore la premiere page et ignorent `nextCursor`. Un locataire qui
 * depasse le plafond verra donc une liste tronquee tant que le client n'aura
 * pas ete mis a jour — c'est une limite connue, ecrite, et le plafond par
 * defaut est choisi tres au-dessus de tout locataire existant pour que
 * personne ne la rencontre avant cette mise a jour.
 *
 * LE CURSEUR
 *
 * Curseur sur cle, pas `OFFSET`. `OFFSET 10000` oblige Postgres a parcourir
 * et jeter dix mille lignes a chaque page ; le cout augmente avec le numero
 * de page. Un curseur sur un identifiant indexe reste constant. Il est aussi
 * stable a l'insertion : une ligne ajoutee pendant la pagination ne decale
 * pas les pages suivantes.
 */

export const DEFAULT_PAGE_SIZE = 2000;
export const MAX_PAGE_SIZE = 5000;

export type PageRequest = { limit: number; cursor: string | null };

/** Renvoie `null` si le client a fourni une valeur invalide, pour un 400. */
export function readPageRequest(
  req: VercelRequest,
  defaultLimit = DEFAULT_PAGE_SIZE,
  maxLimit = MAX_PAGE_SIZE,
): PageRequest | null {
  const raw = req.query.limit;
  const value = Array.isArray(raw) ? raw[0] : raw;
  let limit = defaultLimit;
  if (value !== undefined && value !== '') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) return null;
    limit = parsed;
  }
  const rawCursor = req.query.cursor;
  const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 200)) return null;
  return { limit, cursor: cursor || null };
}

/**
 * Arguments Prisma. On demande `limit + 1` element : la presence du
 * surnumeraire est la seule facon de savoir qu'il reste une page sans
 * emettre un `count` supplementaire sur toute la table.
 */
export function pageArgs(page: PageRequest, cursorField = 'id'): Record<string, unknown> {
  const args: Record<string, unknown> = { take: page.limit + 1 };
  if (page.cursor) {
    args.cursor = { [cursorField]: page.cursor };
    args.skip = 1;
  }
  return args;
}

export type Paged<T> = { items: T[]; nextCursor: string | null };

export function slicePage<T extends { id?: string }>(
  rows: T[],
  page: PageRequest,
  cursorOf: (row: T) => string = (row) => String(row.id),
): Paged<T> {
  if (rows.length <= page.limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, page.limit);
  return { items, nextCursor: cursorOf(items[items.length - 1]) };
}
