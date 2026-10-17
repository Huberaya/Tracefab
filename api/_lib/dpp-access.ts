import type { Prisma } from '@prisma/client';

/**
 * Accès au produit pour un organisme VÉRIFICATEUR mandaté.
 *
 * Ne pas élargir `accessibleProduct` : un fournisseur ordinaire ne doit pas
 * lire le passeport privé d'une marque simplement parce qu'une relation
 * existe. Cette fonction ne réussit que si l'utilisateur courant est membre
 * d'un organisme de type `verifier`, relié par une relation ACTIVE à la
 * marque du produit. La vérification est faite par une fonction SQL
 * SECURITY DEFINER (`tracefab_verifier_product`), pas par une jointure
 * Prisma qui dépendrait des politiques RLS de chaque table.
 */
export async function accessibleProductForVerifier(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<{ id: string; ownerOrganizationId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; brand_organization_id: string }>>`
    SELECT id, brand_organization_id
    FROM tracefab_verifier_product(${productId}::uuid)
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { id: row.id, ownerOrganizationId: row.brand_organization_id } : null;
}

export async function accessibleProductForDppRead(
  tx: Prisma.TransactionClient,
  productId: string,
  accessibleProduct: (tx: Prisma.TransactionClient, id: string) => Promise<{ id: string; ownerOrganizationId: string } | null>,
): Promise<{ id: string; ownerOrganizationId: string; asVerifier: boolean } | null> {
  const brand = await accessibleProduct(tx, productId);
  if (brand) return { ...brand, asVerifier: false };
  const verifier = await accessibleProductForVerifier(tx, productId);
  return verifier ? { ...verifier, asVerifier: true } : null;
}
