import type { Prisma } from '@prisma/client';

export const PRODUCT_SELECT = {
  id: true,
  brand_organization_id: true,
  reference: true,
  sku: true,
  name: true,
  category: true,
  status: true,
  version: true,
  public_slug: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  description: true,
  product_family: true,
  color_name: true,
  size_range: true,
  country_of_design: true,
  country_of_manufacture: true,
  weight_grams: true,
  care_instructions: true,
  data_readiness: true,
  data_completion: true,
  data_ready_at: true,
  last_data_updated_by: true,
} satisfies Prisma.tracefab_productsSelect;

export type ProductRecord = Prisma.tracefab_productsGetPayload<{ select: typeof PRODUCT_SELECT }>;

export function serializeProduct(product: ProductRecord) {
  return {
    id: product.id,
    brandOrganizationId: product.brand_organization_id,
    reference: product.reference,
    sku: product.sku,
    name: product.name,
    category: product.category,
    status: product.status,
    version: product.version,
    publicSlug: product.public_slug,
    createdBy: product.created_by,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
    description: product.description,
    productFamily: product.product_family,
    colorName: product.color_name,
    sizeRange: product.size_range,
    countryOfDesign: product.country_of_design,
    countryOfManufacture: product.country_of_manufacture,
    weightGrams: product.weight_grams === null ? null : String(product.weight_grams),
    careInstructions: product.care_instructions,
    dataReadiness: product.data_readiness,
    dataCompletion: String(product.data_completion),
    dataReadyAt: product.data_ready_at,
    lastDataUpdatedBy: product.last_data_updated_by,
  };
}

export async function activeOrganizationIds(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const memberships = await tx.organization_memberships.findMany({
    where: { user_id: userId, status: 'active' },
    select: { organization_id: true },
  });
  return memberships.map(({ organization_id }) => organization_id);
}

export async function activeBrandOrganizationIds(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const memberships = await tx.organization_memberships.findMany({
    where: {
      user_id: userId,
      status: 'active',
      organizations: { type: 'brand' },
    },
    select: { organization_id: true },
  });
  return memberships.map(({ organization_id }) => organization_id);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

export function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim() || null;
}
