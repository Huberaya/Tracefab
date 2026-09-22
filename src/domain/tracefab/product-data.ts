import type {
  ISODateTime,
  ProductDataReadiness,
  ProductIdentifierType,
  ProductMaterial,
  TracefabProduct,
  UUID,
} from './types';

export interface CreateProductCommand {
  brandOrganizationId: UUID;
  reference: string;
  name: string;
  category?: string | null;
  sku?: string | null;
}

export interface UpdateProductDataCommand {
  productId: UUID;
  reference: string;
  sku: string | null;
  name: string;
  category: string | null;
  description: string | null;
  productFamily: string | null;
  colorName: string | null;
  sizeRange: string[];
  countryOfDesign: string | null;
  countryOfManufacture: string | null;
  weightGrams: number | null;
  careInstructions: Record<string, unknown>;
}

export interface ProductIdentifierInput {
  productId: UUID;
  identifierType: ProductIdentifierType;
  identifierValue: string;
  isPrimary: boolean;
}

export interface ProductComposition {
  product: TracefabProduct;
  materials: ProductMaterial[];
  totalPercentage: number;
  isComplete: boolean;
}

export interface ProductDataReadinessSummary {
  status: ProductDataReadiness;
  completion: number;
  computedAt: ISODateTime | null;
  blockingRequirements: string[];
}

export type StartProductRevisionResult = TracefabProduct;
